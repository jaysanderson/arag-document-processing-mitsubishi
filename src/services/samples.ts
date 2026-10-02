/**
 * The bundled sample documents behind the first-run flow and “Try with a sample”.
 *
 * These are ordinary files served from `public/samples/`; nothing about them is
 * special-cased in the pipeline. The catalogue exists so the UI does not hard-code a list
 * of filenames, and so a partner embedding the product can discover what ships with it
 * from the API (`GET /api/v1/samples`) rather than from the repository.
 */
import type { DocType } from "../types.ts";

export interface Sample {
  id: string;
  title: string;
  description: string;
  filename: string;
  contentType: string;
  /** Static path the client fetches the bytes from before uploading them. */
  url: string;
  kind: "text" | "image" | "pdf";
  expectedDocType: DocType;
  /** Shown up front on the welcome screen rather than under “Other samples”. */
  featured?: boolean;
}

const text = (
  id: string,
  title: string,
  description: string,
  expectedDocType: DocType,
  file = `${id}.txt`,
): Sample => ({
  id,
  title,
  description,
  filename: file,
  contentType: "text/plain",
  url: `/samples/${file}`,
  kind: "text",
  expectedDocType,
});

const image = (
  id: string,
  title: string,
  description: string,
  expectedDocType: DocType,
  file = `${id}.png`,
): Sample => ({
  id,
  title,
  description,
  filename: file,
  contentType: "image/png",
  url: `/samples/images/${file}`,
  kind: "image",
  expectedDocType,
});

/**
 * A PDF sample. `filename` is the name the document arrived under — it is what the queue
 * shows — while the file on disk has a URL-safe name of its own.
 */
const pdf = (
  id: string,
  title: string,
  description: string,
  expectedDocType: DocType,
  file: string,
  filename: string,
): Sample => ({
  id,
  title,
  description,
  filename,
  contentType: "application/pdf",
  url: `/samples/pdf/${file}`,
  kind: "pdf",
  expectedDocType,
  featured: true,
});

export const SAMPLES: readonly Sample[] = [
  // Orders as Mitsubishi Electric Australia receives them: six layouts, one canonical record.
  pdf(
    "me-po-1706",
    "Purchase order No. 1706",
    "Twelve lines of split systems, ducted kits and zone controllers ordered against quotation 2732308, with ordered and required dates.",
    "purchase_order",
    "po-1706.pdf",
    "Purchase_Order_No_1706.pdf",
  ),
  pdf(
    "me-po-050031",
    "Purchase order 050031",
    "A job-management system's order: three split-system part numbers against job 111986, with a delivery date and time.",
    "purchase_order",
    "hvac-po-050031.pdf",
    "hvac Purchase Order 050031.pdf",
  ),
  pdf(
    "me-po-aw25183dt",
    "Purchase order AW25183DT",
    "A contractor's order for an MSZ/MUZ-GS25 pair against job PW103289, with no prices filled in.",
    "purchase_order",
    "po-aw25183dt.pdf",
    "PO_AW25183DT.pdf",
  ),
  pdf(
    "me-order-43699",
    "Handwritten order 43699",
    "A scanned page from an order book: a handwritten model number, delivery day and pricing note. The hard case for the visual path.",
    "purchase_order",
    "order-43699-scan.pdf",
    "20261001_085058.pdf",
  ),
  pdf(
    "me-example-po",
    "Letter-style order form",
    "A one-page letter that orders by quote number (Quote 2732413) instead of listing models, with the contact details removed.",
    "purchase_order",
    "example-po.pdf",
    "Example PO.pdf",
  ),
  pdf(
    "me-order-form",
    "HVAC order form (blank)",
    "Mitsubishi Electric Australia's own order form, not filled in — what the pipeline reports when the page has labels and no values.",
    "form",
    "hvac-order-form-v2.pdf",
    "HVAC Order Form v2.pdf",
  ),
  text(
    "invoice",
    "Supplier invoice",
    "A clean tax invoice: supplier, invoice number, dates, line items, subtotal, tax and total.",
    "invoice",
  ),
  text(
    "purchase-order",
    "Purchase order",
    "Buyer, supplier, PO number and an item table — the other half of a three-way match.",
    "purchase_order",
  ),
  text(
    "contract",
    "Services agreement",
    "Parties, term, value, governing law and termination provisions. Good for the ask panel.",
    "contract",
  ),
  text(
    "bank-statement",
    "Bank statement",
    "Account holder, statement period, opening and closing balances and a transaction list.",
    "bank_statement",
  ),
  text("receipt", "Retail receipt", "A short till receipt: merchant, items, tax and total.", "receipt"),
  text("resume", "Résumé", "Candidate, contact details, skills and employment history.", "resume"),
  image(
    "invoice-image",
    "Scanned invoice",
    "A photographed invoice — the visual path, read as an image rather than as text.",
    "invoice",
    "invoice.png",
  ),
  image(
    "purchase-order-image",
    "Scanned purchase order",
    "A photographed purchase order for the visual extraction path.",
    "purchase_order",
    "purchase-order.png",
  ),
  image(
    "preauth-form-image",
    "Pre-authorisation form",
    "A scanned hospital pre-authorisation request with boxed form fields.",
    "preauthorisation",
    "preauth-form.png",
  ),
  image(
    "remittance-statement-image",
    "Remittance statement",
    "A scanned remittance advice — a dense, tabular document with no dedicated schema.",
    "generic",
    "remittance-statement.png",
  ),
];
