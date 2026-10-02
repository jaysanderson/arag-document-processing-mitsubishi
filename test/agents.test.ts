import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuerySeed, validateNormalize, wholeDocument } from "../src/services/agents.ts";
import { DOC_TYPES, SCHEMAS, schemaFor, toAnswerJsonSchema } from "../src/services/schemas.ts";
import type { ExtractedField } from "../src/types.ts";

test("validateNormalize coerces amounts, dates, currency", () => {
  const fields: ExtractedField[] = [
    { key: "vendor_name", label: "Vendor", value: "Acme" },
    { key: "invoice_number", label: "Invoice #", value: "INV-1" },
    { key: "invoice_date", label: "Invoice Date", value: "15/06/2026" },
    { key: "currency", label: "Currency", value: "$" },
    { key: "subtotal", label: "Subtotal", value: "$96,000" },
    { key: "tax", label: "Tax", value: "$9,600" },
    { key: "total", label: "Total", value: "$105,600" },
  ];
  const { fields: out, issues } = validateNormalize(fields, schemaFor("invoice"));
  const byKey = Object.fromEntries(out.map((f) => [f.key, f]));
  assert.equal(byKey.subtotal!.value, 96000);
  assert.equal(byKey.total!.value, 105600);
  assert.equal(byKey.invoice_date!.value, "2026-06-15");
  assert.equal(byKey.currency!.value, "USD");
  // 96000 + 9600 == 105600 → no arithmetic warning
  assert.ok(!issues.some((i) => i.field === "total" && i.severity === "warning"));
});

test("validateNormalize flags arithmetic mismatch and missing required", () => {
  const fields: ExtractedField[] = [
    { key: "vendor_name", label: "Vendor", value: "Acme" },
    // invoice_number (required) intentionally missing
    { key: "subtotal", label: "Subtotal", value: 100 },
    { key: "tax", label: "Tax", value: 10 },
    { key: "total", label: "Total", value: 200 }, // wrong
  ];
  const { issues } = validateNormalize(fields, schemaFor("invoice"));
  assert.ok(issues.some((i) => i.field === "invoice_number" && i.severity === "error"));
  assert.ok(issues.some((i) => i.field === "total" && i.severity === "warning"));
});

test("every schema is internally consistent", () => {
  for (const docType of DOC_TYPES) {
    const schema = SCHEMAS[docType];
    assert.equal(schema.docType, docType, `${docType} docType mismatch`);
    // required keys exist in properties
    for (const req of schema.required) {
      assert.ok(req in schema.properties, `${docType}: required "${req}" missing from properties`);
    }
    // every property has a label
    for (const key of Object.keys(schema.properties)) {
      assert.ok(key in schema.labels, `${docType}: property "${key}" missing a label`);
    }
    // answer_json_schema shape is valid
    const ajs = toAnswerJsonSchema(schema) as {
      name: string;
      parameters: { type: string; required: string[] };
    };
    assert.equal(typeof ajs.name, "string");
    assert.equal(ajs.parameters.type, "object");
    assert.deepEqual(ajs.parameters.required, schema.required);
  }
});

test("buildQuerySeed uses document text, collapses whitespace, caps length", () => {
  const seed = buildQuerySeed("  ACME ROBOTICS\n\nInvoice  Number: INV-1   ", "x.pdf");
  assert.equal(seed, "ACME ROBOTICS Invoice Number: INV-1");
  const long = buildQuerySeed("a ".repeat(500), "x.pdf");
  assert.ok(long.length <= 280);
});

test("buildQuerySeed falls back to a generic seed when text is empty", () => {
  const seed = buildQuerySeed("   ", "report.pdf");
  assert.match(seed, /^report\.pdf /);
  assert.ok(seed.length > 12);
});

test("the whole-document strategy names the file field once the resource has one", () => {
  // A processed resource carries a key-value field, and ARAG answers 500 to `full_resource`
  // on it — so a reprocess or a question about a finished record must not use it.
  assert.deepEqual(wholeDocument("f9ac4d55"), [{ name: "field_extension", fields: ["f/f9ac4d55"] }]);
  assert.deepEqual(wholeDocument(), [{ name: "full_resource" }]);
});
