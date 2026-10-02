/**
 * Key-value (kv) fields — typed, schema-validated structured metadata on ARAG resources.
 *
 * A kv schema is a Knowledge-Box-scoped declaration of typed fields; kv *data* is written
 * onto a resource under the schema's id and is then filterable in `/find` and `/ask`. This
 * is the durable, queryable counterpart to the product's extraction records: the same
 * fields the visual LLM pulls out of a document can be persisted as kv values so they can
 * be filtered on later ("every invoice over $10k from Acme") without re-reading documents.
 *
 * The vendored platform `AragClient` has no kv support (see docs/architecture/arag-integration.md
 * — "Platform gap"), so everything here goes through its generic `request()` method. Nothing
 * in `vendor/` is forked or edited.
 *
 * Every shape below was verified against the live Knowledge Box on 2026-09-13; the captured
 * requests and responses are reproduced in the architecture doc. The notable live facts the
 * public documentation does not state:
 *
 *   - field ids ARE the declared `key` — no slugging, no generated ids. The accepted pattern
 *     is `^[^/.]{1,64}$`, i.e. anything except `/` and `.`, so spaces and capitals survive.
 *   - `repeated` is only valid on `text`; `range` only on `integer`/`float`/`date`.
 *   - kv filters work on `/find` and `/ask` but NOT on `/catalog`, and kv fields are not facetable.
 *   - a resource's kv values are read back under `data.key_values.<schemaId>.value.data` —
 *     note the extra `.value` wrapper that the write shape does not have.
 */
import type { AragClient, Logger } from "../../vendor/arag-platform/src/index.ts";
import { AragError } from "../../vendor/arag-platform/src/index.ts";
import type { ExtractionSchema, JsonProp } from "./schemas.ts";

// ─── limits and constraints (all verified live) ───────────────────────────────

/** A Knowledge Box holds at most 20 kv schemas. */
export const MAX_KV_SCHEMAS_PER_KB = 20;
/** Each kv schema holds at most 50 fields (enforced server-side with a 422). */
export const MAX_KV_FIELDS_PER_SCHEMA = 50;
/** Schema ids and field keys must match this exactly — `/` and `.` are the only bans. */
export const KV_NAME_PATTERN = /^[^/.]{1,64}$/;
/** `repeated: true` is accepted only on these types. */
export const REPEATABLE_TYPES: readonly KvFieldType[] = ["text"];
/** `range: true` is accepted only on these types. */
export const RANGEABLE_TYPES: readonly KvFieldType[] = ["integer", "float", "date"];

// ─── types ────────────────────────────────────────────────────────────────────

export type KvFieldType = "text" | "integer" | "float" | "boolean" | "date";

/** A closed interval stored by a `range: true` field. `lower` must be strictly < `upper`. */
export interface KvRange {
  lower: string | number;
  upper: string | number;
}

/** Every value a kv field can hold. `string[]` only for `repeated`, `KvRange` only for `range`. */
export type KvValue = string | string[] | number | boolean | KvRange;

/** The `data` map written under one schema id. */
export type KvData = Record<string, KvValue>;

export interface KvSchemaField {
  key: string;
  type: KvFieldType;
  /** Free text. This is what guides a Data Augmentation generator agent's extraction. */
  description?: string;
  required?: boolean;
  range?: boolean;
  repeated?: boolean;
}

export interface KvSchema {
  id: string;
  description?: string;
  fields: KvSchemaField[];
}

/** Body accepted by `PATCH /kb/{kb}/kv-schemas/{id}` — `id` is immutable. */
export interface KvSchemaUpdate {
  description?: string;
  fields?: KvSchemaField[];
}

// ─── errors ───────────────────────────────────────────────────────────────────

/** What went wrong in a kv validation failure, normalised from ARAG's two 422 dialects. */
export type KvErrorKind =
  | "type_mismatch" // wrong value type for the declared field type
  | "missing_required" // a `required: true` field was absent
  | "unknown_key" // a key not declared in the schema
  | "range_bounds" // lower >= upper
  | "too_many_fields" // > 50 fields in a schema
  | "too_many_schemas" // > 20 schemas in the KB
  | "invalid_name" // id/key fails KV_NAME_PATTERN
  | "invalid_modifier" // repeated/range on a type that does not allow it
  | "duplicate_key" // two fields share a key
  | "unknown"; // anything else ARAG rejected

/**
 * A kv write or schema change that ARAG refused (or that we refused before sending).
 *
 * ARAG returns 422 in two different shapes: a plain `{"detail": "<sentence>"}` for semantic
 * schema violations, and FastAPI's `{"detail": [{loc, msg, type}, …]}` for body-shape
 * violations. `fromAragError` normalises both so the product can say which field is wrong
 * rather than surfacing a raw upstream blob.
 */
export class KvValidationError extends Error {
  readonly kind: KvErrorKind;
  /** Field key at fault, when the error identifies one. */
  readonly field: string | undefined;
  readonly schemaId: string | undefined;
  /** Declared type, when the error is a type mismatch. */
  readonly expected: string | undefined;
  /** What was actually supplied. */
  readonly got: string | undefined;
  readonly status: number | undefined;
  /** The upstream detail, trimmed, for logs. */
  readonly detail: string | undefined;

  constructor(
    message: string,
    kind: KvErrorKind,
    opts: {
      field?: string;
      schemaId?: string;
      expected?: string;
      got?: string;
      status?: number;
      detail?: string;
    } = {},
  ) {
    super(message);
    this.name = "KvValidationError";
    this.kind = kind;
    this.field = opts.field;
    this.schemaId = opts.schemaId;
    this.expected = opts.expected;
    this.got = opts.got;
    this.status = opts.status;
    this.detail = opts.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      field: this.field,
      schemaId: this.schemaId,
      expected: this.expected,
      got: this.got,
      status: this.status,
    };
  }
}

/** Semantic 422s ARAG phrases as sentences, with the patterns that identify each. */
const SENTENCE_RULES: Array<{
  re: RegExp;
  kind: KvErrorKind;
  build: (m: RegExpMatchArray) => { field?: string; schemaId?: string; expected?: string; got?: string };
}> = [
  {
    // Key 'v_int' in schema 'dip_verify_all' expects type 'integer', got str
    re: /^Key '([^']+)' in schema '([^']+)' expects type '([^']+)', got (.+)$/,
    kind: "type_mismatch",
    build: (m) => ({ field: m[1], schemaId: m[2], expected: m[3], got: m[4]?.trim() }),
  },
  {
    // Missing required keys for schema 'dip_verify_all': ['v_text']
    re: /^Missing required keys for schema '([^']+)': \[(.*)\]$/,
    kind: "missing_required",
    build: (m) => ({ schemaId: m[1], field: firstQuoted(m[2] ?? "") }),
  },
  {
    // Unknown keys for schema 'dip_verify_all': ['nope']
    re: /^Unknown keys for schema '([^']+)': \[(.*)\]$/,
    kind: "unknown_key",
    build: (m) => ({ schemaId: m[1], field: firstQuoted(m[2] ?? "") }),
  },
];

function firstQuoted(list: string): string | undefined {
  return /'([^']+)'/.exec(list)?.[1];
}

/** Map a FastAPI validation entry to a kind. */
function kindFromDetailEntry(msg: string, loc: string[]): KvErrorKind {
  if (/must be < than its upper endpoint|must be >= than gte/.test(msg)) return "range_bounds";
  if (/at most 50 items/.test(msg)) return "too_many_fields";
  if (/should match pattern/.test(msg)) return "invalid_name";
  if (/is not an allowed (repeated|range) type/.test(msg)) return "invalid_modifier";
  if (/field keys must be unique/.test(msg)) return "duplicate_key";
  if (loc.includes("fields") || loc.includes("data")) return "type_mismatch";
  return "unknown";
}

/**
 * Turn an `AragError` carrying a 422 body into a `KvValidationError`.
 * Non-422 errors (and unparseable bodies) are returned unchanged for the caller to rethrow.
 */
export function kvErrorFrom(err: unknown, schemaId?: string): KvValidationError | undefined {
  if (!(err instanceof AragError) || err.status !== 422) return undefined;
  const detail = parseDetail(err.detail);
  if (typeof detail === "string") {
    for (const rule of SENTENCE_RULES) {
      const m = rule.re.exec(detail);
      if (!m) continue;
      const parts = rule.build(m);
      return new KvValidationError(detail, rule.kind, {
        ...parts,
        schemaId: parts.schemaId ?? schemaId,
        status: 422,
        detail,
      });
    }
    return new KvValidationError(detail, "unknown", { schemaId, status: 422, detail });
  }
  if (Array.isArray(detail) && detail.length > 0) {
    // Pydantic emits one entry per union member for a single bad value; the last entry is
    // the most specific (the real constraint), so prefer a recognised kind over "unknown".
    let best: KvValidationError | undefined;
    for (const raw of detail) {
      const entry = raw as { msg?: unknown; loc?: unknown; type?: unknown };
      const msg = String(entry.msg ?? "");
      const loc = Array.isArray(entry.loc) ? entry.loc.map((x) => String(x)) : [];
      const kind = kindFromDetailEntry(msg, loc);
      const field = fieldFromLoc(loc);
      const candidate = new KvValidationError(msg || "kv validation failed", kind, {
        field,
        schemaId,
        status: 422,
        detail: JSON.stringify(raw).slice(0, 400),
      });
      if (kind !== "unknown" && kind !== "type_mismatch") return candidate;
      best ??= candidate;
    }
    return best;
  }
  return new KvValidationError(err.detail ?? err.message, "unknown", { schemaId, status: 422 });
}

/** `["body","data","v_int"]` → `v_int`; `["body","fields",0,"key"]` → `fields[0]`. */
function fieldFromLoc(loc: string[]): string | undefined {
  const dataAt = loc.indexOf("data");
  if (dataAt >= 0 && loc[dataAt + 1]) return loc[dataAt + 1];
  const fieldsAt = loc.indexOf("fields");
  if (fieldsAt >= 0 && loc[fieldsAt + 1] !== undefined) return `fields[${loc[fieldsAt + 1]}]`;
  return loc.length > 1 ? loc[loc.length - 1] : undefined;
}

function parseDetail(detail: string | undefined): unknown {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as { detail?: unknown };
    return parsed?.detail ?? parsed;
  } catch {
    return detail;
  }
}

/** Rethrow an ARAG failure as a `KvValidationError` when it is one, else as-is. */
function rethrow(err: unknown, schemaId?: string): never {
  const kv = kvErrorFrom(err, schemaId);
  throw kv ?? err;
}

// ─── filter expressions ───────────────────────────────────────────────────────

/** A leaf kv filter. Exactly one of `eq`, `gte`/`lte`, `contains` is meaningful. */
export interface KvLeafFilter {
  schema_id: string;
  key: string;
  eq?: string | number | boolean;
  gte?: string | number;
  lte?: string | number;
  contains?: string | number;
}

export type KvFilterExpression =
  | KvLeafFilter
  | { and: KvFilterExpression[] }
  | { or: KvFilterExpression[] }
  | { not: KvFilterExpression };

/** The `filter_expression` object accepted by `/find` and `/ask`. */
export interface KvFilterEnvelope {
  key_value: KvFilterExpression;
  operator?: "and" | "or";
}

/**
 * Build the `filter_expression` for a kv match, verified live on `/find` and `/ask`.
 *
 * ```ts
 * find({ query, filter_expression: kvFilter({ schemaId: "invoice", key: "vendor", eq: "Acme" }) })
 * ```
 *
 * Operator support is per-field-kind and is enforced by ARAG with a 412, so pick correctly:
 *   - `eq`        scalar fields (text/integer/float/boolean/date). NOT repeated fields.
 *   - `gte`/`lte` integer/float/date scalars. NOT range fields, NOT text.
 *   - `contains`  `repeated: true` text fields (membership) and `range: true` fields
 *                 (is the value inside the stored interval). NOT plain scalars.
 */
export function kvFilter(
  spec: KvFilterExpression | KvFilterExpression[],
  opts: { operator?: "and" | "or" } = {},
): KvFilterEnvelope {
  const key_value = Array.isArray(spec)
    ? spec.length === 1
      ? (spec[0] as KvFilterExpression)
      : { and: spec }
    : spec;
  return opts.operator ? { key_value, operator: opts.operator } : { key_value };
}

/** `and` / `or` / `not` combinators, for readability at call sites. */
export const kvAnd = (...parts: KvFilterExpression[]): KvFilterExpression => ({ and: parts });
export const kvOr = (...parts: KvFilterExpression[]): KvFilterExpression => ({ or: parts });
export const kvNot = (part: KvFilterExpression): KvFilterExpression => ({ not: part });

// ─── the `kv=` query parameter ────────────────────────────────────────────────

/** The four operators a caller can filter with. Each is legal on some field kinds only. */
export const KV_OPERATORS = ["eq", "gte", "lte", "contains"] as const;
export type KvOperator = (typeof KV_OPERATORS)[number];

/** One parsed `kv=<schemaId>:<key>:<op>:<value>` filter, before it is checked against a schema. */
export interface KvFilterSpec {
  schemaId: string;
  key: string;
  op: KvOperator;
  value: string;
}

/**
 * Parse one `kv` query parameter.
 *
 * The shape is `<schemaId>:<key>:<op>:<value>` and only the first three colons separate —
 * the value keeps the rest, because an RFC 3339 instant (`2026-01-15T00:00:00Z`) is full of
 * them and a date range is exactly what this parameter exists for.
 *
 * Throws `KvValidationError` with a message naming what was wrong, so the route can answer
 * 400 with something a caller can act on rather than letting ARAG answer 412.
 */
export function parseKvFilterParam(raw: string): KvFilterSpec {
  const parts = splitN(String(raw), ":", 4);
  if (parts.length < 4) {
    throw new KvValidationError(
      `kv filter "${raw}" is malformed — use kv=<schemaId>:<field>:<${KV_OPERATORS.join("|")}>:<value>`,
      "unknown",
    );
  }
  const [schemaId, key, op, value] = parts as [string, string, string, string];
  if (!KV_OPERATORS.includes(op as KvOperator)) {
    throw new KvValidationError(
      `kv filter "${raw}" uses operator "${op}"; supported operators are ${KV_OPERATORS.join(", ")}`,
      "unknown",
      { schemaId, field: key },
    );
  }
  if (!schemaId || !key) {
    throw new KvValidationError(`kv filter "${raw}" needs both a schema id and a field key`, "unknown");
  }
  return { schemaId, key, op: op as KvOperator, value };
}

function splitN(input: string, sep: string, limit: number): string[] {
  const out: string[] = [];
  let rest = input;
  for (let i = 0; i < limit - 1; i++) {
    const at = rest.indexOf(sep);
    if (at === -1) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  out.push(rest);
  return out;
}

/**
 * Turn a parsed spec into a leaf filter, checking the operator against the field's declared
 * kind first. ARAG enforces the same rules with a **412**, which reaches a caller as an
 * opaque upstream failure; checking here means the answer is a 400 that says which operator
 * that field does accept.
 *
 * Verified operator support, per kind:
 *   - `eq`        every scalar field (text/integer/float/boolean/date). NOT repeated, NOT range.
 *   - `gte`/`lte` integer/float/date scalars. NOT range fields, NOT text, NOT boolean.
 *   - `contains`  `repeated` text (membership) and `range` fields (is the value in the interval).
 */
export function toKvLeafFilter(spec: KvFilterSpec, schema: KvSchema): KvLeafFilter {
  const field = schema.fields.find((f) => f.key === spec.key);
  if (!field) {
    throw new KvValidationError(
      `kv schema "${schema.id}" has no field "${spec.key}" (it has: ${schema.fields.map((f) => f.key).join(", ") || "none"})`,
      "unknown_key",
      { schemaId: schema.id, field: spec.key },
    );
  }
  const kind = field.repeated ? "repeated" : field.range ? "range" : "scalar";
  const allowed = kind === "scalar" ? scalarOperators(field.type) : (["contains"] as KvOperator[]);
  if (!allowed.includes(spec.op)) {
    throw new KvValidationError(
      `kv field "${spec.key}" is a ${describeField(field)} field, which supports ${allowed.join("/")}, not "${spec.op}"`,
      "invalid_modifier",
      { schemaId: schema.id, field: spec.key, expected: allowed.join("|"), got: spec.op },
    );
  }
  const value = coerceFilterValue(spec, field);
  const leaf: KvLeafFilter = { schema_id: schema.id, key: spec.key };
  if (spec.op === "eq") leaf.eq = value;
  else if (spec.op === "gte") leaf.gte = value as string | number;
  else if (spec.op === "lte") leaf.lte = value as string | number;
  else leaf.contains = value as string | number;
  return leaf;
}

function scalarOperators(type: KvFieldType): KvOperator[] {
  return RANGEABLE_TYPES.includes(type) ? ["eq", "gte", "lte"] : ["eq"];
}

/** Coerce the raw query-string value to the field's declared type, or explain why it cannot. */
function coerceFilterValue(spec: KvFilterSpec, field: KvSchemaField): string | number | boolean {
  // A `contains` on a repeated text field matches one member, which is a string; on a range
  // field it asks "is this point inside the interval", which is the element type.
  const type = field.repeated ? "text" : field.type;
  switch (type) {
    case "integer":
    case "float": {
      const n = Number(spec.value.replace(/[^0-9.eE+-]/g, ""));
      if (!Number.isFinite(n) || !/\d/.test(spec.value)) {
        throw new KvValidationError(
          `kv filter on "${spec.key}" needs a number; got "${spec.value}"`,
          "type_mismatch",
          { schemaId: spec.schemaId, field: spec.key, expected: type, got: spec.value },
        );
      }
      return type === "integer" ? Math.trunc(n) : n;
    }
    case "boolean": {
      if (/^(true|yes|1)$/i.test(spec.value)) return true;
      if (/^(false|no|0)$/i.test(spec.value)) return false;
      throw new KvValidationError(
        `kv filter on "${spec.key}" needs true or false; got "${spec.value}"`,
        "type_mismatch",
        { schemaId: spec.schemaId, field: spec.key, expected: "boolean", got: spec.value },
      );
    }
    case "date": {
      const iso = toRfc3339(spec.value);
      if (!iso) {
        throw new KvValidationError(
          `kv filter on "${spec.key}" needs an RFC 3339 date; got "${spec.value}"`,
          "type_mismatch",
          { schemaId: spec.schemaId, field: spec.key, expected: "date", got: spec.value },
        );
      }
      return iso;
    }
    default:
      return spec.value;
  }
}

/** Does one stored kv value satisfy one leaf filter? Shared by mock mode and the unit tests. */
export function kvValueMatches(value: KvValue | undefined, leaf: KvLeafFilter): boolean {
  if (value === undefined) return false;
  if (leaf.eq !== undefined) return sameScalar(value, leaf.eq);
  if (leaf.gte !== undefined || leaf.lte !== undefined) {
    if (Array.isArray(value) || (value && typeof value === "object")) return false;
    if (leaf.gte !== undefined && !(compare(value, leaf.gte) >= 0)) return false;
    if (leaf.lte !== undefined && !(compare(value, leaf.lte) <= 0)) return false;
    return true;
  }
  if (leaf.contains !== undefined) {
    if (Array.isArray(value)) return value.some((v) => sameScalar(v, leaf.contains as string | number));
    const range = value as KvRange;
    if (range && typeof range === "object" && "lower" in range && "upper" in range) {
      return compare(range.lower, leaf.contains) <= 0 && compare(range.upper, leaf.contains) >= 0;
    }
    return false;
  }
  return false;
}

function sameScalar(a: unknown, b: string | number | boolean): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return String(a) === String(b);
}

function compare(a: string | number | boolean, b: string | number | boolean): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// ─── JSON Schema → kv schema mapping ──────────────────────────────────────────

/**
 * The result of projecting an extraction config onto a kv schema.
 *
 * `fieldIds` maps the product's property name → the kv field key actually used, and
 * `names` is its inverse. They differ only when a property name contains `/` or `.` (which
 * ARAG rejects) or exceeds 64 characters, so values can always be round-tripped.
 */
export interface KvSchemaMapping {
  schema: KvSchema;
  /** property name → kv field key */
  fieldIds: Record<string, string>;
  /** kv field key → property name */
  names: Record<string, string>;
}

/**
 * Normalise a property name into a kv field key ARAG accepts.
 *
 * Live rule: `^[^/.]{1,64}$`. Only `/` and `.` are forbidden and the cap is 64 characters,
 * so — unlike a slug — spaces, capitals, hyphens and non-ASCII all survive untouched. This
 * keeps the mapping as close to an identity as the platform allows.
 */
export function toKvFieldKey(name: string): string {
  const cleaned = name.replace(/[/.]+/g, "_").trim() || "field";
  return cleaned.slice(0, 64);
}

/** Map one JSON-Schema property to a kv field type. */
export function jsonPropToKvType(prop: JsonProp | { type?: string; format?: string }): KvFieldType {
  const p = prop as { type?: string; format?: string };
  switch (p.type) {
    case "integer":
      return "integer";
    case "number":
      return "float";
    case "boolean":
      return "boolean";
    default:
      return p.format === "date" || p.format === "date-time" ? "date" : "text";
  }
}

/**
 * Project a product extraction schema onto an ARAG kv schema.
 *
 * Type mapping: `string`→text, `integer`→integer, `number`→float, `boolean`→boolean,
 * `string` with `format: "date"`→date, `array`→the item type marked `repeated`.
 * `description` carries over verbatim — it is what a Data Augmentation generator agent
 * reads to decide what to extract into each key, so it is the highest-value part of the map.
 * `required` follows the schema's `required` list. `minimum`/`maximum` on a numeric property
 * mark the field `range: true`.
 *
 * The derivation is only the **default**. A property carrying a `kv` annotation
 * (`JsonProp.kv`) overrides it, because the JSON-Schema type is not always the right kv
 * type: money is captured as a string so the original formatting survives, but has to be a
 * `float` in the Knowledge Box or "every invoice over $10k" cannot be a filter. An override
 * that ARAG would reject — `repeated` on anything but text, `range` on anything but
 * integer/float/date — throws here rather than at the Knowledge Box.
 *
 * Caveat worth knowing at the call site: ARAG's `range` means the field *stores an interval*
 * (`{lower, upper}`), not that a scalar is bounded. A property mapped to a range field must
 * therefore be written as a `KvRange`, never as a bare number — `toKvData` enforces this.
 *
 * Throws `KvValidationError` when the config cannot be represented: more than 50 fields, a
 * name collision after normalisation, or a modifier the platform rejects for that type.
 */
export function schemaToKvSchema(
  schema: ExtractionSchema,
  opts: { id?: string; description?: string } = {},
): KvSchemaMapping {
  const id = opts.id ?? toKvFieldKey(schema.name);
  if (!KV_NAME_PATTERN.test(id)) {
    throw new KvValidationError(
      `kv schema id "${id}" is invalid (must match ${KV_NAME_PATTERN.source})`,
      "invalid_name",
      { schemaId: id },
    );
  }

  const entries = Object.entries(schema.properties);
  if (entries.length > MAX_KV_FIELDS_PER_SCHEMA) {
    throw new KvValidationError(
      `extraction config "${schema.name}" has ${entries.length} fields; ARAG allows at most ${MAX_KV_FIELDS_PER_SCHEMA} per kv schema`,
      "too_many_fields",
      { schemaId: id },
    );
  }

  const fields: KvSchemaField[] = [];
  const fieldIds: Record<string, string> = {};
  const names: Record<string, string> = {};

  for (const [name, prop] of entries) {
    const key = toKvFieldKey(name);
    if (key in names) {
      throw new KvValidationError(
        `extraction config "${schema.name}" maps "${name}" and "${names[key]}" onto the same kv field key "${key}"`,
        "duplicate_key",
        { schemaId: id, field: key },
      );
    }

    const override = prop.kv ?? {};
    const derivedRepeated = prop.type === "array";
    const repeated = override.repeated ?? derivedRepeated;
    const itemType = derivedRepeated
      ? jsonPropToKvType((prop.items as { type?: string; format?: string }) ?? { type: "string" })
      : jsonPropToKvType(prop);

    // `repeated` exists only for text; an array of numbers cannot be represented, so a
    // *derived* repeated field is stored as repeated text rather than silently dropped
    // (values round-trip as strings). An explicit override is never silently rewritten —
    // the author asked for something ARAG refuses, and is told so.
    let type: KvFieldType;
    if (override.type) {
      type = override.type;
      if (repeated && !REPEATABLE_TYPES.includes(type)) {
        throw new KvValidationError(
          `extraction config "${schema.name}" field "${name}": repeated is only allowed on ${REPEATABLE_TYPES.join("/")}, not ${type}`,
          "invalid_modifier",
          { schemaId: id, field: key, expected: REPEATABLE_TYPES.join("|"), got: type },
        );
      }
    } else {
      type = repeated && !REPEATABLE_TYPES.includes(itemType) ? "text" : itemType;
    }

    const bounded = prop as { minimum?: number; maximum?: number };
    const range =
      override.range ??
      (!repeated &&
        RANGEABLE_TYPES.includes(type) &&
        (bounded.minimum !== undefined || bounded.maximum !== undefined));
    if (range && !RANGEABLE_TYPES.includes(type)) {
      throw new KvValidationError(
        `extraction config "${schema.name}" field "${name}": range is only allowed on ${RANGEABLE_TYPES.join("/")}, not ${type}`,
        "invalid_modifier",
        { schemaId: id, field: key, expected: RANGEABLE_TYPES.join("|"), got: type },
      );
    }

    const field: KvSchemaField = { key, type, required: schema.required.includes(name) };
    if (prop.description) field.description = prop.description;
    if (range) field.range = true;
    if (repeated) field.repeated = true;
    fields.push(field);
    fieldIds[name] = key;
    names[key] = name;
  }

  const description = opts.description ?? schema.description;
  return { schema: { id, description, fields }, fieldIds, names };
}

/**
 * Project an extracted record onto the kv `data` map for a mapping, dropping anything the
 * schema does not declare and coercing values to the declared type. Values that cannot be
 * coerced are omitted rather than sent — ARAG would 422 the whole write for one bad field.
 */
export function toKvData(
  values: Record<string, unknown>,
  mapping: KvSchemaMapping,
): { data: KvData; skipped: Array<{ field: string; reason: string }> } {
  const byKey = new Map(mapping.schema.fields.map((f) => [f.key, f]));
  const data: KvData = {};
  const skipped: Array<{ field: string; reason: string }> = [];

  for (const [name, raw] of Object.entries(values)) {
    const key = mapping.fieldIds[name];
    if (!key) continue; // not part of this schema
    const field = byKey.get(key);
    if (!field || raw === null || raw === undefined || raw === "") continue;
    const coerced = coerce(raw, field);
    if (coerced === undefined) {
      // Name the value, not just its JavaScript type: "total: '1,234.50 AUD' is not a
      // float" tells a reviewer what to fix, where "cannot represent string as float"
      // tells them only that something went wrong somewhere.
      skipped.push({ field: name, reason: `${describeValue(raw)} is not a ${describeField(field)}` });
      continue;
    }
    data[key] = coerced;
  }

  for (const field of mapping.schema.fields) {
    if (field.required && !(field.key in data)) {
      skipped.push({ field: mapping.names[field.key] ?? field.key, reason: "required but not extracted" });
    }
  }
  return { data, skipped };
}

function describeField(f: KvSchemaField): string {
  return f.repeated ? `repeated ${f.type}` : f.range ? `${f.type} range` : f.type;
}

/** The offending value, quoted and clipped, for a skip reason a reviewer can act on. */
function describeValue(raw: unknown): string {
  if (typeof raw === "string") return `"${raw.length > 60 ? `${raw.slice(0, 60)}…` : raw}"`;
  if (raw === null || raw === undefined) return String(raw);
  if (typeof raw === "object") return Array.isArray(raw) ? `a ${raw.length}-item list` : "an object";
  return String(raw);
}

function coerce(raw: unknown, field: KvSchemaField): KvValue | undefined {
  if (field.repeated) {
    const list = (Array.isArray(raw) ? raw : [raw])
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) => String(v));
    return list.length ? list : undefined;
  }
  if (field.range) return toRange(raw);
  switch (field.type) {
    case "integer": {
      const n = toNumber(raw);
      return n === undefined ? undefined : Math.trunc(n);
    }
    case "float":
      return toNumber(raw);
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (/^(true|yes|y|1)$/i.test(String(raw))) return true;
      if (/^(false|no|n|0)$/i.test(String(raw))) return false;
      return undefined;
    case "date":
      return toRfc3339(raw);
    default:
      return Array.isArray(raw) ? raw.map((v) => String(v)).join(", ") : String(raw);
  }
}

/**
 * Parse a number out of a formatted value ("$1,234.56" → 1234.56), returning undefined when
 * the text carries no digits at all — stripping punctuation from "not a number" leaves an
 * empty string, and `Number("")` is 0, which would silently write a wrong value.
 */
function toNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const cleaned = String(raw).replace(/[^0-9.-]/g, "");
  if (!/\d/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * ARAG requires a full RFC 3339 date-TIME with an offset: `"2026-01-15"` alone is rejected
 * with a type mismatch (verified live), so a bare date is widened to midnight UTC.
 */
export function toRfc3339(raw: unknown): string | undefined {
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Build a `KvRange`, rejecting the `lower >= upper` that ARAG refuses with a 422. */
export function toRange(raw: unknown): KvRange | undefined {
  const r = raw as { lower?: unknown; upper?: unknown };
  if (r && typeof r === "object" && r.lower !== undefined && r.upper !== undefined) {
    const lower = typeof r.lower === "number" ? r.lower : (toRfc3339(r.lower) ?? Number(r.lower));
    const upper = typeof r.upper === "number" ? r.upper : (toRfc3339(r.upper) ?? Number(r.upper));
    if (lower === undefined || upper === undefined) return undefined;
    if (typeof lower === "number" && typeof upper === "number" && !(lower < upper)) return undefined;
    if (typeof lower === "string" && typeof upper === "string" && !(lower < upper)) return undefined;
    return { lower, upper };
  }
  return undefined;
}

// ─── service ──────────────────────────────────────────────────────────────────

export interface KvDeps {
  arag: AragClient;
  log: Logger;
  /**
   * ARAG_MOCK=1. The vendored mock server knows nothing of kv routes and is never edited,
   * so the service keeps an in-memory registry that mirrors the live shapes and validation
   * instead, letting `make test` and `make e2e` run the same code paths offline.
   */
  mock?: boolean;
}

/** One resource's kv values, keyed by schema id. */
export type ResourceKeyValues = Record<string, KvData>;

export class KvService {
  private readonly d: KvDeps;
  /** Mock-mode only: schema id → schema. */
  private readonly mockSchemas = new Map<string, KvSchema>();
  /** Mock-mode only: resource id → schema id → data (the resource's CURRENT values). */
  private readonly mockValues = new Map<string, ResourceKeyValues>();
  /**
   * Mock-mode only: resource id → schema id → field key → EVERY value ever written.
   *
   * This is the overwrite trap, reproduced. Live, a kv write replaces the resource's values
   * but does not remove the old ones from the Knowledge Box's filter index — the index
   * accumulates, and there is no purge call, so a corrected resource keeps matching a filter
   * on the value it superseded. The mock keeps the same history and filters against it, so
   * the behaviour the product reports (`meta.kv.filterIndexStale`) is observable offline
   * instead of only against the real Knowledge Box.
   */
  private readonly mockIndex = new Map<string, Record<string, Record<string, KvValue[]>>>();

  constructor(deps: KvDeps) {
    this.d = deps;
  }

  get mocked(): boolean {
    return this.d.mock === true;
  }

  private async json<T>(method: string, path: string, body?: unknown, schemaId?: string): Promise<T> {
    try {
      const res = await this.d.arag.request(method, path, {
        body: body === undefined ? null : JSON.stringify(body),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      });
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      rethrow(err, schemaId);
    }
  }

  // ─── schemas ────────────────────────────────────────────────────────────────

  /** `GET /kb/{kb}/kv-schemas` → `{ schemas: { <id>: KvSchema } }`. */
  async listKvSchemas(): Promise<Record<string, KvSchema>> {
    if (this.mocked) return Object.fromEntries(this.mockSchemas);
    const res = await this.json<{ schemas?: Record<string, KvSchema> }>("GET", "/kv-schemas");
    return res.schemas ?? {};
  }

  /** `GET /kb/{kb}/kv-schemas/{id}`. Returns undefined on 404. */
  async getKvSchema(id: string): Promise<KvSchema | undefined> {
    if (this.mocked) return this.mockSchemas.get(id);
    try {
      return await this.json<KvSchema>("GET", `/kv-schemas/${encodeURIComponent(id)}`, undefined, id);
    } catch (err) {
      if (err instanceof AragError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** `POST /kb/{kb}/kv-schemas` → 201 with the stored schema (defaults filled in). */
  async createKvSchema(schema: KvSchema): Promise<KvSchema> {
    this.assertSchemaValid(schema);
    if (this.mocked) {
      if (this.mockSchemas.size >= MAX_KV_SCHEMAS_PER_KB && !this.mockSchemas.has(schema.id)) {
        throw new KvValidationError(
          `Knowledge Box already holds ${MAX_KV_SCHEMAS_PER_KB} kv schemas`,
          "too_many_schemas",
          { schemaId: schema.id },
        );
      }
      const stored = normaliseSchema(schema);
      this.mockSchemas.set(schema.id, stored);
      return stored;
    }
    const out = await this.json<KvSchema>("POST", "/kv-schemas", schema, schema.id);
    this.d.log.info("kv.schema.create", { id: schema.id, fields: schema.fields.length });
    return out;
  }

  /** `PATCH /kb/{kb}/kv-schemas/{id}` — `id` itself cannot be changed. */
  async updateKvSchema(id: string, update: KvSchemaUpdate): Promise<KvSchema> {
    if (update.fields) this.assertSchemaValid({ id, fields: update.fields });
    if (this.mocked) {
      const current = this.mockSchemas.get(id);
      if (!current) throw new KvValidationError(`no kv schema "${id}"`, "unknown", { schemaId: id });
      const next = normaliseSchema({ ...current, ...update, id });
      this.mockSchemas.set(id, next);
      return next;
    }
    const path = `/kv-schemas/${encodeURIComponent(id)}`;
    let out: KvSchema;
    try {
      out = await this.json<KvSchema>("PATCH", path, update, id);
    } catch (err) {
      // Some zones route the update as PUT and answer a PATCH to an existing schema with 404
      // (or 405) — which read as "the schema is gone" and left a changed config unable to
      // write its new fields. The schema was just fetched, so a 404 here is about the verb.
      if (!(err instanceof AragError) || (err.status !== 404 && err.status !== 405)) throw err;
      out = await this.json<KvSchema>("PUT", path, update, id);
    }
    this.d.log.info("kv.schema.update", { id });
    return out;
  }

  /** Create the schema, or patch it into shape when it already exists. Idempotent. */
  async ensureKvSchema(schema: KvSchema): Promise<KvSchema> {
    const existing = await this.getKvSchema(schema.id);
    if (!existing) return this.createKvSchema(schema);
    if (sameSchema(existing, schema)) return existing;
    return this.updateKvSchema(schema.id, { description: schema.description, fields: schema.fields });
  }

  /** `DELETE /kb/{kb}/kv-schemas/{id}`. A missing schema is not an error. */
  async deleteKvSchema(id: string): Promise<void> {
    if (this.mocked) {
      this.mockSchemas.delete(id);
      for (const values of this.mockValues.values()) delete values[id];
      for (const indexed of this.mockIndex.values()) delete indexed[id];
      return;
    }
    try {
      await this.d.arag.request("DELETE", `/kv-schemas/${encodeURIComponent(id)}`);
      this.d.log.info("kv.schema.delete", { id });
    } catch (err) {
      if (err instanceof AragError && err.status === 404) return;
      rethrow(err, id);
    }
  }

  // ─── values ─────────────────────────────────────────────────────────────────

  /**
   * `PUT /kb/{kb}/resource/{rid}/key_value/{schemaId}` with `{ data }`.
   *
   * This REPLACES the whole kv field: keys absent from `data` are dropped, and every
   * `required` key must be present or ARAG returns a 422. Use `writeResourceKeyValues`
   * to set several schemas at once without disturbing the others.
   */
  async putResourceKeyValue(rid: string, schemaId: string, data: KvData): Promise<void> {
    if (this.mocked) {
      this.validateAgainstMockSchema(schemaId, data);
      const values = this.mockValues.get(rid) ?? {};
      values[schemaId] = { ...data };
      this.mockValues.set(rid, values);
      this.indexMockWrite(rid, schemaId, data);
      return;
    }
    await this.json<unknown>(
      "PUT",
      `/resource/${rid}/key_value/${encodeURIComponent(schemaId)}`,
      { data },
      schemaId,
    );
    this.d.log.info("kv.value.put", { rid, schemaId, keys: Object.keys(data).length });
  }

  /**
   * `PATCH /kb/{kb}/resource/{rid}` with an inline `key_values` map — the same shape
   * `POST /kb/{kb}/resources` accepts at create time. Schemas not named are left alone.
   */
  async writeResourceKeyValues(rid: string, values: ResourceKeyValues): Promise<void> {
    if (this.mocked) {
      for (const [schemaId, data] of Object.entries(values)) this.validateAgainstMockSchema(schemaId, data);
      const current = this.mockValues.get(rid) ?? {};
      for (const [schemaId, data] of Object.entries(values)) {
        current[schemaId] = { ...data };
        this.indexMockWrite(rid, schemaId, data);
      }
      this.mockValues.set(rid, current);
      return;
    }
    await this.json<unknown>("PATCH", `/resource/${rid}`, { key_values: this.inlineKeyValues(values) });
    this.d.log.info("kv.value.write", { rid, schemas: Object.keys(values) });
  }

  /**
   * The `key_values` block of a `POST /resources` (create) or `PATCH /resource/{rid}`
   * (update) body — the one definition of that wire shape, used by `writeResourceKeyValues`
   * rather than duplicated inside it, so a test of this function tests what really goes out.
   */
  inlineKeyValues(values: ResourceKeyValues): Record<string, { data: KvData }> {
    return Object.fromEntries(Object.entries(values).map(([id, data]) => [id, { data }]));
  }

  /**
   * `GET /kb/{kb}/resource/{rid}?show=values` → `data.key_values.<schemaId>.value.data`.
   * Note the extra `.value` wrapper the write shape does not have; this unwraps it.
   */
  async readResourceKeyValues(rid: string): Promise<ResourceKeyValues> {
    if (this.mocked) return { ...(this.mockValues.get(rid) ?? {}) };
    const res = await this.json<{
      data?: { key_values?: Record<string, { value?: { data?: KvData } }> };
    }>("GET", `/resource/${rid}?show=values`);
    const out: ResourceKeyValues = {};
    for (const [schemaId, entry] of Object.entries(res.data?.key_values ?? {})) {
      out[schemaId] = entry?.value?.data ?? {};
    }
    return out;
  }

  /**
   * Resource ids matching a set of kv leaf filters, **through the Knowledge Box**.
   *
   * Run as a `/find` with an empty query and `show: ["basic","values"]`, because kv filter
   * expressions work on `/find` and `/ask` and are rejected by `/catalog` with a 422 — and
   * kv fields are not facetable, so there is no cheaper route to the same answer. The
   * filters are ANDed: several `kv=` parameters narrow, they do not widen.
   *
   * In mock mode the same leaves are evaluated against the in-memory registry, so the
   * filtering path is exercised by `make test` rather than skipped offline.
   */
  async findResourceIdsByKv(
    leaves: KvLeafFilter[],
    opts: { topK?: number; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    if (leaves.length === 0) return [];
    if (this.mocked) {
      const out: string[] = [];
      // Matched against the accumulated index, not the current values — see `mockIndex`.
      for (const [rid, indexed] of this.mockIndex) {
        const ok = leaves.every((leaf) =>
          (indexed[leaf.schema_id]?.[leaf.key] ?? []).some((v) => kvValueMatches(v, leaf)),
        );
        if (ok) out.push(rid);
      }
      return out;
    }
    const res = await this.d.arag.find(
      {
        // The query is deliberately empty: this is a metadata filter, not a search. The
        // filter expression is what selects, and an empty query keeps semantic scoring out
        // of a question that has an exact answer.
        query: "",
        filter_expression: kvFilter(leaves),
        show: ["basic", "values"],
        top_k: opts.topK ?? 200,
      },
      { signal: opts.signal },
    );
    const ids = Object.keys(res.resources ?? {});
    this.d.log.debug("kv.find", { leaves: leaves.length, matched: ids.length });
    return ids;
  }

  /** Read one schema's values back and project them onto the product's property names. */
  async readMapped(rid: string, mapping: KvSchemaMapping): Promise<Record<string, KvValue>> {
    const all = await this.readResourceKeyValues(rid);
    const data = all[mapping.schema.id] ?? {};
    const out: Record<string, KvValue> = {};
    for (const [key, value] of Object.entries(data)) out[mapping.names[key] ?? key] = value;
    return out;
  }

  // ─── validation shared by live pre-flight and mock mode ─────────────────────

  /** Reject locally what ARAG would reject anyway, with a message naming the field. */
  assertSchemaValid(schema: { id: string; fields: KvSchemaField[] }): void {
    if (!KV_NAME_PATTERN.test(schema.id)) {
      throw new KvValidationError(
        `kv schema id "${schema.id}" must match ${KV_NAME_PATTERN.source}`,
        "invalid_name",
        { schemaId: schema.id },
      );
    }
    if (schema.fields.length > MAX_KV_FIELDS_PER_SCHEMA) {
      throw new KvValidationError(
        `kv schema "${schema.id}" has ${schema.fields.length} fields; the limit is ${MAX_KV_FIELDS_PER_SCHEMA}`,
        "too_many_fields",
        { schemaId: schema.id },
      );
    }
    const seen = new Set<string>();
    for (const f of schema.fields) {
      if (!KV_NAME_PATTERN.test(f.key)) {
        throw new KvValidationError(
          `kv field key "${f.key}" must match ${KV_NAME_PATTERN.source}`,
          "invalid_name",
          { schemaId: schema.id, field: f.key },
        );
      }
      if (seen.has(f.key)) {
        throw new KvValidationError(`kv schema "${schema.id}" declares "${f.key}" twice`, "duplicate_key", {
          schemaId: schema.id,
          field: f.key,
        });
      }
      seen.add(f.key);
      if (f.repeated && !REPEATABLE_TYPES.includes(f.type)) {
        throw new KvValidationError(
          `kv field "${f.key}": repeated is only allowed on ${REPEATABLE_TYPES.join("/")}, not ${f.type}`,
          "invalid_modifier",
          { schemaId: schema.id, field: f.key, expected: REPEATABLE_TYPES.join("|"), got: f.type },
        );
      }
      if (f.range && !RANGEABLE_TYPES.includes(f.type)) {
        throw new KvValidationError(
          `kv field "${f.key}": range is only allowed on ${RANGEABLE_TYPES.join("/")}, not ${f.type}`,
          "invalid_modifier",
          { schemaId: schema.id, field: f.key, expected: RANGEABLE_TYPES.join("|"), got: f.type },
        );
      }
    }
  }

  /** Record a mock write in the accumulating filter index, deduplicating identical values. */
  private indexMockWrite(rid: string, schemaId: string, data: KvData): void {
    const perResource = this.mockIndex.get(rid) ?? {};
    const perSchema = perResource[schemaId] ?? {};
    for (const [key, value] of Object.entries(data)) {
      const seen = perSchema[key] ?? [];
      if (!seen.some((v) => JSON.stringify(v) === JSON.stringify(value))) seen.push(value);
      perSchema[key] = seen;
    }
    perResource[schemaId] = perSchema;
    this.mockIndex.set(rid, perResource);
  }

  /** Mock-mode stand-in for ARAG's write-time validation, raising the same error kinds. */
  private validateAgainstMockSchema(schemaId: string, data: KvData): void {
    const schema = this.mockSchemas.get(schemaId);
    if (!schema) {
      throw new KvValidationError(`Unknown key-value schema: '${schemaId}'`, "unknown_key", { schemaId });
    }
    const byKey = new Map(schema.fields.map((f) => [f.key, f]));
    const unknown = Object.keys(data).filter((k) => !byKey.has(k));
    if (unknown.length) {
      throw new KvValidationError(
        `Unknown keys for schema '${schemaId}': ${JSON.stringify(unknown)}`,
        "unknown_key",
        { schemaId, field: unknown[0] },
      );
    }
    const missing = schema.fields.filter((f) => f.required && !(f.key in data)).map((f) => f.key);
    if (missing.length) {
      throw new KvValidationError(
        `Missing required keys for schema '${schemaId}': ${JSON.stringify(missing)}`,
        "missing_required",
        { schemaId, field: missing[0] },
      );
    }
    for (const [key, value] of Object.entries(data)) {
      const field = byKey.get(key);
      if (!field) continue;
      const got = kvTypeOf(value);
      if (!valueMatches(value, field)) {
        throw new KvValidationError(
          `Key '${key}' in schema '${schemaId}' expects type '${describeField(field)}', got ${got}`,
          "type_mismatch",
          { schemaId, field: key, expected: describeField(field), got },
        );
      }
      if (field.range && toRange(value) === undefined) {
        throw new KvValidationError(
          `Key '${key}' in schema '${schemaId}': lower endpoint must be < than its upper endpoint`,
          "range_bounds",
          { schemaId, field: key },
        );
      }
    }
  }
}

function kvTypeOf(value: KvValue): string {
  if (Array.isArray(value)) return "list";
  if (value && typeof value === "object") return "Range";
  return typeof value;
}

function valueMatches(value: KvValue, field: KvSchemaField): boolean {
  if (field.repeated) return Array.isArray(value) || typeof value === "string";
  if (field.range) return typeof value === "object" && value !== null && !Array.isArray(value);
  switch (field.type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "float":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && /\d{4}-\d{2}-\d{2}T/.test(value);
    default:
      return typeof value === "string";
  }
}

/** Fill in the defaults ARAG stamps on a stored schema, so mock reads match live reads. */
function normaliseSchema(schema: KvSchema): KvSchema {
  return {
    id: schema.id,
    description: schema.description,
    fields: schema.fields.map((f) => ({
      key: f.key,
      type: f.type,
      description: f.description,
      // Live, an unspecified modifier comes back `false` — including `required` (see the
      // captured 201 in the architecture doc). Defaulting it to `true` here made mock mode
      // stricter than the Knowledge Box and contradicted the provisioning policy (DP-47).
      required: f.required ?? false,
      range: f.range ?? false,
      repeated: f.repeated ?? false,
    })),
  };
}

function sameSchema(a: KvSchema, b: KvSchema): boolean {
  const norm = (s: KvSchema) =>
    JSON.stringify({
      description: s.description ?? "",
      fields: normaliseSchema(s).fields.map((f) => ({ ...f, description: f.description ?? "" })),
    });
  return norm(a) === norm(b);
}
