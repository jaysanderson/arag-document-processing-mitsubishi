/**
 * Document domain logic: upload → job → canonical record → export / ask / delete.
 * No HTTP types here; routes are thin wrappers over this service.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  type AragClient,
  badRequest,
  type Collection,
  conflict,
  type Job,
  type JobManager,
  type Logger,
  notFound,
  type PlatformEnv,
  payloadTooLarge,
  type Store,
  unsupportedMediaType,
} from "../../vendor/arag-platform/src/index.ts";
import type { DocumentRecord } from "../types.ts";
import type { Agents } from "./agents.ts";
import { paragraphsFromRetrieval, wholeDocument } from "./agents.ts";
import type { ConfigsService } from "./configs.ts";
import { EXTENSION, type Format, MIME, serialize, serializeMany } from "./formats.ts";
import {
  type KvFilterSpec,
  type KvLeafFilter,
  type KvService,
  KvValidationError,
  parseKvFilterParam,
  toKvLeafFilter,
} from "./kv.ts";
import { type ProcessDocumentInput, runPipeline } from "./pipeline.ts";
import { SAMPLES } from "./samples.ts";

/** Upload MIME allowlist. Anything else is rejected with 415 before it reaches the KB. */
export const ALLOWED_MIME: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/tiff": [".tif", ".tiff"],
  "text/plain": [".txt", ".text"],
  "text/markdown": [".md", ".markdown"],
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
};

const EXT_TO_MIME: Record<string, string> = Object.entries(ALLOWED_MIME).reduce<Record<string, string>>(
  (acc, [mime, exts]) => {
    for (const e of exts) acc[e] = mime;
    return acc;
  },
  {},
);

/**
 * Strip directory components, control characters and anything outside a conservative
 * allowlist from a client-supplied filename. The prototype forwarded `X-Filename`
 * straight into `Content-Disposition`; this is the fix.
 */
export function sanitiseFilename(input: string | undefined): string {
  const base = basename(String(input ?? "").replace(/\\/g, "/")).trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^A-Za-z0-9._ -]/g, "_");
  const safe = cleaned.replace(/^[.\s]+/, "").slice(0, 120);
  return safe || "document";
}

/** Resolve the effective content type: the declared one, else guessed from the extension. */
export function resolveContentType(declared: string | undefined, filename: string): string {
  const ct = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct && ct !== "application/octet-stream" && ct in ALLOWED_MIME) return ct;
  const guessed = EXT_TO_MIME[extname(filename).toLowerCase()];
  if (guessed) return guessed;
  return ct || "application/octet-stream";
}

export interface DocumentsDeps {
  arag: AragClient;
  store: Store;
  jobs: JobManager;
  configs: ConfigsService;
  agents: Agents;
  /** Key-value fields: written after extraction, and the KB-side half of list filtering. */
  kv: KvService;
  env: PlatformEnv;
  log: Logger;
  /** ARAG extract strategy id (DIP_EXTRACT_STRATEGY / ARAG_EXTRACT_STRATEGY). */
  extractStrategy: string;
  /** Max upload size in bytes. */
  maxUploadBytes: number;
  /** Generative model recorded on records. */
  generativeModel: string;
  /** Directory the bundled samples are served from (used by `createFromSample`). */
  publicDir: string;
}

export interface Facets {
  total: number;
  status: Record<string, number>;
  docType: Record<string, number>;
  degraded: number;
  needsReview: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  next_page: boolean;
  facets?: Facets;
  filters?: AppliedFilters;
}

/**
 * Which half of a list query was answered by which system.
 *
 * A `kv=` filter is resolved **in the Knowledge Box** — it is the whole point of writing
 * extracted values back as key-value fields — while everything else is a predicate over
 * this service's own store. The two are not interchangeable and a screen should not imply
 * they are, so the page says which filters ran where and how many resources the Knowledge
 * Box matched before the local predicates narrowed it further.
 */
export interface AppliedFilters {
  knowledgeBox: {
    /**
     * Filters that were actually applied. **Empty when the Knowledge Box could not answer** —
     * the page is then the local list, unnarrowed, and a UI that rendered a filter chip from
     * `requested` would be claiming a narrowing that never happened.
     */
    applied: KvFilterSpec[];
    /** What the caller asked for, applied or not. */
    requested: KvFilterSpec[];
    /** Resources the Knowledge Box matched, before local filters and paging. */
    matchedResources: number;
    /**
     * Present when kv filters were asked for but could not be resolved against the
     * Knowledge Box. The list is then unfiltered by them rather than silently empty.
     */
    error?: string;
  };
  /** Names of the parameters applied against this service's own store. */
  local: string[];
}

/** Sort keys accepted by `GET /api/v1/documents?sort=` (the spec's enum). */
export type SortKey = "created_at" | "filename" | "doc_type" | "status" | "fields" | "grounding";

export interface ListOptions {
  page: number;
  pageSize: number;
  status?: string;
  /** One or several document types (`?doc_type=invoice&doc_type=receipt`). */
  docTypes?: string[];
  /** Free-text over filename, summary, tags and extracted field labels/values. */
  q?: string;
  sort?: SortKey;
  order?: "asc" | "desc";
  dateFrom?: string;
  dateTo?: string;
  config?: string;
  degraded?: boolean;
  hasIssues?: boolean;
  minGrounding?: number;
  /** Restrict to these resource ids (how a Knowledge-Box-side kv filter is intersected in). */
  resourceIds?: Set<string>;
}

/**
 * Everything a user might reasonably type into the search box, lower-cased into one
 * string: the filename they uploaded under, the summary, the tags, and the extracted
 * labels and values. Searching a document by the supplier printed on it — rather than by
 * the filename a scanner happened to give it — is the whole point of the box.
 */
function searchBlob(d: DocumentRecord): string {
  const parts: string[] = [d.filename, d.docType, d.summary ?? "", ...d.tags];
  for (const f of d.fields) {
    parts.push(f.label, f.key);
    parts.push(Array.isArray(f.value) ? f.value.join(" ") : String(f.value ?? ""));
  }
  // Newline, not a space: a separator keeps "Acme" + "Widgets" in adjacent fields from
  // matching a search for "acmewidgets", and a newline can never appear in a typed query.
  // (It was a literal NUL, which made git treat this whole file as binary and show `Bin …`
  // instead of a diff for every commit that touched it.)
  return parts.join("\n").toLowerCase();
}

/**
 * Accept both a full ISO instant and a bare `YYYY-MM-DD`. A bare date means the whole
 * day in both directions, so `date_from=2026-09-12&date_to=2026-09-12` returns that day's
 * documents rather than nothing at all.
 */
function parseBoundary(value: string | undefined, edge: "start" | "end"): number | null {
  if (!value) return null;
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ts = Date.parse(bare ? `${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z` : value);
  return Number.isNaN(ts) ? null : ts;
}

/** Which list parameters were actually supplied, so the page can label them as local. */
function localFilterNames(opts: ListOptions): string[] {
  const names: Array<[string, unknown]> = [
    ["status", opts.status],
    ["doc_type", opts.docTypes?.length ? opts.docTypes : undefined],
    ["q", opts.q?.trim() || undefined],
    ["date_from", opts.dateFrom],
    ["date_to", opts.dateTo],
    ["config", opts.config],
    ["degraded", opts.degraded],
    ["has_issues", opts.hasIssues],
    ["min_grounding", opts.minGrounding],
  ];
  return names.filter(([, v]) => v !== undefined && v !== "").map(([n]) => n);
}

function compareBy(key: SortKey, a: DocumentRecord, b: DocumentRecord): number {
  switch (key) {
    case "filename":
      return a.filename.localeCompare(b.filename);
    case "doc_type":
      return a.docType.localeCompare(b.docType) || a.createdAt.localeCompare(b.createdAt);
    case "status":
      return a.status.localeCompare(b.status) || a.createdAt.localeCompare(b.createdAt);
    case "fields":
      return a.fields.length - b.fields.length;
    case "grounding":
      // Records with no grounding score sort below every scored record in either
      // direction's "worst" end rather than jumping to the top of a descending sort.
      return (a.meta.groundingScore ?? -1) - (b.meta.groundingScore ?? -1);
    default:
      return a.createdAt.localeCompare(b.createdAt);
  }
}

/** Extracted text is immutable for a processed resource; a short cache is plenty. */
const TEXT_TTL_MS = 5 * 60_000;

export class DocumentsService {
  private readonly d: DocumentsDeps;
  private readonly col: Collection<DocumentRecord>;
  private readonly textCache = new Map<string, { at: number; text: string }>();

  constructor(deps: DocumentsDeps) {
    this.d = deps;
    this.col = deps.store.collection<DocumentRecord>("documents");
    deps.jobs.register<ProcessDocumentInput, { documentId: string; fields: number }>(
      "process-document",
      async (ctx) => {
        const stored = this.col.get(ctx.job.input.documentId);
        if (!stored) throw new Error(`document ${ctx.job.input.documentId} not found`);
        // Replace rather than mutate: the object returned by `create()` may still be being
        // serialised into the 202 response, and must keep reporting status "pending".
        const record = this.col.put({ ...stored, status: "processing" });
        try {
          const done = await runPipeline(record, ctx.job.input, ctx, {
            arag: deps.arag,
            agents: deps.agents,
            configs: deps.configs,
            kv: deps.kv,
            log: deps.log,
          });
          this.col.put(done);
          return { documentId: done.id, fields: done.fields.length };
        } catch (err) {
          this.col.put({ ...record, status: "failed", error: (err as Error).message });
          throw err;
        }
      },
    );
  }

  /**
   * Upload bytes into the Knowledge Box and queue the processing job.
   * Throws HttpErrors (415/413/400) for invalid input before anything reaches ARAG.
   */
  async create(input: {
    bytes: Buffer;
    filename: string | undefined;
    contentType: string | undefined;
    config?: string;
  }): Promise<{ document: DocumentRecord; job: Job }> {
    const filename = sanitiseFilename(input.filename);
    const contentType = resolveContentType(input.contentType, filename);
    if (!input.bytes || input.bytes.length === 0) throw badRequest("Empty upload body");
    if (input.bytes.length > this.d.maxUploadBytes) throw payloadTooLarge(this.d.maxUploadBytes);
    if (!(contentType in ALLOWED_MIME)) {
      throw unsupportedMediaType(
        `Content type "${contentType}" is not accepted. Allowed: ${Object.keys(ALLOWED_MIME).join(", ")}`,
      );
    }
    const config = (input.config ?? "auto").trim() || "auto";
    if (config !== "auto" && config !== "agent" && !this.d.configs.resolve(config)) {
      throw badRequest(`Unknown extraction config "${config}"`);
    }

    // Images and PDFs get the ingestion-time visual-LLM extract strategy when one is
    // configured; text/office files use ARAG's default processing.
    const useStrategy =
      !!this.d.extractStrategy && (contentType.startsWith("image/") || contentType === "application/pdf");
    const uploaded = await this.d.arag.upload(input.bytes, filename, contentType, {
      extractStrategy: useStrategy ? this.d.extractStrategy : undefined,
    });
    const uuid = uploaded.uuid;

    // Allocate the job id up front so the stored record references its job from the
    // first write (the job may start on the next microtask).
    const jobId = randomUUID();
    const record = this.col.put({
      id: uuid,
      resourceId: uuid,
      jobId,
      filename,
      contentType,
      bytes: input.bytes.length,
      status: "pending",
      docType: "generic",
      fields: [],
      entities: [],
      tags: [],
      issues: [],
      evidence: [],
      meta: {
        processedAt: new Date().toISOString(),
        schema: "generic_extraction",
        model: this.d.generativeModel || "KB default",
        durationsMs: {},
        extractStrategy: useStrategy ? this.d.extractStrategy : undefined,
        fileField: uploaded.field_id || "file",
      },
    });
    const jobInput: ProcessDocumentInput = {
      documentId: record.id,
      resourceId: uuid,
      filename,
      contentType,
      config,
    };
    const job = this.d.jobs.submit("process-document", jobInput, { ref: record.id, id: jobId });
    this.d.log.info("document.created", {
      documentId: record.id,
      jobId,
      contentType,
      bytes: input.bytes.length,
      config,
    });
    return { document: record, job: job as Job };
  }

  list(opts: ListOptions): Page<DocumentRecord> {
    const q = opts.q?.trim().toLowerCase();
    const from = parseBoundary(opts.dateFrom, "start");
    const to = parseBoundary(opts.dateTo, "end");
    const filter = (d: DocumentRecord) => {
      if (opts.resourceIds && !opts.resourceIds.has(d.resourceId)) return false;
      if (opts.status && d.status !== opts.status) return false;
      if (opts.docTypes?.length && !opts.docTypes.includes(d.docType)) return false;
      if (opts.config && d.meta.config !== opts.config) return false;
      if (opts.degraded !== undefined && (d.meta.stageErrors ?? []).length > 0 !== opts.degraded)
        return false;
      if (opts.hasIssues !== undefined && d.issues.length > 0 !== opts.hasIssues) return false;
      if (opts.minGrounding !== undefined && (d.meta.groundingScore ?? -1) < opts.minGrounding) return false;
      if (from !== null && Date.parse(d.createdAt) < from) return false;
      if (to !== null && Date.parse(d.createdAt) > to) return false;
      if (q && !searchBlob(d).includes(q)) return false;
      return true;
    };
    const dir = opts.order === "asc" ? 1 : -1;
    const sort = (a: DocumentRecord, b: DocumentRecord) => dir * compareBy(opts.sort ?? "created_at", a, b);
    const total = this.col.list({ filter }).length;
    const items = this.col.list({
      filter,
      sort,
      offset: (opts.page - 1) * opts.pageSize,
      limit: opts.pageSize,
    });
    return {
      items,
      page: opts.page,
      page_size: opts.pageSize,
      total,
      next_page: opts.page * opts.pageSize < total,
      // Counts across the whole collection, not the page: a filter chip that says how many
      // documents it would show has to count the ones the current filter is hiding.
      facets: this.facets(),
    };
  }

  /**
   * Validate `kv=` parameters against the schemas this product provisions, returning the
   * leaf filters to send to the Knowledge Box.
   *
   * Every rejection is a `KvValidationError` naming the field and what it does accept, so
   * the route can answer 400 with a sentence instead of letting ARAG answer 412 with an
   * opaque body. Kept here rather than in the route because "which schemas exist and what
   * types are their fields" is domain knowledge, not HTTP.
   */
  parseKvFilters(raw: string[]): { specs: KvFilterSpec[]; leaves: KvLeafFilter[] } {
    const specs: KvFilterSpec[] = [];
    const leaves: KvLeafFilter[] = [];
    for (const entry of raw) {
      const spec = parseKvFilterParam(entry);
      const mapping = this.d.configs.kvSchemaById(spec.schemaId);
      if (!mapping) {
        const known = this.d.configs.kvSchemaIds();
        throw new KvValidationError(
          `unknown key-value schema "${spec.schemaId}". This workspace provisions: ${known.join(", ")}`,
          "unknown_key",
          { schemaId: spec.schemaId },
        );
      }
      // Callers filter by the product's own property names where they differ from the kv
      // key (they differ only for names containing `/` or `.`), so resolve either spelling.
      const key = mapping.fieldIds[spec.key] ?? spec.key;
      specs.push(spec);
      leaves.push(toKvLeafFilter({ ...spec, key }, mapping.schema));
    }
    return { specs, leaves };
  }

  /**
   * The documents list, with the key-value half of the query resolved in the Knowledge Box.
   *
   * kv filter expressions work on `/find` and `/ask` and are rejected by `/catalog`, so the
   * Knowledge-Box-side pass is a `/find` with an empty query: the filter expression selects,
   * and the matching resource ids are intersected with this service's own list. Local
   * predicates (status, free text, dates, grounding) are then applied to that intersection.
   *
   * A Knowledge Box that cannot answer degrades to the local list with the reason reported
   * on `filters.knowledgeBox.error`, rather than serving an empty page that looks like
   * "nothing matched".
   */
  async listWithKv(
    opts: ListOptions & { kv?: string[] },
    signal?: AbortSignal,
  ): Promise<Page<DocumentRecord>> {
    const raw = opts.kv ?? [];
    const local = localFilterNames(opts);
    if (raw.length === 0) {
      return {
        ...this.list(opts),
        filters: { knowledgeBox: { applied: [], requested: [], matchedResources: 0 }, local },
      };
    }
    // Throws `KvValidationError` for a bad operator or value — the route turns it into a 400.
    const { specs, leaves } = this.parseKvFilters(raw);
    let resourceIds: Set<string> | undefined;
    let error: string | undefined;
    let matchedResources = 0;
    try {
      const ids = await this.d.kv.findResourceIdsByKv(leaves, { signal });
      resourceIds = new Set(ids);
      matchedResources = ids.length;
    } catch (err) {
      error = (err as Error).message;
      this.d.log.warn("documents.kvFilter.fail", { message: error, filters: raw.length });
    }
    const page = this.list({ ...opts, resourceIds });
    return {
      ...page,
      filters: {
        knowledgeBox: {
          // Nothing was applied if the Knowledge Box could not answer: `resourceIds` is
          // undefined and the page is the unnarrowed local list.
          applied: error ? [] : specs,
          requested: specs,
          matchedResources,
          ...(error ? { error } : {}),
        },
        local,
      },
    };
  }

  /**
   * Collection-wide counts for the filter bar and the overview strip. `needsReview` is the
   * product's one composite signal — a record with a warning or error issue, or with a
   * grounding score below half — because "what do I have to look at today?" is the question
   * the list exists to answer.
   */
  facets(): Facets {
    const all = this.col.list();
    const status: Record<string, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
    const docType: Record<string, number> = {};
    let degraded = 0;
    let needsReview = 0;
    for (const d of all) {
      status[d.status] = (status[d.status] ?? 0) + 1;
      docType[d.docType] = (docType[d.docType] ?? 0) + 1;
      if ((d.meta.stageErrors ?? []).length) degraded++;
      const risky =
        d.issues.some((i) => i.severity !== "info") ||
        (typeof d.meta.groundingScore === "number" && d.meta.groundingScore < 0.5);
      if (risky) needsReview++;
    }
    return { total: all.length, status, docType, degraded, needsReview };
  }

  /**
   * The document's own extracted text, fetched from the Knowledge Box on demand and cached
   * briefly. It is not persisted on the record: a 200 kB page of text per document would
   * multiply the JSON store for something only the source view reads.
   */
  async text(id: string, maxChars = 200_000): Promise<{ text: string; chars: number; truncated: boolean }> {
    const rec = this.require(id);
    const hit = this.textCache.get(id);
    const full =
      hit && Date.now() - hit.at < TEXT_TTL_MS
        ? hit.text
        : await this.d.arag.extractedText(rec.resourceId).catch((err) => {
            this.d.log.warn("document.text.fail", { id, message: (err as Error).message });
            return "";
          });
    this.textCache.set(id, { at: Date.now(), text: full });
    return { text: full.slice(0, maxChars), chars: full.length, truncated: full.length > maxChars };
  }

  /** The original uploaded bytes, straight from the ARAG resource's file field. */
  async source(id: string): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const rec = this.require(id);
    const field = rec.meta.fileField ?? "file";
    let res: Response;
    try {
      res = await this.d.arag.downloadFileField(rec.resourceId, field);
    } catch (err) {
      throw notFound(
        `The original file for this document is no longer available (${(err as Error).message})`,
      );
    }
    if (!res.ok) throw notFound("The original file for this document is no longer available");
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || rec.contentType,
      filename: rec.filename,
    };
  }

  get(id: string): DocumentRecord | undefined {
    return this.col.get(id);
  }

  /** The record or a 404 problem. */
  require(id: string): DocumentRecord {
    const rec = this.col.get(id);
    if (!rec) throw notFound("Document");
    return rec;
  }

  /**
   * Persist a whole record the caller has already derived from a stored one — the shape
   * human review needs, where a correction rewrites fields, evidence and the grounding
   * score together and a field-by-field patch would let the three drift apart.
   */
  replace(record: DocumentRecord): DocumentRecord {
    return this.col.put(record);
  }

  /** Serialised export plus the headers a download needs. */
  export(id: string, format: Format): { body: string; contentType: string; filename: string } {
    const rec = this.require(id);
    const base = sanitiseFilename(rec.filename).replace(/\.[^.]+$/, "") || "document";
    return {
      body: serialize(rec, format),
      contentType: MIME[format],
      filename: `${base}.${EXTENSION[format]}`,
    };
  }

  /**
   * Upload one of the bundled samples. The guided path would otherwise be a fetch in the
   * browser followed by an upload; one call is both fewer moving parts and something a
   * contract test can exercise.
   */
  async createFromSample(sampleId: string, config?: string): Promise<{ document: DocumentRecord; job: Job }> {
    const sample = SAMPLES.find((s) => s.id === sampleId);
    if (!sample) throw badRequest(`Unknown sample "${sampleId}"`);
    // `sample.url` is a constant from the catalogue, never client input, but resolve and
    // check anyway so the catalogue can never be edited into a path traversal.
    const file = resolve(this.d.publicDir, sample.url.replace(/^\//, ""));
    if (!file.startsWith(resolve(this.d.publicDir))) throw badRequest("Invalid sample path");
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      throw notFound(`Sample "${sampleId}" is not installed in this deployment`);
    }
    return this.create({
      bytes,
      filename: sample.filename,
      contentType: sample.contentType,
      config: config ?? "auto",
    });
  }

  /**
   * Re-run the pipeline over a resource that is already in the Knowledge Box. This is the
   * recovery action a failed or degraded record needs: the bytes were accepted, so asking
   * the user to find and upload the file again would be busywork. The record is reset to
   * `pending` (keeping id, resource and filename) and a fresh job is queued.
   */
  reprocess(id: string, config?: string): { document: DocumentRecord; job: Job } {
    const rec = this.require(id);
    if (rec.status === "pending" || rec.status === "processing") {
      throw conflict(`Document ${id} is already ${rec.status}`);
    }
    const chosen = (config ?? rec.meta.config ?? "auto").trim() || "auto";
    if (chosen !== "auto" && chosen !== "agent" && !this.d.configs.resolve(chosen)) {
      throw badRequest(`Unknown extraction config "${chosen}"`);
    }
    const jobId = randomUUID();
    const reset = this.col.put({
      ...rec,
      jobId,
      status: "pending",
      docType: "generic",
      docTypeConfidence: undefined,
      fields: [],
      entities: [],
      tags: [],
      issues: [],
      evidence: [],
      summary: undefined,
      error: undefined,
      meta: {
        ...rec.meta,
        processedAt: new Date().toISOString(),
        durationsMs: {},
        groundingScore: undefined,
        stageErrors: undefined,
        // No field of the new extraction is corrected yet. `corrections` itself is kept:
        // it is the record's review history, and history is not undone by a re-run.
        correctedFields: undefined,
        // `meta.kv` is deliberately NOT cleared. The Knowledge Box filter index still holds
        // every value the previous run wrote, so the re-run's write is a second write and
        // has to be reported as one — clearing this would hide the overwrite trap.
      },
    });
    const job = this.d.jobs.submit(
      "process-document",
      {
        documentId: reset.id,
        resourceId: reset.resourceId,
        filename: reset.filename,
        contentType: reset.contentType,
        config: chosen,
      },
      { ref: reset.id, id: jobId },
    );
    this.d.log.info("document.reprocess", { documentId: reset.id, jobId, config: chosen });
    return { document: reset, job: job as Job };
  }

  /**
   * Delete several documents. Best-effort per id: a selection of twenty must not be
   * abandoned because one of them was already deleted in another tab.
   */
  async bulkDelete(
    ids: string[],
  ): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }> {
    const deleted: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        if (await this.delete(id)) deleted.push(id);
        else failed.push({ id, error: "Not found" });
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }
    this.d.log.info("document.bulkDelete", { requested: ids.length, deleted: deleted.length });
    return { deleted, failed };
  }

  /** One file containing several records. Unknown ids are skipped and reported. */
  bulkExport(
    ids: string[],
    format: Format,
  ): { body: string; contentType: string; filename: string; skipped: string[] } {
    const recs: DocumentRecord[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const rec = this.col.get(id);
      if (rec) recs.push(rec);
      else skipped.push(id);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      body: serializeMany(recs, format),
      contentType: MIME[format],
      filename: `documents-${stamp}.${EXTENSION[format]}`,
      skipped,
    };
  }

  /**
   * Counters for the documents overview strip: status mix, type mix, grounding and the
   * total work the workspace has actually produced. Credential-free by design — a list
   * screen should be able to poll it while a pipeline runs.
   */
  overview(): {
    documents: Record<string, number>;
    byDocType: Record<string, number>;
    groundingScore: number | null;
    fields: number;
    issues: number;
    lastProcessedAt: string | null;
  } {
    const all = this.col.list();
    const byDocType: Record<string, number> = {};
    let fields = 0;
    let issues = 0;
    let lastProcessedAt: string | null = null;
    for (const d of all) {
      byDocType[d.docType] = (byDocType[d.docType] ?? 0) + 1;
      fields += d.fields.length;
      issues += d.issues.length;
      if (d.status === "ready" && (!lastProcessedAt || d.updatedAt > lastProcessedAt)) {
        lastProcessedAt = d.updatedAt;
      }
    }
    return {
      documents: this.stats(),
      byDocType,
      groundingScore: this.averageGroundingScore(),
      fields,
      issues,
      lastProcessedAt,
    };
  }

  /** Documents per extraction-config id, for the configs table's "is anything using this?". */
  countsByConfig(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this.col.list()) {
      const key = d.meta.config;
      if (key) out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  /** Grounded Q&A scoped to one document. */
  async ask(
    id: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<{
    answer: string;
    sources: string[];
    citations: Array<{ paragraphId: string; text: string; start?: number; end?: number }>;
    ms: number;
  }> {
    const rec = this.require(id);
    const res = await this.d.arag.ask(
      {
        query: question,
        citations: true,
        // `/ask` + resource_filters, never `/resource/{id}/ask`: the per-resource endpoint
        // rejects `full_resource` upstream (HTTP 500/503). See services/agents.ts — and
        // `wholeDocument` there for why a finished record names its own file field.
        resource_filters: [rec.resourceId],
        rag_strategies: wholeDocument(rec.meta.fileField),
        prompt: {
          system:
            "Answer using only the provided document content. If the answer is not in the document, say you don't have that information.",
        },
        temperature: 0,
        max_tokens: 400,
        generative_model: this.d.generativeModel || undefined,
        reranker: this.d.env.arag.reranker,
      },
      { signal },
    );
    // `sources` is a list of titles, and with one resource in the filter that is always the
    // same single title — not something a reader can open. The retrieval paragraphs behind
    // the answer are, so they are returned alongside: one idea of "show me where", used for
    // an answer exactly as it is for a field.
    const paragraphs = paragraphsFromRetrieval(res.retrieval, rec.resourceId);
    const cited = new Set(Object.keys(res.citations ?? {}));
    const chosen = paragraphs.filter((p) => cited.size === 0 || cited.has(p.id));
    return {
      answer: res.answerText,
      sources: res.sourceTitles,
      citations: chosen.slice(0, 8).map((p) => ({
        paragraphId: p.id,
        text: (p.text ?? "").slice(0, 600),
        start: p.start,
        end: p.end,
      })),
      ms: res.timings.totalMs,
    };
  }

  /** Delete the record and the backing KB resource. */
  async delete(id: string): Promise<boolean> {
    const rec = this.col.get(id);
    if (!rec) return false;
    await this.d.arag
      .deleteResource(rec.resourceId)
      .catch((err) => this.d.log.warn("document.delete.arag", { id, message: (err as Error).message }));
    return this.col.delete(id);
  }

  /** Delete every document older than `olderThanDays` from the store and the KB. */
  async purge(
    olderThanDays: number,
    dryRun = false,
  ): Promise<{
    deleted: string[];
    failed: Array<{ id: string; error: string }>;
    wouldDelete: number;
    oldest: string | null;
    newest: string | null;
    ids: string[];
  }> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const stale = this.col.list({ filter: (d) => Date.parse(d.createdAt) < cutoff });
    const dates = stale.map((d) => d.createdAt).sort();
    const preview = {
      wouldDelete: stale.length,
      oldest: dates[0] ?? null,
      newest: dates[dates.length - 1] ?? null,
      ids: stale.map((d) => d.id),
    };
    // A confirmation that cannot state the consequence is theatre: the dry run reports the
    // exact blast radius and touches nothing.
    if (dryRun) return { deleted: [], failed: [], ...preview };
    const deleted: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const doc of stale) {
      try {
        await this.d.arag.deleteResource(doc.resourceId);
        this.col.delete(doc.id);
        deleted.push(doc.id);
      } catch (err) {
        failed.push({ id: doc.id, error: (err as Error).message });
      }
    }
    this.d.log.info("document.purge", { olderThanDays, deleted: deleted.length, failed: failed.length });
    return { deleted, failed, ...preview };
  }

  /**
   * Counts for the admin usage endpoint. `degraded` counts records that finished but lost
   * a stage on the way — otherwise "ARAG was down for an hour" is invisible in a list of
   * documents that all say `ready`.
   */
  stats(): Record<string, number> {
    const all = this.col.list();
    const byStatus: Record<string, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
    let degraded = 0;
    for (const d of all) {
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      if (d.meta.stageErrors?.length) degraded++;
    }
    return { total: all.length, ...byStatus, degraded };
  }

  /**
   * Mean grounding score across records that have one, or null when none do. Answers
   * "how much of what this service extracted today is backed by the document?" in a
   * single number an operator can watch.
   */
  averageGroundingScore(): number | null {
    const scores = this.col
      .list()
      .map((d) => d.meta.groundingScore)
      .filter((s): s is number => typeof s === "number");
    if (scores.length === 0) return null;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.round(mean * 100) / 100;
  }
}
