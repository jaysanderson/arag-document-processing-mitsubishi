/**
 * Data-augmentation agents.
 *
 * Each agent is a focused, grounded call to ARAG that enriches the canonical record:
 *
 *   classify          → pick the document type (drives which extraction schema is used)
 *   extractFields     → schema-driven visual-LLM field extraction (the core step)
 *   enrichEntities    → named-entity surfacing (people, orgs, money, dates, …)
 *   summarize         → one-paragraph abstractive summary + topic tags
 *   validateNormalize → deterministic normalisation + consistency checks (no model call)
 *
 * Extraction/classification use `answer_json_schema` so the model is forced to return
 * structured JSON grounded in the uploaded document (retrieval is constrained to that
 * one resource via `resourceId`). Temperature 0 keeps demos repeatable.
 *
 * All HTTP goes through the shared platform `AragClient`; nothing here knows URLs.
 *
 * Every call targets `POST /ask` with `resource_filters: [resourceId]` rather than the
 * per-resource `POST /resource/{id}/ask` endpoint. Verified against the live KB: the
 * per-resource endpoint returns HTTP 500/503 as soon as `rag_strategies:
 * [{name:"full_resource"}]` is present, while `/ask` + `resource_filters` accepts the same
 * payload and returns the structured answer. Since full_resource grounding is the whole
 * point of the extraction agents, `resource_filters` is the only shape that works.
 */
import type {
  AnswerJsonSchema,
  AragClient,
  Logger,
  RagStrategy,
  SearchConfiguration,
} from "../../vendor/arag-platform/src/index.ts";
import type {
  DocType,
  Entity,
  Evidence,
  EvidenceVerification,
  ExtractedField,
  ValidationIssue,
} from "../types.ts";
import { normalizeCurrency, parseAmount, parseDateISO } from "./normalize.ts";
import { DOC_TYPES, type ExtractionSchema, SCHEMAS, toAnswerJsonSchema } from "./schemas.ts";

// The last sentence keeps the model in step with `parseDateISO`, which reads an ambiguous
// numeric date day-first. A date field asks for ISO 8601, so without it the model converts
// "01/10/2026" itself — month-first as often as not — and the normaliser never sees the
// original to get it right. These are Australian orders: 01/10/2026 is 1 October.
export const GROUNDING =
  "You are a precise document-data extraction engine. Use ONLY the content of the provided document. " +
  "Do not invent values. If a field is not present, omit it or leave it empty. Return values exactly as written in the document unless asked to normalize. " +
  "A date written in numbers is day/month/year: 01/10/2026 is 1 October 2026.";

export interface AgentDeps {
  arag: AragClient;
  log: Logger;
  generativeModel: string;
  reranker: string;
}

// ─── ARAG-side extraction configs ──────────────────────────────────────────────
// Each extraction schema is provisioned as a stored ARAG search_configuration that
// specifies the generative model (the multimodal LLM used for visual processing), the
// full_resource RAG strategy, the reranker, the grounding prompt (rules), and the
// answer_json_schema. Extraction then runs through that stored config via /ask.

/** Deterministic ARAG search_configuration name for a schema. */
export function aragConfigName(schema: ExtractionSchema): string {
  return `dip_${schema.name}`;
}

/**
 * The retrieval strategy that puts the whole document in front of the model.
 *
 * `full_resource` does that for a fresh resource. But ARAG answers HTTP 500 for it as soon as
 * the resource carries a key-value field — and every processed document does, because the
 * pipeline's last stage writes one. So a reprocess, or a question about a finished record,
 * failed on exactly the documents that had been read successfully. `field_extension` on the
 * uploaded file's own field supplies the same text without touching the key-value field. It
 * is passed per request (a request's strategies replace the stored configuration's), since
 * the field id belongs to the resource, not to the schema.
 */
export function wholeDocument(fileField?: string): RagStrategy[] {
  return fileField ? [{ name: "field_extension", fields: [`f/${fileField}`] }] : [{ name: "full_resource" }];
}

/** Build the Nuclia search_configuration body (kind:"ask") for a schema. */
export function toSearchConfig(schema: ExtractionSchema, deps: AgentDeps): SearchConfiguration {
  return {
    kind: "ask",
    config: {
      generative_model: deps.generativeModel || undefined,
      reranker: deps.reranker,
      rag_strategies: [{ name: "full_resource" }],
      prompt: { system: GROUNDING },
      answer_json_schema: toAnswerJsonSchema(schema),
    },
  };
}

/** Provisioning result for one schema. */
export interface ProvisionResult {
  schema: string;
  aragConfig: string;
  ok: boolean;
  error?: string;
}

/**
 * Agent runner. Holds the client plus a cache of already-provisioned ARAG search
 * configurations so repeat extractions do not re-POST the same config.
 */
export class Agents {
  private readonly d: AgentDeps;
  private readonly provisioned = new Set<string>();

  constructor(deps: AgentDeps) {
    this.d = deps;
  }

  /** Forget the provisioning cache (used by admin re-provision so it really re-POSTs). */
  resetProvisionCache(): void {
    this.provisioned.clear();
  }

  /** Ensure a schema's search_configuration exists in ARAG (idempotent, cached). */
  async ensureExtractionConfig(schema: ExtractionSchema, opts: { force?: boolean } = {}): Promise<string> {
    const name = aragConfigName(schema);
    if (!opts.force && this.provisioned.has(name)) return name;
    await this.d.arag.putSearchConfiguration(name, toSearchConfig(schema, this.d));
    this.provisioned.add(name);
    this.d.log.info("arag.config.provisioned", { name });
    return name;
  }

  /** Provision a set of extraction configs in ARAG; never throws. */
  async provision(schemas: ExtractionSchema[], opts: { force?: boolean } = {}): Promise<ProvisionResult[]> {
    const out: ProvisionResult[] = [];
    for (const schema of schemas) {
      const aragConfig = aragConfigName(schema);
      try {
        await this.ensureExtractionConfig(schema, opts);
        out.push({ schema: schema.name, aragConfig, ok: true });
      } catch (err) {
        this.d.log.warn("arag.config.provision.fail", {
          schema: schema.name,
          message: (err as Error).message,
        });
        out.push({ schema: schema.name, aragConfig, ok: false, error: (err as Error).message });
      }
    }
    this.d.log.info("arag.config.provision.done", {
      ok: out.filter((r) => r.ok).length,
      failed: out.filter((r) => !r.ok).length,
    });
    return out;
  }

  /** Remove a stored ARAG search configuration (used when a custom config is deleted). */
  async deleteSearchConfiguration(name: string): Promise<void> {
    await this.d.arag.deleteSearchConfiguration(name);
    this.provisioned.delete(name);
  }

  /** Provision all built-in extraction configs (called at boot and by admin). */
  provisionBuiltins(opts: { force?: boolean } = {}): Promise<ProvisionResult[]> {
    return this.provision(
      DOC_TYPES.map((dt) => SCHEMAS[dt]),
      opts,
    );
  }

  // ─── classify ───────────────────────────────────────────────────────────────

  async classify(
    resourceId: string,
    querySeed: string,
    signal?: AbortSignal,
    fileField?: string,
  ): Promise<{ docType: DocType; confidence: number }> {
    const schema: AnswerJsonSchema = {
      name: "classify_document",
      description: "Classify the document into one of the supported types.",
      parameters: {
        type: "object",
        properties: {
          doc_type: {
            type: "string",
            enum: DOC_TYPES,
            description: "The single best-fitting document type.",
          },
          confidence: { type: "number", description: "Confidence between 0 and 1." },
        },
        required: ["doc_type", "confidence"],
      },
    };
    const res = await this.d.arag.ask(
      {
        query: querySeed,
        resource_filters: [resourceId],
        rag_strategies: wholeDocument(fileField),
        prompt: { system: GROUNDING },
        answer_json_schema: schema,
        temperature: 0,
        // Generous cap: a truncated structured response is invalid JSON and yields NO
        // answer_json at all, which silently demotes every document to "generic".
        max_tokens: 300,
        generative_model: this.d.generativeModel || undefined,
        reranker: this.d.reranker,
      },
      { signal },
    );
    const o = obj(res.answerJson);
    const docType = (DOC_TYPES as string[]).includes(String(o.doc_type))
      ? (o.doc_type as DocType)
      : "generic";
    const confidence = typeof o.confidence === "number" ? clamp01(o.confidence) : 0.5;
    this.d.log.info("agent.classify", { resourceId, docType, confidence, ms: res.timings.totalMs });
    return { docType, confidence };
  }

  // ─── extractFields ──────────────────────────────────────────────────────────

  async extractFields(
    resourceId: string,
    schema: ExtractionSchema,
    querySeed: string,
    opts: { sourceText?: string; signal?: AbortSignal; fileField?: string } = {},
  ): Promise<{ fields: ExtractedField[]; evidence: Evidence[] }> {
    // Extraction runs through the schema's STORED ARAG search configuration, which
    // owns the model (visual LLM), full_resource RAG strategy, reranker, prompt, and
    // answer_json_schema. Provision it on first use (idempotent).
    const configName = await this.ensureExtractionConfig(schema);
    const res = await this.d.arag.ask(
      {
        query: querySeed,
        search_configuration: configName,
        resource_filters: [resourceId],
        ...(opts.fileField ? { rag_strategies: wholeDocument(opts.fileField) } : {}),
        temperature: 0,
        max_tokens: 1500,
      },
      { signal: opts.signal },
    );
    const answer = obj(res.answerJson);
    const fields = fieldsFromSchema(answer, schema);
    // The model was asked for verbatim quotes as part of the schema; check them against
    // the document rather than taking them on trust. `citations` cannot be used here —
    // ARAG rejects it alongside `answer_json_schema` — but the retrieval item still
    // arrives, so quotes can be pinned to a paragraph.
    const evidence = verifyEvidence(answer.evidence, {
      sourceText: opts.sourceText ?? "",
      fieldKeys: new Set(fields.map((f) => f.key)),
      paragraphs: paragraphsFromRetrieval(res.retrieval, resourceId),
    });
    this.d.log.info("agent.extract", {
      resourceId,
      schema: schema.name,
      fields: fields.length,
      evidence: evidence.length,
      verified: evidence.filter((e) => e.verified !== "unverified").length,
      ms: res.timings.totalMs,
    });
    return { fields, evidence };
  }

  // ─── enrichEntities ─────────────────────────────────────────────────────────

  async enrichEntities(
    resourceId: string,
    querySeed: string,
    signal?: AbortSignal,
    fileField?: string,
  ): Promise<Entity[]> {
    const schema: AnswerJsonSchema = {
      name: "extract_entities",
      description: "Surface the salient named entities in the document.",
      parameters: {
        type: "object",
        properties: {
          entities: {
            type: "array",
            description: "Named entities found in the document.",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                type: {
                  type: "string",
                  description: "PERSON | ORG | DATE | MONEY | LOCATION | EMAIL | PHONE | ID | OTHER",
                },
              },
              required: ["text", "type"],
            },
          },
        },
        required: ["entities"],
      },
    };
    const res = await this.d.arag.ask(
      {
        query: querySeed,
        resource_filters: [resourceId],
        rag_strategies: wholeDocument(fileField),
        prompt: { system: GROUNDING },
        answer_json_schema: schema,
        temperature: 0,
        // Generous cap: a truncated structured response yields invalid JSON and thus NO
        // answer_json at all (not a partial), so under-budgeting here drops every entity.
        max_tokens: 1500,
        generative_model: this.d.generativeModel || undefined,
        reranker: this.d.reranker,
      },
      { signal },
    );
    const entities = entitiesFrom(obj(res.answerJson));
    this.d.log.info("agent.entities", { resourceId, count: entities.length, ms: res.timings.totalMs });
    return entities;
  }

  // ─── summarize ──────────────────────────────────────────────────────────────

  async summarize(
    resourceId: string,
    querySeed: string,
    signal?: AbortSignal,
    fileField?: string,
  ): Promise<{ summary: string; tags: string[] }> {
    const schema: AnswerJsonSchema = {
      name: "summarize_document",
      description: "Summarize the document and assign topic tags.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "A single, factual paragraph (<= 60 words)." },
          tags: { type: "array", items: { type: "string" }, description: "3-6 short topic tags." },
        },
        required: ["summary"],
      },
    };
    const res = await this.d.arag.ask(
      {
        query: querySeed,
        resource_filters: [resourceId],
        rag_strategies: wholeDocument(fileField),
        prompt: { system: GROUNDING },
        answer_json_schema: schema,
        temperature: 0,
        max_tokens: 400,
        generative_model: this.d.generativeModel || undefined,
        reranker: this.d.reranker,
      },
      { signal },
    );
    const o = obj(res.answerJson);
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    const tags = Array.isArray(o.tags)
      ? o.tags
          .map((t) => String(t).trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    this.d.log.info("agent.summary", { resourceId, tags: tags.length, ms: res.timings.totalMs });
    return { summary, tags };
  }

  /**
   * Read fields a Data Augmentation "ask" agent persisted on the resource (a JSON text
   * field or a key-value field written by the agent in the ARAG dashboard) instead of
   * running a live extraction. Returns null when the resource carries no agent output.
   */
  async readPersistedFields(
    resourceId: string,
    opts: { destination?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown> | null> {
    const r = await this.d.arag.getResource(resourceId, {
      show: ["values", "extracted"],
      extracted: ["text"],
      signal: opts.signal,
    });
    const candidates: Array<[string, Record<string, unknown>]> = [];
    for (const [category, fields] of Object.entries(r.data ?? {})) {
      if (category === "files" || category === "generics" || !fields) continue;
      for (const [fid, f] of Object.entries(fields)) {
        // Key-value field: value.keyvalues = [{key,value}, …]
        const value = f?.value as Record<string, unknown> | undefined;
        const kvs = value?.keyvalues;
        if (Array.isArray(kvs) && kvs.length) {
          const o: Record<string, unknown> = {};
          for (const kv of kvs as Array<Record<string, unknown>>) {
            if (kv && typeof kv.key === "string") o[kv.key] = kv.value;
          }
          if (Object.keys(o).length) candidates.push([fid, o]);
          continue;
        }
        // JSON text field: value.body or extracted text that parses to an object.
        const body = typeof value?.body === "string" ? value.body : "";
        const extractedText = typeof f?.extracted?.text?.text === "string" ? f.extracted.text.text : "";
        const text = body || extractedText;
        if (!text) continue;
        try {
          const o = JSON.parse(text) as unknown;
          if (o && typeof o === "object" && !Array.isArray(o))
            candidates.push([fid, o as Record<string, unknown>]);
        } catch {
          /* not JSON — ignore */
        }
      }
    }
    if (candidates.length === 0) return null;
    if (opts.destination) {
      const match = candidates.find(([fid]) => fid === opts.destination);
      if (match) return match[1];
    }
    return candidates[0]![1];
  }
}

// ─── pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Build a retrieval query "seed" from the document's own extracted text.
 *
 * With the `full_resource` RAG strategy the model gets the whole document — BUT
 * retrieval still runs first to locate the resource, and an instruction-style query
 * ("list the entities") shares no vocabulary with many documents, returning zero
 * results (`no_retrieval_data`). Seeding the query with the document's actual opening
 * text guarantees a retrieval hit, after which full_resource supplies full context.
 */
export function buildQuerySeed(text: string, filename: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length >= 12) return cleaned.slice(0, 280);
  return `${filename} document contents details name date total amount party`;
}

function obj(answerJson: unknown): Record<string, unknown> {
  return answerJson && typeof answerJson === "object" ? (answerJson as Record<string, unknown>) : {};
}

/** Values models emit to mean "absent" — treat as not-extracted. */
const SENTINELS = new Set([
  "not specified",
  "n/a",
  "na",
  "none",
  "unknown",
  "not provided",
  "not available",
  "-",
]);
export function isSentinel(v: string): boolean {
  return SENTINELS.has(v.trim().toLowerCase());
}

/** Project a model's structured answer onto a schema's declared fields. */
export function fieldsFromSchema(
  answer: Record<string, unknown>,
  schema: ExtractionSchema,
): ExtractedField[] {
  const fields: ExtractedField[] = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in answer)) continue;
    let value = answer[key] as ExtractedField["value"];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (typeof value === "string" && isSentinel(value)) continue; // "Not specified" / "N/A" / …
    if (prop.type === "number" && typeof value === "string") {
      const parsed = parseAmount(value);
      if (parsed !== null) value = parsed;
    }
    const required = schema.required.includes(key);
    fields.push({
      key,
      label: schema.labels[key] ?? key,
      value,
      confidence: required ? 0.95 : 0.85,
    });
  }
  return fields;
}

// ─── verified evidence ─────────────────────────────────────────────────────────

/**
 * Normalise a quote for a forgiving comparison: case, whitespace runs, the punctuation a
 * model habitually "tidies" (curly quotes, en/em dashes, trailing full stops) and the
 * spaces around it. Deliberately does NOT strip digits or letters — a quote that only
 * matches after mangling the numbers is not evidence.
 */
export function normaliseQuote(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[.,;:!?()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One retrieval paragraph, reduced to what locating a quote needs. */
export interface EvidenceParagraph {
  id: string;
  text?: string;
  start?: number;
  end?: number;
}

/**
 * Pull the paragraphs out of an `/ask` retrieval item. ARAG keys them
 * `<rid>/<type>/<field>/<start>-<end>`, which is what a client needs to highlight a span.
 */
export function paragraphsFromRetrieval(retrieval: unknown, resourceId?: string): EvidenceParagraph[] {
  const resources = (retrieval as { resources?: Record<string, unknown> } | undefined)?.resources ?? {};
  const out: EvidenceParagraph[] = [];
  for (const [rid, resource] of Object.entries(resources)) {
    if (resourceId && rid !== resourceId) continue;
    const fields = (resource as { fields?: Record<string, unknown> }).fields ?? {};
    for (const field of Object.values(fields)) {
      const paragraphs = (field as { paragraphs?: Record<string, unknown> }).paragraphs ?? {};
      for (const [id, paragraph] of Object.entries(paragraphs)) {
        const p = paragraph as { text?: string; position?: { start?: number; end?: number } };
        out.push({ id, text: p.text, start: p.position?.start, end: p.position?.end });
      }
    }
  }
  return out;
}

/**
 * Check each quote the model returned against the document's own extracted text.
 *
 * This is the whole point of the evidence contract: a model asked for a verbatim quote
 * will sometimes paraphrase, and a paraphrase is not proof. Three outcomes:
 *
 *   exact       the quote appears character-for-character (offsets recorded)
 *   normalised  it appears once case, whitespace and punctuation are normalised
 *   unverified  it does not appear at all — treat the field as ungrounded
 *
 * Quotes for fields that were not extracted are dropped: evidence for a value the record
 * does not contain would be misleading.
 */
export function verifyEvidence(
  raw: unknown,
  opts: { sourceText: string; fieldKeys: Set<string>; paragraphs?: EvidenceParagraph[] },
): Evidence[] {
  if (!Array.isArray(raw)) return [];
  const normalisedSource = normaliseQuote(opts.sourceText);
  const seen = new Set<string>();
  const out: Evidence[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const field = String(e.field ?? "").trim();
    const quote = String(e.quote ?? "").trim();
    if (!field || !quote || !opts.fieldKeys.has(field)) continue;
    const dedupe = `${field}:${quote}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    let verified: EvidenceVerification = "unverified";
    let start: number | undefined;
    let end: number | undefined;
    const exactAt = opts.sourceText.indexOf(quote);
    if (exactAt !== -1) {
      verified = "exact";
      start = exactAt;
      end = exactAt + quote.length;
    } else if (normalisedSource.includes(normaliseQuote(quote))) {
      verified = "normalised";
    }

    const item: Evidence = { field, quote, verified };
    if (start !== undefined) {
      item.start = start;
      item.end = end;
    }
    const paragraphId = locateParagraph(quote, start, opts.paragraphs ?? []);
    if (paragraphId) item.paragraphId = paragraphId;
    out.push(item);
  }
  return out;
}

/** Find the retrieval paragraph a quote belongs to, by offset first and then by text. */
function locateParagraph(
  quote: string,
  start: number | undefined,
  paragraphs: EvidenceParagraph[],
): string | undefined {
  if (start !== undefined) {
    const byOffset = paragraphs.find(
      (p) => p.start !== undefined && p.end !== undefined && start >= p.start && start < p.end,
    );
    if (byOffset) return byOffset.id;
  }
  const needle = normaliseQuote(quote);
  if (!needle) return undefined;
  return paragraphs.find((p) => p.text && normaliseQuote(p.text).includes(needle))?.id;
}

/**
 * Share of extracted fields backed by a verified quote (0..1), or undefined when there is
 * nothing to score. Only `exact` and `normalised` count — `unverified` is the failure it
 * is meant to expose.
 */
export function groundingScore(fields: ExtractedField[], evidence: Evidence[]): number | undefined {
  if (fields.length === 0) return undefined;
  const grounded = new Set(evidence.filter((e) => e.verified !== "unverified").map((e) => e.field));
  const covered = fields.filter((f) => grounded.has(f.key)).length;
  return Math.round((covered / fields.length) * 100) / 100;
}

/** Normalise the entity agent's structured answer into deduped entities. */
export function entitiesFrom(answer: Record<string, unknown>): Entity[] {
  const raw = Array.isArray(answer.entities) ? answer.entities : [];
  const seen = new Set<string>();
  const entities: Entity[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const text = String((e as Record<string, unknown>).text ?? "").trim();
    const type = String((e as Record<string, unknown>).type ?? "OTHER")
      .trim()
      .toUpperCase();
    if (!text) continue;
    const dedupe = `${type}:${text.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    entities.push({ text, type });
  }
  return entities;
}

/** Keys whose values are monetary amounts (normalised to numbers). */
const AMOUNT_KEYS = new Set([
  "subtotal",
  "tax",
  "total",
  "total_value",
  "amount_claimed",
  "amount_paid",
  "member_liability",
  "opening_balance",
  "closing_balance",
]);

/**
 * Normalise known field types in place and emit validation issues:
 *   - amounts → numbers (schemas capture them as STRINGS; see schemas.ts `money()`)
 *   - *_date / date keys → ISO 8601 (records a note if not parseable)
 *   - currency → ISO code
 *   - required-field presence (from the schema)
 *   - invoice/receipt arithmetic: subtotal + tax ≈ total
 */
export function validateNormalize(
  fields: ExtractedField[],
  schema: ExtractionSchema,
): { fields: ExtractedField[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const out = fields.map((f) => ({ ...f }));
  const byKey = new Map(out.map((f) => [f.key, f]));

  for (const f of out) {
    if (AMOUNT_KEYS.has(f.key) && typeof f.value !== "number") {
      const n = parseAmount(f.value as string);
      if (n !== null) {
        f.raw = String(f.value);
        f.value = n;
      } else {
        issues.push({ field: f.key, severity: "warning", message: `Could not parse amount "${f.value}"` });
      }
    }
    if ((f.key.endsWith("_date") || f.key === "date") && typeof f.value === "string") {
      const iso = parseDateISO(f.value);
      if (iso) {
        if (iso !== f.value) f.raw = f.value;
        f.value = iso;
      } else {
        issues.push({
          field: f.key,
          severity: "info",
          message: `Date "${f.value}" left as-is (not ISO-parseable)`,
        });
      }
    }
    if (f.key === "currency" && typeof f.value === "string") {
      const c = normalizeCurrency(f.value);
      if (c && c !== f.value) {
        f.raw = f.value;
        f.value = c;
      }
    }
  }

  // Required-field presence.
  for (const req of schema.required) {
    if (!byKey.has(req)) {
      issues.push({ field: req, severity: "error", message: `Required field "${req}" was not extracted` });
    }
  }

  // Arithmetic sanity for money documents.
  const sub = numVal(byKey.get("subtotal"));
  const tax = numVal(byKey.get("tax"));
  const total = numVal(byKey.get("total"));
  if (sub !== null && tax !== null && total !== null) {
    if (Math.abs(sub + tax - total) > 0.02 * Math.max(1, total)) {
      issues.push({
        field: "total",
        severity: "warning",
        message: `subtotal (${sub}) + tax (${tax}) ≠ total (${total})`,
      });
    }
  }

  return { fields: out, issues };
}

function numVal(f?: ExtractedField): number | null {
  if (!f) return null;
  return typeof f.value === "number" ? f.value : parseAmount(f.value as string);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Map a JSON object persisted by a Data Augmentation agent into normalised fields.
 * Keys are user-defined (the agent's schema), so labels are derived from the key and
 * values are lightly normalised by key heuristics (amounts → numbers, dates → ISO).
 */
export function fieldsFromObject(source: Record<string, unknown>): ExtractedField[] {
  const out: ExtractedField[] = [];
  for (const [key, raw] of Object.entries(source)) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw === "string" && isSentinel(raw)) continue;
    const label = key
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    let value = raw as ExtractedField["value"];
    let rawStr: string | undefined;
    const lower = key.toLowerCase();
    if (typeof value === "string") {
      if (/(amount|total|subtotal|tax|balance|price|value|due)/.test(lower)) {
        const n = parseAmount(value);
        if (n !== null) {
          rawStr = value;
          value = n;
        }
      } else if (/(date|_at$|dob)/.test(lower)) {
        const iso = parseDateISO(value);
        if (iso && iso !== value) {
          rawStr = value;
          value = iso;
        }
      }
    }
    out.push({ key, label, value, raw: rawStr });
  }
  return out;
}
