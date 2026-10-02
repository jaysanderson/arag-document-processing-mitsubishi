/**
 * The SAP order hand-off: splitting extracted line items, building the request body for each
 * target, and reporting — rather than hiding — what stands between an order and being posted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENSION, FORMATS, serialize, serializeMany } from "../src/services/formats.ts";
import { odataDate, parseLineItem, readSapConfig, toSalesOrder, toSapExport } from "../src/services/sap.ts";
import type { DocumentRecord, ExtractedField } from "../src/types.ts";

const field = (key: string, value: ExtractedField["value"]): ExtractedField => ({ key, label: key, value });

function record(fields: ExtractedField[], over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc1",
    resourceId: "doc1",
    filename: "Purchase_Order_No_1706.pdf",
    contentType: "application/pdf",
    bytes: 100,
    status: "ready",
    docType: "purchase_order",
    fields,
    entities: [],
    tags: [],
    issues: [],
    evidence: [
      { field: "po_number", quote: "PURCHASE ORDER NO. 1706", verified: "exact" },
      { field: "account_number", quote: "Account: 112941", verified: "exact" },
    ],
    meta: {
      processedAt: "2026-10-02T00:00:00.000Z",
      schema: "purchase_order_extraction",
      model: "m",
      durationsMs: {},
      groundingScore: 1,
    },
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...over,
  } as DocumentRecord;
}

const ORDER = [
  field("po_number", "1706"),
  field("buyer", "Kingston Air"),
  field("account_number", "112941"),
  field("supplier", "MITSUBISHI ELECTRIC PTY LTD"),
  field("order_date", "2026-09-30"),
  field("requested_delivery_date", "2026-10-12"),
  field("quote_reference", "2732308"),
  field("line_items", [
    "1 | MSZAP71VGKIT | 7.1kW Wall Mount Split System With Wi-Fi | ",
    "2 | MSZAP25VGKIT | 2.5kW Wall Mount | $900.00",
  ]),
];

test("a line item is split by shape, whichever way round the model returned it", () => {
  // The order the schema asks for.
  assert.deepEqual(parseLineItem("2 | MSZAP25VGKIT | 2.5kW Wall Mount | $900.00", 1), {
    line: 1,
    quantity: 2,
    productId: "MSZAP25VGKIT",
    description: "2.5kW Wall Mount",
    unitPrice: "$900.00",
    asWritten: "2 | MSZAP25VGKIT | 2.5kW Wall Mount | $900.00",
  });
  // Empty trailing slots are kept as empty, not as a product.
  const sparse = parseLineItem("1 | PFAZ M100 VCAA2 MAKIT |  | ", 3);
  assert.equal(sparse.quantity, 1);
  assert.equal(sparse.productId, "PFAZ M100 VCAA2 MAKIT");
  assert.equal(sparse.description, null);
  assert.equal(sparse.unitPrice, null);
  // A table read left to right: part number first, quantity last.
  const tableOrder = parseLineItem("MSZAP71VGKIT | 7.1kW Wall Mount Split System With Wi-Fi | 1", 1);
  assert.equal(tableOrder.productId, "MSZAP71VGKIT");
  assert.equal(tableOrder.quantity, 1);
  assert.equal(tableOrder.description, "7.1kW Wall Mount Split System With Wi-Fi");
  assert.equal(parseLineItem("MUZ-GS25VFD2-A1 | 1", 2).quantity, 1);
  assert.equal(parseLineItem("2 EA | MSZ-AP35VGKD2-A2", 1).quantity, 2);
  assert.deepEqual(
    [parseLineItem("3 x MXZ-4F80VGD-A2", 1).quantity, parseLineItem("3 x MXZ-4F80VGD-A2", 1).productId],
    [3, "MXZ-4F80VGD-A2"],
  );
  // A part number that merely contains digits is never mistaken for a quantity.
  const bare = parseLineItem("MSZ-GS25VFD2-A1", 1);
  assert.equal(bare.productId, "MSZ-GS25VFD2-A1");
  assert.equal(bare.quantity, null);
  // Nothing to split: the text is kept and the missing quantity is the export's to report.
  assert.equal(parseLineItem("Quote 2732413", 1).quantity, null);
});

test("the sales-order view reads the order-desk fields off a record", () => {
  const order = toSalesOrder(record(ORDER));
  assert.equal(order.customerPoNumber, "1706");
  assert.equal(order.accountNumber, "112941");
  assert.equal(order.requestedDeliveryDate, "2026-10-12");
  assert.equal(order.lines.length, 2);
  assert.equal(order.shipTo, null);
});

test("a complete order becomes a Sales Cloud CustomerOrder with its items deep-inserted", () => {
  const out = toSapExport(record(ORDER), "sap-c4c", readSapConfig({}));
  assert.equal(out.ready, true);
  assert.deepEqual(out.blockers, []);
  assert.equal(out.target.path, "/sap/c4c/odata/v1/c4codataapi/CustomerOrderCollection");
  assert.deepEqual(out.payload, {
    ProcessingTypeCode: "OR",
    BuyerID: "1706",
    BuyerPartyID: "112941",
    Name: "Kingston Air — PO 1706",
    CustomerOrderItem: [
      { ProductID: "MSZAP71VGKIT", Quantity: "1" },
      { ProductID: "MSZAP25VGKIT", Quantity: "2" },
    ],
  });
  // What the order said that the payload does not carry is kept beside it, not dropped.
  assert.deepEqual(out.notInPayload, {
    orderDate: "2026-09-30",
    requestedDeliveryDate: "2026-10-12",
    quoteReference: "2732308",
  });
  // Each SAP field names the record field it came from, and whether its quote was verified.
  const buyerId = out.mapping.find((m) => m.sapField === "BuyerID")!;
  assert.deepEqual(buyerId, { sapField: "BuyerID", from: "po_number", value: "1706", verified: "exact" });
});

test("the same order becomes an S/4HANA sales order, dates as OData literals", () => {
  const cfg = readSapConfig({
    SAP_ORDER_TYPE: "ZOR",
    SAP_SALES_ORG: "2000",
    SAP_DISTRIBUTION_CHANNEL: "10",
    SAP_DIVISION: "00",
  });
  const out = toSapExport(record(ORDER), "sap-s4", cfg);
  assert.equal(out.target.path, "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder");
  assert.deepEqual(out.payload, {
    SalesOrderType: "ZOR",
    SalesOrganization: "2000",
    DistributionChannel: "10",
    OrganizationDivision: "00",
    SoldToParty: "112941",
    PurchaseOrderByCustomer: "1706",
    CustomerPurchaseOrderDate: "/Date(1790726400000)/",
    RequestedDeliveryDate: "/Date(1791763200000)/",
    to_Item: [
      { Material: "MSZAP71VGKIT", RequestedQuantity: "1" },
      { Material: "MSZAP25VGKIT", RequestedQuantity: "2" },
    ],
  });
  assert.equal(odataDate("1/10/26"), null, "only an ISO date becomes a literal");
  assert.equal(odataDate(null), null);
  // The dates are in the payload here, so they are not repeated beside it.
  assert.ok(!("orderDate" in out.notInPayload));
});

test("an order SAP could not take says why, instead of looking ready", () => {
  // The handwritten order: no account number, and one line with no quantity.
  const out = toSapExport(
    record(
      [
        field("po_number", "43699"),
        field("buyer", "Coastal Air"),
        field("line_items", ["1 | PFAZ M100 VCAA2 MAKIT", "MAC-588IF-E"]),
      ],
      {
        issues: [
          { field: "supplier", severity: "warning", message: 'Required field "supplier" was not extracted' },
        ],
        evidence: [{ field: "po_number", quote: "ORDER 43699", verified: "unverified" }],
        meta: {
          processedAt: "2026-10-02T00:00:00.000Z",
          schema: "purchase_order_extraction",
          model: "m",
          durationsMs: {},
          groundingScore: 0.5,
        },
      } as Partial<DocumentRecord>,
    ),
    "sap-c4c",
    readSapConfig({}),
  );
  assert.equal(out.ready, false);
  assert.ok(out.blockers.some((b) => /No account number/.test(b) && /Coastal Air/.test(b)));
  assert.ok(out.blockers.some((b) => /Line 2 \(MAC-588IF-E\) has no quantity/.test(b)));
  // The line still travels, without a quantity it never had.
  assert.deepEqual(out.payload.CustomerOrderItem, [
    { ProductID: "PFAZ M100 VCAA2 MAKIT", Quantity: "1" },
    { ProductID: "MAC-588IF-E" },
  ]);
  assert.ok(
    out.warnings.some((w) => /50%/.test(w)),
    "weak grounding is a warning",
  );
  assert.ok(
    out.warnings.some((w) => /BuyerID/.test(w) && /not found/.test(w)),
    "an unverified quote is named",
  );
  assert.ok(
    out.warnings.some((w) => /supplier/.test(w)),
    "the record's own issues are carried",
  );
  assert.ok(out.warnings.some((w) => /product master/.test(w)));

  const empty = toSapExport(record([]), "sap-s4", readSapConfig({}));
  assert.equal(empty.ready, false);
  assert.ok(empty.blockers.includes("No order lines were read."));
  assert.deepEqual(empty.payload, { SalesOrderType: "OR", to_Item: [] });

  // An order placed against a quote, with a masked account: both are said in so many words.
  const byQuote = toSapExport(
    record([field("account_number", "XXXXXX"), field("quote_reference", "2732413")]),
    "sap-c4c",
    readSapConfig({}),
  );
  assert.ok(byQuote.blockers.some((b) => /masked \("XXXXXX"\)/.test(b)));
  assert.ok(byQuote.blockers.some((b) => /quote 2732413/.test(b)));
  assert.ok(!("BuyerPartyID" in byQuote.payload), "a placeholder is never sent as the account");

  const invoice = toSapExport(record(ORDER, { docType: "invoice" }), "sap-c4c", readSapConfig({}));
  assert.ok(invoice.blockers.some((b) => /not as a purchase order/.test(b)));
});

test("the SAP hand-offs are export formats like any other", () => {
  assert.deepEqual([...FORMATS], ["json", "xml", "csv", "sap-c4c", "sap-s4"]);
  assert.equal(EXTENSION["sap-c4c"], "sap-c4c.json");
  const one = JSON.parse(serialize(record(ORDER), "sap-c4c")) as {
    target: { id: string };
    payload: { BuyerID: string };
  };
  assert.equal(one.target.id, "sap-c4c");
  assert.equal(one.payload.BuyerID, "1706");
  const many = JSON.parse(serializeMany([record(ORDER), record(ORDER, { id: "doc2" })], "sap-s4")) as Array<{
    source: { documentId: string };
  }>;
  assert.deepEqual(
    many.map((m) => m.source.documentId),
    ["doc1", "doc2"],
  );
});
