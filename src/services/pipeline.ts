/**
 * Pipeline orchestrator.
 *
 * Drives one document from a freshly-uploaded ARAG resource to a finished canonical
 * `DocumentRecord`. It runs inside a platform **job** (kind `process-document`), so every
 * stage is emitted as a `JobEvent` and streamed to clients over
 * `GET /api/v1/jobs/{id}/events` (SSE) — the SSE stream is a *view* of the job, not the
 * work itself, so a disconnecting client no longer kills (or keeps alive) the run.
 *
 *   process → classify → extract → entities → summary → validate → standardize
 *
 * Each stage is wrapped so a failure degrades gracefully: the run continues with the
 * best record it has rather than dying, and the failure is surfaced as a stage error.
 */
import type { AragClient, JobContext, Logger } from "../../vendor/arag-platform/src/index.ts";
import type { DocumentRecord, FieldValue, KvRejection, KvWriteRecord, StageName } from "../types.ts";
import type { Agents } from "./agents.ts";
import { buildQuerySeed, fieldsFromObject, groundingScore, validateNormalize } from "./agents.ts";
import type { ConfigsService } from "./configs.ts";
import { type KvData, type KvService, KvValidationError, kvErrorFrom, toKvData } from "./kv.ts";
import { type ExtractionSchema, schemaFor } from "./schemas.ts";

/** Input persisted on the job (so a job can be inspected long after it ran). */
export interface ProcessDocumentInput {
  documentId: string;
  resourceId: string;
  filename: string;
  contentType: string;
  /** `auto` (classify), `agent` (read DA-agent persisted fields), or a config id. */
  config: string;
}

export interface PipelineDeps {
  arag: AragClient;
  agents: Agents;
  configs: ConfigsService;
  log: Logger;
  /** Key-value writer. Absent means "do not persist the record into the Knowledge Box". */
  kv?: KvService;
}

// ─── key-value write-back ─────────────────────────────────────────────────────

/** What `writeRecordKv` needs. The pipeline and human review both hand it the same things. */
export interface KvWriteDeps {
  kv?: KvService;
  configs: ConfigsService;
  log: Logger;
}

/** The record's extracted fields as a plain object, keyed by the config's property names. */
function recordValues(record: DocumentRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of record.fields) out[field.key] = field.value;
  return out;
}

/** A `KvValidationError` reduced to the per-field message the record view shows. */
function toRejection(err: KvValidationError, names: Record<string, string>): KvRejection {
  const rejection: KvRejection = { kind: err.kind, message: err.message };
  if (err.field) rejection.field = names[err.field] ?? err.field;
  if (err.expected) rejection.expected = err.expected;
  if (err.got) rejection.got = err.got;
  return rejection;
}

/**
 * Write a finished record's fields into its resource's key-value field, and record on the
 * document exactly what happened.
 *
 * ### The overwrite trap
 *
 * A kv write is a **full replace** of the schema's data, and — this is the part that has to
 * be designed around rather than papered over — overwriting a value does **not** remove the
 * old one from the Knowledge Box's filter index. The index accumulates every value ever
 * written to that field on that resource, and there is no purge call. A resource whose
 * `vendor` was corrected from "Acme" to "Acme Pty Ltd" keeps matching a filter on "Acme"
 * forever.
 *
 * So the rule is **write once per resource**: the pipeline writes when the record is
 * finished, and nothing writes again unless a human corrects a field or the document is
 * reprocessed. When a second write is unavoidable, it is not hidden — `writes` counts them,
 * `filterIndexStale` goes true, and `superseded` keeps the values the resource still
 * wrongly matches, so the UI can say so in as many words.
 *
 * Never throws: a Knowledge Box that refuses the values is a degraded record, not a failed
 * document. The caller records a `stageErrors` entry from the returned `error`.
 */
export async function writeRecordKv(
  record: DocumentRecord,
  schema: ExtractionSchema,
  deps: KvWriteDeps,
  opts: { configId?: string } = {},
): Promise<KvWriteRecord> {
  const previous = record.meta.kv;
  const at = new Date().toISOString();
  const writes = (previous?.writes ?? 0) + 1;
  const base = (schemaId: string): KvWriteRecord => ({
    schemaId,
    written: false,
    at,
    fields: 0,
    writes,
    ...(previous?.filterIndexStale ? { filterIndexStale: true, superseded: previous.superseded } : {}),
  });

  const projection = deps.configs.kvForSchema(schema, opts.configId ?? schema.docType);
  if (!projection) {
    return { ...base(""), error: `no key-value schema could be derived for "${schema.name}"` };
  }
  const { mapping } = projection;
  const schemaId = mapping.schema.id;
  if (!deps.kv) return { ...base(schemaId), error: "key-value writes are not configured" };
  if (projection.status.state !== "provisioned") {
    return {
      ...base(schemaId),
      error: `key-value schema "${schemaId}" is ${projection.status.state}${projection.status.error ? `: ${projection.status.error}` : ""}`,
    };
  }

  const { data, skipped } = toKvData(recordValues(record), mapping);
  // The provisioned kv schema marks nothing required — ARAG would otherwise refuse the whole
  // write for one field a faded scan did not yield (see `provisionable` in configs.ts) — so
  // the config's own required list is checked here instead. The gap is reported, not enforced.
  for (const name of schema.required) {
    const key = mapping.fieldIds[name];
    if (key && !(key in data) && !skipped.some((s) => s.field === name)) {
      skipped.push({ field: name, reason: "required by the extraction config but not extracted" });
    }
  }
  const out: KvWriteRecord = {
    ...base(schemaId),
    fields: Object.keys(data).length,
    keys: mapping.fieldIds,
    values: data,
  };
  if (skipped.length) out.skipped = skipped;

  if (out.fields === 0) {
    out.error = "nothing to write: no extracted value could be represented in the key-value schema";
    return out;
  }

  try {
    await deps.kv.writeResourceKeyValues(record.resourceId, { [schemaId]: data });
    out.written = true;
  } catch (err) {
    const kvErr = err instanceof KvValidationError ? err : kvErrorFrom(err, schemaId);
    if (kvErr) out.rejected = [toRejection(kvErr, mapping.names)];
    out.error = (err as Error).message;
    deps.log.warn("kv.write.rejected", { rid: record.resourceId, schemaId, message: out.error });
    return out;
  }

  // Only a write that actually LANDED can have superseded anything. A rejected write still
  // populates `values` (they are computed before the call), so testing the values alone made
  // a resource written exactly once cry wolf — and named values that never reached the
  // Knowledge Box as still-matching. This is the product's headline honesty signal: a false
  // positive here is worse than a missing one.
  if (writes > 1 && previous?.written && previous.values) {
    out.filterIndexStale = true;
    out.superseded = mergeSuperseded(previous, data, mapping.names);
  }
  deps.log.info("kv.write.ok", {
    rid: record.resourceId,
    schemaId,
    fields: out.fields,
    skipped: skipped.length,
    writes,
  });
  return out;
}

/** Values this resource still matches a filter on although they have been replaced. */
function mergeSuperseded(
  previous: KvWriteRecord,
  next: KvData,
  names: Record<string, string>,
): Array<{ field: string; value: unknown }> {
  const kept = [...(previous.superseded ?? [])];
  for (const [key, old] of Object.entries(previous.values ?? {})) {
    if (JSON.stringify(next[key]) === JSON.stringify(old)) continue;
    const field = names[key] ?? key;
    if (kept.some((s) => s.field === field && JSON.stringify(s.value) === JSON.stringify(old))) continue;
    kept.push({ field, value: old });
  }
  return kept;
}

/**
 * Build the write-back `ReviewService` calls when a reviewer corrects a field.
 *
 * A kv write replaces the whole schema's data, so a one-field correction still has to send
 * **every** current value of the record — sending only the corrected key would drop every
 * other field from the Knowledge Box and fail on the required ones. The record handed in
 * already carries the corrected value (review applies the correction before writing back),
 * so what goes out is simply the whole current record.
 */
export function makeKvWriteback(
  deps: KvWriteDeps & { schemaOf: (record: DocumentRecord) => ExtractionSchema },
) {
  type CorrectionKv = NonNullable<NonNullable<DocumentRecord["corrections"]>[number]["kv"]>;
  return async (
    record: DocumentRecord,
    correction: { field: string; value: FieldValue },
  ): Promise<CorrectionKv> => {
    const schema = deps.schemaOf(record);
    const written = await writeRecordKv(record, schema, deps, { configId: record.meta.config });
    // The record is saved by the caller, so stamping it here is what carries the staleness
    // and the rejected values through to the API response.
    record.meta = { ...record.meta, kv: written };
    const out: CorrectionKv = {
      written: written.written,
      schemaId: written.schemaId || undefined,
      fieldId: written.keys?.[correction.field],
    };
    if (written.error) out.error = written.error;
    if (written.rejected?.length) {
      out.error = written.rejected.map((r) => r.message).join("; ");
    }
    if (written.filterIndexStale) out.filterIndexStale = true;
    return out;
  };
}

/**
 * Run the pipeline for one document, mutating and returning `record`.
 * `ctx` is the platform JobContext: `ctx.stage()` times each step and emits events.
 */
export async function runPipeline(
  record: DocumentRecord,
  input: ProcessDocumentInput,
  ctx: JobContext<ProcessDocumentInput>,
  deps: PipelineDeps,
): Promise<DocumentRecord> {
  const { resourceId } = input;
  const durations = record.meta.durationsMs;
  const useAgentFields = input.config === "agent";
  const forced = deps.configs.resolve(input.config);
  const stageErrors: string[] = [];
  /**
   * Wrapper around `ctx.stage` that does three things the pipeline needs:
   *   - records the stage duration on the *record* (`ctx.stage` only times the job);
   *   - collects failures so they can be surfaced on the record rather than only in the
   *     job's event log (a `soft` failure otherwise looks like "no fields in this
   *     document" to an API caller);
   *   - implements `soft` here rather than in `ctx.stage`, so the error still reaches
   *     this catch block. The emitted job events are identical either way.
   */
  const stage = async <T>(
    name: StageName,
    message: string,
    fn: () => Promise<T>,
    opts: { soft?: boolean; progress?: number } = {},
  ): Promise<T | undefined> => {
    const t0 = performance.now();
    try {
      return (await ctx.stage(name, message, fn, { progress: opts.progress })) as T | undefined;
    } catch (err) {
      stageErrors.push(`${name}: ${(err as Error).message}`);
      if (opts.soft) return undefined;
      throw err;
    } finally {
      durations[name] = Math.round(performance.now() - t0);
    }
  };

  // 1. Wait for ARAG to finish OCR/visual/layout/embedding processing, THEN wait until
  //    the resource is actually searchable. A resource's status flips to PROCESSED a few
  //    seconds BEFORE retrieval is ready — extracting too early yields empty results, so
  //    the pipeline gates on a cheap /find poll (`waitSearchable`) as well.
  //
  //    The extracted text is fetched in between: it is available as soon as the resource is
  //    PROCESSED, it is the query seed every later stage uses, and probing searchability
  //    with the document's own words hits far sooner than a generic probe query does.
  let sourceText = "";
  let seed = buildQuerySeed("", input.filename);
  await stage(
    "process",
    "Progress Agentic RAG is processing the document (OCR, visual layout, embeddings)…",
    async () => {
      await deps.arag.waitProcessed(resourceId, {
        intervalMs: 1500,
        signal: ctx.signal,
        onPoll: (status, attempt) =>
          ctx.emit("process", "progress", { message: `status: ${status} (poll ${attempt})` }),
      });
      sourceText = await deps.arag.extractedText(resourceId, { signal: ctx.signal }).catch(() => "");
      record.meta.sourceChars = sourceText.length;
      seed = buildQuerySeed(sourceText, input.filename);
      const searchable = await deps.arag.waitSearchable(resourceId, {
        query: seed,
        intervalMs: 1200,
        signal: ctx.signal,
        onPoll: () =>
          ctx.emit("process", "progress", { message: "indexing — waiting for search readiness…" }),
      });
      return { searchable, sourceChars: sourceText.length };
    },
    { soft: true, progress: 0.2 },
  );

  // 2a. Native path: read fields a Data Augmentation agent already persisted on the
  //     resource (configured in the ARAG dashboard). Falls back to live extraction.
  let agentHandled = false;
  if (useAgentFields) {
    const persisted = await stage(
      "classify",
      "Reading fields written by the ARAG Data Augmentation agent…",
      () => deps.agents.readPersistedFields(resourceId, { signal: ctx.signal }),
      { soft: true, progress: 0.35 },
    );
    if (persisted && Object.keys(persisted).length) {
      record.docType = "generic";
      record.meta.config = "generic";
      record.meta.configLabel = "ARAG DA agent (persisted)";
      record.meta.forced = true;
      record.meta.schema = "da_agent";
      const fields = fieldsFromObject(persisted);
      durations.extract = 0;
      ctx.emit("extract", "ok", { ms: 0, message: "Loaded persisted agent fields", progress: 0.6 });
      record.fields = fields;
      agentHandled = true;
    } else {
      ctx.emit("classify", "skip", {
        message: "No DA-agent fields on this resource yet — using live extraction.",
      });
    }
  }

  // Every agent call below names the uploaded file's own field (see `wholeDocument`).
  const fileField = record.meta.fileField;

  // 2b. Choose the extraction config. If one was forced, skip auto-classification and
  //     use it directly; otherwise an agent classifies the document.
  let schema: ExtractionSchema = schemaFor(record.docType);
  if (agentHandled) {
    // fields already loaded from the DA agent; classify/extract are skipped below
  } else if (forced) {
    ctx.emit("classify", "skip", {
      message: `Using "${forced.label}" config — auto-classification skipped`,
      data: { docType: forced.schema.docType, forced: true },
      progress: 0.35,
    });
    schema = forced.schema;
    record.docType = forced.schema.docType;
    // The **id**, not the label: `?config=` filtering, the per-config counts, the record's
    // key-value view and the generator agent all resolve this, and `resolve()` hands back
    // both. Storing `forced.label` made `?config=purchase_order` read `"purchase order"`.
    record.meta.config = forced.configId;
    record.meta.configLabel = forced.label;
    record.meta.forced = true;
  } else {
    const cls = await stage(
      "classify",
      "Classifying document type…",
      () => deps.agents.classify(resourceId, seed, ctx.signal, fileField),
      { soft: true, progress: 0.35 },
    );
    if (cls) {
      record.docType = cls.docType;
      record.docTypeConfidence = cls.confidence;
    }
    schema = schemaFor(record.docType);
    record.meta.config = record.docType;
    record.meta.configLabel = record.docType.replace(/_/g, " ");
    record.meta.forced = false;
  }
  if (!agentHandled) {
    record.meta.schema = schema.name;
    record.meta.searchConfiguration = `dip_${schema.name}`;
  }

  // 3. Schema-driven visual-LLM extraction (the core step). Retry once if the first
  //    pass comes back empty — guards against residual indexing lag. Skipped when the
  //    DA-agent path already loaded persisted fields.
  if (!agentHandled) {
    const extracted = await stage(
      "extract",
      `Extracting ${schema.docType.replace(/_/g, " ")} fields with the visual LLM…`,
      async () => {
        const opts = { sourceText, signal: ctx.signal, fileField };
        let out = await deps.agents.extractFields(resourceId, schema, seed, opts);
        if (out.fields.length === 0) {
          await sleep(2500, ctx.signal);
          out = await deps.agents.extractFields(resourceId, schema, seed, opts);
        }
        return out;
      },
      { soft: true, progress: 0.6 },
    );
    record.fields = extracted?.fields ?? [];
    record.evidence = extracted?.evidence ?? [];
  }

  // 4. Entity enrichment then summarisation — run SEQUENTIALLY, not concurrently.
  //    Two simultaneous full_resource generations against the same resource make one
  //    of them return empty; sequencing trades ~2 s of latency for reliability.
  const entities = await stage(
    "entities",
    "Surfacing named entities…",
    async () => {
      let e = await deps.agents.enrichEntities(resourceId, seed, ctx.signal, fileField);
      if (e.length === 0) {
        await sleep(1200, ctx.signal);
        e = await deps.agents.enrichEntities(resourceId, seed, ctx.signal, fileField);
      }
      return e;
    },
    { soft: true, progress: 0.75 },
  );
  record.entities = entities ?? [];

  const summ = await stage(
    "summary",
    "Summarising and tagging…",
    () => deps.agents.summarize(resourceId, seed, ctx.signal, fileField),
    { soft: true, progress: 0.85 },
  );
  if (summ) {
    record.summary = summ.summary;
    record.tags = summ.tags;
  }

  // 5. Deterministic validation + normalisation (no model call).
  await stage(
    "validate",
    "Normalising values and validating consistency…",
    async () => {
      // For the DA-agent path the field keys are user-defined, so skip schema-required
      // checks (no fixed schema); still normalise amounts/dates and check arithmetic.
      const valSchema = agentHandled ? { ...schema, required: [] } : schema;
      const { fields: normalized, issues } = validateNormalize(record.fields, valSchema);
      record.fields = normalized;
      record.issues = issues;
      // The headline "can I trust this record?" number: how much of what we extracted is
      // backed by text that really appears in the document.
      record.meta.groundingScore = groundingScore(record.fields, record.evidence);
      const unverified = record.evidence.filter((e) => e.verified === "unverified");
      for (const e of unverified) {
        issues.push({
          field: e.field,
          severity: "warning",
          message: `Supporting quote was not found in the document text: "${e.quote.slice(0, 120)}"`,
        });
      }
      return { issues: issues.length, groundingScore: record.meta.groundingScore };
    },
    { soft: true, progress: 0.95 },
  );

  // 6. Persist the verified record into the resource's key-value field, so the values are
  //    filterable in the Knowledge Box rather than only in this service's own store. This
  //    runs inside `standardize` rather than as a new stage: it is part of producing the
  //    canonical record, and the pipeline's stage list is a published contract.
  //
  //    A failure here degrades, it never fails the document — the extraction succeeded, and
  //    a record the KB would not index is still a record. The reason lands in `stageErrors`
  //    exactly like any other soft failure, and the detail (which fields were skipped, which
  //    the KB rejected and why) lands on `meta.kv` where the record view reads it.
  //
  //    Skipped on the DA-agent path: those fields were written as key-values by an ARAG
  //    agent in the first place, and they have no fixed schema to project onto.
  if (!agentHandled && deps.kv) {
    const t0 = performance.now();
    try {
      record.meta.kv = await writeRecordKv(record, schema, deps, { configId: record.meta.config });
      if (record.meta.kv.error) stageErrors.push(`standardize: key-value write — ${record.meta.kv.error}`);
    } catch (err) {
      // `writeRecordKv` is written not to throw; this is the belt to its braces.
      stageErrors.push(`standardize: key-value write — ${(err as Error).message}`);
    } finally {
      // Folded into `standardize` rather than added as a key of its own: `meta.durationsMs`
      // is keyed by the published stage names and a client may render exactly those.
      durations.standardize = (durations.standardize ?? 0) + Math.round(performance.now() - t0);
    }
  }

  // 7. Standardise — the record is ready for JSON/XML/CSV serialisation.
  record.meta.processedAt = new Date().toISOString();
  record.status = "ready";
  // A soft stage failure must not look like "this document simply had no fields":
  // surface it on the record itself so an API caller never has to read job events.
  if (stageErrors.length) {
    record.meta.stageErrors = stageErrors;
    for (const message of stageErrors) {
      const [field] = message.split(":");
      record.issues.push({ field: field ?? "pipeline", severity: "error", message });
    }
  }

  // Serialisation itself costs nothing; the key-value write-back above is the only work
  // this stage does, so whatever it took is what `standardize` took.
  durations.standardize ??= 0;
  ctx.emit("standardize", "ok", {
    message: "Canonical record ready (JSON · XML · CSV)",
    data: { fields: record.fields.length },
    progress: 1,
  });
  deps.log.info("pipeline.done", {
    documentId: record.id,
    docType: record.docType,
    fields: record.fields.length,
    entities: record.entities.length,
    issues: record.issues.length,
  });
  return record;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}
