/**
 * Extraction schema library.
 *
 * Each schema is an OpenAI-function-style JSON Schema passed to ARAG `/ask` as
 * `answer_json_schema`. ARAG forces the (multimodal) generative model to return a
 * structured object matching it — this is the "custom visual-LLM extraction" layer:
 * the model reads the processed document (text + page images/layout) and fills the
 * schema, grounded in the actual file.
 *
 * Schemas are intentionally flat and demo-legible. `field()` keeps them terse.
 */

import { DOC_TYPE_VALUES, type DocType } from "../types.ts";

export interface ExtractionSchema {
  /** Schema name (also used as answer_json_schema.name). */
  name: string;
  /** Doc type this schema targets. */
  docType: DocType;
  /** Human description shown in the UI and sent to the model. */
  description: string;
  /** JSON Schema "properties" for the extraction object. */
  properties: Record<string, JsonProp>;
  /** Required property keys. */
  required: string[];
  /** Friendly labels for keys (UI + canonical record). */
  labels: Record<string, string>;
}

/**
 * The five types an ARAG key-value field can have. Declared here rather than imported from
 * `services/kv.ts` so the schema library stays free of the kv service; the two unions are
 * identical and structurally interchangeable.
 */
export type KvTypeHint = "text" | "integer" | "float" | "boolean" | "date";

/**
 * How one property should be represented as a **key-value field** in the Knowledge Box,
 * when the JSON-Schema type is not the right answer.
 *
 * `jsonPropToKvType()` is a good default but it cannot be right for everything: a money
 * field is deliberately declared as a `string` on the record so the original formatting
 * ("$96,000.00") survives, and mapping that to kv `text` means nobody can ever filter
 * "invoices over $10,000". The annotation is the override — the extraction stays a string,
 * the Knowledge Box gets a `float` — and the same applies to dates the model returns as
 * text. It is stripped before the schema is sent to ARAG as `answer_json_schema`.
 */
export interface KvHint {
  /** Knowledge Box field type. Overrides the type derived from the JSON-Schema type. */
  type?: KvTypeHint;
  /** Store a list of values. ARAG accepts `repeated` on `text` only. */
  repeated?: boolean;
  /** Store an interval (`{lower, upper}`). ARAG accepts `range` on integer/float/date only. */
  range?: boolean;
}

export interface JsonProp {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  items?: { type: "string" | "number" } | Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: string[];
  /** Key-value field override; not part of the JSON Schema sent to the model. */
  kv?: KvHint;
}

function s(description: string): JsonProp {
  return { type: "string", description };
}
/**
 * A date captured as text (models are far more reliable returning "2026-01-15" than a typed
 * value), stored as a kv `date` so `gte`/`lte` filtering works on it.
 */
function date(description: string): JsonProp {
  return { type: "string", description, kv: { type: "date" } };
}
/**
 * Money/amount fields are declared as STRINGS, not numbers. Forcing the model to emit
 * a JSON `number` for a currency-formatted value ("$96,000.00") is unreliable — it
 * frequently returns 0. Capturing the raw string and letting `validateNormalize`
 * deterministically parse it to a number is both robust and preserves the original.
 */
function money(description: string): JsonProp {
  return {
    type: "string",
    description: `${description} (capture exactly as written, including currency/symbols)`,
    // …and a `float` in the Knowledge Box, so "every invoice over $10k" is a filter rather
    // than a full re-read. The record keeps the string; only the kv projection is numeric.
    kv: { type: "float" },
  };
}
function n(description: string): JsonProp {
  return { type: "number", description };
}
function arr(description: string): JsonProp {
  return { type: "array", description, items: { type: "string" } };
}

export const SCHEMAS: Record<DocType, ExtractionSchema> = {
  invoice: {
    name: "invoice_extraction",
    docType: "invoice",
    description: "Structured fields from a commercial invoice or bill.",
    properties: {
      vendor_name: s("Name of the vendor / supplier issuing the invoice"),
      vendor_address: s("Vendor postal address, if present"),
      bill_to: s("Customer / bill-to party"),
      invoice_number: s("Invoice number or identifier"),
      invoice_date: date("Invoice issue date in ISO 8601 (YYYY-MM-DD) if determinable"),
      due_date: date("Payment due date in ISO 8601 if determinable"),
      currency: s("ISO 4217 currency code, e.g. USD, AUD, EUR"),
      subtotal: money("Subtotal amount before tax"),
      tax: money("Total tax amount"),
      total: money("Grand total / amount due"),
      line_items: arr("One string per line item, e.g. 'Widget x2 @ $10 = $20'"),
      po_number: s("Referenced purchase-order number, if any"),
    },
    required: ["vendor_name", "invoice_number", "total"],
    labels: {
      vendor_name: "Vendor",
      vendor_address: "Vendor Address",
      bill_to: "Bill To",
      invoice_number: "Invoice #",
      invoice_date: "Invoice Date",
      due_date: "Due Date",
      currency: "Currency",
      subtotal: "Subtotal",
      tax: "Tax",
      total: "Total",
      line_items: "Line Items",
      po_number: "PO #",
    },
  },

  receipt: {
    name: "receipt_extraction",
    docType: "receipt",
    description: "Structured fields from a retail or expense receipt.",
    properties: {
      merchant: s("Merchant / store name"),
      transaction_date: date("Transaction date in ISO 8601 if determinable"),
      currency: s("ISO 4217 currency code"),
      subtotal: money("Subtotal before tax"),
      tax: money("Tax amount"),
      total: money("Total paid"),
      payment_method: s("Payment method, e.g. Visa, cash"),
      items: arr("Purchased items, one per entry"),
    },
    required: ["merchant", "total"],
    labels: {
      merchant: "Merchant",
      transaction_date: "Date",
      currency: "Currency",
      subtotal: "Subtotal",
      tax: "Tax",
      total: "Total",
      payment_method: "Payment Method",
      items: "Items",
    },
  },

  contract: {
    name: "contract_extraction",
    docType: "contract",
    description: "Key terms from a legal agreement or contract.",
    properties: {
      title: s("Contract title / type, e.g. 'Master Services Agreement'"),
      parties: arr("Names of the contracting parties"),
      effective_date: date("Effective date in ISO 8601 if determinable"),
      term: s("Contract term / duration"),
      governing_law: s("Governing law / jurisdiction"),
      total_value: s("Total contract value, with currency"),
      termination: s("Termination / notice provisions summary"),
      key_obligations: arr("Material obligations, one per entry"),
    },
    required: ["title", "parties"],
    labels: {
      title: "Title",
      parties: "Parties",
      effective_date: "Effective Date",
      term: "Term",
      governing_law: "Governing Law",
      total_value: "Total Value",
      termination: "Termination",
      key_obligations: "Key Obligations",
    },
  },

  resume: {
    name: "resume_extraction",
    docType: "resume",
    description: "Structured fields from a resume / CV.",
    properties: {
      full_name: s("Candidate full name"),
      email: s("Email address"),
      phone: s("Phone number"),
      location: s("Location / city"),
      headline: s("Professional headline or current title"),
      years_experience: n("Approximate total years of experience"),
      skills: arr("Notable skills / technologies"),
      employers: arr("Recent employers, one per entry"),
      education: arr("Degrees / institutions, one per entry"),
    },
    required: ["full_name"],
    labels: {
      full_name: "Name",
      email: "Email",
      phone: "Phone",
      location: "Location",
      headline: "Headline",
      years_experience: "Years Experience",
      skills: "Skills",
      employers: "Employers",
      education: "Education",
    },
  },

  purchase_order: {
    name: "purchase_order_extraction",
    docType: "purchase_order",
    description:
      "Structured fields from a purchase order, captured so the order can be keyed into a sales-order system.",
    properties: {
      po_number: s("Purchase order number"),
      buyer: s("Buyer / ordering organization — the customer placing the order"),
      account_number: s("The buyer's account or customer number with the supplier, exactly as printed"),
      supplier: s("Supplier / vendor"),
      order_date: date("Order date in ISO 8601 if determinable"),
      requested_delivery_date: date(
        "Date the goods are required or due to be delivered, in ISO 8601 if determinable",
      ),
      quote_reference: s("Quotation or quote number the order refers to"),
      job_reference: s("The buyer's own job, project or site reference number"),
      ordered_by: s("Person who placed or authorised the order"),
      currency: s("ISO 4217 currency code"),
      total: money("Order total"),
      // One string per line, in a fixed order, so an order line can be split into the product
      // and quantity a sales-order API needs without the record growing a nested shape.
      line_items: arr(
        "Ordered items, one per entry, each written as `quantity | part or model number | description | unit price`. " +
          "Keep all three separators and leave a slot empty when the order does not give that value",
      ),
      ship_to: s("Delivery / ship-to address"),
      delivery_instructions: s("Delivery or site instructions, exactly as written"),
    },
    required: ["po_number", "supplier"],
    labels: {
      po_number: "PO #",
      buyer: "Buyer",
      account_number: "Account #",
      supplier: "Supplier",
      order_date: "Order Date",
      requested_delivery_date: "Requested Delivery",
      quote_reference: "Quote Reference",
      job_reference: "Job Reference",
      ordered_by: "Ordered By",
      currency: "Currency",
      total: "Total",
      line_items: "Line Items",
      ship_to: "Ship To",
      delivery_instructions: "Delivery Instructions",
    },
  },

  medical_claim: {
    name: "medical_claim_extraction",
    docType: "medical_claim",
    description: "Structured fields from a medical/health insurance claim or claims remittance advice.",
    properties: {
      claim_number: s("Claim number or identifier"),
      scheme: s("Medical scheme / insurer name"),
      member_number: s("Member / policy number"),
      patient_name: s("Patient name"),
      provider: s("Treating provider or facility that rendered the service"),
      service_date: date("Date of service in ISO 8601 if determinable"),
      diagnosis_code: s("Primary diagnosis code (e.g. ICD-10)"),
      procedure_code: s("Procedure / tariff code (e.g. CPT)"),
      currency: s("ISO 4217 currency code"),
      amount_claimed: money("Total amount claimed"),
      amount_paid: money("Total amount paid"),
      member_liability: money("Amount for the member's account / co-payment"),
      status: s("Claim status, e.g. paid in full, partially paid, rejected"),
    },
    required: ["provider"],
    labels: {
      claim_number: "Claim #",
      scheme: "Scheme / Insurer",
      member_number: "Member #",
      patient_name: "Patient",
      provider: "Provider",
      service_date: "Service Date",
      diagnosis_code: "Diagnosis (ICD-10)",
      procedure_code: "Procedure / Tariff",
      currency: "Currency",
      amount_claimed: "Amount Claimed",
      amount_paid: "Amount Paid",
      member_liability: "Member Liability",
      status: "Status",
    },
  },

  preauthorisation: {
    name: "preauthorisation_extraction",
    docType: "preauthorisation",
    description: "Structured fields from a hospital/medical pre-authorisation request or outcome.",
    properties: {
      authorisation_number: s("Authorisation number, if issued"),
      reference: s("Form / request reference number"),
      scheme: s("Medical scheme name"),
      benefit_option: s("Benefit option / plan"),
      member_number: s("Membership number"),
      patient_name: s("Patient name"),
      provider: s("Treating provider / practitioner"),
      facility: s("Hospital / facility name"),
      admission_date: date("Proposed admission date in ISO 8601 if determinable"),
      length_of_stay: s("Approved or requested length of stay"),
      procedure: s("Procedure description and/or code"),
      diagnosis_code: s("Primary diagnosis code (e.g. ICD-10)"),
      status: s("Authorisation status, e.g. approved, declined, pending"),
      co_payment: s("Co-payment applicable, if any"),
    },
    required: ["member_number"],
    labels: {
      authorisation_number: "Authorisation #",
      reference: "Reference",
      scheme: "Scheme",
      benefit_option: "Benefit Option",
      member_number: "Member #",
      patient_name: "Patient",
      provider: "Provider",
      facility: "Facility",
      admission_date: "Admission Date",
      length_of_stay: "Length of Stay",
      procedure: "Procedure",
      diagnosis_code: "Diagnosis (ICD-10)",
      status: "Status",
      co_payment: "Co-payment",
    },
  },

  bank_statement: {
    name: "bank_statement_extraction",
    docType: "bank_statement",
    description: "Header/summary fields from a bank or financial account statement.",
    properties: {
      bank_name: s("Bank / financial institution name"),
      account_holder: s("Account holder name"),
      account_number: s("Account number (may be masked)"),
      statement_period: s("Statement period / date range"),
      currency: s("ISO 4217 currency code"),
      opening_balance: money("Opening balance"),
      closing_balance: money("Closing balance"),
      transactions: arr("Notable transactions, one per entry as 'date — description — amount'"),
    },
    required: ["bank_name", "account_holder"],
    labels: {
      bank_name: "Bank",
      account_holder: "Account Holder",
      account_number: "Account #",
      statement_period: "Statement Period",
      currency: "Currency",
      opening_balance: "Opening Balance",
      closing_balance: "Closing Balance",
      transactions: "Transactions",
    },
  },

  form: {
    name: "form_extraction",
    docType: "form",
    description: "Field/value pairs from a structured form.",
    properties: {
      form_title: s("Title or type of the form"),
      reference: s("Reference / case / application number"),
      submitted_by: s("Person or entity who submitted the form"),
      submitted_date: date("Submission date in ISO 8601 if determinable"),
      fields: arr("All field:value pairs found, formatted as 'Label: Value'"),
    },
    required: ["form_title"],
    labels: {
      form_title: "Form Title",
      reference: "Reference",
      submitted_by: "Submitted By",
      submitted_date: "Submitted Date",
      fields: "Fields",
    },
  },

  report: {
    name: "report_extraction",
    docType: "report",
    description: "Key facts from a report or whitepaper.",
    properties: {
      title: s("Report title"),
      author: s("Author or publishing organization"),
      date: date("Publication date in ISO 8601 if determinable"),
      key_findings: arr("Key findings / takeaways, one per entry"),
      metrics: arr("Notable metrics or figures, one per entry"),
    },
    required: ["title"],
    labels: {
      title: "Title",
      author: "Author",
      date: "Date",
      key_findings: "Key Findings",
      metrics: "Metrics",
    },
  },

  generic: {
    name: "generic_extraction",
    docType: "generic",
    description: "Generic structured summary for an uncategorized document.",
    properties: {
      title: s("A concise title for the document"),
      document_kind: s("What kind of document this appears to be"),
      key_values: arr("Most important field:value pairs, formatted as 'Label: Value'"),
      dates: arr("Any significant dates found, ISO 8601 where possible"),
      amounts: arr("Any monetary amounts found, with currency"),
      people_orgs: arr("People and organizations mentioned"),
    },
    required: ["title"],
    labels: {
      title: "Title",
      document_kind: "Document Kind",
      key_values: "Key Values",
      dates: "Dates",
      amounts: "Amounts",
      people_orgs: "People & Orgs",
    },
  },
};

/**
 * The evidence contract, appended to every extraction schema.
 *
 * ARAG rejects `answer_json_schema` together with `citations` (HTTP 500 on the live KB),
 * so the usual citation machinery is unavailable to structured extraction. Asking the
 * model for verbatim quotes *inside* the schema gets the same guarantee by another route:
 * each quote is then checked against the document's own extracted text, so a value is
 * only ever presented as grounded if its supporting text really appears in the document.
 */
const EVIDENCE_PROPERTY: JsonProp = {
  type: "array",
  description:
    "One entry per field you filled in, quoting the document verbatim. `field` is the " +
    "property name; `quote` is the exact text from the document that supports that " +
    "value — copy it character for character, do not paraphrase, summarise or translate. " +
    "Omit a field entirely rather than inventing a quote for it.",
  items: {
    type: "object",
    properties: {
      field: { type: "string", description: "The property name this quote supports." },
      quote: { type: "string", description: "Verbatim text copied from the document." },
    },
    required: ["field", "quote"],
  },
};

/**
 * Build the answer_json_schema payload ARAG expects for a given schema.
 *
 * `kv` is the product's own annotation for the key-value projection, not JSON Schema, so
 * it is stripped here: what the model is handed stays a valid function schema.
 */
export function toAnswerJsonSchema(schema: ExtractionSchema): unknown {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const { kv: _kv, ...rest } = prop;
    properties[key] = rest;
  }
  return {
    name: schema.name,
    description: schema.description,
    parameters: {
      type: "object",
      properties: { ...properties, evidence: EVIDENCE_PROPERTY },
      required: schema.required,
    },
  };
}

export function schemaFor(docType: DocType): ExtractionSchema {
  return SCHEMAS[docType] ?? SCHEMAS.generic;
}

/** All doc types the classifier may choose from, in the canonical order. */
export const DOC_TYPES: DocType[] = [...DOC_TYPE_VALUES];

// ─── Custom configuration builder ─────────────────────────────────────────────

export interface ConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "array";
  description?: string;
  required?: boolean;
  /**
   * Explicit Knowledge Box field type for this field's key-value projection. Absent means
   * "use the type derived from `type`" — the default, not a silent one: the effective type
   * is reported separately by the config's kv schema.
   */
  kvType?: KvTypeHint;
  kvRepeated?: boolean;
  kvRange?: boolean;
}

/** Project a schema to the flat field list the UI shows in the config manager. */
export function schemaToFields(schema: ExtractionSchema): ConfigField[] {
  return Object.entries(schema.properties).map(([key, prop]) => {
    const field: ConfigField = {
      key,
      label: schema.labels[key] ?? key,
      type: prop.type === "string" || prop.type === "number" || prop.type === "array" ? prop.type : "string",
      description: prop.description,
      required: schema.required.includes(key),
    };
    if (prop.kv?.type) field.kvType = prop.kv.type;
    if (prop.kv?.repeated) field.kvRepeated = true;
    if (prop.kv?.range) field.kvRange = true;
    return field;
  });
}

/** Sanitise an arbitrary label into a stable machine key. */
function toKey(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field"
  );
}

export interface CustomConfigInput {
  name: string;
  description?: string;
  fields: Array<{
    key?: string;
    label: string;
    type?: "string" | "number" | "array";
    description?: string;
    required?: boolean;
    /** Override the Knowledge Box type for this field's key-value projection. */
    kvType?: KvTypeHint;
    kvRepeated?: boolean;
    kvRange?: boolean;
  }>;
}

/**
 * Build a valid ExtractionSchema from a user-defined config. Money/number fields are
 * declared as strings + normalized downstream, consistent with the built-in schemas;
 * here a "number" field is captured as a string and parsed by validateNormalize only if
 * its key is a known amount key, so custom numbers stay literal unless clearly monetary.
 */
export function buildCustomSchema(input: CustomConfigInput): ExtractionSchema {
  const properties: Record<string, JsonProp> = {};
  const labels: Record<string, string> = {};
  const required: string[] = [];
  const usedKeys = new Set<string>();

  for (const f of input.fields) {
    if (!f.label?.trim()) continue;
    let key = f.key?.trim() || toKey(f.label);
    while (usedKeys.has(key)) key = `${key}_2`;
    usedKeys.add(key);
    const type = f.type === "number" ? "number" : f.type === "array" ? "array" : "string";
    const prop: JsonProp =
      type === "array"
        ? { type: "array", description: f.description, items: { type: "string" } }
        : { type, description: f.description };
    // The kv projection is the author's to decide per field: a "string" amount that should
    // be filterable as a number says so here, and provisioning validates the choice against
    // ARAG's own rules (repeated → text only, range → integer/float/date only).
    const kv: KvHint = {};
    if (f.kvType) kv.type = f.kvType;
    if (f.kvRepeated) kv.repeated = true;
    if (f.kvRange) kv.range = true;
    if (Object.keys(kv).length) prop.kv = kv;
    properties[key] = prop;
    labels[key] = f.label.trim();
    if (f.required) required.push(key);
  }

  const safeName = toKey(input.name) || "custom";
  return {
    name: `custom_${safeName}`,
    docType: "generic",
    description: input.description?.trim() || `Custom extraction config: ${input.name}`,
    properties,
    required,
    labels,
  };
}
