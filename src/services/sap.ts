/**
 * SAP order hand-off: turn a purchase-order record into the request body an SAP sales-order
 * API expects, and say plainly whether it is fit to post.
 *
 * A customer's purchase order becomes the supplier's sales order. Two targets are supported
 * because "SAP" is not one API:
 *
 *   sap-c4c  SAP Sales Cloud (Cloud for Customer) — `POST …/c4codataapi/CustomerOrderCollection`
 *            with the items deep-inserted as `CustomerOrderItem`.
 *   sap-s4   SAP S/4HANA — `POST …/API_SALES_ORDER_SRV/A_SalesOrder` with `to_Item`.
 *
 * This module only builds the payload. It never calls SAP: nothing here holds a credential,
 * and an order that is wrong in SAP is far more expensive than one that waited for a person.
 * So every export also carries `ready`, `blockers` and `warnings` — what an integration (or a
 * person) has to resolve first — and `mapping`, which ties each SAP field back to the field it
 * was read from and whether that value's quote was verified against the document.
 *
 * Pure functions, no I/O.
 */
import type { DocumentRecord, EvidenceVerification, ExtractedField } from "../types.ts";

export type SapTarget = "sap-c4c" | "sap-s4";

export const SAP_TARGETS: readonly SapTarget[] = ["sap-c4c", "sap-s4"];

/** Deployment-specific SAP values. None of these can be read off a customer's order. */
export interface SapConfig {
  /** Sales document type — `ProcessingTypeCode` in C4C, `SalesOrderType` in S/4HANA. */
  orderType: string;
  salesOrganization?: string;
  distributionChannel?: string;
  division?: string;
}

/** `SAP_ORDER_TYPE`, `SAP_SALES_ORG`, `SAP_DISTRIBUTION_CHANNEL`, `SAP_DIVISION`. */
export function readSapConfig(env: Record<string, string | undefined> = process.env): SapConfig {
  const opt = (k: string) => (env[k] ?? "").trim() || undefined;
  return {
    orderType: opt("SAP_ORDER_TYPE") ?? "OR",
    salesOrganization: opt("SAP_SALES_ORG"),
    distributionChannel: opt("SAP_DISTRIBUTION_CHANNEL"),
    division: opt("SAP_DIVISION"),
  };
}

// ─── the order, as read ───────────────────────────────────────────────────────

export interface SalesOrderLine {
  /** 1-based position on the order. */
  line: number;
  /** Part or model number exactly as printed. */
  productId: string | null;
  quantity: number | null;
  description: string | null;
  /** Unit price as written, when the order gives one. */
  unitPrice: string | null;
  /** The line item as extracted, before it was split. */
  asWritten: string;
}

export interface SalesOrder {
  customerPoNumber: string | null;
  accountNumber: string | null;
  buyer: string | null;
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  quoteReference: string | null;
  jobReference: string | null;
  orderedBy: string | null;
  currency: string | null;
  total: string | null;
  shipTo: string | null;
  deliveryInstructions: string | null;
  lines: SalesOrderLine[];
}

/** A quantity, tolerating a unit ("2 EA", "x2") but not a part number that happens to hold digits. */
function parseQuantity(part: string): number | null {
  const m = part.trim().match(/^x?\s*(\d+(?:\.\d+)?)\s*(?:x|ea|each|pcs?|units?|off)?\.?$/i);
  return m ? Number(m[1]) : null;
}

/**
 * Split one extracted line item into its parts.
 *
 * The purchase-order schema asks for `quantity | part number | description | unit price`.
 * A model reading a table does not always keep that order — the same line may come back as
 * `part number | description | quantity` — so the quantity is found by shape (the first or
 * the last slot that is a bare number) rather than by position alone. A line that cannot be
 * split keeps its text as the product and has no quantity, which the export reports.
 */
export function parseLineItem(raw: string, line: number): SalesOrderLine {
  const asWritten = String(raw).replace(/\s+/g, " ").trim();
  const parts = asWritten
    .split("|")
    .map((p) => p.trim())
    .filter((_, i, all) => !(all.length > 1 && i === all.length - 1 && all[i] === ""));
  const empty = (v: string | undefined) => (v === undefined || v === "" ? null : v);

  if (parts.length === 1) {
    // "2 x MSZ-AP35VGKD2" — a quantity written in front of the part number.
    const lead = asWritten.match(/^(\d+(?:\.\d+)?)\s*(?:x|×)\s+(.+)$/i);
    if (lead)
      return {
        line,
        productId: lead[2]!,
        quantity: Number(lead[1]),
        description: null,
        unitPrice: null,
        asWritten,
      };
    return {
      line,
      productId: empty(parts[0]),
      quantity: null,
      description: null,
      unitPrice: null,
      asWritten,
    };
  }

  const first = parseQuantity(parts[0]!);
  if (first !== null) {
    return {
      line,
      quantity: first,
      productId: empty(parts[1]),
      description: empty(parts[2]),
      unitPrice: empty(parts[3]),
      asWritten,
    };
  }
  // Quantity last: `part | description | quantity`, or `part | quantity`.
  const lastIndex = parts.length - 1;
  const last = parseQuantity(parts[lastIndex]!);
  if (last !== null) {
    const middle = parts.slice(1, lastIndex).filter(Boolean);
    return {
      line,
      quantity: last,
      productId: empty(parts[0]),
      description: middle.length ? middle.join(" ") : null,
      unitPrice: null,
      asWritten,
    };
  }
  return {
    line,
    productId: empty(parts[0]),
    quantity: null,
    description: empty(parts[1]),
    unitPrice: null,
    asWritten,
  };
}

function scalar(field: ExtractedField | undefined): string | null {
  if (!field) return null;
  const v = Array.isArray(field.value) ? field.value[0] : field.value;
  if (v === null || v === undefined || v === "") return null;
  return String(v).replace(/\s+/g, " ").trim() || null;
}

/** The sales-order view of a record: the fields an order desk keys, whatever they were called. */
export function toSalesOrder(rec: DocumentRecord): SalesOrder {
  const by = new Map(rec.fields.map((f) => [f.key, f]));
  const items = by.get("line_items")?.value;
  const lines = (Array.isArray(items) ? items : items ? [items] : [])
    .map((v) => String(v))
    .filter((v) => v.trim() !== "")
    .map((v, i) => parseLineItem(v, i + 1));
  return {
    customerPoNumber: scalar(by.get("po_number")),
    accountNumber: scalar(by.get("account_number")),
    buyer: scalar(by.get("buyer")),
    orderDate: scalar(by.get("order_date")),
    requestedDeliveryDate: scalar(by.get("requested_delivery_date")),
    quoteReference: scalar(by.get("quote_reference")),
    jobReference: scalar(by.get("job_reference")),
    orderedBy: scalar(by.get("ordered_by")),
    currency: scalar(by.get("currency")),
    total: scalar(by.get("total")),
    shipTo: scalar(by.get("ship_to")),
    deliveryInstructions: scalar(by.get("delivery_instructions")),
    lines,
  };
}

// ─── the export ───────────────────────────────────────────────────────────────

export interface SapMapping {
  /** Field in the SAP payload. */
  sapField: string;
  /** Record field it was read from. */
  from: string;
  value: string;
  /** Whether the value's supporting quote was found in the document; absent = no quote. */
  verified?: EvidenceVerification;
}

export interface SapExport {
  target: {
    id: SapTarget;
    system: string;
    method: "POST";
    path: string;
  };
  /** True when nothing below blocks posting. Warnings never make an order unready. */
  ready: boolean;
  /** What must be resolved before this payload is posted. */
  blockers: string[];
  /** What a person should look at, but that does not stop the order. */
  warnings: string[];
  /** The request body. */
  payload: Record<string, unknown>;
  /** How each payload field traces back to the document. */
  mapping: SapMapping[];
  /** Values read from the order that this payload does not carry. */
  notInPayload: Record<string, string>;
  lines: SalesOrderLine[];
  source: {
    documentId: string;
    filename: string;
    docType: string;
    groundingScore?: number;
    processedAt: string;
  };
}

const TARGETS: Record<SapTarget, { system: string; path: string }> = {
  "sap-c4c": {
    system: "SAP Sales Cloud (Cloud for Customer)",
    path: "/sap/c4c/odata/v1/c4codataapi/CustomerOrderCollection",
  },
  "sap-s4": {
    system: "SAP S/4HANA",
    path: "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder",
  },
};

/** OData V2 JSON date literal for an ISO `YYYY-MM-DD`; null when it is not one. */
export function odataDate(iso: string | null): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `/Date(${Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))})/`;
}

/** Decimal quantities travel as strings in OData V2 JSON. */
const qty = (n: number) => String(n);

function put(payload: Record<string, unknown>, key: string, value: string | undefined | null): void {
  if (value !== undefined && value !== null && value !== "") payload[key] = value;
}

/** Build the SAP request body for one record, with its readiness report. */
export function toSapExport(
  rec: DocumentRecord,
  target: SapTarget,
  cfg: SapConfig = readSapConfig(),
): SapExport {
  const order = toSalesOrder(rec);
  const verifiedBy = new Map(rec.evidence.map((e) => [e.field, e.verified]));
  const mapping: SapMapping[] = [];
  const map = (sapField: string, from: string, value: string | null) => {
    if (value === null || value === "") return;
    mapping.push({ sapField, from, value, verified: verifiedBy.get(from) });
  };

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (rec.docType !== "purchase_order") {
    blockers.push(
      `This record was read as "${rec.docType}", not as a purchase order — there is no order to post.`,
    );
  }
  // A redacted or placeholder account ("XXXXXX", "****") is a missing account, not a party id.
  const masked =
    order.accountNumber && /^[xX*#\-_.\s]+$/.test(order.accountNumber) ? order.accountNumber : null;
  if (masked) {
    order.accountNumber = null;
    blockers.push(
      `The account number on the order is masked ("${masked}") — the sold-to account has to be looked up.`,
    );
  } else if (!order.accountNumber) {
    blockers.push(
      order.buyer
        ? `No account number on the order — the sold-to account for "${order.buyer}" has to be looked up.`
        : "No account number and no buyer name on the order — the sold-to account has to be identified.",
    );
  }
  if (order.lines.length === 0) {
    blockers.push(
      order.quoteReference
        ? `No order lines were read — the order refers to quote ${order.quoteReference}, so its lines have to come from the quote.`
        : "No order lines were read.",
    );
  }
  for (const l of order.lines) {
    if (!l.productId) blockers.push(`Line ${l.line} has no part or model number.`);
    else if (l.quantity === null) blockers.push(`Line ${l.line} (${l.productId}) has no quantity.`);
  }
  if (!order.customerPoNumber)
    warnings.push("The order carries no purchase-order number to use as the customer reference.");
  if (order.lines.length) {
    warnings.push(
      "Part numbers are as printed on the order; they have not been checked against the SAP product master.",
    );
  }
  const score = rec.meta.groundingScore;
  if (score !== undefined && score < 0.8) {
    warnings.push(
      `Only ${Math.round(score * 100)}% of the extracted values carry a verified quote — review the record first.`,
    );
  }
  for (const i of rec.issues) warnings.push(`${i.field}: ${i.message}`);

  const payload: Record<string, unknown> = {};
  const name = [order.buyer, order.customerPoNumber ? `PO ${order.customerPoNumber}` : null]
    .filter(Boolean)
    .join(" — ");

  if (target === "sap-c4c") {
    payload.ProcessingTypeCode = cfg.orderType;
    put(payload, "BuyerID", order.customerPoNumber);
    put(payload, "BuyerPartyID", order.accountNumber);
    put(payload, "Name", name || undefined);
    put(payload, "SalesUnitPartyID", cfg.salesOrganization);
    put(payload, "DistributionChannelCode", cfg.distributionChannel);
    put(payload, "DivisionCode", cfg.division);
    payload.CustomerOrderItem = order.lines
      .filter((l) => l.productId)
      .map((l) => ({
        ProductID: l.productId,
        ...(l.quantity !== null ? { Quantity: qty(l.quantity) } : {}),
      }));
    map("BuyerID", "po_number", order.customerPoNumber);
    map("BuyerPartyID", "account_number", order.accountNumber);
    map("Name", order.buyer ? "buyer" : "po_number", name || null);
    map("CustomerOrderItem", "line_items", order.lines.length ? `${order.lines.length} line(s)` : null);
  } else {
    payload.SalesOrderType = cfg.orderType;
    put(payload, "SalesOrganization", cfg.salesOrganization);
    put(payload, "DistributionChannel", cfg.distributionChannel);
    put(payload, "OrganizationDivision", cfg.division);
    put(payload, "SoldToParty", order.accountNumber);
    // 35 characters is the field's length in S/4HANA; a longer reference is reported, not cut silently.
    put(payload, "PurchaseOrderByCustomer", order.customerPoNumber?.slice(0, 35));
    if ((order.customerPoNumber?.length ?? 0) > 35) {
      warnings.push(
        "The purchase-order number is longer than the 35 characters S/4HANA keeps; it was shortened.",
      );
    }
    put(payload, "CustomerPurchaseOrderDate", odataDate(order.orderDate));
    put(payload, "RequestedDeliveryDate", odataDate(order.requestedDeliveryDate));
    payload.to_Item = order.lines
      .filter((l) => l.productId)
      .map((l) => ({
        Material: l.productId,
        ...(l.quantity !== null ? { RequestedQuantity: qty(l.quantity) } : {}),
      }));
    map("SoldToParty", "account_number", order.accountNumber);
    map("PurchaseOrderByCustomer", "po_number", order.customerPoNumber);
    map("CustomerPurchaseOrderDate", "order_date", odataDate(order.orderDate) ? order.orderDate : null);
    map(
      "RequestedDeliveryDate",
      "requested_delivery_date",
      odataDate(order.requestedDeliveryDate) ? order.requestedDeliveryDate : null,
    );
    map("to_Item", "line_items", order.lines.length ? `${order.lines.length} line(s)` : null);
  }

  for (const m of mapping) {
    if (m.verified === "unverified") {
      warnings.push(`${m.sapField} comes from a value whose quote was not found in the document.`);
    }
  }

  // What the order said that the payload above does not carry. The integration decides where
  // these belong (a text, a partner, a pricing element); dropping them silently would lose
  // exactly the things an order desk reads an order for.
  const notInPayload: Record<string, string> = {};
  const keep = (k: string, v: string | null) => {
    if (v) notInPayload[k] = v;
  };
  if (target === "sap-c4c") {
    keep("orderDate", order.orderDate);
    keep("requestedDeliveryDate", order.requestedDeliveryDate);
  }
  keep("quoteReference", order.quoteReference);
  keep("jobReference", order.jobReference);
  keep("orderedBy", order.orderedBy);
  keep("shipTo", order.shipTo);
  keep("deliveryInstructions", order.deliveryInstructions);
  keep("currency", order.currency);
  keep("total", order.total);

  return {
    target: { id: target, system: TARGETS[target].system, method: "POST", path: TARGETS[target].path },
    ready: blockers.length === 0,
    blockers,
    warnings,
    payload,
    mapping,
    notInPayload,
    lines: order.lines,
    source: {
      documentId: rec.id,
      filename: rec.filename,
      docType: rec.docType,
      groundingScore: score,
      processedAt: rec.meta.processedAt,
    },
  };
}
