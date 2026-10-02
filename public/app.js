/**
 * Document Processing — operator app.
 *
 * A hash-routed static SPA that talks only to `/api/v1`; there are no secrets in the
 * browser. Hash routing rather than path routing because the platform's static file
 * server has no SPA fallback: `/documents/abc` would answer a 404 problem document rather
 * than the app.
 *
 * The chrome is the platform kit's `<arag-app-shell>` (v0.2.0) — band, rail, connection
 * pill, live region — mounted through `mountShell()` in lib/core.js, which carries the two
 * hash-routing adapters the kit's path-routing rail needs.
 */
import {
  $,
  api,
  applyBranding,
  buildHash,
  createRouter,
  mountShell,
  navigate,
  parseHash,
  tour,
} from "./lib/core.js";
import { startSession } from "./lib/session.js";
import { renderApi } from "./views/api.js";
import { renderAsk } from "./views/ask.js";
import { renderConfigBuilder, renderConfigDetail, renderConfigs } from "./views/configs.js";
import { renderDocument } from "./views/document.js";
import { renderDocuments, renderUpload } from "./views/documents.js";
import { renderJobDetail, renderJobs } from "./views/jobs.js";
import { renderSettings } from "./views/settings.js";
import { renderWelcome } from "./views/welcome.js";

const NAV = [
  { key: "documents", label: "Documents", href: buildHash("/documents"), icon: "document" },
  { key: "configs", label: "Configs", href: buildHash("/configs"), icon: "layers" },
  { key: "ask", label: "Ask", href: buildHash("/ask"), icon: "quote" },
  { key: "jobs", label: "Jobs", href: buildHash("/jobs"), icon: "clock" },
  { key: "api", label: "API", href: buildHash("/api"), icon: "book" },
  { key: "settings", label: "Settings", href: buildHash("/settings/connection"), icon: "settings" },
];

const { main, setActiveNav, setNavBadge } = mountShell(document.getElementById("app"), {
  productName: "Document Processing",
  tagline: "Documents in, validated records out",
  nav: NAV,
  bandLink: { label: "Admin", href: "/admin/" },
});

// The session cookie is what lets this page make the writes DP-12 protects — a delete, a
// config, a field correction — without a key pasted into the browser. `startSession` records
// whether it succeeded so the screens that offer a write can say why one is refused.
startSession();
api("/api/v1/branding")
  .then(applyBranding)
  .catch(() => undefined);

/** Live nav badges: what needs review, and what is still moving. */
async function refreshBadges() {
  try {
    const s = await api("/api/v1/stats");
    setNavBadge("documents", s.documents.total, {
      title: `${s.documents.total} documents`,
    });
    setNavBadge("jobs", (s.jobs.queued ?? 0) + (s.jobs.running ?? 0), { title: "queued and running jobs" });
    const configs = await api("/api/v1/extraction-configs");
    setNavBadge("configs", configs.items.length);
  } catch {
    /* badges are decoration; a failed poll must never interrupt a screen */
  }
}

const withNav = (key, fn) => async (ctx) => {
  await fn(main, ctx);
  // The rail is told which item is current after the render, not before: a pushState or
  // hash router changes the URL without telling the shell anything (DP-32).
  setActiveNav(key);
  refreshBadges();
  maybeTour(ctx);
};

const router = createRouter(
  [
    ["/welcome", withNav("documents", renderWelcome)],
    ["/documents", withNav("documents", renderDocuments)],
    ["/documents/upload", withNav("documents", renderUpload)],
    ["/documents/:id", withNav("documents", (m, c) => renderDocument(m, c, ""))],
    ["/documents/:id/source", withNav("documents", (m, c) => renderDocument(m, c, "source"))],
    ["/documents/:id/pipeline", withNav("documents", (m, c) => renderDocument(m, c, "pipeline"))],
    ["/documents/:id/ask", withNav("documents", (m, c) => renderDocument(m, c, "ask"))],
    ["/documents/:id/json", withNav("documents", (m, c) => renderDocument(m, c, "json"))],
    ["/documents/:id/compare", withNav("documents", (m, c) => renderDocument(m, c, "compare"))],
    ["/configs", withNav("configs", renderConfigs)],
    ["/configs/new", withNav("configs", (m, c) => renderConfigBuilder(m, { ...c, params: {} }))],
    ["/configs/:id", withNav("configs", renderConfigDetail)],
    ["/configs/:id/edit", withNav("configs", renderConfigBuilder)],
    ["/ask", withNav("ask", renderAsk)],
    ["/jobs", withNav("jobs", renderJobs)],
    ["/jobs/:id", withNav("jobs", renderJobDetail)],
    ["/api", withNav("api", renderApi)],
    ["/settings", withNav("settings", (m, c) => renderSettings(m, { ...c, params: { tab: "connection" } }))],
    ["/settings/:tab", withNav("settings", renderSettings)],
  ],
  { fallback: () => navigate("/documents", {}, { replace: true }) },
);

// ── the guided path ──────────────────────────────────────────────────────────
/**
 * A spotlight over the real screens, never a mock of them — the kit's `tour()`, which adds
 * the Escape handling and the advisory (click-through) scrim. At most four steps, each
 * describing something visible, and it never restarts on its own. `?tour=1&step=N` in the
 * hash still opens the tour at a given step, so the showcase recording can link to one.
 */
const TOUR = [
  {
    target: "#strip",
    title: "The queue",
    body: "This is the queue. Everything you process lands here, with the numbers that decide what to look at first.",
  },
  {
    target: "#docsTable",
    title: "Rows carry the document's own identity",
    body: "Each row carries the document's own identity — the order number and the supplier — not just the filename a scanner gave it. Open the row when it says Ready.",
  },
  {
    target: '[data-nav="Configs"]',
    title: "Configs are the contract",
    body: "Configs are what the model is forced to return. Eleven types are built in; a new one is a list of field names.",
  },
];

let activeTour = null;
/** True while we are tearing the tour down ourselves, so `onDone` stays out of the way. */
let tourClosing = false;

function endTour() {
  if (!activeTour) return;
  tourClosing = true;
  activeTour.stop();
  tourClosing = false;
  activeTour = null;
}

function maybeTour(ctx) {
  endTour();
  if (ctx.query.tour !== "1") return;
  if (!document.querySelector(TOUR[0].target)) return;
  activeTour = tour(TOUR, {
    onDone: () => {
      activeTour = null;
      if (tourClosing) return;
      // Skip/Done/Escape all land here: drop the tour out of the hash so a reload of the
      // same link does not reopen it.
      const { path, query } = parseHash();
      navigate(path, { ...query, tour: undefined, step: undefined }, { replace: true });
    },
  });
  // The kit's tour owns its step index, so a deep link is honoured by advancing it — the
  // card re-renders synchronously, and `step` is clamped below the last step so this can
  // never trip "Done".
  const step = Math.max(0, Math.min(TOUR.length - 1, Number(ctx.query.step ?? 1) - 1));
  for (let i = 0; i < step; i++) document.querySelector(".arag-tour-card [data-next]")?.click();
}

// ── keyboard shortcuts (documented in Settings → API, none required) ─────────
let chord = false;
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (chord) {
    chord = false;
    const to = {
      d: "/documents",
      c: "/configs",
      a: "/ask",
      j: "/jobs",
      i: "/api",
      s: "/settings/connection",
    }[e.key];
    if (to) {
      e.preventDefault();
      navigate(to);
    }
    return;
  }
  if (e.key === "g") {
    chord = true;
    return;
  }
  if (e.key === "/") {
    const box = $("#q") ?? $(".arag-search input");
    if (box) {
      e.preventDefault();
      box.focus();
    }
  }
  if (e.key === "u") {
    e.preventDefault();
    navigate("/documents/upload");
  }
});

if (!location.hash) {
  // First run goes to the welcome screen; anything else lands in the queue.
  api("/api/v1/documents?page_size=1")
    .then((p) => navigate(p.total === 0 ? "/welcome" : "/documents", {}, { replace: true }))
    .catch(() => navigate("/documents", {}, { replace: true }));
} else {
  router.run();
}
refreshBadges();
