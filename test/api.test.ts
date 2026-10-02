/**
 * Integration + contract tests: boot the whole product in-process against the mock ARAG.
 * Every assertion that touches a response also checks it against the OpenAPI schema.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openapi } from "../src/openapi.ts";
import { createProduct, type Product } from "../src/server.ts";
import { DOC_TYPE_VALUES, STAGES } from "../src/types.ts";
import { Logger, readEnv, testing } from "../vendor/arag-platform/src/index.ts";

const ADMIN = "test-admin-token";
const INVOICE = readFileSync(new URL("../public/samples/invoice.txt", import.meta.url));

let product: Product;
let c: testing.TestClient;
/** Session cookie from POST /api/v1/session — destructive verbs require a credential. */
let writer: Record<string, string>;

before(async () => {
  const env = readEnv({
    ARAG_MOCK: "1",
    ADMIN_TOKEN: ADMIN,
    DATA_DIR: mkdtempSync(join(tmpdir(), "dip-")),
    RATE_LIMIT_RPS: "0",
    NODE_ENV: "test",
  });
  product = await createProduct(env, {
    log: new Logger({ level: "error", write: () => undefined }),
    persist: false,
  });
  c = await testing.startTestServer(product.app);
  const session = await c.post("/api/v1/session");
  writer = { cookie: session.headers.get("set-cookie")!.split(";")[0]! };
});

after(async () => {
  await c.close();
  await product.close();
});

/** Upload a document and wait for its job to finish. */
async function upload(
  body: Buffer | string,
  filename: string,
  contentType: string,
  config = "auto",
): Promise<{ id: string; jobId: string }> {
  const res = await c.request("POST", `/api/v1/documents?config=${encodeURIComponent(config)}`, {
    body: body as unknown as BodyInit,
    headers: { "Content-Type": contentType, "X-Filename": filename },
  });
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents", "post", 202, res.json), []);
  const { document, job } = res.json as { document: { id: string }; job: { id: string } };
  await waitForJob(job.id);
  return { id: document.id, jobId: job.id };
}

async function waitForJob(id: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = product.jobs.get(id);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status))
      return job as unknown as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs} ms`);
}

// ─── contract ─────────────────────────────────────────────────────────────────

test("the OpenAPI document is lint-clean and every /api/v1 route is documented", () => {
  assert.deepEqual(testing.lintSpec(openapi), []);
  assert.deepEqual(testing.missingFromSpec(product.app, openapi), []);
});

test("docs, health and static surfaces are served", async () => {
  assert.equal((await c.get("/api/v1/openapi.json")).status, 200);
  assert.match((await c.get("/api/v1/docs")).text, /redoc/i);
  assert.match((await c.get("/api/v1/swagger")).text, /swagger/i);
  assert.equal((await c.get("/healthz")).status, 200);
  const ready = await c.get("/readyz");
  assert.equal((ready.json as { arag: { ok: boolean } }).arag.ok, true);
  // Readiness is cached briefly (every open tab polls it every 15 s, and each uncached
  // check costs a catalog + configuration call): an immediate second call is byte-identical.
  const again = await c.get("/readyz");
  assert.equal(again.text, ready.text, "/readyz should be served from the cache");
  // Both surfaces are shells rendered by their own module; the product's components live
  // in ui-ext.css and the Progress wordmarks are the kit's, served from /ui/brand/ (the
  // product's own copies went with platform kit v0.2.0, which ships the official artwork).
  assert.match((await c.get("/")).text, /id="app"/);
  assert.match((await c.get("/")).text, /\/ui-ext\.css/);
  assert.match((await c.get("/admin/")).text, /admin\.js/);
  assert.match((await c.get("/ui/arag-ui.css")).headers.get("content-type") ?? "", /text\/css/);
  assert.match((await c.get("/ui-ext.css")).headers.get("content-type") ?? "", /text\/css/);
  assert.match((await c.get("/lib/core.js")).headers.get("content-type") ?? "", /javascript/);
  for (const logo of ["/ui/brand/arag-logo.svg", "/ui/brand/arag-logo-alt.svg"]) {
    const res = await c.get(logo);
    assert.equal(res.status, 200, logo);
    assert.match(res.text, /#5ce500/, "the official wordmark carries Progress green");
  }
});

// ─── pipeline ─────────────────────────────────────────────────────────────────

test("upload → job → canonical record with extracted fields, entities, summary", async () => {
  const { id, jobId } = await upload(INVOICE, "invoice.txt", "text/plain");

  const job = product.jobs.get(jobId)!;
  assert.equal(job.status, "succeeded");
  assert.equal(job.kind, "process-document");
  // The job emits exactly the documented stage names, in order.
  const stages = [...new Set(job.events.map((e) => e.stage))];
  assert.deepEqual(stages, [...STAGES]);

  const got = await c.get(`/api/v1/documents/${id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents/{id}", "get", 200, got.json), []);
  const rec = got.json as {
    status: string;
    docType: string;
    fields: Array<{ key: string; value: unknown }>;
    entities: unknown[];
    summary?: string;
    evidence: Array<{ field: string; quote: string; verified: string; paragraphId?: string }>;
    meta: {
      schema: string;
      searchConfiguration?: string;
      sourceChars?: number;
      durationsMs: Record<string, number>;
      groundingScore?: number;
    };
  };
  assert.equal(rec.status, "ready");
  assert.equal(rec.docType, "invoice");
  assert.equal(rec.meta.schema, "invoice_extraction");
  assert.equal(rec.meta.searchConfiguration, "dip_invoice_extraction");
  assert.ok((rec.meta.sourceChars ?? 0) > 100);
  // The record carries the per-stage timings, not just the job (the demo and the API
  // both report `meta.durationsMs`).
  assert.deepEqual(Object.keys(rec.meta.durationsMs).sort(), [...STAGES].sort());
  const byKey = Object.fromEntries(rec.fields.map((f) => [f.key, f.value]));
  assert.equal(byKey.invoice_number, "INV-2026-0042");
  // Amounts are captured as STRINGS by the schema then normalised to numbers here.
  assert.equal(typeof byKey.total, "number");
  assert.equal(byKey.invoice_date, "2026-06-15"); // 15/06/2026 → ISO
  assert.ok(rec.entities.length > 0);
  assert.ok((rec.summary ?? "").length > 0);

  // Verified evidence: every extracted field carries a quote that really is in the document.
  assert.equal(rec.evidence.length, rec.fields.length);
  assert.ok(
    rec.evidence.every((e) => e.verified === "exact"),
    JSON.stringify(rec.evidence.slice(0, 2)),
  );
  assert.ok(rec.evidence.every((e) => typeof e.paragraphId === "string"));
  assert.equal(rec.meta.groundingScore, 1);
  const vendorEvidence = rec.evidence.find((e) => e.field === "vendor_name")!;
  assert.match(vendorEvidence.quote, /ACME ROBOTICS/);
});

test("SSE job events replay the pipeline for a finished job", async () => {
  const jobs = product.jobs.list({ kind: "process-document", limit: 1 });
  const jobId = jobs[0]!.id;
  const ev = await c.get(`/api/v1/jobs/${jobId}/events`);
  assert.equal(ev.status, 200);
  assert.match(ev.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(ev.text, /event: event/);
  assert.match(ev.text, /event: job/);
  assert.match(ev.text, /standardize/);
});

test("a forced extraction config skips classification", async () => {
  const { id, jobId } = await upload(INVOICE, "forced-invoice.txt", "text/plain", "purchase_order");
  const job = product.jobs.get(jobId)!;
  const classify = job.events.find((e) => e.stage === "classify");
  assert.equal(classify?.status, "skip");
  const rec = (await c.get(`/api/v1/documents/${id}`)).json as {
    docType: string;
    meta: { forced: boolean; config: string; configLabel: string };
  };
  assert.equal(rec.docType, "purchase_order");
  assert.equal(rec.meta.forced, true);
  // The **id**, not the label. Everything downstream resolves this, so storing
  // "purchase order" here made `?config=purchase_order` return nothing for forced
  // uploads, zeroed every per-config document count, and left the record's key-value
  // view unable to look up the declared types.
  assert.equal(rec.meta.config, "purchase_order");
  assert.equal(rec.meta.configLabel, "purchase order");

  // The filter and the counts are the two things that were silently wrong.
  const byConfig = (await c.get("/api/v1/documents?config=purchase_order")).json as {
    items: Array<{ id: string }>;
  };
  assert.ok(
    byConfig.items.some((d) => d.id === id),
    "a forced upload must come back when filtering by the config it was forced to",
  );
  const stats = (await c.get("/api/v1/extraction-configs")).json as {
    items: Array<{ id: string; documentCount: number }>;
  };
  const po = stats.items.find((cfg) => cfg.id === "purchase_order");
  assert.ok((po?.documentCount ?? 0) > 0, "the config's own document count must see it too");
});

test("listing is paged and filterable", async () => {
  const list = await c.get("/api/v1/documents?page=1&page_size=10&status=ready");
  assert.equal(list.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents", "get", 200, list.json), []);
  const page = list.json as { items: unknown[]; total: number; page_size: number };
  assert.ok(page.total >= 2);
  assert.equal(page.page_size, 10);
  assert.equal((await c.get("/api/v1/documents?page=0")).status, 400);
  assert.equal((await c.get("/api/v1/documents?doc_type=not-a-type")).status, 400);
});

// ─── exports ──────────────────────────────────────────────────────────────────

test("exports serialise the record as JSON, XML and CSV with a download filename", async () => {
  const { id } = await upload(INVOICE, "export-me.txt", "text/plain");

  const json = await c.get(`/api/v1/documents/${id}/export?format=json`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-disposition") ?? "", /filename="export-me\.json"/);
  assert.equal((JSON.parse(json.text) as { id: string }).id, id);

  const xml = await c.get(`/api/v1/documents/${id}/export?format=xml`);
  assert.match(xml.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(xml.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml.text, /<document id="/);
  assert.match(xml.text, /<fields>/);
  assert.match(xml.text, /<evidence>/);
  assert.match(xml.text, /<groundingScore>/);

  const csv = await c.get(`/api/v1/documents/${id}/export?format=csv`);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(csv.text.split("\n")[0]!, /^document_id,filename,doc_type,field_key/);
  assert.match(csv.text.split("\n")[0]!, /evidence_quote,evidence_verified$/);
  assert.match(csv.text, /,exact$/m, "each field row carries its verified quote");
  assert.ok(csv.text.split("\n").length > 2);

  // The SAP hand-offs are formats too: a request body plus what stands between it and SAP.
  for (const format of ["sap-c4c", "sap-s4"]) {
    const sap = await c.get(`/api/v1/documents/${id}/export?format=${format}`);
    assert.equal(sap.status, 200, sap.text);
    const out = JSON.parse(sap.text) as { target: { id: string }; ready: boolean; blockers: string[] };
    assert.deepEqual(
      testing.checkResponse(openapi, "/api/v1/documents/{id}/export", "get", 200, out, "application/json"),
      [],
    );
    assert.match(sap.headers.get("content-disposition") ?? "", new RegExp(`\\.${format}\\.json"$`));
    assert.equal(out.target.id, format);
    // An invoice is not an order: the export says so rather than inventing one.
    assert.equal(out.ready, false);
    assert.ok(out.blockers.some((b) => /not as a purchase order/.test(b)));
  }

  assert.equal((await c.get(`/api/v1/documents/${id}/export?format=yaml`)).status, 400);
});

// ─── ask ──────────────────────────────────────────────────────────────────────

test("ask answers a question grounded in one document", async () => {
  const { id } = await upload(INVOICE, "ask-me.txt", "text/plain");
  const res = await c.post(`/api/v1/documents/${id}/ask`, { question: "What is the total due?" });
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents/{id}/ask", "post", 200, res.json), []);
  const ans = res.json as { answer: string; sources: string[] };
  assert.ok(ans.answer.length > 0);
  assert.ok(Array.isArray(ans.sources));
  assert.equal((await c.post(`/api/v1/documents/${id}/ask`, { question: "" })).status, 400);
  assert.equal((await c.post("/api/v1/documents/missing/ask", { question: "hi" })).status, 404);
});

// ─── upload validation ────────────────────────────────────────────────────────

test("uploads are validated: MIME allowlist, empty body, unknown config", async () => {
  const bad = await c.request("POST", "/api/v1/documents", {
    body: "MZ\x00binary" as unknown as BodyInit,
    headers: { "Content-Type": "application/x-msdownload", "X-Filename": "virus.exe" },
  });
  assert.equal(bad.status, 415);
  assert.equal((bad.json as { title: string }).title, "Unsupported media type");

  const empty = await c.request("POST", "/api/v1/documents", {
    body: "" as unknown as BodyInit,
    headers: { "Content-Type": "text/plain", "X-Filename": "empty.txt" },
  });
  assert.equal(empty.status, 400);

  const unknown = await c.request("POST", "/api/v1/documents?config=nope", {
    body: "hello" as unknown as BodyInit,
    headers: { "Content-Type": "text/plain", "X-Filename": "a.txt" },
  });
  assert.equal(unknown.status, 400);
});

test("filenames are sanitised before they reach the KB or Content-Disposition", async () => {
  const res = await c.request("POST", "/api/v1/documents", {
    body: INVOICE as unknown as BodyInit,
    headers: { "Content-Type": "text/plain", "X-Filename": '../../etc/pa"sswd.txt' },
  });
  assert.equal(res.status, 202);
  const { document } = res.json as { document: { filename: string; id: string } };
  assert.equal(document.filename, "pa_sswd.txt");
  await waitForJob((res.json as { job: { id: string } }).job.id);
  const exp = await c.get(`/api/v1/documents/${document.id}/export?format=csv`);
  assert.match(exp.headers.get("content-disposition") ?? "", /filename="pa_sswd\.csv"/);
});

test("multipart uploads work and carry the config field", async () => {
  // Mixed case on purpose: browsers send `----WebKitFormBoundaryAbC…` and the boundary
  // must survive verbatim (a lowercased Content-Type finds no parts at all).
  const boundary = "----DipTestBoundaryAbC123";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\ncontract\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="contract.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n`,
    ),
    readFileSync(new URL("../public/samples/contract.txt", import.meta.url)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await c.request("POST", "/api/v1/documents", {
    body: body as unknown as BodyInit,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.status, 202, res.text);
  const { document, job } = res.json as { document: { filename: string; id: string }; job: { id: string } };
  assert.equal(document.filename, "contract.txt");
  await waitForJob(job.id);
  const rec = (await c.get(`/api/v1/documents/${document.id}`)).json as { docType: string };
  assert.equal(rec.docType, "contract");
});

// ─── extraction configs ───────────────────────────────────────────────────────

test("extraction configs: built-ins listed, custom created + provisioned + deletable", async () => {
  const list = await c.get("/api/v1/extraction-configs");
  assert.equal(list.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/extraction-configs", "get", 200, list.json), []);
  const builtins = (list.json as { items: Array<{ builtin: boolean; id: string; aragConfig: string }> })
    .items;
  assert.equal(builtins.filter((c2) => c2.builtin).length, DOC_TYPE_VALUES.length);
  assert.ok(builtins.some((c2) => c2.id === "medical_claim"));
  assert.ok(builtins.some((c2) => c2.id === "preauthorisation"));
  assert.ok(builtins.some((c2) => c2.id === "bank_statement"));
  assert.ok(builtins.every((c2) => c2.aragConfig.startsWith("dip_")));

  const created = await c.post(
    "/api/v1/extraction-configs",
    {
      name: "Insurance Card",
      fields: [
        { label: "Policy Number", required: true },
        { label: "Insurer" },
        { label: "Benefits", type: "array" },
      ],
    },
    writer,
  );
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/extraction-configs", "post", 201, created.json),
    [],
  );
  const cfg = created.json as { id: string; aragConfig: string; provisioned: boolean; fields: unknown[] };
  assert.match(cfg.id, /^cfg_/);
  assert.equal(cfg.aragConfig, "dip_custom_insurance_card");
  assert.equal(cfg.provisioned, true);
  assert.equal(cfg.fields.length, 3);

  // The stored ARAG search configuration really exists in the (mock) KB.
  const stored = await product.arag.getSearchConfiguration("dip_custom_insurance_card");
  assert.equal(stored.kind, "ask");
  const storedConfig = stored.config as { rag_strategies: Array<{ name: string }>; prompt: unknown };
  assert.equal(storedConfig.rag_strategies[0]!.name, "full_resource");

  const one = await c.get(`/api/v1/extraction-configs/${cfg.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/extraction-configs/{id}", "get", 200, one.json),
    [],
  );

  // The custom config is usable as the upload `config` parameter.
  const { id: docId } = await upload(INVOICE, "custom-cfg.txt", "text/plain", cfg.id);
  const rec = (await c.get(`/api/v1/documents/${docId}`)).json as {
    meta: { config: string; configLabel: string };
  };
  // Same rule for a custom config: the `cfg_…` id is stored, the name is the label.
  assert.equal(rec.meta.config, cfg.id);
  assert.equal(rec.meta.configLabel, "Insurance Card");
  const mine = (await c.get(`/api/v1/documents?config=${cfg.id}`)).json as {
    items: Array<{ id: string }>;
  };
  assert.ok(mine.items.some((d) => d.id === docId));

  assert.equal(
    (await c.request("DELETE", "/api/v1/extraction-configs/invoice", { headers: writer })).status,
    409,
  );
  assert.equal(
    (await c.request("DELETE", `/api/v1/extraction-configs/${cfg.id}`, { headers: writer })).status,
    204,
  );
  assert.equal((await c.get(`/api/v1/extraction-configs/${cfg.id}`)).status, 404);

  const badCfg = await c.post("/api/v1/extraction-configs", { name: "", fields: [] }, writer);
  assert.equal(badCfg.status, 400);
});

test("the schema catalogue lists every document type and its fields", async () => {
  const res = await c.get("/api/v1/schemas");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/schemas", "get", 200, res.json), []);
  const items = (res.json as { items: Array<{ docType: string; fields: unknown[] }> }).items;
  assert.equal(items.length, DOC_TYPE_VALUES.length);
  const invoice = items.find((i) => i.docType === "invoice")!;
  assert.ok(invoice.fields.length >= 10);
});

// ─── jobs ─────────────────────────────────────────────────────────────────────

test("jobs are listable, fetchable and cancellable", async () => {
  const list = await c.get("/api/v1/jobs?limit=5");
  assert.equal(list.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/jobs", "get", 200, list.json), []);
  const jobs = (list.json as { items: Array<{ id: string }> }).items;
  const one = await c.get(`/api/v1/jobs/${jobs[0]!.id}`);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/jobs/{id}", "get", 200, one.json), []);
  assert.equal((await c.get("/api/v1/jobs/missing")).status, 404);
  assert.equal((await c.request("DELETE", "/api/v1/jobs/missing", { headers: writer })).status, 404);
  // Cancelling a job that already finished is a conflict, not a silent success.
  const late = await c.request("DELETE", `/api/v1/jobs/${jobs[0]!.id}`, { headers: writer });
  assert.equal(late.status, 409);
  assert.match((late.json as { detail: string }).detail, /already succeeded/);
});

// ─── admin ────────────────────────────────────────────────────────────────────

test("admin routes require the token; login sets an HttpOnly cookie", async () => {
  assert.equal((await c.get("/api/v1/admin/health")).status, 401);
  const h = await c.get("/api/v1/admin/health", { authorization: `Bearer ${ADMIN}` });
  assert.equal(h.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/admin/health", "get", 200, h.json), []);
  const health = h.json as {
    arag: { ok: boolean; mock: boolean };
    generativeModel: string;
    documents: Record<string, number>;
  };
  assert.equal(typeof health.documents.degraded, "number");
  assert.equal(health.arag.ok, true);
  assert.equal(health.arag.mock, true);
  assert.ok(health.generativeModel.length > 0);

  const login = await c.post("/api/v1/admin/login", { token: ADMIN });
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal((await c.get("/api/v1/admin/config", { cookie })).status, 200);
  assert.equal((await c.get("/api/v1/admin/usage", { cookie })).status, 200);
  assert.equal((await c.get("/api/v1/admin/logs?level=info&limit=10", { cookie })).status, 200);
  assert.equal((await c.post("/api/v1/admin/login", { token: "wrong" })).status, 401);

  // Sign-out is the other half of sign-in: an operator on a shared machine must be able to
  // end the session rather than wait twelve hours for the cookie to expire.
  const out = await c.post("/api/v1/admin/logout", {}, { cookie });
  assert.equal(out.status, 200);
  const cleared = out.headers.get("set-cookie") ?? "";
  assert.match(cleared, /arag_admin=/);
  assert.match(cleared, /Max-Age=0/, "the cookie must actually be removed, not just emptied");
  // Signing out when you were not signed in is not an error — answering differently would
  // tell an unauthenticated caller whether a session existed.
  assert.equal((await c.post("/api/v1/admin/logout", {})).status, 200);
});

test("admin config redacts secrets", async () => {
  const cfg = await c.get("/api/v1/admin/config", { authorization: `Bearer ${ADMIN}` });
  const body = JSON.stringify(cfg.json);
  assert.ok(body.includes("adminToken"));
  assert.ok(!body.includes(ADMIN), "the admin token must never be echoed back");
});

test("admin provision re-creates every ARAG search configuration", async () => {
  const res = await c.post("/api/v1/admin/provision", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/admin/provision", "post", 200, res.json), []);
  const out = res.json as { ok: number; failed: number; items: Array<{ aragConfig: string; ok: boolean }> };
  assert.equal(out.failed, 0);
  assert.ok(out.ok >= DOC_TYPE_VALUES.length);
  assert.ok(out.items.every((i) => i.aragConfig.startsWith("dip_")));

  // The provisioned configurations are readable back from the Knowledge Box.
  const listed = await c.get("/api/v1/admin/search-configurations", {
    authorization: `Bearer ${ADMIN}`,
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/admin/search-configurations", "get", 200, listed.json),
    [],
  );
  const configs = listed.json as {
    items: Array<{ name: string; kind: string; config: Record<string, unknown> }>;
  };
  assert.ok(configs.items.length >= DOC_TYPE_VALUES.length);
  const invoiceCfg = configs.items.find((i) => i.name === "dip_invoice_extraction")!;
  assert.equal(invoiceCfg.kind, "ask");
  assert.equal((invoiceCfg.config.rag_strategies as Array<{ name: string }>)[0]!.name, "full_resource");
  assert.ok(invoiceCfg.config.answer_json_schema, "the stored config carries the extraction schema");
  assert.equal((await c.get("/api/v1/admin/search-configurations")).status, 401);
});

test("admin purge deletes old documents from the store and the KB", async () => {
  const before0 = product.documents.stats().total ?? 0;
  assert.ok(before0 > 0);
  const res = await c.post("/api/v1/admin/purge", { olderThanDays: 0 }, { authorization: `Bearer ${ADMIN}` });
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/admin/purge", "post", 200, res.json), []);
  const out = res.json as { deleted: string[]; failed: unknown[] };
  assert.equal(out.deleted.length, before0);
  assert.equal(out.failed.length, 0);
  assert.equal(product.documents.stats().total, 0);
});

test("deleting a document also deletes the KB resource", async () => {
  const { id } = await upload(INVOICE, "delete-me.txt", "text/plain");
  assert.equal((await c.request("DELETE", `/api/v1/documents/${id}`, { headers: writer })).status, 204);
  assert.equal((await c.get(`/api/v1/documents/${id}`)).status, 404);
  assert.equal((await c.request("DELETE", `/api/v1/documents/${id}`, { headers: writer })).status, 404);
  await assert.rejects(() => product.arag.getResource(id));
});

test("destructive verbs reject anonymous callers even when API_KEYS is unset", async () => {
  const { id } = await upload(INVOICE, "guard-me.txt", "text/plain");
  // Reads and uploads stay open so the docs and the demo work with no setup…
  assert.equal((await c.get(`/api/v1/documents/${id}`)).status, 200);
  // …but deleting a document also deletes the Knowledge Box resource.
  const anon = await c.request("DELETE", `/api/v1/documents/${id}`);
  assert.equal(anon.status, 401);
  assert.match((anon.json as { detail: string }).detail, /POST \/api\/v1\/session/);
  assert.equal((await c.request("DELETE", "/api/v1/jobs/anything")).status, 401);
  assert.equal((await c.request("DELETE", "/api/v1/extraction-configs/invoice")).status, 401);
  // Creating a config provisions a stored ARAG search configuration — also a shared write.
  const anonCfg = await c.post("/api/v1/extraction-configs", {
    name: "Anon Probe",
    fields: [{ label: "Anything" }],
  });
  assert.equal(anonCfg.status, 401);
  // The admin token is also a writer credential.
  assert.equal(
    (
      await c.request("DELETE", `/api/v1/documents/${id}`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).status,
    204,
  );
});

test("a session cookie can be issued for the demo UI", async () => {
  const res = await c.post("/api/v1/session");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/session", "post", 200, res.json), []);
  assert.match(res.headers.get("set-cookie") ?? "", /arag_session=/);
});

test("errors are RFC 9457 problem documents with a request id", async () => {
  const res = await c.get("/api/v1/documents/does-not-exist");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/problem\+json/);
  const problem = res.json as { type: string; status: number; requestId: string; instance: string };
  assert.equal(problem.type, "https://arag.dev/problems/not-found");
  assert.equal(problem.status, 404);
  assert.ok(problem.requestId.length > 0);
  assert.equal(problem.instance, "/api/v1/documents/does-not-exist");
});

// ─── list search, filters, sorting ────────────────────────────────────────────

test("the documents list searches, filters and sorts", async () => {
  const a = await upload(INVOICE, "search-invoice.txt", "text/plain", "invoice");
  const b = await upload(
    "PURCHASE ORDER\nPO Number: PO-SEARCH-77\nSupplier: Zenith Components\n",
    "search-po.txt",
    "text/plain",
    "purchase_order",
  );

  const page = await c.get("/api/v1/documents?page_size=200");
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents", "get", 200, page.json), []);

  // `q` searches the extracted values, not just the filename: the invoice number is
  // nowhere in "search-invoice.txt", and finding it is the point of the box.
  const byNumber = await c.get("/api/v1/documents?q=INV-2026-0042");
  const hits = (byNumber.json as { items: Array<{ id: string }> }).items;
  assert.ok(
    hits.some((d) => d.id === a.id),
    "expected the invoice to be found by a value printed on it",
  );
  assert.ok(!hits.some((d) => d.id === b.id));

  // Search is case-insensitive and matches the filename too.
  assert.ok(
    (await c.get("/api/v1/documents?q=SEARCH-PO")).json &&
      ((await c.get("/api/v1/documents?q=search-po")).json as { items: Array<{ id: string }> }).items.some(
        (d) => d.id === b.id,
      ),
  );

  // Filters combine with AND.
  const filtered = await c.get("/api/v1/documents?doc_type=purchase_order&status=ready");
  const ids = (filtered.json as { items: Array<{ id: string }> }).items.map((d) => d.id);
  assert.ok(ids.includes(b.id));
  assert.ok(!ids.includes(a.id));

  // Sorting: ascending filename is the reverse of descending filename.
  const asc = (
    (await c.get("/api/v1/documents?sort=filename&order=asc&page_size=200")).json as {
      items: Array<{ filename: string }>;
    }
  ).items.map((d) => d.filename);
  const desc = (
    (await c.get("/api/v1/documents?sort=filename&order=desc&page_size=200")).json as {
      items: Array<{ filename: string }>;
    }
  ).items.map((d) => d.filename);
  assert.deepEqual(asc, [...desc].reverse());
  assert.deepEqual(
    asc,
    [...asc].sort((x, y) => x.localeCompare(y)),
  );

  // A bare YYYY-MM-DD date bound covers the whole day in both directions.
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = await c.get(`/api/v1/documents?date_from=${today}&date_to=${today}&page_size=200`);
  assert.ok((sameDay.json as { total: number }).total >= 2);
  assert.equal(
    (await c.get("/api/v1/documents?date_from=2000-01-01&date_to=2000-01-02")).json &&
      ((await c.get("/api/v1/documents?date_to=2000-01-02")).json as { total: number }).total,
    0,
  );

  // An unknown sort value is rejected by the spec, not silently ignored.
  assert.equal((await c.get("/api/v1/documents?sort=nonsense")).status, 400);
});

// ─── bulk actions ─────────────────────────────────────────────────────────────

test("bulk export bundles several records into one file per format", async () => {
  const a = await upload(INVOICE, "bulk-a.txt", "text/plain", "invoice");
  const b = await upload(INVOICE, "bulk-b.txt", "text/plain", "invoice");

  const json = await c.request("POST", "/api/v1/documents/bulk-export", {
    json: { ids: [a.id, b.id], format: "json" },
  });
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-disposition") ?? "", /attachment; filename="documents-/);
  assert.equal((JSON.parse(json.text) as unknown[]).length, 2);

  const xml = await c.request("POST", "/api/v1/documents/bulk-export", {
    json: { ids: [a.id, b.id], format: "xml" },
  });
  // Exactly one XML declaration, one root, both documents inside it.
  assert.equal(xml.text.match(/<\?xml/g)?.length, 1);
  assert.match(xml.text, /<documents count="2">/);
  assert.equal(xml.text.match(/<document /g)?.length, 2);

  const csv = await c.request("POST", "/api/v1/documents/bulk-export", {
    json: { ids: [a.id, b.id], format: "csv" },
  });
  const lines = csv.text.trim().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("document_id,")).length, 1, "one header for the batch");
  assert.ok(lines.length > 3);

  // Unknown ids are skipped and named rather than failing the whole export.
  const partial = await c.request("POST", "/api/v1/documents/bulk-export", {
    json: { ids: [a.id, "nope"], format: "json" },
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.headers.get("x-skipped-ids"), "nope");
  assert.equal((JSON.parse(partial.text) as unknown[]).length, 1);

  // Every id stale (the selection was deleted in another tab) still yields a valid, empty
  // file rather than a truncated one.
  const stale = await c.request("POST", "/api/v1/documents/bulk-export", {
    json: { ids: ["gone-1", "gone-2"], format: "xml" },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("x-skipped-ids"), "gone-1,gone-2");
  assert.match(stale.text, /<documents count="0">/);
  assert.equal(stale.text.match(/<\?xml/g)?.length, 1);

  assert.equal(
    (await c.request("POST", "/api/v1/documents/bulk-export", { json: { ids: [], format: "json" } })).status,
    400,
    "an empty selection is a bad request, not an empty file",
  );
});

test("bulk delete is best-effort, credential-guarded and reports each id", async () => {
  const a = await upload(INVOICE, "bulk-del-a.txt", "text/plain", "invoice");
  const b = await upload(INVOICE, "bulk-del-b.txt", "text/plain", "invoice");

  // Same guard as a single delete: it removes Knowledge Box resources.
  assert.equal(
    (await c.request("POST", "/api/v1/documents/bulk-delete", { json: { ids: [a.id] } })).status,
    401,
  );

  const res = await c.request("POST", "/api/v1/documents/bulk-delete", {
    json: { ids: [a.id, b.id, "does-not-exist"] },
    headers: writer,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/documents/bulk-delete", "post", 200, res.json),
    [],
  );
  const out = res.json as { deleted: string[]; failed: Array<{ id: string; error: string }> };
  assert.deepEqual(out.deleted.sort(), [a.id, b.id].sort());
  assert.deepEqual(out.failed, [{ id: "does-not-exist", error: "Not found" }]);
  assert.equal((await c.get(`/api/v1/documents/${a.id}`)).status, 404);
});

// ─── reprocess ────────────────────────────────────────────────────────────────

test("a document can be reprocessed without re-uploading it", async () => {
  const { id } = await upload(INVOICE, "reprocess.txt", "text/plain", "invoice");
  const before = (await c.get(`/api/v1/documents/${id}`)).json as { jobId: string; fields: unknown[] };
  assert.ok(before.fields.length > 0);

  assert.equal((await c.request("POST", `/api/v1/documents/${id}/reprocess`)).status, 401);

  const res = await c.request("POST", `/api/v1/documents/${id}/reprocess`, { headers: writer });
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/documents/{id}/reprocess", "post", 202, res.json),
    [],
  );
  const { document, job } = res.json as { document: { status: string; id: string }; job: { id: string } };
  assert.equal(document.id, id, "the record keeps its id and its Knowledge Box resource");
  assert.equal(document.status, "pending");
  assert.notEqual(job.id, before.jobId);

  await waitForJob(job.id);
  const after = (await c.get(`/api/v1/documents/${id}`)).json as { status: string; fields: unknown[] };
  assert.equal(after.status, "ready");
  assert.equal(after.fields.length, before.fields.length);

  // Reprocessing a document that is still in flight would queue a second job over itself.
  const busy = await c.request("POST", "/api/v1/documents?config=invoice", {
    body: INVOICE as unknown as BodyInit,
    headers: { "Content-Type": "text/plain", "X-Filename": "busy.txt" },
  });
  const busyDoc = (busy.json as { document: { id: string }; job: { id: string } }).document;
  const conflicted = await c.request("POST", `/api/v1/documents/${busyDoc.id}/reprocess`, {
    headers: writer,
  });
  assert.equal(conflicted.status, 409, "a pending or processing document cannot be reprocessed");
  assert.match((conflicted.json as { detail: string }).detail, /pending|processing/);
  await waitForJob((busy.json as { job: { id: string } }).job.id);

  // A config that does not exist is rejected before anything is queued.
  assert.equal(
    (await c.request("POST", `/api/v1/documents/${id}/reprocess?config=nope`, { headers: writer })).status,
    400,
  );
  assert.equal(
    (await c.request("POST", "/api/v1/documents/missing/reprocess", { headers: writer })).status,
    404,
  );
});

// ─── workspace: stats, settings, samples ──────────────────────────────────────

test("stats report the document mix, grounding and job counts", async () => {
  await upload(INVOICE, "stats.txt", "text/plain", "invoice");
  const res = await c.get("/api/v1/stats");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/stats", "get", 200, res.json), []);
  const s = res.json as {
    documents: Record<string, number>;
    byDocType: Record<string, number>;
    groundingScore: number | null;
    fields: number;
    jobs: Record<string, number>;
    lastProcessedAt: string | null;
  };
  assert.ok((s.documents.total ?? 0) >= 1);
  assert.ok((s.byDocType.invoice ?? 0) >= 1);
  assert.ok(s.fields > 0);
  assert.ok((s.jobs.succeeded ?? 0) >= 1);
  assert.ok(typeof s.groundingScore === "number");
  assert.ok(s.lastProcessedAt && !Number.isNaN(Date.parse(s.lastProcessedAt)));
});

test("settings describe the deployment without leaking secrets", async () => {
  const res = await c.get("/api/v1/settings");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/settings", "get", 200, res.json), []);
  const s = res.json as {
    product: { name: string; version: string };
    connection: { ok: boolean; mock: boolean };
    extraction: { visualExtraction: boolean; stages: string[]; configs: number };
    uploads: { maxBytes: number; acceptedTypes: string[] };
    security: { apiKeysEnforced: boolean; adminEnabled: boolean };
  };
  assert.equal(s.product.name, "Document Processing");
  assert.equal(s.connection.ok, true);
  assert.equal(s.connection.mock, true);
  assert.deepEqual(s.extraction.stages, [...STAGES]);
  assert.equal(s.extraction.configs, DOC_TYPE_VALUES.length);
  assert.ok(s.uploads.acceptedTypes.includes("application/pdf"));
  assert.equal(s.security.adminEnabled, true);
  // No credential, token or strategy id anywhere in the payload.
  assert.ok(!res.text.includes(ADMIN));
  assert.ok(!/extractStrategy/i.test(res.text));
});

test("the sample catalogue points at files that are actually served", async () => {
  const res = await c.get("/api/v1/samples");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/samples", "get", 200, res.json), []);
  const items = (res.json as { items: Array<{ id: string; url: string; kind: string }> }).items;
  assert.ok(items.length >= 6);
  assert.ok(items.some((s) => s.kind === "image"));
  for (const s of items) {
    const file = await c.get(s.url);
    assert.equal(file.status, 200, `${s.id}: ${s.url} is not served`);
  }
});

// ─── source text, original file, samples ──────────────────────────────────────

test("the document's own extracted text is retrievable, and evidence offsets index into it", async () => {
  const { id } = await upload(INVOICE, "text-source.txt", "text/plain", "invoice");
  const res = await c.get(`/api/v1/documents/${id}/text`);
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents/{id}/text", "get", 200, res.json), []);
  const { text, chars, truncated } = res.json as { text: string; chars: number; truncated: boolean };
  assert.ok(chars > 0);
  assert.equal(truncated, false);
  assert.match(text, /TAX INVOICE/);

  // The contract that makes "jump to source" possible: an exact quote's offsets really do
  // select that quote in this text.
  const rec = (await c.get(`/api/v1/documents/${id}`)).json as {
    evidence: Array<{ quote: string; verified: string; start?: number; end?: number }>;
  };
  const exact = rec.evidence.find((e) => e.verified === "exact" && e.start !== undefined);
  assert.ok(exact, "expected at least one exactly-verified quote");
  assert.equal(text.slice(exact.start!, exact.end!), exact.quote);

  // max_chars truncates and says so.
  const short = await c.get(`/api/v1/documents/${id}/text?max_chars=1000`);
  const s = short.json as { text: string; chars: number; truncated: boolean };
  assert.equal(s.text.length, Math.min(1000, s.chars));
  assert.equal(s.truncated, s.chars > 1000);
});

test("the original uploaded file is streamed back for the source preview", async () => {
  const { id } = await upload(INVOICE, "original.txt", "text/plain", "invoice");
  const res = await c.get(`/api/v1/documents/${id}/source`);
  assert.equal(res.status, 200);
  // Inline, not an attachment: this is for looking at the page, not saving it.
  assert.match(res.headers.get("content-disposition") ?? "", /^inline; filename="original.txt"$/);
  assert.equal(res.text, INVOICE.toString("utf8"));
  assert.equal((await c.get("/api/v1/documents/missing/source")).status, 404);
});

test("a bundled sample can be processed in one call", async () => {
  const res = await c.post("/api/v1/documents/sample", { sampleId: "contract" });
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents/sample", "post", 202, res.json), []);
  const { document, job } = res.json as { document: { id: string; filename: string }; job: { id: string } };
  assert.equal(document.filename, "contract.txt");
  await waitForJob(job.id);
  const rec = (await c.get(`/api/v1/documents/${document.id}`)).json as { status: string; docType: string };
  assert.equal(rec.status, "ready");
  assert.equal(rec.docType, "contract");

  assert.equal((await c.post("/api/v1/documents/sample", { sampleId: "not-a-sample" })).status, 400);
});

// ─── facets, jobs paging, config editing, admin security ──────────────────────

test("the documents page carries collection-wide facets", async () => {
  await upload(INVOICE, "facet.txt", "text/plain", "invoice");
  const res = await c.get("/api/v1/documents?page_size=1");
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/documents", "get", 200, res.json), []);
  const page = res.json as {
    items: unknown[];
    total: number;
    facets: { total: number; status: Record<string, number>; docType: Record<string, number> };
  };
  assert.equal(page.items.length, 1);
  // Facets describe the collection, not the page — that is the whole point of them.
  assert.equal(page.facets.total, page.total);
  assert.ok((page.facets.docType.invoice ?? 0) >= 1);
  assert.ok((page.facets.status.ready ?? 0) >= 1);

  // min_grounding excludes records that have no score at all.
  const grounded = await c.get("/api/v1/documents?min_grounding=0.5&page_size=200");
  for (const d of (grounded.json as { items: Array<{ meta: { groundingScore?: number } }> }).items) {
    assert.ok((d.meta.groundingScore ?? 0) >= 0.5);
  }
  // `doc_type` is a repeatable parameter: one value or several, both documented.
  const one = await c.get("/api/v1/documents?doc_type=invoice&page_size=200");
  for (const d of (one.json as { items: Array<{ docType: string }> }).items) {
    assert.equal(d.docType, "invoice");
  }
  const multi = await c.get("/api/v1/documents?doc_type=invoice&doc_type=contract&page_size=200");
  const types = new Set((multi.json as { items: Array<{ docType: string }> }).items.map((d) => d.docType));
  assert.ok(types.size >= 2, "both requested types come back");
  for (const t of types) assert.ok(["invoice", "contract"].includes(t), `unexpected ${t}`);
  assert.equal((await c.get("/api/v1/documents?doc_type=not-a-type")).status, 400);
});

test("jobs are paged, sorted and searchable", async () => {
  const res = await c.get("/api/v1/jobs?page=1&page_size=2");
  assert.equal(res.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/jobs", "get", 200, res.json), []);
  const page = res.json as { items: unknown[]; page: number; total: number; next_page: boolean };
  assert.ok(page.total > 2, "the suite has run more than two jobs by now");
  assert.equal(page.items.length, 2);
  assert.equal(page.next_page, true);

  const second = (await c.get("/api/v1/jobs?page=2&page_size=2")).json as { items: Array<{ id: string }> };
  const first = page.items as Array<{ id: string }>;
  assert.notEqual(first[0]!.id, second.items[0]!.id, "page 2 is not page 1");

  const { id } = await upload(INVOICE, "job-search.txt", "text/plain", "invoice");
  const found = (await c.get(`/api/v1/jobs?q=${id}`)).json as { items: Array<{ ref?: string }> };
  assert.ok(found.items.length >= 1);
  assert.equal(found.items[0]!.ref, id);
});

test("a custom config can be edited in place and re-provisioned individually", async () => {
  const created = await c.post(
    "/api/v1/extraction-configs",
    { name: "Editable Card", fields: [{ label: "Policy Number" }] },
    writer,
  );
  assert.equal(created.status, 201, created.text);
  const id = (created.json as { id: string }).id;

  // A built-in cannot be edited, only replaced by forking it.
  assert.equal(
    (
      await c.request("PUT", "/api/v1/extraction-configs/invoice", {
        json: { name: "Nope", fields: [{ label: "X" }] },
        headers: writer,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await c.request("PUT", `/api/v1/extraction-configs/${id}`, {
        json: { name: "Nope", fields: [{ label: "X" }] },
      })
    ).status,
    401,
  );

  const updated = await c.request("PUT", `/api/v1/extraction-configs/${id}`, {
    json: {
      name: "Editable Card",
      description: "Now with two fields",
      fields: [{ label: "Policy Number" }, { label: "Insurer" }],
    },
    headers: writer,
  });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/extraction-configs/{id}", "put", 200, updated.json),
    [],
  );
  const cfg = updated.json as { id: string; fields: unknown[]; provisioned: boolean; documentCount: number };
  // The id survives the edit: every document already processed with it keeps resolving.
  assert.equal(cfg.id, id);
  assert.equal(cfg.fields.length, 2);
  assert.equal(cfg.provisioned, true);
  assert.equal(cfg.documentCount, 0);

  const prov = await c.request("POST", `/api/v1/extraction-configs/${id}/provision`, { headers: writer });
  assert.equal(prov.status, 200);
  assert.deepEqual(
    testing.checkResponse(openapi, "/api/v1/extraction-configs/{id}/provision", "post", 200, prov.json),
    [],
  );
  assert.equal((prov.json as { ok: boolean }).ok, true);

  // documentCount answers "is anything using this?" before a delete.
  const list = (await c.get("/api/v1/extraction-configs")).json as {
    items: Array<{ id: string; documentCount: number }>;
  };
  const invoice = list.items.find((x) => x.id === "invoice")!;
  assert.ok(invoice.documentCount > 0, "invoices have been processed with the built-in config");

  await c.request("DELETE", `/api/v1/extraction-configs/${id}`, { headers: writer });
});

test("admin security reports the posture without leaking a key, and purge can be previewed", async () => {
  const sec = await c.get("/api/v1/admin/security", { authorization: `Bearer ${ADMIN}` });
  assert.equal(sec.status, 200);
  assert.deepEqual(testing.checkResponse(openapi, "/api/v1/admin/security", "get", 200, sec.json), []);
  const s = sec.json as { adminTokenSet: boolean; writesRequireCredential: boolean; maxUploadBytes: number };
  assert.equal(s.adminTokenSet, true);
  assert.equal(s.writesRequireCredential, true);
  assert.ok(s.maxUploadBytes > 0);
  assert.ok(!sec.text.includes(ADMIN), "the admin token itself is never returned");
  assert.equal((await c.get("/api/v1/admin/security")).status, 401);

  const before = (await c.get("/api/v1/documents?page_size=1")).json as { total: number };
  const dry = await c.post(
    "/api/v1/admin/purge",
    { olderThanDays: 0, dryRun: true },
    { authorization: `Bearer ${ADMIN}` },
  );
  assert.equal(dry.status, 200);
  const d = dry.json as { dryRun: boolean; wouldDelete: number; deleted: string[]; oldest: string | null };
  assert.equal(d.dryRun, true);
  assert.equal(d.deleted.length, 0, "a dry run deletes nothing");
  assert.equal(d.wouldDelete, before.total);
  assert.ok(d.oldest);
  // …and it really did not delete anything.
  assert.equal(
    ((await c.get("/api/v1/documents?page_size=1")).json as { total: number }).total,
    before.total,
  );
});
