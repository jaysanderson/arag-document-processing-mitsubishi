/**
 * The bundled PDF samples — orders as Mitsubishi Electric receives them — and the two
 * things a PDF needs that a text file does not: the mock must not present its bytes as its
 * text, and the visual extract strategy must actually reach the Knowledge Box.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createProduct, type Product, sendExtractStrategyHeader } from "../src/server.ts";
import { SAMPLES } from "../src/services/samples.ts";
import { type AragClient, Logger, readEnv, testing } from "../vendor/arag-platform/src/index.ts";

let product: Product;
let c: testing.TestClient;

before(async () => {
  const env = readEnv({
    ARAG_MOCK: "1",
    DATA_DIR: mkdtempSync(join(tmpdir(), "dip-pdf-")),
    RATE_LIMIT_RPS: "0",
    NODE_ENV: "test",
  });
  product = await createProduct(env, {
    log: new Logger({ level: "error", write: () => undefined }),
    persist: false,
  });
  c = await testing.startTestServer(product.app);
});

after(async () => {
  await c.close();
  await product.close();
});

async function waitForJob(id: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = product.jobs.get(id);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs} ms`);
}

/** Process a bundled sample and return its record and source text. */
async function runSample(sampleId: string): Promise<{ filename: string; docType: string; text: string }> {
  const res = await c.post("/api/v1/documents/sample", { sampleId });
  assert.equal(res.status, 202, res.text);
  const { document, job } = res.json as { document: { id: string }; job: { id: string } };
  await waitForJob(job.id);
  const rec = (await c.get(`/api/v1/documents/${document.id}`)).json as {
    filename: string;
    status: string;
    docType: string;
  };
  assert.equal(rec.status, "ready");
  const { text } = (await c.get(`/api/v1/documents/${document.id}/text`)).json as { text: string };
  return { filename: rec.filename, docType: rec.docType, text };
}

test("the order samples lead the catalogue, as PDFs under the names they arrived with", () => {
  const featured = SAMPLES.filter((s) => s.featured);
  assert.equal(featured.length, 6);
  assert.deepEqual(SAMPLES.slice(0, 6), featured, "the orders come before the generic samples");
  for (const s of featured) {
    assert.equal(s.kind, "pdf");
    assert.equal(s.contentType, "application/pdf");
    assert.match(s.url, /^\/samples\/pdf\/[a-z0-9-]+\.pdf$/, "the file on disk has a URL-safe name");
    const bytes = readFileSync(new URL(`../public${s.url}`, import.meta.url));
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-", `${s.id} is not a PDF`);
  }
  assert.equal(new Set(SAMPLES.map((s) => s.id)).size, SAMPLES.length, "sample ids are unique");
});

test("a PDF sample is read from its own text layer under the mock", async () => {
  const out = await runSample("me-po-1706");
  assert.equal(out.filename, "Purchase_Order_No_1706.pdf");
  assert.equal(out.docType, "purchase_order");
  assert.match(out.text, /PURCHASE ORDER NO\. 1706/);
  assert.match(out.text, /MSZAP71VGKIT/);
  // Not the mock's own fictional purchase order, which any filename containing "po" gets.
  assert.doesNotMatch(out.text, /COBALT MANUFACTURING/);
  const named = await runSample("me-po-aw25183dt");
  assert.match(named.text, /AW25183DT/);
  assert.doesNotMatch(named.text, /COBALT MANUFACTURING/);
});

test("every pipeline question reads the document through its own file field", async () => {
  await runSample("me-po-050031");
  const asks = product.mock!.mock.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/ask"),
  );
  assert.ok(asks.length >= 4, "classify, extract, entities and summary all ask");
  for (const call of asks) {
    const strategies = (call.body as { rag_strategies?: Array<{ name: string; fields?: string[] }> })
      .rag_strategies;
    assert.equal(
      strategies?.[0]?.name,
      "field_extension",
      "never full_resource: it fails once key-values are written",
    );
    assert.match(strategies?.[0]?.fields?.[0] ?? "", /^f\/.+/);
  }
});

test("a scanned sample has no text layer, so the mock says it cannot read it", async () => {
  const out = await runSample("me-order-43699");
  assert.equal(out.filename, "20261001_085058.pdf");
  assert.match(out.text, /Visual extraction placeholder/);
});

test("the mock never presents a PDF's raw bytes as its text", async () => {
  // This PDF's first 512 bytes are almost all printable, which is what used to pass the
  // mock's "is this text?" sniff and put `%PDF-1.7` in the record.
  const bytes = readFileSync(new URL("../public/samples/pdf/example-po.pdf", import.meta.url));
  const res = await c.request("POST", "/api/v1/documents?config=auto", {
    body: bytes as unknown as BodyInit,
    headers: { "Content-Type": "application/pdf", "X-Filename": "unknown-upload.pdf" },
  });
  assert.equal(res.status, 202, res.text);
  const { document, job } = res.json as { document: { id: string }; job: { id: string } };
  await waitForJob(job.id);
  const { text } = (await c.get(`/api/v1/documents/${document.id}/text`)).json as { text: string };
  assert.doesNotMatch(text, /%PDF-/);
  assert.match(text, /Visual extraction placeholder/);
});

test("an upload's extract strategy is sent in the header the Knowledge Box reads", async () => {
  const seen: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
  const client = {
    request: async (method: string, path: string, init: { headers?: Record<string, string> } = {}) => {
      seen.push({ method, path, headers: init.headers });
      return new Response("{}");
    },
  } as unknown as AragClient;
  const wrapped = sendExtractStrategyHeader(client);

  await wrapped.request("POST", "/upload?extract_strategy=abc-123", { headers: { "X-FILENAME": "eA==" } });
  assert.equal(seen[0]!.headers?.["x-extract-strategy"], "abc-123");
  assert.equal(seen[0]!.headers?.["X-FILENAME"], "eA==", "the caller's headers are kept");
  assert.equal(seen[0]!.path, "/upload?extract_strategy=abc-123", "the mock still reads the query");

  // Nothing else is touched: no strategy, or not an upload at all.
  await wrapped.request("POST", "/upload", {});
  await wrapped.request("GET", "/resource/r1?show=basic");
  assert.equal(seen[1]!.headers?.["x-extract-strategy"], undefined);
  assert.equal(seen[2]!.headers, undefined);
});
