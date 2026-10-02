/**
 * App wiring for Document Processing. Everything HTTP lives here and in `routes/`;
 * domain logic lives in `services/`. Exported as a factory so tests (and `make smoke`)
 * can boot the whole product in-process against the mock ARAG server.
 *
 * Nothing here snapshots configuration into a closure. `SettingsService` owns the effective
 * value of every setting (environment as the default, the product's store as the override),
 * and this file hands the services *getters* rather than values — so an operator's edit is
 * in force on the very next request, with no restart. The one object that cannot be mutated
 * in place, `AragClient`, sits behind a proxy and is rebuilt when a connection setting
 * changes; every holder keeps the same reference and transparently talks to the new client.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  App,
  AragClient,
  type Branding,
  badRequest,
  constantTimeEqual,
  cors,
  log as defaultLog,
  healthRoutes,
  JobManager,
  type Logger,
  type MockAragServer,
  type PlatformEnv,
  Store,
  type StoredDoc,
  securityHeaders,
  startMockArag,
} from "../vendor/arag-platform/src/index.ts";
import { openapi, VERSION } from "./openapi.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerConfigRoutes } from "./routes/configs.ts";
import { registerDocumentRoutes } from "./routes/documents.ts";
import { registerGeneratorRoutes } from "./routes/generators.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerReviewRoutes } from "./routes/review.ts";
import { registerWorkspaceRoutes } from "./routes/workspace.ts";
import { Agents } from "./services/agents.ts";
import { ApiKeysService } from "./services/apikeys.ts";
import { AuditService, auditCalls, auditContext } from "./services/audit.ts";
import { ConfigsService } from "./services/configs.ts";
import { DaAgents } from "./services/da-agents.ts";
import { DocumentsService } from "./services/documents.ts";
import { GeneratorsService } from "./services/generators.ts";
import { KvService, KvValidationError } from "./services/kv.ts";
import { mockEvidenceHook } from "./services/mock-evidence.ts";
import { fixMockPdfText, registerMockSampleTexts } from "./services/mock-samples.ts";
import { makeKvWriteback } from "./services/pipeline.ts";
import { ReviewService } from "./services/review.ts";
import { schemaFor } from "./services/schemas.ts";
import { SettingsService, type SettingValue } from "./services/settings.ts";

export interface Usage {
  startedAt: number;
  requests: number;
  aragCalls: number;
  /** Calls that genuinely failed: network, timeout, or a 5xx from ARAG. */
  aragErrors: number;
  /**
   * Expected 409s from idempotent provisioning. `putSearchConfiguration` POSTs first and
   * falls back to PATCH when the configuration already exists, so a re-provision of the
   * eleven built-ins reports eleven conflicts — which read as eleven failures on an
   * operator's dashboard if they are not counted apart.
   */
  aragConflicts: number;
  /** Other 4xx (a missing resource, a rejected payload) — worth seeing, not an outage. */
  aragClientErrors: number;
  aragMs: number;
}

export interface Product {
  name: string;
  version: string;
  /** Effective white-label branding, read live from the settings service. */
  branding: Branding;
  app: App;
  arag: AragClient;
  store: Store;
  jobs: JobManager;
  agents: Agents;
  configs: ConfigsService;
  documents: DocumentsService;
  /** Key-value fields: typed, filterable metadata on the Knowledge Box's resources. */
  kv: KvService;
  /** Data Augmentation generator agents — the alternative extraction path. */
  generators: GeneratorsService;
  /** Human review: field corrections and the cross-document ask. */
  review: ReviewService;
  settings: SettingsService;
  apikeys: ApiKeysService;
  audit: AuditService;
  usage: Usage;
  /** The in-process mock ARAG server when ARAG_MOCK=1 (tests seed it); null when live. */
  mock: MockAragServer | null;
  /** Provision every extraction config as an ARAG search configuration. */
  provision(): Promise<unknown>;
  close(): Promise<void>;
}

export interface CreateOptions {
  log?: Logger;
  /** Persist stores to DATA_DIR (default true; tests pass false for a clean slate). */
  persist?: boolean;
  /** Provision the ARAG search configurations at boot (default true). */
  provisionAtBoot?: boolean;
  /** Options handed to the in-process mock ARAG when ARAG_MOCK=1 (tests use answerHook). */
  mock?: Parameters<typeof startMockArag>[0];
}

const HERE = resolve(import.meta.dirname ?? ".", "..");

/**
 * Make an upload's extract strategy actually reach the Knowledge Box.
 *
 * The vendored client sends it as `?extract_strategy=`, which the upload endpoints accept
 * and ignore: the file field comes back with `extract_strategy: ""` and the page is read
 * from whatever text layer the file happens to carry — for a scan, the scanner's own OCR.
 * The API takes the strategy from the `x-extract-strategy` header. The query parameter is
 * left in place because the mock records the strategy from it. Vendored files are never
 * edited, so the request is corrected here, on its way out.
 */
export function sendExtractStrategyHeader(client: AragClient): AragClient {
  const request = client.request.bind(client);
  client.request = (method, path, init = {}) => {
    const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    const strategy = method === "POST" ? new URLSearchParams(query).get("extract_strategy") : null;
    if (!strategy) return request(method, path, init);
    return request(method, path, { ...init, headers: { ...init.headers, "x-extract-strategy": strategy } });
  };
  return client;
}

export async function createProduct(env: PlatformEnv, opts: CreateOptions = {}): Promise<Product> {
  const log = opts.log ?? defaultLog;
  const usage: Usage = {
    startedAt: Date.now(),
    requests: 0,
    aragCalls: 0,
    aragErrors: 0,
    aragConflicts: 0,
    aragClientErrors: 0,
    aragMs: 0,
  };

  // ARAG: live client, or the in-process mock when ARAG_MOCK=1 (no credentials needed).
  let mock: Awaited<ReturnType<typeof startMockArag>> | null = null;
  const baselineOverrides: Record<string, SettingValue> = { "operations.logLevel": log.level };
  const ignoreEnv: string[] = [];
  if (env.arag.mock) {
    // The mock has no notion of our `evidence` contract; the hook teaches it to quote the
    // fixture text it extracted from, so the demo and the tests exercise real verification
    // instead of a grounding score of zero. Vendored files are never edited.
    mock = await startMockArag({ log, answerHook: mockEvidenceHook, ...opts.mock });
    // Nor can it read a PDF: the bundled PDF samples register their own text layer, so the
    // mock answers with the document that was submitted rather than an unrelated fixture —
    // and never with the PDF's raw bytes.
    registerMockSampleTexts(resolve(HERE, "public"));
    fixMockPdfText(mock.mock);
    // The mock owns the connection while it is running: its ids are the baseline an operator
    // edits from, and the deployment's real credentials are not the default here.
    baselineOverrides["connection.kbId"] = mock.kbId;
    baselineOverrides["connection.apiKey"] = mock.apiKey;
    baselineOverrides["connection.baseUrl"] = mock.url;
    ignoreEnv.push("connection.kbId", "connection.apiKey", "connection.baseUrl");
    log.warn("arag.mock", { url: mock.url });
  }

  const store = new Store(env.dataDir, { persist: opts.persist ?? true });

  // Settings first: every service below reads through it, and a stored override is in force
  // from the first request rather than after the first edit.
  const settings = new SettingsService({
    store,
    env,
    log,
    brandingDefaults: {
      productName: "Document Processing",
      tagline: "Documents in, validated records out",
      docsUrl: "/api/v1/docs",
    },
    baselineOverrides,
    ignoreEnv,
  });
  settings.apply();

  const audit = new AuditService({ store, log });
  const apikeys = new ApiKeysService({ store, log });

  // ── the rebuildable ARAG client ────────────────────────────────────────────
  // `AragClient` resolves its base URL and captures its credentials in the constructor, so a
  // connection change means a new client. Everything downstream holds this proxy instead, and
  // therefore never holds a stale one.
  let aragError: string | null = null;
  const buildArag = (): AragClient => {
    const c = settings.effective().connection;
    return new AragClient({
      kbId: c.kbId,
      apiKey: c.apiKey,
      baseUrl: c.baseUrl || undefined,
      region: c.region,
      timeoutMs: c.timeoutMs,
      onRequest: (i) => {
        usage.aragCalls++;
        usage.aragMs += i.ms;
        const status = i.status ?? 0;
        if (i.error || status >= 500) usage.aragErrors++;
        else if (status === 409 && i.path.includes("/search_configurations/")) usage.aragConflicts++;
        else if (status >= 400) usage.aragClientErrors++;
        log.debug("arag.request", {
          method: i.method,
          path: i.path,
          status: i.status,
          ms: Math.round(i.ms),
          error: i.error,
        });
      },
    });
  };
  let live = sendExtractStrategyHeader(buildArag());
  const arag = new Proxy({} as AragClient, {
    get(_t, prop) {
      const value = Reflect.get(live as object, prop) as unknown;
      return typeof value === "function" ? value.bind(live) : value;
    },
    has: (_t, prop) => prop in (live as object),
    getPrototypeOf: () => Object.getPrototypeOf(live) as object,
  });

  const jobs = new JobManager(store, log, { concurrency: 2 });
  // Getters, not values: `Agents` and `DocumentsService` read these on every call, so an
  // operator's edit reaches the next extraction without a restart.
  const agents = new Agents({
    arag,
    log,
    get generativeModel() {
      return settings.effective().connection.generativeModel;
    },
    get reranker() {
      return settings.effective().connection.reranker;
    },
  });
  // Key-value fields have no support in the vendored client, so `KvService` drives the
  // routes through its generic `request()` — and, under ARAG_MOCK, an in-memory registry
  // that mirrors the live shapes and validation, so the same code paths run offline.
  const kv = new KvService({ arag, log, mock: env.arag.mock });
  const da = new DaAgents({
    arag,
    kv,
    log,
    mock: env.arag.mock,
    get generativeModel() {
      return settings.effective().connection.generativeModel;
    },
  });
  const configs = new ConfigsService({ store, agents, kv, log });
  const documents = new DocumentsService({
    arag,
    store,
    jobs,
    configs,
    agents,
    kv,
    env,
    log,
    get extractStrategy() {
      return settings.effective().connection.extractStrategy;
    },
    get maxUploadBytes() {
      return settings.effective().limits.maxUploadBytes;
    },
    get generativeModel() {
      return settings.effective().connection.generativeModel;
    },
    publicDir: resolve(HERE, "public"),
  });

  const generators = new GeneratorsService({ da, kv, configs, documents, store, log });

  // Human review. `kvWriteback` is the pipeline's own key-value writer, so a correction
  // lands in the Knowledge Box by exactly the route an extraction does — including sending
  // the whole record (a key-value write is a full replace) and reporting that the filter
  // index now also matches the value the correction superseded.
  const review = new ReviewService({
    arag,
    documents,
    env,
    log,
    get generativeModel() {
      return settings.effective().connection.generativeModel;
    },
    kvWriteback: makeKvWriteback({
      kv,
      configs,
      log,
      schemaOf: (record) => configs.resolve(record.meta.config)?.schema ?? schemaFor(record.docType),
    }),
    // The actor comes from the request scope (`auditContext`), which knows the API key's
    // stored name; the string the review service offers would be a coarser answer.
    audit: (entry) =>
      void audit.record({
        action: entry.action,
        target: entry.target,
        before: entry.before,
        after: entry.after,
      }),
  });

  // ── audited writes ─────────────────────────────────────────────────────────
  // The services stay free of HTTP and of the audit log; the wrapper records who changed
  // what, taking the actor from the request scope.
  auditCalls(configs, audit, [
    {
      method: "create",
      action: "config.create",
      targetOf: (_a, r) => (r as { id: string }).id,
      before: () => null,
      after: (r) => r,
    },
    {
      method: "update",
      action: "config.update",
      targetOf: (a) => String(a[0]),
      before: (a) => configs.get(String(a[0])) ?? null,
      after: (r) => (typeof r === "string" ? undefined : r),
    },
    {
      method: "delete",
      action: "config.delete",
      targetOf: (a) => String(a[0]),
      before: (a) => configs.get(String(a[0])) ?? null,
      after: (r) => (r === "deleted" ? { deleted: true } : undefined),
    },
    {
      method: "provision",
      action: "config.provision",
      targetOf: (a) => String(a[0]),
      after: (r) => r ?? undefined,
    },
  ]);
  auditCalls(documents, audit, [
    {
      method: "delete",
      action: "document.delete",
      targetOf: (a) => String(a[0]),
      before: (a) => {
        const rec = documents.get(String(a[0]));
        return rec ? { filename: rec.filename, docType: rec.docType, resourceId: rec.resourceId } : null;
      },
      after: (r) => (r === true ? { deleted: true } : undefined),
    },
    {
      method: "purge",
      action: "documents.purge",
      targetOf: () => "*",
      before: (a) => ({ olderThanDays: Number(a[0]) }),
      after: (r, a) => {
        if (a[1] === true) return undefined; // a dry run changes nothing
        const out = r as { deleted: string[]; failed: unknown[] };
        return { deleted: out.deleted.length, failed: out.failed.length };
      },
    },
  ]);

  // ── session signing ───────────────────────────────────────────────────────
  // The platform defaults `sessionSecret` to ADMIN_TOKEN and captures it in the App
  // constructor, which has two consequences the product must not inherit: rotating the admin
  // token would leave every previously-issued `arag_session` cookie forgeable with the old
  // token forever (and a session satisfies `requireWriter`), and anyone who has ever held the
  // admin token could mint sessions indefinitely. The signing key is therefore independent of
  // every credential, and persisted so that a restart — or a second instance on the same
  // volume — does not invalidate every open tab.
  const runtime = store.collection<{ id: string; secret: string } & StoredDoc>("runtime");
  const sessionSecret =
    runtime.get("session-secret")?.secret ??
    runtime.put({ id: "session-secret", secret: randomBytes(32).toString("hex") }).secret;

  const app = new App({ env, log, sessionSecret });

  // A key-value validation failure is a *caller* problem — a value the Knowledge Box's schema
  // refuses, an operator an unknown field does not have — and the platform's default mapper
  // turns any non-HttpError into a 500. Mapped once here so every route answers 400 with the
  // message naming the field, rather than each route remembering to catch it.
  app.errorMapper = (err) => (err instanceof KvValidationError ? badRequest(err.message) : null);

  // ── authentication: stored API keys authenticate exactly like `API_KEYS` ────
  // The platform only knows the env list; a stored key is verified against its salted digest
  // and reported the same way, so `auth: "api"` and `requireWriter` (DP-12) need no changes.
  const platformAuthenticate = app.authenticate.bind(app);
  app.authenticate = (ctx) => {
    const info = platformAuthenticate(ctx);
    if (info.via !== "anonymous") return info;
    const authz = ctx.header("authorization") ?? "";
    const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
    const presented = ctx.header("x-api-key") || bearer;
    if (!presented) return info;
    // Keys seeded by API_KEYS keep working even when enforcement is switched off (which
    // empties `env.apiKeys`, the platform's only enforcement lever).
    if (settings.seedApiKeys.some((k) => constantTimeEqual(presented, k)))
      return { admin: false, apiKey: presented, session: false, via: "api-key" };
    const stored = apikeys.verify(presented);
    if (stored) return { admin: false, apiKey: presented, session: false, via: "api-key" };
    return info;
  };

  // The demo previews an uploaded PDF from a blob: URL in an <iframe>; the default CSP
  // allows only `frame-src 'self'` (and `object-src 'none'`, which rules out <embed>).
  app.use(securityHeaders({ frameSrc: ["blob:"] }), cors());
  app.use(async (ctx, next) => {
    usage.requests++;
    // Middlewares run before the platform authenticates, so resolve the caller here and let
    // the audit log read it from the request scope rather than from every call site.
    ctx.auth = app.authenticate(ctx);
    await next();
  });
  app.use(auditContext((key) => apikeys.list().find((k) => key.startsWith(`${k.prefix}_`))?.name));

  // Every open browser tab polls /readyz every 15 s (the UI kit's status pill), and each
  // ARAG health check costs a catalog + configuration call. Cache it briefly so a handful
  // of demo viewers cannot turn readiness polling into steady Knowledge Box traffic.
  let readyCache: { at: number; version: number; value: Record<string, unknown> } | null = null;
  const READY_TTL_MS = 10_000;
  healthRoutes(app, async () => {
    if (readyCache && readyCache.version === settings.version && Date.now() - readyCache.at < READY_TTL_MS)
      return readyCache.value;
    const value = {
      version: VERSION,
      arag: { ...(await arag.health()), mock: env.arag.mock },
      // Whether an ingestion-time visual-LLM extract strategy is configured — a boolean,
      // not the strategy id (that stays behind the admin token).
      visualExtraction: Boolean(settings.effective().connection.extractStrategy),
    };
    readyCache = { at: Date.now(), version: settings.version, value };
    return value;
  });
  app.docs("/api/v1", openapi, { title: "Document Processing" });

  const jobCounts = () => ({
    queued: jobs.count({ status: "queued" }),
    running: jobs.count({ status: "running" }),
    succeeded: jobs.count({ status: "succeeded" }),
    failed: jobs.count({ status: "failed" }),
    cancelled: jobs.count({ status: "cancelled" }),
  });

  // ── retention scheduler ────────────────────────────────────────────────────
  let purgeTimer: NodeJS.Timeout | null = null;
  let nextPurgeAt: string | null = null;
  const applyRetention = (): void => {
    const r = settings.effective().retention;
    if (purgeTimer) {
      clearInterval(purgeTimer);
      purgeTimer = null;
      nextPurgeAt = null;
    }
    if (!r.autoPurgeEnabled) return;
    const everyMs = Math.max(1, r.purgeIntervalHours) * 3_600_000;
    purgeTimer = setInterval(() => {
      nextPurgeAt = new Date(Date.now() + everyMs).toISOString();
      // The wrapper audits it as `documents.purge` with the `scheduler` actor.
      documents
        .purge(settings.effective().retention.days)
        .catch((err) => log.warn("purge.scheduled.fail", { message: (err as Error).message }));
    }, everyMs);
    purgeTimer.unref?.();
    nextPurgeAt = new Date(Date.now() + everyMs).toISOString();
  };
  applyRetention();

  settings.onChange((changed) => {
    if (changed.some((k) => k.startsWith("connection."))) {
      try {
        live = sendExtractStrategyHeader(buildArag());
        aragError = null;
      } catch (err) {
        // Keep serving with the previous client and say so, rather than 500ing the save.
        aragError = (err as Error).message;
        log.error("arag.rebuild.fail", { message: aragError });
      }
    }
    if (changed.some((k) => k.startsWith("retention."))) applyRetention();
  });

  /** What the running process is actually using — read from the live objects, not the store. */
  const applied = (): Record<string, unknown> => {
    const eff = settings.effective();
    return {
      settingsVersion: settings.version,
      arag: {
        kbId: live.kbId,
        baseUrl: live.baseUrl,
        timeoutMs: live.timeoutMs,
        mock: env.arag.mock,
        generativeModel: eff.connection.generativeModel || "KB default",
        reranker: eff.connection.reranker,
        visualExtraction: Boolean(eff.connection.extractStrategy),
        error: aragError,
      },
      limits: {
        maxUploadBytes: eff.limits.maxUploadBytes,
        maxBodyBytes: env.maxBodyBytes,
        rateLimitRps: env.rateLimitRps,
        rateLimitBurst: env.rateLimitBurst,
      },
      security: {
        apiKeysEnforced: env.apiKeys.length > 0,
        storedApiKeys: apikeys.activeCount(),
        seededApiKeys: settings.seedApiKeys.length,
        adminEnabled: Boolean(env.adminToken),
        allowedOrigins: [...env.allowedOrigins],
        trustProxy: env.trustProxy,
      },
      retention: {
        days: eff.retention.days,
        autoPurgeEnabled: eff.retention.autoPurgeEnabled,
        purgeIntervalHours: eff.retention.purgeIntervalHours,
        schedulerActive: purgeTimer !== null,
        nextRunAt: nextPurgeAt,
      },
      operations: { logLevel: log.level },
      branding: settings.branding(),
    };
  };

  registerDocumentRoutes(app, { documents, jobCounts });
  registerWorkspaceRoutes(app, { arag, env, configs, settings, version: VERSION });
  registerJobRoutes(app, { jobs });
  registerConfigRoutes(app, { configs, documentCounts: () => documents.countsByConfig() });
  registerReviewRoutes(app, { review, documents });
  registerGeneratorRoutes(app, { generators });
  registerAdminRoutes(app, {
    arag,
    env,
    log,
    usage,
    store,
    jobs,
    documents,
    configs,
    settings,
    apikeys,
    audit,
    version: VERSION,
    applied,
  });

  // Branding is public: both UIs fetch it before they paint, and so may a partner's own
  // front end. It contains no secrets — only what a visitor already sees on the page.
  app.get("/api/v1/branding", () => settings.branding(), {
    operationId: "getBranding",
    noRateLimit: true,
  });

  // Session for the demo UI when API keys are enforced (rate-limited like any public route).
  app.post(
    "/api/v1/session",
    (ctx) => {
      ctx.setCookie("arag_session", app.issueSession(12 * 3600), { maxAge: 12 * 3600 });
      return { ok: true, expiresInSec: 12 * 3600 };
    },
    { operationId: "createSession" },
  );

  // Static surfaces: UI kit, admin panel, demo app. Both UIs consume only /api/v1.
  app.static("/ui", resolve(HERE, "vendor/arag-platform/ui"), { cache: "public, max-age=300" });
  // Partner logos and other brand assets, uploaded through Settings → Branding into
  // DATA_DIR/branding (a Fly volume in production) so rebranding never needs a rebuild.
  app.static("/branding", resolve(env.dataDir, "branding"), { cache: "public, max-age=300" });
  app.static("/admin", resolve(HERE, "admin"));
  app.static("/", resolve(HERE, "public"));

  const provision = () => configs.provisionAll();
  if (opts.provisionAtBoot ?? true) {
    // Non-blocking: the server accepts requests immediately and `extractFields`
    // lazily provisions anything that is not ready yet.
    provision().catch((err) => log.warn("provision.boot.fail", { message: (err as Error).message }));
  }

  return {
    name: "arag-doc-processing",
    version: VERSION,
    get branding() {
      return settings.branding();
    },
    app,
    arag,
    store,
    jobs,
    agents,
    configs,
    documents,
    kv,
    generators,
    review,
    settings,
    apikeys,
    audit,
    usage,
    mock,
    provision,
    async close() {
      if (purgeTimer) clearInterval(purgeTimer);
      apikeys.flushUsage();
      store.flushAll();
      try {
        await app.close();
      } finally {
        await mock?.close();
      }
    },
  };
}
