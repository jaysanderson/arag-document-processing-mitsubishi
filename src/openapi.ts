/**
 * OpenAPI 3.1 document for Document Processing — the single source of truth for the
 * public API. Authored before the routes (STANDARDS §2): every `/api/v1` route is
 * validated with `operationSchemas(openapi, …)` and the contract tests fail the build
 * if a route is missing from this document or a response drifts from its schema.
 */
import {
  BrandingSchema,
  buildOpenApi,
  jsonBody,
  jsonResponse,
  pageSchema,
  standardResponses,
} from "../vendor/arag-platform/src/index.ts";

import { DOC_TYPE_VALUES } from "./types.ts";

export const VERSION = "1.0.0";

/** The spec's document-type enums come from the code, so the two cannot drift. */
const DOC_TYPES = DOC_TYPE_VALUES;

const ExtractedField = {
  type: "object",
  required: ["key", "label", "value"],
  properties: {
    key: { type: "string", description: "Stable machine key, e.g. invoice_number" },
    label: { type: "string", description: "Human label" },
    value: {
      description: "Normalised value (string, number, boolean, null, or an array of those)",
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: {} },
      ],
    },
    raw: { type: "string", description: "Value exactly as the model returned it, before normalisation" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    page: { type: "integer", minimum: 0 },
  },
};

const Entity = {
  type: "object",
  required: ["text", "type"],
  properties: {
    text: { type: "string" },
    type: {
      type: "string",
      description: "PERSON | ORG | DATE | MONEY | LOCATION | EMAIL | PHONE | ID | OTHER",
    },
    salience: { type: "number" },
  },
};

const Evidence = {
  type: "object",
  description:
    "A verbatim quote from the document supporting one extracted field, checked against " +
    "the document's own extracted text rather than taken on trust.",
  required: ["field", "quote", "verified"],
  properties: {
    field: { type: "string", description: "The `ExtractedField.key` this quote supports" },
    quote: { type: "string", description: "The quote exactly as the model returned it" },
    verified: {
      type: "string",
      enum: ["exact", "normalised", "unverified"],
      description:
        "`exact`: the quote appears character-for-character in the document. `normalised`: " +
        "it appears once case, whitespace and punctuation are normalised. `unverified`: it " +
        "does not appear — treat the field as ungrounded.",
    },
    paragraphId: {
      type: "string",
      description: "ARAG retrieval paragraph containing the quote (`<rid>/<type>/<field>/<start>-<end>`)",
    },
    start: { type: "integer", description: "Offset into the extracted text (exact matches only)" },
    end: { type: "integer" },
  },
};

const ValidationIssue = {
  type: "object",
  required: ["field", "severity", "message"],
  properties: {
    field: { type: "string" },
    severity: { type: "string", enum: ["info", "warning", "error"] },
    message: { type: "string" },
  },
};

const Document = {
  type: "object",
  description: "Canonical, format-agnostic record for one document.",
  required: [
    "id",
    "resourceId",
    "filename",
    "contentType",
    "bytes",
    "status",
    "docType",
    "fields",
    "entities",
    "tags",
    "issues",
    "evidence",
    "meta",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", description: "Document id (equal to the ARAG resource id)" },
    resourceId: { type: "string", description: "ARAG resource id" },
    filename: { type: "string" },
    contentType: { type: "string" },
    bytes: { type: "integer" },
    status: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
    jobId: { type: "string" },
    docType: { type: "string", enum: [...DOC_TYPES] },
    docTypeConfidence: { type: "number", minimum: 0, maximum: 1 },
    fields: { type: "array", items: { $ref: "#/components/schemas/ExtractedField" } },
    entities: { type: "array", items: { $ref: "#/components/schemas/Entity" } },
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { $ref: "#/components/schemas/ValidationIssue" } },
    evidence: { type: "array", items: { $ref: "#/components/schemas/Evidence" } },
    corrections: {
      type: "array",
      description:
        "Human corrections to extracted fields, oldest first. Never discarded — a correction " +
        "is recorded alongside the model's original value, not in place of it.",
      items: { $ref: "#/components/schemas/FieldCorrection" },
    },
    error: { type: "string" },
    meta: {
      type: "object",
      required: ["processedAt", "schema", "model", "durationsMs"],
      properties: {
        processedAt: { type: "string", format: "date-time" },
        schema: { type: "string" },
        model: { type: "string" },
        sourceChars: { type: "integer" },
        durationsMs: { type: "object", additionalProperties: { type: "number" } },
        config: {
          type: "string",
          description:
            "**Id** of the extraction configuration used — a document type for a built-in " +
            "(`purchase_order`) or a `cfg_…` id for a custom one. It is the same value " +
            "`GET /api/v1/documents?config=` filters on and the per-config document counts " +
            "are keyed by, so it resolves; `configLabel` carries the human wording.",
        },
        configLabel: {
          type: "string",
          description: 'Human label for display — "purchase order", "Insurance Card".',
        },
        forced: { type: "boolean" },
        searchConfiguration: { type: "string" },
        extractStrategy: { type: "string" },
        groundingScore: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Share of extracted fields backed by a verified quote. Absent when nothing was " +
            "extracted. The headline signal for whether this record can be trusted unreviewed.",
        },
        stageErrors: {
          type: "array",
          items: { type: "string" },
          description:
            'Stages that failed during the run ("<stage>: <message>"). Present only when a stage ' +
            "failed: the pipeline degrades gracefully, so a `ready` record can still be missing the " +
            "output of a stage that errored. The same failures also appear in `issues`.",
        },
        correctedFields: {
          type: "integer",
          description:
            "Fields a reviewer has corrected. A corrected field is NOT excluded from " +
            "`groundingScore`: it stays in the denominator and counts in the numerator only " +
            "when the corrected value is itself verified against the document, so editing a " +
            "field never moves the headline number. This count is what lets a record view say " +
            "“12 of 12 fields carry a verified quote · 1 corrected by a reviewer”.",
        },
        kv: { $ref: "#/components/schemas/KvWriteRecord" },
      },
      additionalProperties: true,
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const DocumentAccepted = {
  type: "object",
  required: ["document", "job"],
  properties: {
    document: { $ref: "#/components/schemas/Document" },
    job: { $ref: "#/components/schemas/Job" },
  },
};

const AskRequest = {
  type: "object",
  required: ["question"],
  properties: { question: { type: "string", minLength: 1, maxLength: 1200 } },
  additionalProperties: false,
};

const AskResponse = {
  type: "object",
  required: ["answer", "sources", "ms"],
  properties: {
    answer: { type: "string" },
    sources: { type: "array", items: { type: "string" }, description: "Titles of the resources retrieved" },
    citations: {
      type: "array",
      description:
        "The retrieval paragraphs behind the answer, so a caller can show where it came from " +
        "rather than only which file it came from. Empty when retrieval returned nothing.",
      items: {
        type: "object",
        required: ["paragraphId", "text"],
        properties: {
          paragraphId: { type: "string" },
          text: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
        },
      },
    },
    ms: { type: "integer" },
  },
};

/**
 * The key-value override is the same three properties wherever a field is described, so it
 * is declared once. A money field is captured as a `string` (the original formatting is
 * worth keeping) but has to be a `float` in the Knowledge Box or "every invoice over $10k"
 * cannot be a filter — that mismatch is what these exist for.
 */
const kvFieldOverride = {
  kvType: {
    type: "string",
    enum: ["text", "integer", "float", "boolean", "date"],
    description:
      "Knowledge Box type for this field's key-value projection, overriding the type derived " +
      "from `type`. Use it when the value is captured as text but should be filtered as a " +
      "number or a date — an invoice total, an issue date. Validated on provisioning.",
  },
  kvRepeated: {
    type: "boolean",
    description: "Store a list of values. ARAG accepts `repeated` on `text` only.",
  },
  kvRange: {
    type: "boolean",
    description:
      "Store an interval (`{lower, upper}`) rather than a point. ARAG accepts `range` on " +
      "integer, float and date only.",
  },
};

const ConfigField = {
  type: "object",
  required: ["key", "label", "type"],
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    type: { type: "string", enum: ["string", "number", "array"] },
    description: { type: "string" },
    required: { type: "boolean" },
    ...kvFieldOverride,
  },
};

const ExtractionConfig = {
  type: "object",
  required: ["id", "name", "docType", "description", "builtin", "aragConfig", "fields"],
  properties: {
    id: { type: "string", description: "Use as the `config` parameter on upload" },
    name: { type: "string" },
    docType: { type: "string" },
    description: { type: "string" },
    builtin: { type: "boolean", description: "Built-in configs cannot be deleted" },
    aragConfig: {
      type: "string",
      description: "Stored ARAG search configuration (kind: ask) backing this config",
    },
    provisioned: {
      type: "boolean",
      description: "Whether the stored ARAG search configuration is in place (see `provisioning`)",
    },
    kvSchemaId: {
      type: "string",
      description:
        "Key-value schema this configuration's extracted records are written into, and the " +
        "`schemaId` half of a `kv=` filter on `GET /api/v1/documents`",
    },
    kvFields: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Property name → key-value field key. They differ only where a property name " +
        "contains `/` or `.`, which ARAG's `^[^/.]{1,64}$` forbids.",
    },
    provisioning: { $ref: "#/components/schemas/ConfigProvisioning" },
    documentCount: {
      type: "integer",
      description: "Documents in this workspace extracted with this configuration",
    },
    fields: { type: "array", items: { $ref: "#/components/schemas/ConfigField" } },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const ExtractionConfigCreate = {
  type: "object",
  required: ["name", "fields"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", maxLength: 400 },
    fields: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        required: ["label"],
        properties: {
          key: { type: "string", maxLength: 60 },
          label: { type: "string", minLength: 1, maxLength: 80 },
          type: { type: "string", enum: ["string", "number", "array"] },
          description: { type: "string", maxLength: 300 },
          required: { type: "boolean" },
          ...kvFieldOverride,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const Schema = {
  type: "object",
  required: ["name", "docType", "description", "fields", "required"],
  properties: {
    name: { type: "string" },
    docType: { type: "string", enum: [...DOC_TYPES] },
    description: { type: "string" },
    required: { type: "array", items: { type: "string" } },
    fields: { type: "array", items: { $ref: "#/components/schemas/ConfigField" } },
  },
};

const ProvisionResult = {
  type: "object",
  description:
    "Provisioning one configuration. `ok` is the stored ARAG search configuration; " +
    "`keyValueSchema` is the key-value schema provisioned alongside it — the two are " +
    "provisioned together, and either can fail without the other.",
  required: ["schema", "aragConfig", "ok"],
  properties: {
    schema: { type: "string" },
    aragConfig: { type: "string" },
    ok: { type: "boolean" },
    error: { type: "string" },
    keyValueSchema: { $ref: "#/components/schemas/ProvisioningStatus" },
  },
};

/** Ids a bulk action applies to. Capped so one request cannot become an unbounded job. */
const BulkIds = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: { type: "string", maxLength: 128 },
};

const BulkDeleteRequest = {
  type: "object",
  required: ["ids"],
  properties: { ids: BulkIds },
  additionalProperties: false,
};

const BulkDeleteResult = {
  type: "object",
  description:
    "Per-id outcome. A bulk delete is best-effort: ids that could not be deleted are " +
    "reported rather than failing the whole request.",
  required: ["deleted", "failed"],
  properties: {
    deleted: { type: "array", items: { type: "string" } },
    failed: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "error"],
        properties: { id: { type: "string" }, error: { type: "string" } },
      },
    },
  },
};

const BulkExportRequest = {
  type: "object",
  required: ["ids"],
  properties: {
    ids: BulkIds,
    format: { type: "string", enum: ["json", "xml", "csv"], default: "json" },
  },
  additionalProperties: false,
};

const Stats = {
  type: "object",
  description: "Workspace counters for the documents overview — no credentials required.",
  required: ["documents", "byDocType", "jobs"],
  properties: {
    documents: {
      type: "object",
      description: "Counts by lifecycle status plus `total` and `degraded`.",
      additionalProperties: { type: "number" },
    },
    byDocType: { type: "object", additionalProperties: { type: "number" } },
    groundingScore: {
      type: ["number", "null"],
      description: "Mean grounding score across stored records; null when none has one.",
    },
    fields: { type: "integer", description: "Total extracted fields across every record" },
    issues: { type: "integer", description: "Total open validation issues across every record" },
    lastProcessedAt: { type: ["string", "null"], format: "date-time" },
    jobs: { type: "object", additionalProperties: { type: "number" } },
  },
};

const Settings = {
  type: "object",
  description:
    "Effective, non-secret runtime settings for the signed-in workspace: what this " +
    "deployment is connected to, how it extracts, and what it accepts. Everything here is " +
    "already visible to a user of the product; secrets stay behind ADMIN_TOKEN.",
  required: ["product", "connection", "extraction", "uploads", "branding"],
  properties: {
    product: {
      type: "object",
      required: ["name", "version"],
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        docsUrl: { type: "string" },
        openapiUrl: { type: "string" },
      },
    },
    connection: {
      type: "object",
      description:
        "Whether this deployment can reach its Knowledge Box, and roughly where it is. The " +
        "Knowledge Box id and its base URL are NOT here: they identify the tenant and its " +
        "region host, which is an operator's business for the same reason the extract-strategy " +
        "id is (DP-40). Both are on `GET /api/v1/admin/settings` behind `ADMIN_TOKEN`.",
      required: ["ok", "mock"],
      properties: {
        ok: { type: "boolean" },
        mock: { type: "boolean", description: "True when running against the in-process mock ARAG" },
        region: { type: "string" },
        resources: { type: ["integer", "null"] },
        ms: { type: ["number", "null"], description: "Round-trip of the last health check" },
        error: { type: "string" },
        checkedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: true,
    },
    extraction: {
      type: "object",
      required: ["visualExtraction", "generativeModel", "stages"],
      properties: {
        visualExtraction: {
          type: "boolean",
          description:
            "Whether an ingestion-time visual-LLM extract strategy is configured. The strategy " +
            "id itself stays behind ADMIN_TOKEN.",
        },
        generativeModel: { type: "string" },
        reranker: { type: ["string", "null"] },
        stages: { type: "array", items: { type: "string" } },
        configs: { type: "integer", description: "Extraction configurations available" },
      },
    },
    uploads: {
      type: "object",
      required: ["maxBytes", "acceptedTypes"],
      properties: {
        maxBytes: { type: "integer" },
        acceptedTypes: { type: "array", items: { type: "string" } },
        acceptedExtensions: { type: "array", items: { type: "string" } },
      },
    },
    branding: { $ref: "#/components/schemas/Branding" },
    security: {
      type: "object",
      properties: {
        apiKeysEnforced: { type: "boolean" },
        adminEnabled: { type: "boolean" },
      },
    },
  },
};

const DocumentText = {
  type: "object",
  description:
    "The document's own extracted text — the exact text every extraction stage read, and " +
    "the text `Evidence.start`/`Evidence.end` are offsets into.",
  required: ["text", "chars", "truncated"],
  properties: {
    text: { type: "string" },
    chars: { type: "integer", description: "Length of the full extracted text, before truncation" },
    truncated: { type: "boolean" },
  },
};

const Facets = {
  type: "object",
  description:
    "Counts across the whole collection (not the current page), for filter chips and the overview strip.",
  required: ["status", "docType", "degraded", "needsReview", "total"],
  properties: {
    total: { type: "integer" },
    status: { type: "object", additionalProperties: { type: "integer" } },
    docType: { type: "object", additionalProperties: { type: "integer" } },
    degraded: { type: "integer" },
    needsReview: {
      type: "integer",
      description: "Records carrying a warning/error issue, or a grounding score below 0.5",
    },
  },
};

const SampleRequest = {
  type: "object",
  required: ["sampleId"],
  properties: {
    sampleId: { type: "string", maxLength: 80 },
    config: { type: "string", maxLength: 80, description: "auto | agent | <extraction config id>" },
  },
  additionalProperties: false,
};

const SecurityPosture = {
  type: "object",
  description: "What is protecting this deployment. Values only — never a key or a token.",
  required: ["apiKeys", "adminTokenSet", "rateLimit", "maxUploadBytes", "writesRequireCredential"],
  properties: {
    apiKeys: {
      type: "object",
      required: ["count", "hints"],
      properties: {
        count: { type: "integer" },
        hints: {
          type: "array",
          items: { type: "string" },
          description: "Last four characters of each configured key, so an operator can tell them apart",
        },
      },
    },
    adminTokenSet: { type: "boolean" },
    sessionTtlSec: { type: "integer" },
    cors: { type: "array", items: { type: "string" } },
    rateLimit: {
      type: "object",
      properties: { rps: { type: "number" }, burst: { type: "number" } },
    },
    maxUploadBytes: { type: "integer" },
    maxBodyBytes: { type: "integer" },
    trustProxy: { type: "string" },
    headers: { type: "object", additionalProperties: { type: "boolean" } },
    writesRequireCredential: { type: "boolean" },
    retention: { type: "object", properties: { defaultOlderThanDays: { type: "integer" } } },
  },
};

const Sample = {
  type: "object",
  description: "A bundled sample document the first-run flow can process in one click.",
  required: ["id", "title", "filename", "contentType", "url"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    filename: { type: "string" },
    contentType: { type: "string" },
    url: { type: "string", description: "Static path to fetch the sample's bytes from" },
    kind: { type: "string", enum: ["text", "image", "pdf"] },
    expectedDocType: { type: "string", enum: [...DOC_TYPES] },
    featured: {
      type: "boolean",
      description: "Shown up front on the welcome screen rather than under “Other samples”",
    },
  },
};

// ─── settings, API keys and audit ─────────────────────────────────────────────
// Everything between this banner and the next one is the operator surface added by the
// full-implementation pass: editable settings (env is a default, the store overrides it),
// a real API-key store, and the audited-change log. Kept together so it merges cleanly
// alongside the key-value-field and API-explorer work landing in the same document.

const SettingField = {
  type: "object",
  description:
    "One editable setting: its effective value, which layer that value came from, and whether " +
    'it is a secret. A UI renders `source: "env"` as “from the environment default”, ' +
    '`source: "store"` as “edited in the product” (with a reset), and a secret as “set · rotate”.',
  required: ["key", "group", "label", "type", "envVar", "secret", "adminOnly", "source", "value", "envSet"],
  properties: {
    key: { type: "string", description: "Dotted key, e.g. `branding.tagline`. Also the patch path." },
    group: {
      type: "string",
      enum: ["branding", "connection", "limits", "security", "retention", "operations"],
    },
    label: { type: "string" },
    description: { type: "string" },
    type: {
      type: "string",
      enum: ["string", "number", "boolean", "color", "uuid", "enum", "url", "list"],
      description: "How the field is edited and validated. `color` uses the platform's strict grammar.",
    },
    envVar: { type: "string", description: "Environment variable that supplies this field's default" },
    secret: { type: "boolean", description: "True when the value is write-only and never returned" },
    adminOnly: {
      type: "boolean",
      description: "True when the value never appears on the viewer-facing `GET /api/v1/settings` (DP-40)",
    },
    source: {
      type: "string",
      enum: ["store", "env", "default"],
      description:
        "Which layer the effective value came from: an in-product edit, the environment, or the built-in default",
    },
    value: {
      description: "Effective value. Always `null` for a secret.",
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
    },
    set: { type: "boolean", description: "Secrets only: whether a value is in force" },
    hint: { type: "string", description: "Secrets only: the last four characters, to tell two apart" },
    envSet: {
      type: "boolean",
      description: "Whether the environment sets this field, so a reset has a target",
    },
    constraints: {
      type: "object",
      description: "Bounds the API enforces: min, max, maxLength, values.",
      additionalProperties: true,
    },
    note: { type: "string", description: "Operator-facing caveat shown next to the field" },
  },
};

const SettingsDocument = {
  type: "object",
  description:
    "Every setting this deployment reads, grouped for the settings screen, plus `applied`: the " +
    "values the running process is actually using, read back from the live objects rather than " +
    "from the stored document. `applied` is how a UI proves an edit took effect without a restart.",
  required: ["version", "groups", "applied"],
  properties: {
    version: { type: "integer", description: "Bumped on every applied change; usable as an ETag-ish guard" },
    updatedAt: { type: ["string", "null"], format: "date-time" },
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label", "fields"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          fields: { type: "array", items: { $ref: "#/components/schemas/SettingField" } },
        },
      },
    },
    applied: {
      type: "object",
      description:
        "Live values in force right now: the ARAG client's KB id, base URL and timeout, the rate " +
        "limiter's numbers, the upload and body ceilings, whether API keys are enforced, and the " +
        "state of the retention scheduler.",
      additionalProperties: true,
    },
  },
};

const SettingsPatch = {
  type: "object",
  description:
    'Settings to change, either nested (`{ "branding": { "tagline": "…" } }`) or flat ' +
    '(`{ "branding.tagline": "…" }`). Only the keys present are touched. Every value is ' +
    "validated before anything is written: a bad colour, a non-UUID Knowledge Box id or an " +
    "out-of-range number fails the whole patch with an RFC 9457 problem listing each field.",
  additionalProperties: true,
};

const SettingsChange = {
  type: "object",
  description: "One applied change. `before`/`after` are null for a secret — that it changed is the record.",
  required: ["key", "secret"],
  properties: {
    key: { type: "string" },
    secret: { type: "boolean" },
    before: {},
    after: {},
  },
};

const SettingsPatchResult = {
  type: "object",
  description: "The changes that were actually applied, plus the new settings document.",
  required: ["changed", "settings"],
  properties: {
    changed: { type: "array", items: { $ref: "#/components/schemas/SettingsChange" } },
    settings: { $ref: "#/components/schemas/SettingsDocument" },
  },
};

const SettingsResetRequest = {
  type: "object",
  description: "Drop in-product overrides so the named settings fall back to their environment default.",
  required: ["keys"],
  properties: {
    keys: {
      type: "array",
      minItems: 1,
      maxItems: 60,
      items: { type: "string", maxLength: 80 },
      description: 'Dotted setting keys, e.g. `["branding.primaryColor"]`',
    },
  },
  additionalProperties: false,
};

const BrandingAsset = {
  type: "object",
  description: "A brand asset written into `DATA_DIR/branding/` and served from `/branding/`.",
  required: ["url", "filename", "bytes"],
  properties: {
    url: { type: "string", description: "Path the asset is served from, e.g. `/branding/logo.svg`" },
    filename: { type: "string" },
    bytes: { type: "integer" },
    contentType: { type: "string" },
    settings: { $ref: "#/components/schemas/SettingsDocument" },
  },
};

const ApiKey = {
  type: "object",
  description:
    "A stored API key. The key itself is never returned — only a salted digest is kept, and the " +
    "prefix is what an operator matches against the value they saved at creation.",
  required: ["id", "name", "prefix", "createdAt", "revoked"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string", description: "Non-secret leading part of the key, e.g. `dip_3f9c1a2b`" },
    createdAt: { type: "string", format: "date-time" },
    createdBy: { type: "string", description: "Who created it: the admin token, a key's name, or a session" },
    lastUsedAt: { type: ["string", "null"], format: "date-time" },
    revokedAt: { type: ["string", "null"], format: "date-time" },
    revoked: { type: "boolean" },
  },
};

const ApiKeyCreateRequest = {
  type: "object",
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "What this key is for, e.g. `ingest-worker`",
    },
  },
  additionalProperties: false,
};

const ApiKeyCreated = {
  type: "object",
  description:
    "The only response that ever contains the key. It is shown once and cannot be recovered: " +
    "the store keeps a salted SHA-256 digest, not the value.",
  required: ["key", "apiKey"],
  properties: {
    key: { type: "string", description: "The plaintext key. Copy it now — it is never returned again." },
    apiKey: { $ref: "#/components/schemas/ApiKey" },
  },
};

const AuditEntry = {
  type: "object",
  description:
    "One audited change: who, what, when, and what it changed from and to. Secret values are " +
    "replaced with `***` before the entry is written, so the log is safe to read.",
  required: ["id", "seq", "ts", "actor", "action", "target"],
  properties: {
    id: { type: "string" },
    seq: { type: "integer", description: "Monotonic ordering key; the page cursor encodes it" },
    ts: { type: "string", format: "date-time" },
    actor: {
      type: "object",
      required: ["type", "name"],
      properties: {
        type: { type: "string", enum: ["admin", "api-key", "session", "anonymous", "system"] },
        name: { type: "string", description: "Admin token, the API key's name, `session`, or `scheduler`" },
      },
    },
    action: {
      type: "string",
      description:
        "Dotted verb: `settings.update`, `settings.reset`, `apikey.create`, `apikey.revoke`, " +
        "`config.create`, `config.update`, `config.delete`, `config.provision`, " +
        "`document.field.correct`, `document.delete`, `documents.purge`, `branding.logo`",
    },
    target: {
      type: "string",
      description: "Setting key, key id, config id, document id, or `*` for a sweep",
    },
    before: {},
    after: {},
    requestId: { type: ["string", "null"], description: "Correlates with the request log" },
    detail: { type: "string" },
  },
};

const CursorPageFields = {
  nextCursor: {
    type: ["string", "null"],
    description: "Opaque cursor for the next page in the reading direction; null at the end.",
  },
  prevCursor: {
    type: ["string", "null"],
    description: "Opaque cursor for the page you came from; null at the start.",
  },
  hasMore: { type: "boolean" },
  hasPrev: { type: "boolean" },
  total: { type: "integer", description: "Rows matching the filter across every page" },
};

const AuditPage = {
  type: "object",
  description:
    "A page of audited changes, newest first. Paging is by sequence number, not offset, so an " +
    "entry written while an operator is reading cannot duplicate or hide a row.",
  required: ["items", "nextCursor", "prevCursor", "hasMore", "total"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/AuditEntry" } },
    actions: {
      type: "array",
      items: { type: "string" },
      description: "Distinct actions seen, for the filter",
    },
    ...CursorPageFields,
  },
};

const LogPage = {
  type: "object",
  description:
    "A page of runtime log records, oldest first (the ring buffer has always read like a " +
    "terminal), with the same stable cursor contract as the audit log.",
  required: ["items", "nextCursor", "prevCursor", "hasMore", "total"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/LogRecord" } },
    ...CursorPageFields,
  },
};

// ─── end settings, API keys and audit ─────────────────────────────────────────

// ─── key-value fields, generator agents and human review ─────────────────────
// The second half of the full-implementation pass: extracted values written back into the
// Knowledge Box as typed key-value fields (so they can be filtered on rather than re-read),
// the Data Augmentation generator agent as an alternative extraction path with an honest
// comparison against this product's own, and the review surface that corrects a field and
// asks one question across the corpus.

const KvRejection = {
  type: "object",
  description:
    "One value the Knowledge Box refused, normalised out of ARAG's two different 422 " +
    "dialects. This is the product's own “the KB rejected this value” signal: it names the " +
    "field, what the schema expected and what was supplied, so a reviewer can see why a " +
    "field is missing from the Knowledge Box.",
  required: ["kind", "message"],
  properties: {
    field: { type: "string", description: "Product property name, when the error identifies one" },
    kind: {
      type: "string",
      enum: [
        "type_mismatch",
        "missing_required",
        "unknown_key",
        "range_bounds",
        "too_many_fields",
        "too_many_schemas",
        "invalid_name",
        "invalid_modifier",
        "duplicate_key",
        "unknown",
      ],
    },
    message: { type: "string" },
    expected: { type: "string", description: "Declared key-value type for the field" },
    got: { type: "string", description: "What was actually supplied" },
  },
};

const KvWriteRecord = {
  type: "object",
  description:
    "What reached the resource's key-value field for this document, and what did not.\n\n" +
    "**The overwrite trap.** A key-value write replaces the whole schema's data, and " +
    "overwriting a value does *not* remove the old one from the Knowledge Box's filter " +
    "index — the index accumulates every value ever written to that field on that resource " +
    "and there is no purge call. Values are therefore written once per resource; when a " +
    "second write is unavoidable (a human correction, a reprocess) `writes` counts it, " +
    "`filterIndexStale` goes true and `superseded` lists the values this resource still " +
    "matches a filter on despite having replaced them. It is reported rather than hidden.",
  required: ["schemaId", "written", "at", "fields"],
  properties: {
    schemaId: { type: "string", description: "Key-value schema the values were written under" },
    written: { type: "boolean", description: "True when the Knowledge Box accepted the write" },
    at: { type: "string", format: "date-time" },
    fields: { type: "integer", description: "Keys actually written" },
    keys: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Product property name → key-value field key, so the JSON tab can render both",
    },
    values: {
      type: "object",
      additionalProperties: true,
      description: "Key-value field key → the value exactly as it reached the Knowledge Box",
    },
    skipped: {
      type: "array",
      description: "Extracted values that could not be represented in the schema, each with the reason",
      items: {
        type: "object",
        required: ["field", "reason"],
        properties: { field: { type: "string" }, reason: { type: "string" } },
      },
    },
    rejected: { type: "array", items: { $ref: "#/components/schemas/KvRejection" } },
    error: { type: "string", description: "Why the write did not happen, or did not land" },
    writes: {
      type: "integer",
      description: "How many times this resource's key-value field has been written",
    },
    filterIndexStale: {
      type: "boolean",
      description:
        "True once this resource has been written more than once: the Knowledge Box filter " +
        "index also matches every superseded value, so a filter on an old value still " +
        "returns this document.",
    },
    superseded: {
      type: "array",
      description: "Values this resource still matches a filter on although they have been replaced",
      items: {
        type: "object",
        required: ["field"],
        properties: { field: { type: "string" }, value: {} },
      },
    },
  },
};

const ProvisioningStatus = {
  type: "object",
  required: ["state"],
  properties: {
    state: { type: "string", enum: ["provisioned", "failed", "not provisioned"] },
    error: { type: "string", description: "Why it failed, in a sentence an operator can act on" },
    at: { type: "string", format: "date-time" },
  },
};

const ConfigProvisioning = {
  type: "object",
  description:
    "What this configuration has in the Knowledge Box. A config needs two objects there: a " +
    "stored search configuration (how a document is read) and a key-value schema (how the " +
    "result is kept and filtered). `state` is `provisioned` only when both are in place.",
  required: ["state", "searchConfiguration", "keyValueSchema"],
  properties: {
    state: { type: "string", enum: ["provisioned", "failed", "not provisioned"] },
    searchConfiguration: {
      allOf: [
        { $ref: "#/components/schemas/ProvisioningStatus" },
        { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      ],
    },
    keyValueSchema: {
      allOf: [
        { $ref: "#/components/schemas/ProvisioningStatus" },
        {
          type: "object",
          required: ["schemaId", "fields"],
          properties: {
            schemaId: { type: "string" },
            fields: { type: "integer", description: "Fields declared in the key-value schema (max 50)" },
          },
        },
      ],
    },
  },
};

const AppliedFilters = {
  type: "object",
  description:
    "Which half of the query was answered by which system. `kv` filters are resolved **in " +
    "the Knowledge Box** (a `/find` with the key-value filter expression, whose matching " +
    "resource ids are then intersected with this workspace's own list); everything else is a " +
    "predicate over the local store. A list screen should label them differently because " +
    "they are not interchangeable.",
  required: ["knowledgeBox", "local"],
  properties: {
    knowledgeBox: {
      type: "object",
      required: ["applied", "requested", "matchedResources"],
      properties: {
        applied: {
          type: "array",
          description:
            "Filters that were actually applied. **Empty when `error` is present** — the page " +
            "is then the unnarrowed local list, and a UI must not render a filter chip from " +
            "`requested`, which would claim a narrowing that never happened.",
          items: { $ref: "#/components/schemas/KvFilterSpec" },
        },
        requested: {
          type: "array",
          description: "What the caller asked for, applied or not.",
          items: { $ref: "#/components/schemas/KvFilterSpec" },
        },
        matchedResources: {
          type: "integer",
          description: "Resources the Knowledge Box matched, before local filters and paging",
        },
        error: {
          type: "string",
          description:
            "Present when the Knowledge Box could not answer. The key-value filters were then " +
            "NOT applied — the page is the local list, not an empty result.",
        },
      },
    },
    local: {
      type: "array",
      items: { type: "string" },
      description: "Parameters applied against this workspace's own store",
    },
  },
};

const KvFilterSpec = {
  type: "object",
  description: "One parsed `kv=<schemaId>:<field>:<op>:<value>` filter.",
  required: ["schemaId", "key", "op", "value"],
  properties: {
    schemaId: { type: "string" },
    key: { type: "string" },
    op: { type: "string", enum: ["eq", "gte", "lte", "contains"] },
    value: { type: "string" },
  },
};

const FieldCorrection = {
  type: "object",
  description:
    "One human correction to one extracted field, kept on the record forever. The model's " +
    "original value and the reviewer are both preserved: a correction is recorded, never a " +
    "silent overwrite. `verified` is the corrected value re-checked against the document's " +
    "own text with the same contract the pipeline uses — a human typing a value does not " +
    "make it grounded, but if the value they typed *is* in the document, that is worth showing.",
  required: ["field", "label", "previousValue", "value", "actor", "at", "verified"],
  properties: {
    field: { type: "string" },
    label: { type: "string" },
    previousValue: {},
    value: {},
    reason: { type: "string" },
    actor: {
      type: "string",
      description: "`admin`, `api-key` or `session`. Never a credential.",
    },
    at: { type: "string", format: "date-time" },
    verified: { type: "string", enum: ["exact", "normalised", "unverified"] },
    kv: {
      type: "object",
      description: "Whether the corrected value reached the Knowledge Box key-value field.",
      required: ["written"],
      properties: {
        written: { type: "boolean" },
        schemaId: { type: "string" },
        fieldId: { type: "string" },
        error: { type: "string" },
        filterIndexStale: {
          type: "boolean",
          description:
            "True when this write superseded an earlier one: the Knowledge Box filter index " +
            "still matches the value the correction replaced.",
        },
      },
    },
  },
};

const FieldCorrectionRequest = {
  type: "object",
  description: "The value a reviewer is setting the field to, and why.",
  required: ["value"],
  properties: {
    value: {
      description: "The corrected value. `null` clears the field.",
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: {} },
      ],
    },
    reason: {
      type: "string",
      maxLength: 400,
      description: "Why the value was wrong, in the reviewer's words",
    },
  },
  additionalProperties: false,
};

const FieldCorrectionResult = {
  type: "object",
  required: ["document", "correction"],
  properties: {
    document: { $ref: "#/components/schemas/Document" },
    correction: { $ref: "#/components/schemas/FieldCorrection" },
  },
};

const CorpusAskRequest = {
  type: "object",
  description:
    "A question asked across a filtered set of documents rather than one. The filter is the " +
    "Documents list's own filter, so “ask the twelve invoices from last week” is the list " +
    "already on screen.",
  required: ["question"],
  properties: {
    question: { type: "string", minLength: 1, maxLength: 1200 },
    maxResources: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Ceiling on documents retrieved over, so one ask cannot fan out over the whole corpus",
    },
    filters: {
      type: "object",
      description: "The same filters `GET /api/v1/documents` accepts, by their query-parameter names.",
      properties: {
        q: { type: "string", maxLength: 200 },
        config: { type: "string", maxLength: 80 },
        doc_type: { type: "array", items: { type: "string", enum: [...DOC_TYPES] } },
        date_from: { type: "string", maxLength: 40 },
        date_to: { type: "string", maxLength: 40 },
        has_issues: { type: "boolean" },
        degraded: { type: "boolean" },
        min_grounding: { type: "number", minimum: 0, maximum: 1 },
        sort: {
          type: "string",
          enum: ["created_at", "filename", "doc_type", "status", "fields", "grounding"],
        },
        order: { type: "string", enum: ["asc", "desc"] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const CorpusAnswer = {
  type: "object",
  description:
    "One grounded answer over many documents. Citations carry this product's own document " +
    "ids, so “show me where” still works across the corpus.",
  required: ["answer", "scope", "citations", "documents", "ms"],
  properties: {
    answer: { type: "string" },
    scope: {
      type: "object",
      required: ["documents", "filters"],
      properties: {
        documents: { type: "integer", description: "Documents the question was asked over" },
        filters: { type: "object", additionalProperties: true },
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["documentId", "filename", "docType", "paragraphId", "text"],
        properties: {
          documentId: { type: "string" },
          filename: { type: "string" },
          docType: { type: "string" },
          paragraphId: { type: "string" },
          text: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
        },
      },
    },
    documents: {
      type: "array",
      description: "Distinct documents the citations came from, in citation order",
      items: {
        type: "object",
        required: ["id", "filename", "docType", "citations"],
        properties: {
          id: { type: "string" },
          filename: { type: "string" },
          docType: { type: "string" },
          citations: { type: "integer" },
        },
      },
    },
    ms: { type: "integer" },
  },
};

const GeneratorAgent = {
  type: "object",
  description:
    "A Data Augmentation generator agent this workspace started: an ARAG-side task (kind " +
    "`ask`, `store_as_key_value: true`) that extracts into the configuration's key-value " +
    "schema on the platform's own schedule. One per configuration — ARAG allows only one " +
    "running `ask` task per destination, and the destination is the key-value schema.",
  required: ["configId", "kvSchemaId", "taskId", "name", "startedAt", "state"],
  properties: {
    configId: { type: "string" },
    kvSchemaId: {
      type: "string",
      description: "The agent's own key-value schema (`<config schema>_gen`), never the pipeline's",
    },
    taskId: { type: "string", description: "ARAG task id" },
    name: { type: "string", description: "Task name as it appears in the ARAG dashboard" },
    resourceId: { type: "string", description: "Set when the run was scoped to one document" },
    startedAt: { type: "string", format: "date-time" },
    state: { type: "string", enum: ["running", "done", "failed", "stopped", "absent"] },
  },
};

const GeneratorComparison = {
  type: "object",
  description:
    "This product's extraction beside the generator agent's, field by field.\n\n" +
    "**The two columns are not equivalent and the payload says so.** The evidence contract " +
    "applies to the product's path only: its values carry a verbatim quote checked against " +
    "the document's own text. A generator agent returns values and no quote, so every " +
    "`generator.evidence` is `null` and `evidenceContract.generator` spells out that these " +
    "values are not grounded to the same standard.",
  required: [
    "documentId",
    "resourceId",
    "configId",
    "kvSchemaId",
    "generatorKvSchemaId",
    "fields",
    "summary",
    "evidenceContract",
    "observed",
  ],
  properties: {
    documentId: { type: "string" },
    resourceId: { type: "string" },
    configId: { type: "string" },
    kvSchemaId: { type: "string", description: "Key-value schema the product's own pipeline writes into" },
    generatorKvSchemaId: {
      type: "string",
      description:
        "Key-value schema the generator agent writes into — deliberately a different one " +
        "(`<schema>_gen`). A key-value write is a full replace, so one shared schema would " +
        "mean whichever path ran last silently erased the other's values and polluted the " +
        "resource's filter index; two schemas keep both columns independently readable.",
    },
    agent: {
      description: "The agent started for this configuration, or null when none is running.",
      anyOf: [{ $ref: "#/components/schemas/GeneratorAgent" }, { type: "null" }],
    },
    generatorHasWritten: {
      type: "boolean",
      description: "True once the agent has written values onto this resource",
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        required: ["field", "label", "pipeline", "generator", "agreement"],
        properties: {
          field: { type: "string" },
          label: { type: "string" },
          pipeline: {
            type: "object",
            required: ["present", "value", "evidence"],
            properties: {
              present: { type: "boolean" },
              value: {},
              confidence: { type: "number" },
              evidence: {
                description: "The verified quote behind this value, or null when it has none.",
                anyOf: [
                  {
                    type: "object",
                    required: ["quote", "verified"],
                    properties: {
                      quote: { type: "string" },
                      verified: { type: "string", enum: ["exact", "normalised", "unverified"] },
                    },
                  },
                  { type: "null" },
                ],
              },
            },
          },
          generator: {
            type: "object",
            required: ["present", "value", "evidence"],
            properties: {
              present: { type: "boolean" },
              value: {},
              evidence: {
                type: "null",
                description: "Always null — a generator agent returns no quote to verify.",
              },
            },
          },
          agreement: {
            type: "string",
            enum: ["agree", "differ", "pipeline-only", "generator-only", "neither"],
          },
        },
      },
    },
    summary: { type: "object", additionalProperties: { type: "integer" } },
    evidenceContract: {
      type: "object",
      required: ["pipeline", "generator"],
      properties: { pipeline: { type: "string" }, generator: { type: "string" } },
    },
    observed: {
      type: "object",
      description:
        "What this product has actually seen of the generator path against a live Knowledge " +
        "Box, and what it has not.",
      required: ["provisioning", "lifecycle", "readBack", "endToEndLatency", "note"],
      properties: {
        provisioning: { type: "boolean" },
        lifecycle: { type: "boolean" },
        readBack: { type: "boolean" },
        endToEndLatency: {
          type: "boolean",
          description:
            "False: every run started against the live Knowledge Box on 2026-09-13 was still " +
            "`scheduled` after 20 minutes, so the time from starting a generator to values " +
            "appearing on a resource has never been observed.",
        },
        note: { type: "string" },
      },
    },
  },
};

// ─── end key-value fields, generator agents and human review ──────────────────

const apiSecurity = [{ ApiKey: [] }, { Bearer: [] }];
const adminSecurity = [{ AdminToken: [] }];
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 128 } };
const fieldKeyParam = {
  name: "key",
  in: "path",
  required: true,
  description: "The `ExtractedField.key` being corrected, e.g. `invoice_number`",
  schema: { type: "string", maxLength: 128 },
};

export const openapi = buildOpenApi({
  info: {
    title: "Document Processing API",
    version: VERSION,
    description:
      "Turn any document into a canonical, validated record. Upload a PDF, image, or text " +
      "file; a job runs the pipeline on Progress Agentic RAG (process → classify → extract → " +
      "entities → summary → validate → standardize) and returns structured fields, entities, a " +
      "summary and validation issues, exportable as JSON, XML or CSV.",
  },
  tags: [
    { name: "documents", description: "Upload documents and read canonical records" },
    { name: "jobs", description: "Asynchronous processing jobs and their event streams" },
    { name: "extraction-configs", description: "Built-in and custom extraction configurations" },
    { name: "schemas", description: "Document types and their extraction fields" },
    { name: "admin", description: "Operator endpoints (ADMIN_TOKEN)" },
    {
      name: "settings",
      description:
        "Every setting this deployment reads, editable in the product. Environment variables are " +
        "defaults; an edit is stored and takes effect without a restart. Secrets are write-only.",
    },
    {
      name: "api-keys",
      description: "Create, list and revoke the API keys that authenticate callers of this API",
    },
    { name: "audit", description: "Who changed what, and when — the audited-change log" },
    {
      name: "review",
      description:
        "Human review: correcting an extracted value (recorded, never a silent overwrite) and " +
        "asking one grounded question across a filtered set of documents",
    },
    {
      name: "generators",
      description:
        "Data Augmentation generator agents — the platform's own asynchronous extraction path, " +
        "and an honest field-by-field comparison against this product's",
    },
    { name: "system", description: "Health and session" },
  ],
  schemas: {
    ExtractedField,
    Entity,
    Evidence,
    ValidationIssue,
    Document,
    // The platform's page shape plus `facets`: the list screen's filter counts and stat
    // strip are answers about the whole collection, and a page cannot carry them.
    DocumentPage: (() => {
      const base = pageSchema("#/components/schemas/Document");
      const props = base.properties as Record<string, unknown>;
      props.facets = { $ref: "#/components/schemas/Facets" };
      // Which filters ran in the Knowledge Box and which ran locally — the list screen
      // labels them differently because they are answered by different systems.
      props.filters = { $ref: "#/components/schemas/AppliedFilters" };
      return base;
    })(),
    DocumentAccepted,
    BulkDeleteRequest,
    BulkDeleteResult,
    BulkExportRequest,
    Stats,
    Settings,
    Sample,
    SampleRequest,
    DocumentText,
    Facets,
    SecurityPosture,
    AskRequest,
    AskResponse,
    ConfigField,
    ExtractionConfig,
    ExtractionConfigCreate,
    Schema,
    ProvisionResult,
    Branding: BrandingSchema,
    // settings / API keys / audit
    SettingField,
    SettingsDocument,
    SettingsPatch,
    SettingsChange,
    SettingsPatchResult,
    SettingsResetRequest,
    BrandingAsset,
    ApiKey,
    ApiKeyCreateRequest,
    ApiKeyCreated,
    AuditEntry,
    AuditPage,
    LogPage,
    // key-value fields, generator agents and human review
    KvRejection,
    KvWriteRecord,
    ProvisioningStatus,
    ConfigProvisioning,
    AppliedFilters,
    KvFilterSpec,
    FieldCorrection,
    FieldCorrectionRequest,
    FieldCorrectionResult,
    CorpusAskRequest,
    CorpusAnswer,
    GeneratorAgent,
    GeneratorComparison,
  },
  paths: {
    "/api/v1/documents": {
      get: {
        operationId: "listDocuments",
        tags: ["documents"],
        summary: "List documents (newest first) with search, filters and sorting",
        description:
          "Every parameter is optional and they combine with AND. `q` is a case-insensitive " +
          "substring match across the filename, the summary, the tags and the extracted field " +
          "labels and values — so a user can find a document by the supplier on it, not only by " +
          "the name it was uploaded under.",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          {
            name: "page_size",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
          },
          {
            name: "doc_type",
            in: "query",
            description:
              "Document type. Repeat the parameter to select several (`?doc_type=invoice&doc_type=receipt`).",
            explode: true,
            schema: { type: "array", items: { type: "string", enum: [...DOC_TYPES] } },
          },
          {
            name: "q",
            in: "query",
            description: "Free-text search over filename, summary, tags and extracted field values",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "sort",
            in: "query",
            description: "Field to order by (default `created_at`)",
            schema: {
              type: "string",
              enum: ["created_at", "filename", "doc_type", "status", "fields", "grounding"],
              default: "created_at",
            },
          },
          {
            name: "order",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
          {
            name: "date_from",
            in: "query",
            description: "Only documents created at or after this instant (ISO 8601 or YYYY-MM-DD)",
            schema: { type: "string", maxLength: 40 },
          },
          {
            name: "date_to",
            in: "query",
            description: "Only documents created at or before this instant (ISO 8601 or YYYY-MM-DD)",
            schema: { type: "string", maxLength: 40 },
          },
          {
            name: "config",
            in: "query",
            description: "Only documents extracted with this extraction configuration id",
            schema: { type: "string", maxLength: 80 },
          },
          {
            name: "degraded",
            in: "query",
            description:
              "`true` returns only records that finished with a failed stage (`meta.stageErrors`); " +
              "`false` excludes them.",
            schema: { type: "boolean" },
          },
          {
            name: "has_issues",
            in: "query",
            description: "`true` returns only records carrying at least one validation issue",
            schema: { type: "boolean" },
          },
          {
            name: "min_grounding",
            in: "query",
            description:
              "Only records whose `meta.groundingScore` is at least this. Records with no score " +
              "are excluded — an unmeasured record is not a well-grounded one.",
            schema: { type: "number", minimum: 0, maximum: 1 },
          },
          {
            name: "kv",
            in: "query",
            description:
              "Filter by an **extracted value**, through the Knowledge Box rather than this " +
              "workspace's store. Shape: `kv=<schemaId>:<field>:<op>:<value>` — for example " +
              "`kv=dip_invoice_extraction:total:gte:10000`. Repeat the parameter to narrow " +
              "further; several `kv` filters are ANDed.\n\n" +
              "`schemaId` is an extraction configuration's `kvSchemaId` and `field` is one of " +
              "its `kvFields`. Only the first three colons separate, so a value may contain " +
              "them — which an RFC 3339 instant does.\n\n" +
              "Operators are per field kind and are checked before the call, because ARAG " +
              "enforces them with a 412 that says nothing useful:\n" +
              "- `eq` — any scalar field (text, integer, float, boolean, date)\n" +
              "- `gte` / `lte` — integer, float and date scalars only\n" +
              "- `contains` — `repeated` fields (is this a member?) and `range` fields (is " +
              "this point inside the interval?)\n\n" +
              "A filter naming an unknown schema or field, or using an operator that field " +
              "does not accept, answers **400** with the operators it does accept. Resolved as " +
              "a `/find` with an empty query (key-value filter expressions are rejected by " +
              "`/catalog`), whose matching resource ids are intersected with the local list; " +
              "the response's `filters` block says which filters ran where.",
            explode: true,
            schema: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 10 },
          },
        ],
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/DocumentPage" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      post: {
        operationId: "createDocument",
        tags: ["documents"],
        summary: "Upload a document and start the processing job",
        description:
          "Accepts `multipart/form-data` with a `file` part, or a raw body with an `X-Filename` " +
          "header. `config` selects the extraction configuration: `auto` classifies the document, " +
          "`agent` reads fields persisted by an ARAG Data Augmentation agent, or pass an " +
          "extraction-config id. Returns 202 with the document record and the job to watch.",
        parameters: [
          {
            name: "config",
            in: "query",
            description: "auto | agent | <extraction config id>",
            schema: { type: "string", maxLength: 80, default: "auto" },
          },
          {
            name: "X-Filename",
            in: "header",
            description: "Filename for raw-body uploads (ignored for multipart)",
            schema: { type: "string", maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                  config: { type: "string" },
                },
              },
            },
            "application/pdf": { schema: { type: "string", format: "binary" } },
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/jpeg": { schema: { type: "string", format: "binary" } },
            "text/plain": { schema: { type: "string" } },
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          202: jsonResponse({ $ref: "#/components/schemas/DocumentAccepted" }, "Accepted"),
          413: {
            description: "Upload too large",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          415: {
            description: "Unsupported media type",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}": {
      parameters: [idParam],
      get: {
        operationId: "getDocument",
        tags: ["documents"],
        summary: "Get the canonical record for one document",
        description:
          "The full record: classification, extracted fields with their confidence, the quotes " +
          "supporting them and how each was verified, entities, summary, tags, validation issues " +
          "and the pipeline metadata (schema, model, per-stage timings, grounding score).",
        responses: { 200: jsonResponse({ $ref: "#/components/schemas/Document" }), ...standardResponses },
        security: apiSecurity,
      },
      delete: {
        operationId: "deleteDocument",
        tags: ["documents"],
        summary: "Delete a document and its ARAG resource",
        description:
          "Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.",
        responses: { 204: { description: "Deleted" }, ...standardResponses },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/export": {
      parameters: [idParam],
      get: {
        operationId: "exportDocument",
        tags: ["documents"],
        summary: "Download the record as JSON, XML or CSV",
        description:
          "Serialises the same record `GET /documents/{id}` returns into the requested format and " +
          "sends it as an attachment. CSV flattens the extracted fields to one row per field.",
        parameters: [
          {
            name: "format",
            in: "query",
            schema: { type: "string", enum: ["json", "xml", "csv"], default: "json" },
          },
        ],
        responses: {
          200: {
            description: "Standardised export",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Document" } },
              "application/xml": { schema: { type: "string" } },
              "text/csv": { schema: { type: "string" } },
            },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/ask": {
      parameters: [idParam],
      post: {
        operationId: "askDocument",
        tags: ["documents"],
        summary: "Ask a grounded question about one document",
        description:
          "Answers from this document's own text. Every call is a generative model call " +
          "against the Knowledge Box, so this route has its own, tighter rate-limit bucket " +
          "than the shared public one — an anonymous caller can still try the product " +
          "without a credential, but cannot use it as an unbounded model proxy.",
        requestBody: jsonBody({ $ref: "#/components/schemas/AskRequest" }),
        responses: { 200: jsonResponse({ $ref: "#/components/schemas/AskResponse" }), ...standardResponses },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/text": {
      parameters: [idParam],
      get: {
        operationId: "getDocumentText",
        tags: ["documents"],
        summary: "The document's own extracted text",
        description:
          "The text Progress Agentic RAG read from the file at ingestion — what every " +
          "extraction stage saw, and what `Evidence.start`/`Evidence.end` index into. Without " +
          "it a client can show an evidence quote but cannot show it *in the document*.",
        parameters: [
          {
            name: "max_chars",
            in: "query",
            schema: { type: "integer", minimum: 1000, maximum: 2000000, default: 200000 },
          },
        ],
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/DocumentText" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/source": {
      parameters: [idParam],
      get: {
        operationId: "getDocumentSource",
        tags: ["documents"],
        summary: "The original uploaded file",
        description:
          "Streams the bytes back from the ARAG resource, `Content-Disposition: inline`, so a " +
          "reviewer can see the page the values came from. Answers 404 when the resource no " +
          "longer holds the file; a client should then fall back to the extracted text.",
        responses: {
          200: {
            description: "The original file",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/sample": {
      post: {
        operationId: "createSampleDocument",
        tags: ["documents"],
        summary: "Process one of the bundled sample documents",
        description:
          "Reads the sample from disk server-side and runs it through the ordinary upload path, " +
          "so the first-run flow is one call rather than a fetch followed by an upload. The " +
          "sample ids come from `GET /api/v1/samples`.",
        requestBody: jsonBody({ $ref: "#/components/schemas/SampleRequest" }),
        responses: {
          202: jsonResponse({ $ref: "#/components/schemas/DocumentAccepted" }, "Accepted"),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/reprocess": {
      parameters: [idParam],
      post: {
        operationId: "reprocessDocument",
        tags: ["documents"],
        summary: "Re-run the pipeline over a document already in the Knowledge Box",
        description:
          "The recovery action for a failed or degraded record: the resource is already " +
          "uploaded, so this queues a fresh job over it rather than asking the user to upload " +
          "the file again. Returns 202 with the reset record and the new job to watch. " +
          "Requires a credential even when `API_KEYS` is unset (it spends model calls): an API " +
          "key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.",
        parameters: [
          {
            name: "config",
            in: "query",
            description: "Extraction configuration to use for the re-run (default: the original one)",
            schema: { type: "string", maxLength: 80 },
          },
        ],
        responses: {
          202: jsonResponse({ $ref: "#/components/schemas/DocumentAccepted" }, "Accepted"),
          409: {
            description: "The document is already queued or processing",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/bulk-delete": {
      post: {
        operationId: "bulkDeleteDocuments",
        tags: ["documents"],
        summary: "Delete several documents and their ARAG resources",
        description:
          "Best-effort: each id is attempted and reported separately, so one missing document " +
          "does not abandon the rest of the selection. Requires the same credential as a single " +
          "delete.",
        requestBody: jsonBody({ $ref: "#/components/schemas/BulkDeleteRequest" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/BulkDeleteResult" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/bulk-export": {
      post: {
        operationId: "bulkExportDocuments",
        tags: ["documents"],
        summary: "Download several records as one JSON, XML or CSV file",
        description:
          "JSON returns an array of records; XML wraps them in a `<documents>` root; CSV emits " +
          "one header and one row per extracted field across every selected record, so a " +
          "spreadsheet can reconcile a whole batch in one pass. Ids that do not exist are " +
          "skipped and named in the `X-Skipped-Ids` response header.",
        requestBody: jsonBody({ $ref: "#/components/schemas/BulkExportRequest" }),
        responses: {
          200: {
            description: "Standardised export of the selected records",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Document" } },
              },
              "application/xml": { schema: { type: "string" } },
              "text/csv": { schema: { type: "string" } },
            },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/stats": {
      get: {
        operationId: "getStats",
        tags: ["documents"],
        summary: "Workspace counters: documents by status and type, grounding, jobs",
        description:
          "What the documents overview strip shows. Cheap and credential-free, so a list screen " +
          "can poll it while a pipeline runs without an admin token.",
        responses: { 200: jsonResponse({ $ref: "#/components/schemas/Stats" }), ...standardResponses },
        security: apiSecurity,
      },
    },
    "/api/v1/settings": {
      get: {
        operationId: "getSettings",
        tags: ["system"],
        summary: "Effective, non-secret runtime settings for the workspace",
        description:
          "Connection state, extraction configuration, upload limits and branding — everything " +
          "the Settings screen shows a signed-in user. Secrets (the extract-strategy id, tokens, " +
          "keys) stay behind `ADMIN_TOKEN` on `/api/v1/admin/config`.",
        responses: { 200: jsonResponse({ $ref: "#/components/schemas/Settings" }), ...standardResponses },
        security: apiSecurity,
      },
    },
    "/api/v1/samples": {
      get: {
        operationId: "listSamples",
        tags: ["system"],
        summary: "Bundled sample documents for the first-run flow",
        description:
          "The catalogue behind “Try with a sample”: each entry names a file served from " +
          "`/samples/`, which the client uploads to `POST /api/v1/documents` like any other " +
          "document. Nothing here is special-cased in the pipeline.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: { $ref: "#/components/schemas/Sample" } } },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/jobs": {
      get: {
        operationId: "listJobs",
        tags: ["jobs"],
        summary: "List processing jobs",
        description:
          "Newest first, with paging, a status filter and a search over the job's document and " +
          "config. Each job carries its stage events, so a client can render a pipeline history " +
          "without opening the stream.",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
          },
          { name: "ref", in: "query", description: "Filter by document id", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          {
            name: "page_size",
            in: "query",
            description: "Preferred over `limit`, which stays for compatibility",
            schema: { type: "integer", minimum: 1, maximum: 200 },
          },
          {
            name: "sort",
            in: "query",
            schema: {
              type: "string",
              enum: ["created_at", "duration", "status"],
              default: "created_at",
            },
          },
          { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
          {
            name: "q",
            in: "query",
            description: "Match the job id, its kind, or the document id it refers to",
            schema: { type: "string", maxLength: 200 },
          },
        ],
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items", "page", "page_size", "total"],
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/Job" } },
              page: { type: "integer" },
              page_size: { type: "integer" },
              total: { type: "integer" },
              next_page: { type: "boolean" },
            },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/jobs/{id}": {
      parameters: [idParam],
      get: {
        operationId: "getJob",
        tags: ["jobs"],
        summary: "Get a job",
        description:
          "One job with its full event list: every stage start, progress, success, skip or error, " +
          "with per-stage durations. This is what the pipeline view replays after a reload.",
        responses: { 200: jsonResponse({ $ref: "#/components/schemas/Job" }), ...standardResponses },
        security: apiSecurity,
      },
      delete: {
        operationId: "cancelJob",
        tags: ["jobs"],
        summary: "Cancel a queued or running job",
        description:
          "Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a " +
          "same-origin session cookie from `POST /api/v1/session`. A job that has already finished " +
          "cannot be cancelled and answers 409.",
        responses: {
          204: { description: "Cancelled" },
          409: {
            description: "The job already finished (succeeded, failed or cancelled)",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/jobs/{id}/events": {
      parameters: [idParam],
      get: {
        operationId: "jobEvents",
        tags: ["jobs"],
        summary: "Server-sent events for a job (event names: event, job)",
        description:
          "Replays the job's events so far, then streams new ones. `event` carries a JobEvent " +
          "(stage, status, ms, message); `job` carries the job itself on each status change and " +
          "closes the stream when the job finishes.",
        responses: {
          200: {
            description: "text/event-stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/extraction-configs": {
      get: {
        operationId: "listExtractionConfigs",
        tags: ["extraction-configs"],
        summary: "List built-in and custom extraction configurations",
        description:
          "Every configuration an upload can be processed with, built-in and custom, each with the " +
          "fields it extracts, whether it is provisioned in the Knowledge Box, and how many stored " +
          "documents were processed with it (the question that decides whether it can be deleted).",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/ExtractionConfig" } },
            },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      post: {
        operationId: "createExtractionConfig",
        tags: ["extraction-configs"],
        summary: "Create a custom extraction configuration",
        description:
          "Persists the config and provisions a stored ARAG search configuration (kind `ask`) " +
          "that pins the model, the full_resource RAG strategy, the grounding prompt and the " +
          "answer_json_schema built from these fields. Because it writes into the Knowledge Box, " +
          "it requires a credential even when `API_KEYS` is unset: an API key, the admin token, " +
          "or a same-origin session cookie from `POST /api/v1/session`.",
        requestBody: jsonBody({ $ref: "#/components/schemas/ExtractionConfigCreate" }),
        responses: {
          201: jsonResponse({ $ref: "#/components/schemas/ExtractionConfig" }, "Created"),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/extraction-configs/{id}": {
      parameters: [idParam],
      get: {
        operationId: "getExtractionConfig",
        tags: ["extraction-configs"],
        summary: "Get one extraction configuration",
        description:
          "The configuration's fields, its ARAG search-configuration name, its provisioning state " +
          "and the number of documents processed with it.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/ExtractionConfig" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      put: {
        operationId: "updateExtractionConfig",
        tags: ["extraction-configs"],
        summary: "Replace a custom extraction configuration",
        description:
          "Replaces the name, description and fields, and re-provisions the stored ARAG search " +
          "configuration. The id is kept, so `meta.config` on every document already processed " +
          "with this configuration stays meaningful — which delete-and-recreate would break. " +
          "Built-in configurations answer 409. Requires a writer credential.",
        requestBody: jsonBody({ $ref: "#/components/schemas/ExtractionConfigCreate" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/ExtractionConfig" }),
          409: {
            description: "Built-in configuration cannot be edited",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
      delete: {
        operationId: "deleteExtractionConfig",
        tags: ["extraction-configs"],
        summary: "Delete a custom extraction configuration (built-ins are not deletable)",
        description:
          "Requires a credential even when `API_KEYS` is unset: an API key, the admin token, or a same-origin session cookie from `POST /api/v1/session`.",
        responses: {
          204: { description: "Deleted" },
          409: {
            description: "Built-in configuration cannot be deleted",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/extraction-configs/{id}/provision": {
      parameters: [idParam],
      post: {
        operationId: "provisionExtractionConfig",
        tags: ["extraction-configs"],
        summary: "Re-provision one configuration's Knowledge Box objects",
        description:
          "Re-provisions both the stored ARAG search configuration and the key-value schema " +
          "this configuration writes into, and reports each separately. Idempotent. " +
          "`POST /api/v1/admin/provision` re-provisions all of them and needs the admin " +
          "token; this is the granularity an operator needs to fix the one config that did " +
          "not take. Requires a writer credential.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/ProvisionResult" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/schemas": {
      get: {
        operationId: "listSchemas",
        tags: ["schemas"],
        summary: "List document types and the fields each extraction schema captures",
        description:
          "The read-only catalogue behind auto-classification: every document type this product " +
          "recognises and the fields its built-in schema extracts, with types and required flags. " +
          "Use it to see what a document of a given type will yield before uploading one.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: { $ref: "#/components/schemas/Schema" } } },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/branding": {
      get: {
        operationId: "getBranding",
        tags: ["system"],
        summary: "Effective white-label branding for this deployment",
        description:
          "Public and secret-free — it contains only what a visitor already sees. Both UIs " +
          "fetch it before they paint; a partner's own front end can too. Configured with " +
          "`BRAND_*` environment variables; assets live in `DATA_DIR/branding/` and are served " +
          "from `/branding/`. See `docs/developer/white-label.md`.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/Branding" }),
          ...standardResponses,
        },
      },
    },
    "/api/v1/session": {
      post: {
        operationId: "createSession",
        tags: ["system"],
        summary: "Issue a same-origin session cookie for the demo UI",
        description:
          "Sets a signed, SameSite=Lax `arag_session` cookie so a same-origin front end can call " +
          "the API when API keys are enforced, and can satisfy the writer guard DP-12 applies to " +
          "deletes and config creation. It is not a login: it carries no identity and grants no " +
          "admin access.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["ok", "expiresInSec"],
            properties: { ok: { type: "boolean" }, expiresInSec: { type: "integer" } },
          }),
          ...standardResponses,
        },
      },
    },
    "/api/v1/admin/login": {
      post: {
        operationId: "adminLogin",
        tags: ["admin"],
        summary: "Exchange the admin token for an HttpOnly cookie",
        description:
          "Verifies ADMIN_TOKEN in constant time and sets the HttpOnly `arag_admin` cookie the " +
          "admin panel uses, so the token itself is not held in browser storage. Returns 403 when " +
          "no admin token is configured (admin is disabled) and 401 when the token is wrong.",
        requestBody: jsonBody({
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", minLength: 1, maxLength: 400 } },
          additionalProperties: false,
        }),
        responses: {
          200: jsonResponse({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }),
          ...standardResponses,
        },
      },
    },
    "/api/v1/admin/logout": {
      post: {
        operationId: "adminLogout",
        tags: ["admin"],
        summary: "End the operator session",
        description:
          "Clears the `arag_admin` cookie. The other half of `adminLogin`: an operator who can " +
          "sign in on a shared machine has to be able to sign out of it, and waiting twelve hours " +
          "for the cookie to expire is not a control. Always answers 200 — signing out when you " +
          "were not signed in is not an error, and reporting one would tell an unauthenticated " +
          "caller whether a session existed.",
        responses: {
          200: jsonResponse({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }),
          ...standardResponses,
        },
      },
    },
    "/api/v1/admin/health": {
      get: {
        operationId: "adminHealth",
        tags: ["admin"],
        summary: "Service health, KB connection test, extract strategy and model",
        description:
          "A live round trip to the Knowledge Box plus the operator's view of this process: " +
          "uptime, the effective extract strategy and generative model, document counts by status " +
          "(including `degraded`, records that finished but lost a stage) and the mean grounding " +
          "score across stored records.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["ok", "version", "arag"],
            properties: {
              ok: { type: "boolean" },
              version: { type: "string" },
              uptimeSec: { type: "number" },
              arag: { type: "object", additionalProperties: true },
              extractStrategy: { type: ["string", "null"] },
              generativeModel: { type: "string" },
              groundingScore: {
                type: ["number", "null"],
                description: "Mean grounding score across stored records; null when none has one.",
              },
              documents: {
                type: "object",
                additionalProperties: { type: "number" },
                description:
                  "Counts by status plus `degraded`: records that finished but lost a stage " +
                  "(see the record's `meta.stageErrors`).",
              },
            },
            additionalProperties: true,
          }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/config": {
      get: {
        operationId: "adminConfig",
        tags: ["admin"],
        summary: "Effective configuration (secrets redacted)",
        description:
          "What this process is running with: the environment with every secret redacted, the " +
          "effective branding and how to change it, the extraction configurations and their " +
          "provisioning state, the JSON stores on disk, and the registered route table. For the " +
          "editable view of the same configuration, use `GET /api/v1/admin/settings`.",
        responses: {
          200: jsonResponse({ type: "object", additionalProperties: true }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/usage": {
      get: {
        operationId: "adminUsage",
        tags: ["admin"],
        summary: "Usage counters (requests, ARAG calls, jobs, documents)",
        description:
          "Counters since boot: HTTP requests, calls to ARAG split into failures, expected " +
          "provisioning conflicts and other client errors, total ARAG time, plus document and job " +
          "counts. Intended for an operator's dashboard, not for billing.",
        responses: {
          200: jsonResponse({ type: "object", additionalProperties: true }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/logs": {
      get: {
        operationId: "adminLogs",
        tags: ["admin"],
        summary: "Page the runtime log ring buffer",
        description:
          "Records are returned oldest first. Without a cursor you get the newest `limit` records " +
          "(the tail, as before). With `cursor` and `direction` you walk the buffer in either " +
          "direction on a stable sequence number, so records arriving while an operator reads " +
          "cannot duplicate or hide a row. Follow `prevCursor` with `direction=older` to read " +
          "back, and `nextCursor` with `direction=newer` to tail.",
        parameters: [
          {
            name: "level",
            in: "query",
            description: "Minimum level to include.",
            schema: { type: "string", enum: ["debug", "info", "warn", "error"] },
          },
          {
            name: "contains",
            in: "query",
            description: "Case-insensitive substring match over the whole record.",
            schema: { type: "string", maxLength: 200 },
          },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
          {
            name: "cursor",
            in: "query",
            description: "Opaque cursor from a previous page's `nextCursor`/`prevCursor`.",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "direction",
            in: "query",
            description: "Which way to walk from the cursor. Ignored when no cursor is given.",
            schema: { type: "string", enum: ["older", "newer"], default: "older" },
          },
        ],
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/LogPage" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/search-configurations": {
      get: {
        operationId: "adminSearchConfigurations",
        tags: ["admin"],
        summary: "Read the stored ARAG search configurations this product provisions",
        description:
          "Fetches the `dip_*` search configurations straight from the Knowledge Box, so an " +
          "operator can confirm which model, RAG strategy, prompt and answer_json_schema the " +
          "extraction agents are actually running against — without opening the ARAG dashboard.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "kind"],
                  properties: {
                    name: { type: "string" },
                    kind: { type: "string" },
                    config: { type: "object", additionalProperties: true },
                  },
                },
              },
              other: {
                type: "array",
                items: { type: "string" },
                description: "Names of search configurations in the KB that this product did not create.",
              },
            },
          }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/security": {
      get: {
        operationId: "adminSecurity",
        tags: ["admin"],
        summary: "What is protecting this deployment",
        description:
          "Credentials in force, rate limits, CORS, upload ceiling and retention default, in " +
          "one shape. Key values are never returned — only how many there are and the last four " +
          "characters of each, which is what an operator needs to tell two keys apart.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/SecurityPosture" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/provision": {
      post: {
        operationId: "adminProvision",
        tags: ["admin"],
        summary: "Re-provision every extraction configuration's Knowledge Box objects",
        description:
          "Idempotent: safe to re-run after a Knowledge Box reset, a model change or an upgrade. " +
          "Each configuration is POSTed and, when it already exists, PATCHed — so the stored " +
          "search configurations end up carrying the current model, reranker, prompt and JSON " +
          "schema whatever state they were in. Each configuration's key-value schema is " +
          "ensured in the same pass and reported as `keyValueSchema`; the 20-schemas-per-" +
          "Knowledge-Box ceiling is checked once for the whole run rather than per config.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items", "ok", "failed"],
            properties: {
              ok: { type: "integer" },
              failed: { type: "integer" },
              items: { type: "array", items: { $ref: "#/components/schemas/ProvisionResult" } },
            },
          }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/purge": {
      post: {
        operationId: "adminPurge",
        tags: ["admin"],
        summary: "Delete documents older than N days from the store and the Knowledge Box",
        description:
          "With `dryRun: true` nothing is deleted: the response reports how many documents " +
          "would go and the date range they span, so a confirmation dialog can state the blast " +
          "radius instead of guessing at it.",
        requestBody: jsonBody({
          type: "object",
          properties: {
            olderThanDays: { type: "number", minimum: 0, maximum: 3650, default: 30 },
            dryRun: { type: "boolean", default: false },
          },
          additionalProperties: false,
        }),
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["deleted", "failed"],
            properties: {
              olderThanDays: { type: "number" },
              dryRun: { type: "boolean" },
              wouldDelete: { type: "integer" },
              oldest: { type: ["string", "null"], format: "date-time" },
              newest: { type: ["string", "null"], format: "date-time" },
              ids: { type: "array", items: { type: "string" } },
              deleted: { type: "array", items: { type: "string" } },
              failed: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, error: { type: "string" } },
                },
              },
            },
          }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },

    // ─── settings, API keys and audit ─────────────────────────────────────────
    // Operator surface for the full-implementation pass. Its own section so the
    // key-value-field and API-explorer operations landing in this document merge cleanly.

    "/api/v1/admin/settings": {
      get: {
        operationId: "adminGetSettings",
        tags: ["admin", "settings"],
        summary: "Every setting, with its effective value, source and secret state",
        description:
          "The settings screen reads this. For each field it reports the effective value, whether " +
          "that value came from an in-product edit (`store`), the deployment's environment (`env`) " +
          "or the built-in default, and whether the field is a secret — secrets report " +
          "`{ set, hint }` and never their value. `applied` reports what the running process is " +
          "actually using (the ARAG client's KB and timeout, the live rate limiter, the upload " +
          "ceiling, the retention scheduler), which is how the UI shows that an edit took effect " +
          "without a restart.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/SettingsDocument" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
      patch: {
        operationId: "adminUpdateSettings",
        tags: ["admin", "settings"],
        summary: "Change settings; they take effect immediately, with no restart",
        description:
          "Validates every field before writing anything: a colour outside the platform's strict " +
          "grammar, a Knowledge Box id that is not a UUID or a number outside its range fails the " +
          "whole patch with an RFC 9457 problem naming each offending key. Applied changes are " +
          "persisted in the product's store (so they survive a restart and override the " +
          "environment), pushed into the live objects — the ARAG client is rebuilt when a " +
          "connection field changes — and written to the audit log with who, what and when. " +
          "Secrets are accepted here and never returned anywhere.",
        requestBody: jsonBody({ $ref: "#/components/schemas/SettingsPatch" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/SettingsPatchResult" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/settings/reset": {
      post: {
        operationId: "adminResetSettings",
        tags: ["admin", "settings"],
        summary: "Drop in-product overrides and fall back to the environment default",
        description:
          "The other half of “environment variables are defaults that the store overrides”: this " +
          "removes the stored override for the named keys, so each field's `source` returns to " +
          "`env` (or `default`). Audited like any other settings change.",
        requestBody: jsonBody({ $ref: "#/components/schemas/SettingsResetRequest" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/SettingsPatchResult" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/branding/logo": {
      post: {
        operationId: "adminUploadBrandingLogo",
        tags: ["admin", "settings"],
        summary: "Upload a logo and point branding at it",
        description:
          "Accepts a `multipart/form-data` body with a `file` part (SVG, PNG, JPEG, WebP or GIF, " +
          "up to 2 MB), writes it into `DATA_DIR/branding/` — a mounted volume in production, so " +
          "rebranding never needs a rebuild — and sets `branding.logoUrl` to the `/branding/…` " +
          "path it is served from. Returns the new asset and the updated settings document.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: {
          201: jsonResponse({ $ref: "#/components/schemas/BrandingAsset" }, "Created"),
          413: {
            description: "The file is larger than the 2 MB brand-asset ceiling",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          415: {
            description: "Not an image type this product will serve",
            content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
          },
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/api-keys": {
      get: {
        operationId: "adminListApiKeys",
        tags: ["admin", "api-keys"],
        summary: "List API keys with their last use",
        description:
          "Never returns a key or its digest: an operator identifies a key by its name and prefix. " +
          "`lastUsedAt` is updated on successful authentication (in memory, folded into the store " +
          "at most once a minute per key, so authentication never costs a write). Revoked keys stay " +
          "listed so the history is readable.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } },
              enforced: {
                type: "boolean",
                description: "Whether reads currently require a credential (`security.requireApiKey`)",
              },
              seeded: {
                type: "integer",
                description: "Keys supplied by the `API_KEYS` environment variable, which still authenticate",
              },
            },
          }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
      post: {
        operationId: "adminCreateApiKey",
        tags: ["admin", "api-keys"],
        summary: "Create an API key (the plaintext is returned once)",
        description:
          "Mints `dip_<id>_<secret>` and stores only a salted SHA-256 digest of the secret. The " +
          "response is the one and only place the key appears — it cannot be recovered afterwards, " +
          "only revoked and replaced. The key authenticates exactly like an `API_KEYS` entry: as " +
          "`X-API-Key`, as a bearer token, and as a writer credential for the operations DP-12 " +
          "protects.",
        requestBody: jsonBody({ $ref: "#/components/schemas/ApiKeyCreateRequest" }),
        responses: {
          201: jsonResponse({ $ref: "#/components/schemas/ApiKeyCreated" }, "Created"),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/api-keys/{id}": {
      delete: {
        operationId: "adminRevokeApiKey",
        tags: ["admin", "api-keys"],
        summary: "Revoke an API key",
        description:
          "The key stops authenticating on the next request. The record is kept (with `revokedAt`) " +
          "so the audit trail still explains what that key did.",
        parameters: [idParam],
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/ApiKey" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },
    "/api/v1/admin/audit": {
      get: {
        operationId: "adminAuditLog",
        tags: ["admin", "audit"],
        summary: "Page the audited-change log",
        description:
          "Who changed what, and when — every settings edit, API-key creation and revocation, " +
          "extraction-config create/edit/delete/provision, field corrections, purge and " +
          "document delete, newest " +
          "first. Secret values are redacted to `***` before the entry is written. Paging is by a " +
          "stable sequence number: follow `nextCursor` with `direction=older` to read back through " +
          "history and `prevCursor` with `direction=newer` to return, with no duplicates or gaps " +
          "however many entries arrive in between.",
        parameters: [
          {
            name: "action",
            in: "query",
            description:
              "Exact action, or a prefix such as `settings` to match `settings.update` and `settings.reset`.",
            schema: { type: "string", maxLength: 80 },
          },
          {
            name: "actor",
            in: "query",
            description: "Actor name or type (`admin`, `api-key`, `session`, `anonymous`, `system`).",
            schema: { type: "string", maxLength: 120 },
          },
          {
            name: "target",
            in: "query",
            description: "Exact target: a setting key, key id, config id or document id.",
            schema: { type: "string", maxLength: 200 },
          },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
          {
            name: "cursor",
            in: "query",
            description: "Opaque cursor from a previous page.",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "direction",
            in: "query",
            description: "Walk older (further back) or newer (back towards the top) from the cursor.",
            schema: { type: "string", enum: ["older", "newer"], default: "older" },
          },
        ],
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/AuditPage" }),
          ...standardResponses,
        },
        security: adminSecurity,
      },
    },

    // ─── end settings, API keys and audit ─────────────────────────────────────

    // ─── key-value fields, generator agents and human review ──────────────────

    "/api/v1/documents/{id}/fields/{key}": {
      parameters: [idParam, fieldKeyParam],
      put: {
        operationId: "correctDocumentField",
        tags: ["review", "documents"],
        summary: "Correct one extracted field",
        description:
          "Records a correction rather than overwriting the model's output: the original " +
          "value, the original quote and who changed it are all kept. The corrected value is " +
          "re-checked against the document's own text with the same evidence contract the " +
          "pipeline uses — a human typing a value does not make it grounded, but if the value " +
          "they typed *is* in the document that is worth knowing, so the correction earns a " +
          "new quote and the field's model confidence is dropped (the model did not produce " +
          "this value and claiming its confidence would be a lie on the most-read number in " +
          "the record view).\n\n" +
          "The corrected record is also written back into the resource's key-value field. " +
          "Because a key-value write replaces the whole schema's data, the *entire* current " +
          "record is sent, not just the one field — and because the Knowledge Box's filter " +
          "index keeps every value ever written, this second write leaves the resource still " +
          "matching a filter on the value it replaced. That is reported on " +
          "`correction.kv.filterIndexStale` and `meta.kv.superseded` rather than hidden.\n\n" +
          "A write against shared state, so it needs a credential even when `API_KEYS` is " +
          "unset: an API key, the admin token, or a same-origin session cookie.",
        requestBody: jsonBody({ $ref: "#/components/schemas/FieldCorrectionRequest" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/FieldCorrectionResult" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      delete: {
        operationId: "revertDocumentField",
        tags: ["review", "documents"],
        summary: "Undo the most recent correction to a field",
        description:
          "Restores the value the last correction replaced — as a *new* correction, so the " +
          "history stays append-only and the revert is as attributable as the change it " +
          "undoes. The restored value is re-verified against the document like any other " +
          "correction, and written back to the Knowledge Box the same way (with the same " +
          "filter-index consequence). Answers 400 when the field has never been corrected.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/FieldCorrectionResult" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/corrections": {
      parameters: [idParam],
      get: {
        operationId: "listDocumentCorrections",
        tags: ["review", "documents"],
        summary: "The corrections made to one record, newest first",
        description:
          "The record's review history: every value a person changed, what it was before, why " +
          "they say they changed it, whether the new value could be verified against the " +
          "document, and whether it reached the Knowledge Box. The same list is on the record " +
          "itself as `corrections` (oldest first); this is the reading order a review panel wants.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/FieldCorrection" } },
            },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/ask": {
      post: {
        operationId: "askCorpus",
        tags: ["review", "documents"],
        summary: "Ask one grounded question across a filtered set of documents",
        description:
          "The same grounded ask the record view offers, with the scope widened from one " +
          "document to a filtered set of them — and the filter is the Documents list's own, so " +
          "“ask the twelve invoices from last week” is the list already on screen. Citations " +
          "come back mapped to this product's document ids, so “show me where” still works " +
          "across documents.\n\n" +
          "Retrieval over the set, not `full_resource`: across dozens of documents that would " +
          "be an enormous prompt and a slow, expensive call. Every ask is a real generative " +
          "call against the Knowledge Box, so this route has its own tight rate-limit bucket.",
        requestBody: jsonBody({ $ref: "#/components/schemas/CorpusAskRequest" }),
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/CorpusAnswer" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/extraction-configs/{id}/generator": {
      parameters: [idParam],
      post: {
        operationId: "startConfigGenerator",
        tags: ["generators", "extraction-configs"],
        summary: "Provision and start a Data Augmentation generator agent for this configuration",
        description:
          "The alternative extraction path: instead of this product asking the document a " +
          "question per upload, ARAG runs a task of its own that sweeps resources and writes " +
          "the values it extracts straight into this configuration's key-value schema. The " +
          "schema's field descriptions are the instructions, which is why they are carried " +
          "across verbatim when the schema is provisioned.\n\n" +
          "The agent writes into its **own** key-value schema (`<config schema>_gen`), " +
          "provisioned on demand when the agent is started — not the schema the pipeline " +
          "writes into. A key-value write is a full replace, so one shared schema would mean " +
          "a sweep silently erasing the pipeline's values and polluting the resource's filter " +
          "index; it also costs one more of the Knowledge Box's 20 key-value schemas, which is " +
          "why it is not provisioned for every configuration at boot.\n\n" +
          "ARAG allows only one running `ask` task per destination and the destination is that " +
          "key-value schema, so starting again replaces the existing agent (stopped first — a " +
          "running task cannot be deleted, which answers 409). Answers 400 when the " +
          "configuration's key-value schema is not provisioned, because the agent's schema is " +
          "derived from it.\n\n" +
          "Note on what is verified: provisioning, the start → stop → delete lifecycle and " +
          "reading generated values back were all confirmed against the live Knowledge Box. " +
          "End-to-end write latency was **not** — every run started there was still scheduled " +
          "after 20 minutes — so this returns as soon as the task is accepted and the caller polls.",
        requestBody: jsonBody(
          {
            type: "object",
            properties: {
              model: {
                type: "string",
                maxLength: 80,
                description: "Generative model for the agent. Defaults to the configured one.",
              },
            },
            additionalProperties: false,
          },
          false,
        ),
        responses: {
          202: jsonResponse({ $ref: "#/components/schemas/GeneratorAgent" }, "Started"),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      get: {
        operationId: "getConfigGenerator",
        tags: ["generators", "extraction-configs"],
        summary: "The generator agent running for this configuration, if any",
        description:
          "There is no per-task GET on the platform (it answers 405), so the state is found by " +
          "locating the task id in the buckets of the Knowledge Box's task list. `agent` is " +
          "null when this workspace has not started one.",
        responses: {
          200: jsonResponse({
            type: "object",
            required: ["agent"],
            properties: {
              agent: {
                anyOf: [{ $ref: "#/components/schemas/GeneratorAgent" }, { type: "null" }],
              },
            },
          }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
      delete: {
        operationId: "deleteConfigGenerator",
        tags: ["generators", "extraction-configs"],
        summary: "Stop and delete this configuration's generator agent",
        description:
          "Stops the task first and then deletes it, because ARAG refuses to delete a running " +
          "task. The values the agent has already written stay on their resources — deleting " +
          "the agent stops future writes, it does not retract past ones. Requires a writer " +
          "credential.",
        responses: { 204: { description: "Deleted" }, ...standardResponses },
        security: apiSecurity,
      },
    },
    "/api/v1/extraction-configs/{id}/generator/stop": {
      parameters: [idParam],
      post: {
        operationId: "stopConfigGenerator",
        tags: ["generators", "extraction-configs"],
        summary: "Stop a running generator agent without deleting it",
        description:
          "Halts a sweep in progress while keeping the task, so it can be inspected in the " +
          "ARAG dashboard before it is removed. Stopping is idempotent: a task that is already " +
          "stopped, or already gone, is not an error. Requires a writer credential.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/GeneratorAgent" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/generator-run": {
      parameters: [idParam],
      post: {
        operationId: "runDocumentGenerator",
        tags: ["generators", "documents"],
        summary: "Run the generator agent over this one document",
        description:
          "There is no “run this task on that document” call on the platform, so a " +
          "single-document run is a task filtered to one resource id — which is also the only " +
          "safe way to keep a run from sweeping the whole Knowledge Box. Returns 202 with the " +
          "task; poll `GET /api/v1/extraction-configs/{id}/generator` for its state and read " +
          "the result with the comparison endpoint. Requires a writer credential: it starts " +
          "real model work against the Knowledge Box.",
        requestBody: jsonBody(
          {
            type: "object",
            properties: { model: { type: "string", maxLength: 80 } },
            additionalProperties: false,
          },
          false,
        ),
        responses: {
          202: jsonResponse({ $ref: "#/components/schemas/GeneratorAgent" }, "Started"),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },
    "/api/v1/documents/{id}/generator-comparison": {
      parameters: [idParam],
      get: {
        operationId: "compareDocumentGenerator",
        tags: ["generators", "documents"],
        summary: "This product's extraction beside the generator agent's, field by field",
        description:
          "The record view's answer to “which path should I use?”, with agreement or " +
          "disagreement marked per field.\n\n" +
          "The two columns are **not** equivalent and the payload says so rather than leaving " +
          "it to be inferred from a layout: the evidence contract applies to this product's " +
          "path only. Its values carry a verbatim quote checked against the document's own " +
          "text; a generator agent returns values and no quote, so every `generator.evidence` " +
          "is `null` and `evidenceContract.generator` states that those values are not " +
          "grounded to the same standard.\n\n" +
          "`observed` is the same honesty about this product's own testing: provisioning, the " +
          "task lifecycle and reading values back were verified against the live Knowledge " +
          "Box; end-to-end write latency was not.",
        responses: {
          200: jsonResponse({ $ref: "#/components/schemas/GeneratorComparison" }),
          ...standardResponses,
        },
        security: apiSecurity,
      },
    },

    // ─── end key-value fields, generator agents and human review ──────────────
  },
});
