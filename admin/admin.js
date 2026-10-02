/**
 * Document Processing — operations.
 *
 * An operator product, not a tab inside the app: the same shell, its own navigation, and a
 * sign-in boundary that looks like a door. Everything here needs ADMIN_TOKEN, exchanged
 * once for an HttpOnly cookie and never held in the page.
 */
import {
  $,
  $$,
  announce,
  api,
  applyBranding,
  buildHash,
  createRouter,
  emptyState,
  errorState,
  esc,
  fmtAbsolute,
  fmtBytes,
  fmtRelative,
  icon,
  jobChip,
  label,
  mountShell,
  navigate,
  onLeave,
  openDrawer,
  pct,
  shortId,
  skeletonRows,
  toast,
  wireSegmented,
  wireTable,
} from "/lib/core.js";
import { brandPreviewHead, loadSettings, mountGroup, mountPurge } from "/lib/settings-form.js";

const NAV = [
  { key: "overview", label: "Overview", href: buildHash("/overview"), icon: "chart" },
  { key: "connection", label: "Connection", href: buildHash("/connection"), icon: "plug" },
  { key: "configs", label: "Configs", href: buildHash("/configs"), icon: "layers" },
  { key: "jobs", label: "Jobs", href: buildHash("/jobs"), icon: "clock" },
  { key: "logs", label: "Logs", href: buildHash("/logs"), icon: "logs" },
  { key: "audit", label: "Audit", href: buildHash("/audit"), icon: "shield" },
  { key: "usage", label: "Usage", href: buildHash("/usage"), icon: "chart" },
  { key: "branding", label: "Branding", href: buildHash("/branding"), icon: "settings" },
  { key: "security", label: "Security", href: buildHash("/security"), icon: "key" },
];

const root = document.getElementById("app");
let main = null;
let setActiveNav = () => {};

// `boot()` waits for this: the sign-in card is drawn from it, and drawn first it would show
// the platform's mark, name and colour at the door of a partner's deployment.
const brandingReady = api("/api/v1/branding")
  .then((b) => {
    window.__branding = b;
    applyBranding(b);
  })
  .catch(() => undefined);

// ── sign-in ──────────────────────────────────────────────────────────────────
/**
 * Two distinct failures, two distinct messages: a wrong token is something the visitor can
 * fix by typing again; `ADMIN_TOKEN` unset is not, and must not be dressed up as one.
 */
function renderSignIn(message = "") {
  const logo = window.__branding?.logoUrl || "/ui/brand/arag-logo.svg";
  // `.arag-signin.standalone` is the kit's bandless form: full-bleed ink, no band above it,
  // and the card carries the only wordmark on the page (DP-43 — the door has no rail behind
  // it, so this is the one screen where the card keeps the mark).
  root.innerHTML = `
    <div class="arag-signin standalone">
      <div class="card">
        <img class="wordmark" src="${esc(logo)}"
             alt="${esc(window.__branding?.logoUrl ? (window.__branding.productName ?? "") : "Progress Agentic RAG")}" />
        <h1>${esc(window.__branding?.productName ?? "Document Processing")} — operations</h1>
        <form id="loginForm" autocomplete="off">
          <div class="arag-field">
            <label for="token">Admin token</label>
            <input id="token" name="token" class="arag-input" type="password" autocomplete="current-password" />
          </div>
          <div class="error-slot">${message ? `<div class="arag-alert error" role="alert">${esc(message)}</div>` : ""}</div>
          <button id="signin" class="arag-btn" type="submit">Sign in</button>
        </form>
        <p class="arag-help" style="margin-top:12px">
          The token is the <span class="mono">ADMIN_TOKEN</span> set for this deployment. It is
          exchanged for a cookie and never stored in the page.
        </p>
        <p style="margin-top:12px"><a href="/api/v1/docs">API docs ›</a> · <a href="/">Open the app ›</a></p>
      </div>
    </div>`;
  $("#token", root).focus();
  $("#loginForm", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/v1/admin/login", { method: "POST", json: { token: $("#token", root).value } });
      boot();
    } catch (err) {
      renderSignIn(
        err.status === 403
          ? "Admin access is disabled for this deployment. Set ADMIN_TOKEN and restart to enable it."
          : "That token was not accepted.",
      );
    }
  });
}

// ── shell ────────────────────────────────────────────────────────────────────
function mount() {
  const shell = mountShell(root, {
    productName: "Operations",
    tagline: "Document Processing",
    nav: NAV,
    bandLink: { label: "Open app", href: "/" },
  });
  main = shell.main;
  setActiveNav = shell.setActiveNav;
  // The admin head reads "Operations" over whatever the product is called, so a partner
  // sees their own product name under the operator label rather than the platform tagline.
  if (window.__branding) {
    applyBranding({
      ...window.__branding,
      productName: "Operations",
      tagline: window.__branding.productName,
    });
  }
}

/** Any 401 anywhere means the cookie expired: return to the door, saying so. */
const guard = (fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (err) {
    if (err?.status === 401) renderSignIn("Your admin session expired. Sign in again.");
    else main.innerHTML = errorState(err);
  }
};

const withNav = (key, fn) =>
  guard(async (ctx) => {
    await fn(ctx);
    // After the render, not before: a hash router changes the URL without telling the rail.
    setActiveNav(key);
  });

// ── overview ─────────────────────────────────────────────────────────────────
async function overview() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Overview</h1>
      <div class="actions"><button class="arag-btn ghost" type="button" id="refresh">${icon("refresh")} Refresh</button></div>
    </div></header><div id="body">${skeletonRows(4)}</div>`;
  const [health, usage, logs, configs, degraded, failed] = await Promise.all([
    api("/api/v1/admin/health"),
    api("/api/v1/admin/usage"),
    api("/api/v1/admin/logs?limit=10"),
    api("/api/v1/extraction-configs"),
    api("/api/v1/documents?degraded=true&page_size=5"),
    api("/api/v1/documents?status=failed&page_size=5"),
  ]);
  const unprovisioned = configs.items.filter((c) => !c.provisioned);
  const attention = [
    ...failed.items.map((d) => ({
      chip: '<span class="arag-chip danger">Failed</span>',
      text: `${d.filename} — ${d.error ?? "processing failed"}`,
      when: d.updatedAt,
      href: `/#/documents/${d.id}`,
    })),
    ...degraded.items.map((d) => ({
      chip: '<span class="arag-chip warn">Degraded</span>',
      text: `${d.filename} — ${(d.meta?.stageErrors ?? []).join("; ")}`,
      when: d.updatedAt,
      href: `/#/documents/${d.id}`,
    })),
    ...unprovisioned.map((c) => ({
      chip: '<span class="arag-chip warn">Not provisioned</span>',
      text: `${c.name} has no stored ARAG search configuration`,
      when: c.updatedAt,
      href: buildHash(`/configs`),
    })),
  ];

  $("#body", main).innerHTML = `
    <div class="arag-statstrip">
      ${kpi("Service", health.ok ? "Healthy" : "Degraded", `v${health.version} · up ${Math.round(health.uptimeSec / 60)} min`)}
      ${kpi("Knowledge Box", health.arag.ok ? `${Math.round(health.arag.ms)} ms` : "Offline", shortId(health.arag.kbId))}
      ${kpi("Documents", health.documents.total, `${health.documents.degraded} degraded · ${health.documents.failed} failed`)}
      ${kpi("Jobs", `${usage.jobs.running} running`, `${usage.jobs.queued} queued · ${usage.jobs.failed} failed`)}
      ${kpi("Grounding", health.groundingScore == null ? "—" : pct(health.groundingScore), "mean across records")}
      ${kpi("ARAG calls", usage.aragCalls, `${usage.aragErrors} errors · ${usage.aragConflicts} expected conflicts`)}
    </div>
    <div class="arag-card" style="margin-bottom:16px">
      <div class="head"><h3>Needs attention</h3></div>
      <div class="body">
        ${
          attention.length
            ? `<table class="arag-table"><tbody>${attention
                .slice(0, 8)
                .map(
                  (a) => `<tr><td style="width:1%">${a.chip}</td><td>${esc(a.text)}</td>
                  <td style="width:1%;white-space:nowrap" class="muted small">${esc(fmtRelative(a.when))}</td>
                  <td style="width:1%"><a href="${esc(a.href)}">Open ›</a></td></tr>`,
                )
                .join("")}</tbody></table>`
            : '<p class="muted">Nothing needs attention: every document finished, and every config is provisioned.</p>'
        }
      </div>
    </div>
    <div class="arag-grid cols-2">
      <div class="arag-card">
        <div class="head"><h3>Configuration</h3></div>
        <div class="body"><dl class="arag-kv">
          <dt>Extract strategy</dt><dd>${health.extractStrategy ? esc(health.extractStrategy) : "none (default processing)"}</dd>
          <dt>Model</dt><dd>${esc(health.generativeModel)}</dd>
          <dt>Mode</dt><dd>${health.arag.mock ? "Mock Knowledge Box" : "Live"}</dd>
          <dt>Requests served</dt><dd>${usage.requests}</dd>
        </dl></div>
      </div>
      <div class="arag-card">
        <div class="head"><h3>Recent activity</h3><a class="small" href="${buildHash("/logs")}">All logs ›</a></div>
        <div class="body"><table class="arag-table"><tbody>
          ${logs.items
            .slice(-8)
            .reverse()
            .map(
              (l) => `<tr><td class="mono small" style="width:1%">${esc(String(l.ts).slice(11, 19))}</td>
                <td style="width:1%">${levelChip(l.level)}</td><td class="small">${esc(l.msg)}</td></tr>`,
            )
            .join("")}
        </tbody></table></div>
      </div>
    </div>`;
  $("#refresh", main).addEventListener("click", () => overview());
}

// The kit's stat strip styles its own direct children, so the tile carries `.label`/`.value`/
// `.sub` itself rather than nesting an `.arag-kpi` (which would double the padding).
const kpi = (labelText, value, sub) =>
  `<div><div class="label">${esc(labelText)}</div><div class="value">${esc(String(value))}</div><div class="sub">${esc(sub)}</div></div>`;

const levelChip = (level) =>
  `<span class="arag-chip ${{ error: "danger", warn: "warn", info: "neutral", debug: "outline" }[level] ?? "neutral"}">${esc(level)}</span>`;

// ── connection ───────────────────────────────────────────────────────────────
async function connection() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Connection</h1>
      <div class="actions">
        <button class="arag-btn ghost" type="button" id="test">Test connection</button>
        <button class="arag-btn secondary" type="button" id="provAll">Re-provision all</button>
      </div></div></header><div id="body">${skeletonRows(4)}</div>`;
  const [health, config, stored] = await Promise.all([
    api("/api/v1/admin/health"),
    api("/api/v1/admin/config"),
    api("/api/v1/admin/search-configurations").catch(() => ({ items: [], other: [] })),
  ]);
  const env = config.env ?? {};
  $("#body", main).innerHTML = `
    <div id="connSettings" style="margin-bottom:16px"></div>
    <div class="arag-alert ${health.arag.ok ? "ok" : "error"}" style="margin-bottom:16px">
      ${health.arag.ok ? `Connected · ${Math.round(health.arag.ms)} ms · last tested ${esc(fmtAbsolute(new Date().toISOString()))}` : `Not responding — ${esc(health.arag.error ?? "unknown error")}`}
    </div>
    <div class="arag-card" style="margin-bottom:16px"><div class="body"><dl class="arag-kv">
      <dt>Knowledge Box</dt><dd class="mono">${esc(health.arag.kbId ?? "—")}</dd>
      <dt>Region</dt><dd>${esc(env.ARAG_REGION ?? env.arag?.region ?? "—")}</dd>
      <dt>Endpoint</dt><dd class="mono small">${esc(health.arag.baseUrl ?? "—")}</dd>
      <dt>Resources</dt><dd>${health.arag.resources ?? "—"}</dd>
      <dt>Mode</dt><dd>${health.arag.mock ? "Mock (ARAG_MOCK=1)" : "Live"}</dd>
      <dt>Model</dt><dd>${esc(health.generativeModel)}</dd>
      <dt>Extract strategy</dt><dd>${health.extractStrategy ? `<span class="mono">${esc(health.extractStrategy)}</span>` : "none"}</dd>
    </dl></div></div>
    <h2>Stored ARAG search configurations (${stored.items.length})</h2>
    <p class="muted small arag-prose">What the extraction agents actually run against — the model, the RAG strategy, the grounding prompt and the JSON schema — without opening the ARAG dashboard.</p>
    <div class="arag-datatable" id="storedTable"><div class="scroll">
    <table class="arag-table">
      <thead><tr><th>Name</th><th>Kind</th><th>Model</th><th>Strategy</th></tr></thead>
      <tbody>${stored.items
        .map((s) => {
          const c = s.config ?? {};
          const strategies = (c.rag_strategies ?? []).map((r) => r.name).join(", ");
          return `<tr data-cfg="${esc(s.name)}" data-id="${esc(s.name)}">
            <td class="mono"><span class="cell-title">${esc(s.name)}</span></td>
            <td>${esc(s.kind)}</td><td class="small">${esc(c.generative_model ?? "KB default")}</td>
            <td class="small">${esc(strategies || "—")}</td></tr>`;
        })
        .join("")}</tbody>
    </table></div></div>
    ${stored.other?.length ? `<p class="muted small" style="margin-top:12px">Not created by this product (${stored.other.length}): ${esc(stored.other.join(", "))}</p>` : ""}
    <div id="provResult" style="margin-top:12px"></div>`;

  await mountSettings($("#connSettings", main), "connection", connection);

  // Row activation comes from the kit: delegated, so it survives the table being re-rendered.
  wireTable($("#storedTable", main), {
    onOpen: (name) => {
      const item = stored.items.find((s) => s.name === name);
      const d = openDrawer({
        wide: true,
        title: `<span class="mono">${esc(item.name)}</span>`,
        body: '<arag-json id="cfgJson"></arag-json>',
      });
      $("#cfgJson", d.host).data = item.config;
    },
  });
  $("#test", main).addEventListener("click", async () => {
    const h = await api("/api/v1/admin/health");
    toast(
      h.arag.ok ? `KB connected · ${Math.round(h.arag.ms)} ms` : `KB unreachable: ${h.arag.error}`,
      h.arag.ok ? "info" : "error",
    );
  });
  $("#provAll", main).addEventListener("click", async () => {
    $("#provResult", main).innerHTML = '<div class="arag-alert">Provisioning…</div>';
    const r = await api("/api/v1/admin/provision", { method: "POST" });
    $("#provResult", main).innerHTML =
      `<div class="arag-alert ${r.failed ? "warn" : "ok"}">${r.ok} provisioned · ${r.failed} failed</div>`;
  });
}

// ── configs ──────────────────────────────────────────────────────────────────
async function configs() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Configs</h1>
    <div class="actions"><button class="arag-btn secondary" type="button" id="provAll">Re-provision all</button></div>
  </div></header><div id="body">${skeletonRows(5)}</div>`;
  const { items } = await api("/api/v1/extraction-configs");
  $("#body", main).innerHTML = `
    <div class="arag-datatable"><div class="scroll">
    <table class="arag-table">
      <thead><tr><th>Name</th><th>Kind</th><th>Fields</th><th>ARAG configuration</th><th>Documents</th><th>State</th><th class="rowactions"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${items
        .map(
          (c) => `<tr data-id="${esc(c.id)}">
          <td><span class="cell-title">${esc(c.name)}</span><span class="cell-sub">${esc(c.description)}</span></td>
          <td>${c.builtin ? "Built in" : "Custom"}</td>
          <td class="num">${c.fields.length}</td>
          <td class="mono small">${esc(c.aragConfig)}</td>
          <td class="num">${c.documentCount ?? 0}</td>
          <td>${c.provisioned ? '<span class="arag-chip ok">Ready</span>' : '<span class="arag-chip warn">Not provisioned</span>'}</td>
          <td class="rowactions"><button class="arag-btn ghost sm" type="button" data-prov="${esc(c.id)}">Re-provision</button></td>
        </tr>`,
        )
        .join("")}</tbody>
    </table></div></div>
    <div id="provResult" style="margin-top:12px"></div>`;
  for (const b of $$("[data-prov]", main)) {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const r = await api(`/api/v1/extraction-configs/${b.dataset.prov}/provision`, { method: "POST" });
      toast(r.ok ? `Provisioned ${r.aragConfig}` : `Failed: ${r.error}`, r.ok ? "info" : "error");
      await configs();
    });
  }
  $("#provAll", main).addEventListener("click", async () => {
    const r = await api("/api/v1/admin/provision", { method: "POST" });
    // Re-render first, then report: the table has to show the new state, and the message
    // has to survive the re-render that shows it.
    await configs();
    $("#provResult", main).innerHTML =
      `<div class="arag-alert ${r.failed ? "warn" : "ok"}">${r.ok} provisioned · ${r.failed} failed</div>`;
  });
}

// ── jobs ─────────────────────────────────────────────────────────────────────
async function jobs(ctx) {
  const status = ctx.query.status ?? "";
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Jobs</h1>
    <div class="actions"><button class="arag-btn ghost" type="button" id="reload">${icon("refresh")} Reload</button></div>
  </div></header>
  <div class="arag-filterbar">
    <label class="sr-only" for="jstatus">Status</label>
    <select class="arag-select" id="jstatus">
      ${["", "queued", "running", "succeeded", "failed", "cancelled"]
        .map(
          (s) =>
            `<option value="${s}"${s === status ? " selected" : ""}>${s ? s[0].toUpperCase() + s.slice(1) : "All statuses"}</option>`,
        )
        .join("")}
    </select>
  </div>
  <div id="body">${skeletonRows(5)}</div>`;
  const res = await api(`/api/v1/jobs?page_size=50${status ? `&status=${status}` : ""}`);
  $("#body", main).innerHTML = res.items.length
    ? `<div class="arag-datatable" id="adminJobsTable"><div class="scroll">
      <table class="arag-table">
        <thead><tr><th>Job</th><th>Kind</th><th>Status</th><th>Stage</th><th>Started</th></tr></thead>
        <tbody>${res.items
          .map(
            (j) => `<tr data-job="${esc(j.id)}" data-id="${esc(j.id)}">
            <td class="mono small">${esc(j.id)}</td><td>${esc(j.kind)}</td><td>${jobChip(j.status)}</td>
            <td>${esc(j.stage ?? "—")}</td><td title="${esc(fmtAbsolute(j.createdAt))}">${esc(fmtRelative(j.createdAt))}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
      <nav class="arag-pagination"><span class="range">${res.items.length} of ${res.total}</span></nav></div>`
    : emptyState({ icon: "clock", title: "No jobs match these filters" });
  $("#reload", main).addEventListener("click", () => jobs(ctx));
  $("#jstatus", main).addEventListener("change", (e) =>
    navigate("/jobs", { status: e.target.value || undefined }),
  );
  wireTable($("#adminJobsTable", main), {
    onOpen: async (id) => {
      const job = await api(`/api/v1/jobs/${id}`);
      const live = job.status === "queued" || job.status === "running";
      const d = openDrawer({
        wide: true,
        title: `Job <span class="mono">${esc(shortId(job.id))}</span>`,
        body: `<dl class="arag-kv">
            <dt>Kind</dt><dd>${esc(job.kind)}</dd>
            <dt>Status</dt><dd>${jobChip(job.status)}</dd>
            <dt>Started</dt><dd>${esc(fmtAbsolute(job.createdAt))}</dd>
            ${job.ref ? `<dt>Document</dt><dd><a href="/#/documents/${esc(job.ref)}">Open in the app ›</a></dd>` : ""}
            ${job.error ? `<dt>Error</dt><dd class="arag-chip danger">${esc(job.error.message)}</dd>` : ""}
          </dl>
          <h3 style="margin-top:16px">Stages</h3>
          <arag-job-timeline id="tl"></arag-job-timeline>
          <details style="margin-top:16px"><summary class="muted small">Raw JSON</summary><arag-json id="jj"></arag-json></details>`,
        foot: live ? '<button class="arag-btn danger" type="button" id="cancel">Cancel job</button>' : "",
      });
      $("#tl", d.host).job = job;
      $("#jj", d.host).data = job;
      $("#cancel", d.host)?.addEventListener("click", async () => {
        try {
          await api(`/api/v1/jobs/${job.id}`, { method: "DELETE" });
          toast("Job cancelled");
          d.close();
          jobs(ctx);
        } catch (err) {
          toast(
            err.status === 409 ? "That job already finished, so it cannot be cancelled." : err.message,
            "error",
          );
        }
      });
    },
  });
}

// ── logs ─────────────────────────────────────────────────────────────────────
/**
 * The runtime log, paged on a stable sequence rather than tailed.
 *
 * A log has no stable page 2 — new records arrive at the head and shift everything — so the
 * control is two directional buttons and a range statement, never `1 2 3 ›`. The client keeps
 * a stack of the cursors it has used, so `Newer` returns to exactly the window it came from
 * rather than re-querying into a window that has since moved.
 */
let followTimer = null;

async function logs(ctx) {
  clearInterval(followTimer);
  const level = ctx.query.level ?? "";
  const contains = ctx.query.contains ?? "";
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Logs</h1>
      <div class="actions">
        <label class="arag-switch"><input type="checkbox" id="follow" /> <span>Follow</span></label>
        <button class="arag-btn ghost" type="button" id="download">${icon("download")} Download</button>
      </div></div></header>
    <div class="arag-filterbar">
      <div class="arag-segmented" id="logLevel" aria-label="Level">
        ${[
          ["", "All"],
          ["info", "Info"],
          ["warn", "Warn"],
          ["error", "Error"],
        ]
          .map(
            ([v, t]) =>
              `<button type="button" data-value="${v}" aria-selected="${v === level}">${t}</button>`,
          )
          .join("")}
      </div>
      <div class="arag-search">${icon("search")}
        <label class="sr-only" for="contains">Contains</label>
        <input class="arag-input" id="contains" type="search" value="${esc(contains)}" placeholder="contains…" />
      </div>
      <span class="spacer"></span>
      <span class="muted small" id="count"></span>
      ${level || contains ? '<button class="arag-btn ghost sm" type="button" id="clear">Clear filters</button>' : ""}
    </div>
    <div id="followNote"></div>
    <div id="body">${skeletonRows(8)}</div>`;

  let rows = [];
  let atHead = true;

  const load = async (cursor, direction) => {
    const qs = new URLSearchParams({ limit: "200" });
    if (level) qs.set("level", level);
    if (contains) qs.set("contains", contains);
    if (cursor) {
      qs.set("cursor", cursor);
      qs.set("direction", direction);
    }
    const page = await api(`/api/v1/admin/logs?${qs}`);
    rows = page.items;
    atHead = !cursor || !page.hasMore;
    $("#count", main).textContent = `${page.total} line${page.total === 1 ? "" : "s"} kept`;
    $("#body", main).innerHTML = rows.length
      ? `<div class="arag-datatable"><div class="arag-log dip-logpane" role="log" aria-live="off" tabindex="0" id="logPane">
            ${rows.map(logLine).join("")}
          </div>
          <nav class="arag-pagination">
            <button type="button" id="logNewer"${page.hasMore ? "" : " disabled"} aria-label="Show newer log lines">‹ Newer</button>
            <span class="range">${rows.length} lines · ${esc(String(rows[0].ts).slice(11, 19))} to ${esc(
              String(rows[rows.length - 1].ts).slice(11, 19),
            )}</span>
            <button type="button" id="logOlder"${page.hasPrev ? "" : " disabled"} aria-label="Show older log lines">Older ›</button>
            ${page.hasPrev ? "" : '<span class="muted">The oldest record this deployment keeps.</span>'}
          </nav></div>`
      : emptyState({
          icon: "search",
          title: level || contains ? "No log lines match these filters" : "No log records yet",
          body:
            level || contains
              ? "Widen the level or clear the search."
              : "Records appear as the service handles requests and runs jobs.",
          actions:
            level || contains
              ? '<button class="arag-btn secondary" type="button" id="clear2">Clear filters</button>'
              : "",
        });
    $("#clear2", main)?.addEventListener("click", () => navigate("/logs", {}));
    for (const el of $$("#logPane .line", main)) {
      el.addEventListener("click", () => {
        const d = openDrawer({ title: "Log record", body: '<arag-json id="lj"></arag-json>' });
        $("#lj", d.host).data = rows[Number(el.dataset.line)];
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          el.click();
        }
      });
    }
    // Reading back through an incident and having lines prepended under the cursor is the
    // failure this pauses; the reason is stated rather than the button quietly doing nothing.
    $("#followNote", main).innerHTML = atHead
      ? ""
      : `<div class="arag-alert" style="margin-bottom:12px">Following is paused while you are looking at
           older lines. <button class="arag-btn ghost sm" type="button" id="toHead">Jump to the latest</button></div>`;
    $("#toHead", main)?.addEventListener("click", () => load());
    // The cursors the server just returned bound this exact window, so paging back lands on
    // the window it came from rather than re-querying into one that has since moved.
    $("#logOlder", main)?.addEventListener("click", async () => {
      await load(page.prevCursor, "older");
      $("#logPane", main)?.focus();
      announce(`${rows.length} lines, older.`);
    });
    $("#logNewer", main)?.addEventListener("click", async () => {
      await load(page.nextCursor, "newer");
      $("#logPane", main)?.focus();
      announce(`${rows.length} lines, newer.`);
    });
  };
  await load();

  wireSegmented($("#logLevel", main), (value) => {
    if (value === level) return;
    navigate("/logs", { ...ctx.query, level: value || undefined });
  });
  let deb;
  $("#contains", main).addEventListener("input", (e) => {
    clearTimeout(deb);
    const v = e.target.value;
    deb = setTimeout(() => navigate("/logs", { ...ctx.query, contains: v || undefined }), 300);
  });
  $("#clear", main)?.addEventListener("click", () => navigate("/logs", {}));
  $("#follow", main).addEventListener("change", (e) => {
    clearInterval(followTimer);
    if (!e.target.checked) return;
    if (!atHead) load();
    followTimer = setInterval(() => {
      if (!document.getElementById("body")) return clearInterval(followTimer);
      if (!atHead) return;
      load();
    }, 3000);
  });
  onLeave(() => clearInterval(followTimer));
  $("#download", main).addEventListener("click", () => downloadNdjson(rows, "logs"));
}

/** The level is a word in the line, not a colour: the pane reads correctly with no colour. */
const logLine = (l, i) =>
  `<div class="line" data-line="${i}" role="button" tabindex="0">
     <span class="mono">${esc(String(l.ts).slice(11, 23))}</span>
     <span class="lvl-${esc(l.level)}">${esc(String(l.level).toUpperCase())}</span>
     <span>${esc(l.msg)} <span class="subtle">${esc(summarise(l))}</span></span>
   </div>`;

/** The structured fields of a log record, minus the three the line already shows. */
const summarise = (record) => {
  const rest = { ...record };
  for (const k of ["ts", "level", "msg"]) delete rest[k];
  const s = JSON.stringify(rest);
  return s === "{}" ? "" : s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

// ── usage ────────────────────────────────────────────────────────────────────
async function usage() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Usage</h1></div></header><div id="body">${skeletonRows(4)}</div>`;
  const [u, docs] = await Promise.all([api("/api/v1/admin/usage"), api("/api/v1/documents?page_size=200")]);
  // Documents per day for the last fortnight, derived from the records themselves. No
  // ARAG-calls time series is drawn: the counters are cumulative since boot, and a chart
  // invented from a single number would be a chart that lies.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push({ key: d.toISOString().slice(0, 10), count: 0 });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const doc of docs.items) {
    const k = doc.createdAt.slice(0, 10);
    if (byKey.has(k)) byKey.get(k).count++;
  }
  const max = Math.max(1, ...days.map((d) => d.count));

  $("#body", main).innerHTML = `
    <div class="arag-statstrip">
      ${kpi("Requests", u.requests, `uptime ${Math.round(u.uptimeSec / 60)} min`)}
      ${kpi("ARAG calls", u.aragCalls, `${Math.round(u.aragMs)} ms total`)}
      ${kpi("ARAG errors", u.aragErrors, `${u.aragConflicts} expected provisioning conflicts`)}
      ${kpi("Client errors", u.aragClientErrors, "4xx from the Knowledge Box")}
      ${kpi("Documents", u.documents.total, `${u.documents.degraded} degraded`)}
      ${kpi("Grounding", u.groundingScore == null ? "—" : pct(u.groundingScore), "mean across records")}
    </div>
    <div class="arag-card">
      <div class="head"><h3>Documents processed, last 14 days</h3></div>
      <div class="body">
        ${days
          .map(
            (d) => `<div class="dip-bar"><span class="muted small">${esc(d.key.slice(5))}</span>
            <span class="dip-bar__track"><i style="width:${Math.round((d.count / max) * 100)}%"></i></span>
            <span class="num small">${d.count}</span></div>`,
          )
          .join("")}
        <p class="muted small" style="margin-top:12px">Derived from the stored records. ARAG call counters are cumulative since boot, so there is no time series to draw for them.</p>
      </div>
    </div>
    <div class="arag-card" style="margin-top:16px">
      <div class="head"><h3>Jobs</h3></div>
      <div class="body"><dl class="arag-kv">
        ${Object.entries(u.jobs)
          .map(([k, v]) => `<dt>${esc(label(k))}</dt><dd>${v}</dd>`)
          .join("")}
      </dl></div>
    </div>`;
}

// ── branding ─────────────────────────────────────────────────────────────────
/**
 * The same form the operator app's Settings → Branding renders, beside the same preview.
 * The screen stays where a partner's operator learned to find it; what changed is that it
 * is now a form rather than a list of environment variables with an apology under it.
 */
async function branding() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Branding</h1></div>
      <p class="sub">White-label presentation only. Values set here override the BRAND_* environment
        defaults, take effect on the next request and are audited.</p>
    </header>
    <div class="arag-split">
      <div id="brandForm">${skeletonRows(6)}</div>
      <div class="arag-card" id="brandPreview"></div>
    </div>`;
  const host = $("#brandForm", main);
  const ctx = await mountSettings(host, "branding", branding);
  const b = await api("/api/v1/branding").catch(() => ({}));
  const preview = $("#brandPreview", main);
  const read = () => {
    const out = { ...b };
    for (const row of $$(".dip-setting[data-key]", host)) {
      const el = $("[data-control]", row);
      if (!el) continue;
      out[row.dataset.key.split(".")[1]] = row.dataset.type === "boolean" ? el.checked : el.value;
    }
    return out;
  };
  const repaint = () => {
    const v = read();
    preview.innerHTML = `
      <div class="head"><h3>Preview</h3></div>
      <div class="body">
        ${brandPreviewHead(v)}
        <div class="arag-row" style="margin:12px 0">
          <button class="arag-btn" type="button">Primary</button>
          <button class="arag-btn secondary" type="button">Secondary</button>
        </div>
        <div class="arag-chips">
          <span class="arag-chip ok">Ready</span><span class="arag-chip warn">Degraded</span>
          <span class="arag-chip danger">Failed</span><span class="arag-chip info">Processing</span>
        </div>
        <p class="muted small" style="margin-top:12px">Status, verification, grounding and validation
          colours are <strong>never branded</strong>: a partner may recolour their product, but not the
          evidence.</p>
      </div>`;
  };
  repaint();
  for (const el of $$("[data-control]", host)) {
    el.addEventListener("input", repaint);
    el.addEventListener("change", repaint);
  }
  void ctx;
}

// ── security ─────────────────────────────────────────────────────────────────
async function security() {
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Security</h1></div>
      <p class="sub">The credentials in force, and the retention that limits how long anything is kept.</p>
    </header>
    <div class="arag-stack" id="body">${skeletonRows(4)}</div>`;
  const body = $("#body", main);
  const s = await api("/api/v1/admin/security");
  body.innerHTML = `
    <div id="secForm"></div>
    <div class="arag-card"><div class="head"><h3>Posture</h3></div><div class="body">
      <dl class="arag-kv">
        <dt>API keys</dt><dd>${
          s.apiKeys.count
            ? `${s.apiKeys.count} in force · ${s.apiKeys.hints.map((h) => `<span class="mono">${esc(h)}</span>`).join(" ")}`
            : "None — the public API is open for reads and uploads"
        } · <a href="/#/settings/keys">Create and revoke keys ›</a></dd>
        <dt>Admin token</dt><dd>${s.adminTokenSet ? "Set" : "Not set"}</dd>
        <dt>Session cookie</dt><dd>${Math.round(s.sessionTtlSec / 3600)} h, SameSite=Lax, HttpOnly</dd>
        <dt>Writes</dt><dd>${
          s.writesRequireCredential
            ? "Always require a credential — deletes, config creation and field corrections, even when API_KEYS is unset"
            : "Open"
        }</dd>
        <dt>Rate limit</dt><dd>${
          s.rateLimit.rps > 0
            ? `${s.rateLimit.rps} req/s, burst ${s.rateLimit.burst}`
            : "Disabled (0 means no limit)"
        }</dd>
        <dt>CORS</dt><dd>${s.cors.length ? esc(s.cors.join(", ")) : "same-origin only"}</dd>
        <dt>Max upload</dt><dd>${esc(fmtBytes(s.maxUploadBytes))}</dd>
        <dt>Max body</dt><dd>${esc(fmtBytes(s.maxBodyBytes))}</dd>
        <dt>Headers</dt><dd>${Object.entries(s.headers)
          .filter(([, v]) => v)
          .map(([k]) => k.toUpperCase())
          .join(", ")} on</dd>
        <dt>Trusted proxy</dt><dd>${esc(s.trustProxy)}</dd>
      </dl>
      <p class="muted small" style="margin-top:12px">Key values never leave the process: the count and
        the prefix are what an operator needs to tell keys apart.</p>
    </div></div>
    <div id="retForm"></div>
    <div id="purgeCard"></div>`;
  await mountSettings($("#secForm", main), "security", security);
  await mountSettings($("#retForm", main), "retention", security);
  mountPurge($("#purgeCard", main), { editable: true, defaultDays: s.retention.defaultOlderThanDays });
}

// ── audit ────────────────────────────────────────────────────────────────────
/**
 * Who changed what, when — the record the brief asks for beside "every setting is editable".
 * Newest first, cursor-paged like the runtime log, and filterable by action and actor. The
 * before → after values arrive redacted: a settings change records that a secret changed,
 * never what it changed to.
 */
async function audit(ctx) {
  const action = ctx.query.action ?? "";
  const actor = ctx.query.actor ?? "";
  main.innerHTML = `<header class="arag-pagehead"><div class="row"><h1>Audit</h1>
      <div class="actions"><button class="arag-btn ghost" type="button" id="auditDownload">${icon("download")} Download</button></div>
    </div>
    <p class="sub">Every settings change, key creation, revocation, provision, purge and field correction,
      with the actor and the before → after values. Secrets are redacted to <span class="mono">***</span>.</p>
    </header>
    <div class="arag-filterbar">
      <label class="sr-only" for="auditAction">Action</label>
      <select class="arag-select" id="auditAction"><option value="">All actions</option></select>
      <label class="sr-only" for="auditActor">Actor</label>
      <select class="arag-select" id="auditActor">
        ${["", "admin", "api-key", "session", "system", "anonymous"]
          .map(
            (a) =>
              `<option value="${a}"${a === actor ? " selected" : ""}>${a ? esc(label(a)) : "Any actor"}</option>`,
          )
          .join("")}
      </select>
      <span class="spacer"></span>
      <span class="muted small" id="auditTotal"></span>
      ${action || actor ? '<button class="arag-btn ghost sm" type="button" id="auditClear">Clear filters</button>' : ""}
    </div>
    <div id="body">${skeletonRows(6)}</div>`;

  let rows = [];

  const load = async (cursor, direction) => {
    const qs = new URLSearchParams({ limit: "50" });
    if (action) qs.set("action", action);
    if (actor) qs.set("actor", actor);
    if (cursor) {
      qs.set("cursor", cursor);
      qs.set("direction", direction);
    }
    const page = await api(`/api/v1/admin/audit?${qs}`);
    rows = page.items;
    const select = $("#auditAction", main);
    if (select.options.length === 1) {
      for (const a of page.actions ?? []) {
        const opt = document.createElement("option");
        opt.value = a;
        opt.textContent = a;
        opt.selected = a === action;
        select.appendChild(opt);
      }
    }
    $("#auditTotal", main).textContent = `${page.total} record${page.total === 1 ? "" : "s"}`;
    $("#body", main).innerHTML = rows.length
      ? `<div class="arag-datatable" id="auditTable"><div class="scroll"><table class="arag-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th></tr></thead>
          <tbody>${rows
            .map(
              (e, i) => `<tr data-id="${i}">
                <td class="small" style="white-space:nowrap" title="${esc(fmtAbsolute(e.ts))}">${esc(fmtRelative(e.ts))}</td>
                <td class="small">${esc(e.actor?.name ?? "—")}<span class="cell-sub">${esc(e.actor?.type ?? "")}</span></td>
                <td class="mono small">${esc(e.action)}</td>
                <td class="mono small">${esc(e.target)}</td>
                <td class="small">${esc(summariseChange(e))}</td>
              </tr>`,
            )
            .join("")}</tbody></table></div>
          <nav class="arag-pagination">
            <button type="button" id="auditNewer"${page.hasPrev ? "" : " disabled"} aria-label="Show newer audit records">‹ Newer</button>
            <span class="range">${rows.length} of ${page.total} · ${esc(fmtAbsolute(rows[rows.length - 1].ts))} to ${esc(fmtAbsolute(rows[0].ts))}</span>
            <button type="button" id="auditOlder"${page.hasMore ? "" : " disabled"} aria-label="Show older audit records">Older ›</button>
            ${page.hasMore ? "" : '<span class="muted">The oldest record this deployment keeps.</span>'}
          </nav></div>`
      : emptyState({
          icon: "shield",
          title: action || actor ? "No audit records match these filters" : "No audit records yet",
          body:
            action || actor
              ? "Records appear as settings, keys, configs and records are changed."
              : "Records appear the first time somebody changes a setting, creates a key or corrects a field.",
          actions:
            action || actor
              ? '<button class="arag-btn secondary" type="button" id="auditClear2">Clear filters</button>'
              : "",
        });
    $("#auditClear2", main)?.addEventListener("click", () => navigate("/audit", {}));
    wireTable($("#auditTable", main), {
      onOpen: (i) => {
        const e = rows[Number(i)];
        const d = openDrawer({
          wide: true,
          title: `<span class="mono">${esc(e.action)}</span>`,
          sub: `${esc(e.actor?.name ?? "")} · ${esc(fmtAbsolute(e.ts))}`,
          body: '<arag-json id="auditJson"></arag-json>',
        });
        $("#auditJson", d.host).data = e;
      },
    });
    // Directional, never `1 2 3 ›`: an audit log has no stable page 2, because new records
    // arrive at the head and shift everything. The cursors bound this exact window.
    $("#auditOlder", main)?.addEventListener("click", async () => {
      await load(page.nextCursor, "older");
      $("#body", main).focus?.();
      announce(`${rows.length} audit records, older.`);
    });
    $("#auditNewer", main)?.addEventListener("click", async () => {
      await load(page.prevCursor, "newer");
      announce(`${rows.length} audit records, newer.`);
    });
  };

  await load();
  $("#auditAction", main).addEventListener("change", (e) =>
    navigate("/audit", { ...ctx.query, action: e.target.value || undefined }),
  );
  $("#auditActor", main).addEventListener("change", (e) =>
    navigate("/audit", { ...ctx.query, actor: e.target.value || undefined }),
  );
  $("#auditClear", main)?.addEventListener("click", () => navigate("/audit", {}));
  $("#auditDownload", main).addEventListener("click", () => downloadNdjson(rows, "audit"));
}

/** `before → after` in one cell; the drawer has the whole record. */
function summariseChange(entry) {
  const one = (v) =>
    v === null || v === undefined
      ? "—"
      : typeof v === "object"
        ? JSON.stringify(v).slice(0, 60)
        : String(v).slice(0, 60);
  if (entry.before === null && entry.after === null) return entry.detail ?? "";
  return `${one(entry.before)} → ${one(entry.after)}${entry.detail ? ` · ${entry.detail}` : ""}`;
}

function downloadNdjson(rows, stem) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([rows.map((r) => JSON.stringify(r)).join("\n")], { type: "application/x-ndjson" }),
  );
  a.download = `${stem}-${new Date().toISOString().slice(0, 19)}.ndjson`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── the shared settings form ─────────────────────────────────────────────────
/**
 * One group of `GET /api/v1/admin/settings`, rendered by the module the operator app uses.
 * The console is always signed in, so there is no locked rendering here — but it is the same
 * form, so an edit made in either place behaves identically and is audited identically.
 */
async function mountSettings(host, groupId, rerender) {
  const loaded = await loadSettings();
  const ctx = {
    data: loaded.data,
    editable: loaded.editable,
    reload: async () => {
      await rerender();
    },
    setDirty: () => {},
  };
  const group = ctx.data?.groups?.find((g) => g.id === groupId);
  if (!group) {
    host.innerHTML = errorState({ message: "The settings document did not describe this group." });
    return ctx;
  }
  mountGroup(host, group, ctx);
  return ctx;
}

// ── boot ─────────────────────────────────────────────────────────────────────
let router = null;

async function boot() {
  await brandingReady;
  try {
    await api("/api/v1/admin/health");
  } catch (err) {
    renderSignIn(
      err.status === 403
        ? "Admin access is disabled for this deployment. Set ADMIN_TOKEN and restart to enable it."
        : "",
    );
    return;
  }
  mount();
  if (!router) {
    router = createRouter(
      [
        ["/overview", withNav("overview", overview)],
        ["/connection", withNav("connection", connection)],
        ["/configs", withNav("configs", configs)],
        ["/jobs", withNav("jobs", jobs)],
        ["/logs", withNav("logs", logs)],
        ["/audit", withNav("audit", audit)],
        ["/usage", withNav("usage", usage)],
        ["/branding", withNav("branding", branding)],
        ["/security", withNav("security", security)],
      ],
      { fallback: () => navigate("/overview", {}, { replace: true }) },
    );
  }
  if (!location.hash || location.hash === "#/") navigate("/overview", {}, { replace: true });
  else router.run();
}

boot();
