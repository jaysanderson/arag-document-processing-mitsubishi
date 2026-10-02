/**
 * Documents — the working queue.
 *
 * Find a document, judge at a glance whether it can be trusted unreviewed, act on many at
 * once. Every filter lives in the hash query string, so a filtered queue is a link a
 * colleague can be sent.
 */
import {
  $,
  $$,
  api,
  buildHash,
  confirmDialog,
  docState,
  downloadResponse,
  emptyState,
  errorState,
  esc,
  fmtAbsolute,
  fmtRelative,
  headline,
  icon,
  label,
  menuButton,
  navigate,
  onLeave,
  pct,
  popover,
  skeletonRows,
  statusChip,
  toast,
  wireTable,
} from "../lib/core.js";
import { openUploadDrawer } from "./upload.js";

const PAGE_SIZES = [20, 50, 100];
const SORTS = [
  ["created_at:desc", "Newest first"],
  ["created_at:asc", "Oldest first"],
  ["grounding:asc", "Grounding: lowest first"],
  ["grounding:desc", "Grounding: highest first"],
  ["filename:asc", "Name A–Z"],
  ["doc_type:asc", "Type"],
  ["status:asc", "Status"],
];

/** Selection survives paging within a visit — a batch is rarely one page long. */
const selected = new Set();
let liveTimer = null;

function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
  document.querySelector(".arag-popover")?.remove();
}

function filtersFrom(query) {
  return {
    // Repeatable and ANDed, up to ten: `<schemaId>:<field>:<op>:<value>`. These are answered
    // by the Knowledge Box, not by this product's store, which is the whole point of them.
    kv: [].concat(query.kv ?? []).filter(Boolean),
    q: query.q ?? "",
    status: query.status ?? "",
    doc_type: query.doc_type ?? "",
    config: query.config ?? "",
    has_issues: query.has_issues ?? "",
    degraded: query.degraded ?? "",
    date_from: query.date_from ?? "",
    sort: query.sort ?? "created_at:desc",
    page: Number(query.page ?? 1),
    page_size: Number(query.page_size ?? 20),
  };
}

const activeFilterCount = (f) =>
  ["q", "status", "doc_type", "config", "has_issues", "degraded", "date_from"].filter((k) => f[k]).length +
  f.kv.length;

function toParams(f) {
  const [sort, order] = f.sort.split(":");
  const p = new URLSearchParams({
    page: String(f.page),
    page_size: String(f.page_size),
    sort,
    order,
  });
  for (const k of ["q", "status", "doc_type", "config", "has_issues", "degraded", "date_from"]) {
    if (f[k]) p.set(k, f[k]);
  }
  for (const one of f.kv) p.append("kv", one);
  return p;
}

export async function renderDocuments(main, { query, stale, keepEmpty = false }) {
  const f = filtersFrom(query);
  stopLive();
  main.innerHTML = `
    <header class="arag-pagehead">
      <div class="row">
        <h1>Documents</h1>
        <div class="actions">
          <button class="arag-btn" id="uploadBtn" type="button">${icon("upload")} Upload document</button>
        </div>
      </div>
    </header>
    <div id="strip"></div>
    <div id="filters"></div>
    <div id="kvfilters"></div>
    <div id="list">${skeletonRows(6)}</div>`;

  $("#uploadBtn", main).addEventListener("click", () => navigate("/documents/upload", query));

  let page;
  let configs = [];
  try {
    [page, configs] = await Promise.all([
      api(`/api/v1/documents?${toParams(f)}`),
      api("/api/v1/extraction-configs")
        .then((r) => r.items)
        .catch(() => []),
    ]);
  } catch (err) {
    if (stale()) return;
    // A malformed Knowledge Box filter answers 400 with a message naming the field and what
    // it does accept; showing that beats a generic failure over a list the reader can fix.
    $("#list", main).innerHTML = errorState(err, {
      retry: f.kv.length
        ? `<a class="arag-btn secondary sm" href="${buildHash("/documents", { ...query, kv: undefined })}">Clear the Knowledge Box filters</a>`
        : '<button class="arag-btn secondary sm" id="retry" type="button">Try again</button>',
    });
    $("#retry", main)?.addEventListener("click", () => renderDocuments(main, { query, stale: () => false }));
    return;
  }
  if (stale()) return;

  // First run is a different product from "no results": send it to the welcome screen
  // rather than showing an empty table with filters nobody set. `keepEmpty` is for the
  // upload drawer, which is a route over this list: arriving from Welcome's "Use your own
  // document" with nothing processed yet must not bounce straight back to Welcome.
  if (page.total === 0 && activeFilterCount(f) === 0 && !keepEmpty) {
    navigate("/welcome", {}, { replace: true });
    return;
  }

  renderStrip($("#strip", main), page.facets);
  renderFilters($("#filters", main), f, page.facets, query);
  renderKvFilters($("#kvfilters", main), f, page.filters, configs, query);
  renderList(main, page, f, query);

  // While anything is queued or processing, refresh quietly. The list is a queue: it has
  // to move on its own or the user learns to hammer the browser's reload.
  const busy = page.items.some((d) => d.status === "pending" || d.status === "processing");
  if (busy) {
    onLeave(stopLive);
    liveTimer = setInterval(async () => {
      if (!document.getElementById("docsTable")) return stopLive();
      try {
        const next = await api(`/api/v1/documents?${toParams(f)}`);
        renderStrip($("#strip", main), next.facets);
        renderList(main, next, f, query);
        if (!next.items.some((d) => d.status === "pending" || d.status === "processing")) stopLive();
      } catch {
        /* a failed refresh must never wipe the list that is on screen */
      }
    }, 2500);
  }
}

function tile(href, labelText, value, sub) {
  // The kit's stat strip styles its direct children, so `.label`/`.value`/`.sub` sit on the
  // tile itself rather than inside a nested `.arag-kpi` (which would double the padding).
  const inner = `<div class="label">${esc(labelText)}</div>
      <div class="value">${esc(String(value))}</div>
      <div class="sub">${esc(sub)}</div>`;
  return href ? `<a href="${esc(href)}">${inner}</a>` : `<div>${inner}</div>`;
}

function renderStrip(host, facets = {}) {
  const f = {
    total: facets.total ?? 0,
    needsReview: facets.needsReview ?? 0,
    degraded: facets.degraded ?? 0,
    status: facets.status ?? {},
  };
  const processing = (f.status.pending ?? 0) + (f.status.processing ?? 0);
  host.innerHTML = `<div class="arag-statstrip">
    ${tile(buildHash("/documents"), "Documents", f.total, "in this workspace")}
    ${tile(buildHash("/documents", { has_issues: "true", sort: "grounding:asc" }), "Need review", f.needsReview, "issues or weak grounding")}
    ${tile(buildHash("/documents", { status: "processing" }), "In flight", processing, "queued or processing")}
    ${tile(buildHash("/documents", { degraded: "true" }), "Degraded", f.degraded, "finished with a failed stage")}
  </div>`;
}

/**
 * Knowledge Box filters — the part of this screen that is not answered by this product.
 *
 * A `kv=` filter is evaluated by the Knowledge Box against the typed values the extraction
 * wrote onto the resource; every other filter on this bar is answered from the local store.
 * The two are labelled differently because the distinction is the capability: one of them
 * searches structured data that lives in the customer's own Knowledge Box.
 *
 * There are no counts beside a kv value. The platform cannot produce facets for key-value
 * fields, and a count invented locally would be a count of the page rather than of the
 * corpus.
 */
const KV_OPS = [
  ["eq", "is"],
  ["gte", "is at least"],
  ["lte", "is at most"],
  ["contains", "contains"],
];

const opsFor = (field) => {
  if (!field) return KV_OPS;
  if (field.type === "array") return KV_OPS.filter(([o]) => o === "contains" || o === "eq");
  if (
    field.type === "number" ||
    field.kvType === "date" ||
    field.kvType === "integer" ||
    field.kvType === "float"
  )
    return KV_OPS.filter(([o]) => o !== "contains");
  return KV_OPS.filter(([o]) => o === "eq");
};

const opLabel = (op) => KV_OPS.find(([o]) => o === op)?.[1] ?? op;

/** The `kv=` parameter this applied filter came from, so a chip can remove exactly it. */
const kvSpec = (a) => `${a.schemaId}:${a.key}:${a.op}:${a.value}`;

function renderKvFilters(host, f, filters, configs, query) {
  const kb = filters?.knowledgeBox ?? { applied: [], requested: [], matchedResources: 0 };
  const schemas = configs.filter((c) => c.kvSchemaId && Object.keys(c.kvFields ?? {}).length);
  // Render the chips from `applied`, never from `requested`: a chip for a filter the
  // Knowledge Box never applied would claim a narrowing that did not happen.
  const applied = kb.applied ?? [];
  const dropped = (kb.requested ?? []).filter(
    (r) =>
      !applied.some(
        (a) => a.schemaId === r.schemaId && a.key === r.key && a.op === r.op && a.value === r.value,
      ),
  );
  const localNames = filters?.local ?? [];

  host.innerHTML = `
    <div class="arag-filterchips" style="margin-bottom:12px">
      ${applied
        .map(
          (a) => `<span class="arag-filterchip">
            <strong>Knowledge Box:</strong> ${esc(a.key)} ${esc(opLabel(a.op))} ${esc(String(a.value))}
            <button type="button" data-kv-remove="${esc(kvSpec(a))}"
              aria-label="Remove the Knowledge Box filter on ${esc(a.key)}">${icon("x", { size: 12 })}</button>
          </span>`,
        )
        .join("")}
      ${localNames
        .map((n) => `<span class="arag-filterchip"><strong>This workspace:</strong> ${esc(label(n))}</span>`)
        .join("")}
      ${
        schemas.length
          ? `<button class="arag-btn ghost sm" type="button" id="addKv"${f.kv.length >= 10 ? " disabled" : ""}>${icon(
              "plus",
              { size: 13 },
            )} Knowledge Box filter</button>`
          : ""
      }
      ${
        applied.length
          ? `<span class="muted small">${kb.matchedResources} resource${
              kb.matchedResources === 1 ? "" : "s"
            } matched in the Knowledge Box</span>`
          : ""
      }
    </div>
    ${
      kb.error
        ? `<div class="arag-alert warn" style="margin-bottom:12px">
             <strong>The Knowledge Box could not answer that filter.</strong> ${esc(kb.error)}
             The list below is this workspace's own store, unfiltered by the Knowledge Box — so it is
             wider than what you asked for, not narrower.
           </div>`
        : ""
    }
    ${
      dropped.length
        ? `<div class="arag-alert warn" style="margin-bottom:12px">
             ${dropped.length} requested Knowledge Box filter${dropped.length === 1 ? " was" : "s were"} not
             applied: ${dropped.map((d) => `<span class="mono">${esc(`${d.key} ${d.op} ${d.value}`)}</span>`).join(", ")}.
           </div>`
        : ""
    }`;

  // Removed by value, not by position: a requested filter the Knowledge Box declined is not
  // in `applied`, so the two lists can differ in length and an index would take the wrong one.
  for (const b of $$("[data-kv-remove]", host)) {
    b.addEventListener("click", () => {
      const next = f.kv.filter((one) => one !== b.dataset.kvRemove);
      navigate("/documents", { ...query, kv: next, page: undefined });
    });
  }

  $("#addKv", host)?.addEventListener("click", (e) => {
    const pop = popover(
      e.currentTarget,
      `<form id="kvForm" class="arag-stack" style="min-width:18rem">
        <div class="arag-field">
          <label for="kvSchema">Extraction config</label>
          <select class="arag-select" id="kvSchema">
            ${schemas.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="arag-field">
          <label for="kvField">Field</label>
          <select class="arag-select" id="kvField"></select>
        </div>
        <div class="arag-field">
          <label for="kvOp">Matches</label>
          <select class="arag-select" id="kvOp"></select>
        </div>
        <div class="arag-field">
          <label for="kvValue">Value</label>
          <input class="arag-input" id="kvValue" />
        </div>
        <p class="arag-help">This filter is evaluated by the Knowledge Box against the typed value written
          onto the resource, not by this product's store.</p>
        <button class="arag-btn sm" type="submit">Add the filter</button>
      </form>`,
    );
    if (!pop) return;
    const schemaSel = $("#kvSchema", pop);
    const fieldSel = $("#kvField", pop);
    const opSel = $("#kvOp", pop);
    const cfgOf = () => schemas.find((c) => c.id === schemaSel.value);
    const fieldOf = () => (cfgOf()?.fields ?? []).find((x) => x.key === fieldSel.value);
    const paintFields = () => {
      const cfg = cfgOf();
      const keys = Object.keys(cfg?.kvFields ?? {});
      fieldSel.innerHTML = (cfg?.fields ?? [])
        .filter((x) => keys.includes(x.key))
        .map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`)
        .join("");
      paintOps();
    };
    const paintOps = () => {
      opSel.innerHTML = opsFor(fieldOf())
        .map(([o, t]) => `<option value="${esc(o)}">${esc(t)}</option>`)
        .join("");
    };
    schemaSel.addEventListener("change", paintFields);
    fieldSel.addEventListener("change", paintOps);
    paintFields();
    $("#kvForm", pop).addEventListener("submit", (ev) => {
      ev.preventDefault();
      const cfg = cfgOf();
      const value = $("#kvValue", pop).value.trim();
      if (!cfg || !fieldSel.value || !value) return;
      const kvKey = cfg.kvFields[fieldSel.value] ?? fieldSel.value;
      // The popover is anchored to a button this navigation is about to replace, so it closes
      // itself rather than floating over the list it just filtered.
      pop.remove();
      navigate("/documents", {
        ...query,
        kv: [...f.kv, `${cfg.kvSchemaId}:${kvKey}:${opSel.value}:${value}`],
        page: undefined,
      });
    });
  });
}

function option(value, text, current) {
  return `<option value="${esc(value)}"${String(current) === String(value) ? " selected" : ""}>${esc(text)}</option>`;
}

function renderFilters(host, f, facets = {}, query) {
  const types = Object.entries(facets.docType ?? {}).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <div class="arag-filterbar">
      <div class="arag-search">
        ${icon("search")}
        <label class="sr-only" for="q">Search documents</label>
        <input class="arag-input" id="q" type="search" value="${esc(f.q)}"
               placeholder="Search filename, type or value" />
      </div>
      <label class="sr-only" for="fStatus">Status</label>
      <select class="arag-select" id="fStatus">
        ${option("", "Any status", f.status)}
        ${["pending", "processing", "ready", "failed"]
          .map((s) =>
            option(s, `${label(s === "pending" ? "queued" : s)} (${facets.status?.[s] ?? 0})`, f.status),
          )
          .join("")}
      </select>
      <label class="sr-only" for="fType">Document type</label>
      <select class="arag-select" id="fType">
        ${option("", "Any type", f.doc_type)}
        ${types.map(([t, n]) => option(t, `${label(t)} (${n})`, f.doc_type)).join("")}
      </select>
      <label class="sr-only" for="fReview">Review state</label>
      <select class="arag-select" id="fReview">
        ${option("", "Any review state", f.has_issues ? "issues" : f.degraded ? "degraded" : "")}
        ${option("issues", "Has issues", f.has_issues ? "issues" : "")}
        ${option("degraded", "Degraded", f.degraded ? "degraded" : "")}
      </select>
      <label class="sr-only" for="fSort">Sort</label>
      <select class="arag-select" id="fSort">${SORTS.map(([v, t]) => option(v, t, f.sort)).join("")}</select>
      <span class="spacer"></span>
      ${
        activeFilterCount(f)
          ? '<button class="arag-btn ghost sm" type="button" id="clearFilters">Clear all filters</button>'
          : ""
      }
    </div>`;

  const apply = (patch) => {
    selected.clear();
    navigate("/documents", { ...query, page: undefined, ...patch });
  };
  let debounce;
  $("#q", host).addEventListener("input", (e) => {
    clearTimeout(debounce);
    const value = e.target.value;
    debounce = setTimeout(() => apply({ q: value || undefined }), 300);
  });
  $("#fStatus", host).addEventListener("change", (e) => apply({ status: e.target.value || undefined }));
  $("#fType", host).addEventListener("change", (e) => apply({ doc_type: e.target.value || undefined }));
  $("#fReview", host).addEventListener("change", (e) =>
    apply({
      has_issues: e.target.value === "issues" ? "true" : undefined,
      degraded: e.target.value === "degraded" ? "true" : undefined,
    }),
  );
  $("#fSort", host).addEventListener("change", (e) => apply({ sort: e.target.value }));
  $("#clearFilters", host)?.addEventListener("click", () => {
    selected.clear();
    navigate("/documents", {});
  });
}

const COLUMNS = [
  ["filename", "File"],
  ["doc_type", "Type"],
  ["status", "Status"],
  ["fields", "Fields"],
  ["grounding", "Grounding"],
  [null, "Issues"],
];

function issueChip(doc) {
  const issues = (doc.issues ?? []).filter((i) => i.severity !== "info");
  if (!issues.length) return '<span class="subtle">—</span>';
  const worst = issues.some((i) => i.severity === "error") ? "danger" : "warn";
  return `<span class="arag-chip ${worst}" title="${esc(issues.map((i) => i.message).join(" · "))}">${issues.length}</span>`;
}

function subline(doc) {
  const h = headline(doc);
  // The identifier and the counterparty are extracted field values — an LLM's reading of a
  // document someone uploaded — so they are attacker-controlled and must be escaped like
  // any other untrusted string before they reach innerHTML.
  const bits = [h.identifier, h.counterparty].filter(Boolean).map(esc);
  const state = docState(doc);
  if (state === "processing" || state === "pending") {
    bits.push(doc.jobId ? "processing" : "queued");
  } else if (state === "failed") {
    bits.push(esc(doc.error ?? "processing failed"));
  } else if (state === "degraded") {
    bits.push(esc((doc.meta?.stageErrors ?? [])[0] ?? "a stage failed"));
  }
  bits.push(`<span title="${esc(fmtAbsolute(doc.createdAt))}">${esc(fmtRelative(doc.createdAt))}</span>`);
  return bits.join(" · ");
}

function renderList(main, page, f, query) {
  const host = $("#list", main);
  if (!page.items.length) {
    host.innerHTML =
      activeFilterCount(f) === 0
        ? emptyState({
            icon: "document",
            title: "No documents yet",
            body: "Drop in a document and get back a checked, structured record — with the sentence from the page behind every value.",
            actions: `<a class="arag-btn" href="${buildHash("/documents/upload")}">Upload document</a>
              <a class="arag-btn secondary" href="${buildHash("/welcome")}">Start the guided sample</a>`,
          })
        : emptyState({
            icon: "search",
            title: "No documents match these filters",
            body: "Try a wider date range, or a different status.",
            actions:
              '<button class="arag-btn secondary" type="button" id="clear2">Clear all filters</button>',
          });
    $("#clear2", host)?.addEventListener("click", () => navigate("/documents", {}));
    return;
  }
  const [sortKey, sortOrder] = f.sort.split(":");
  const from = (page.page - 1) * page.page_size + 1;
  const to = Math.min(page.page * page.page_size, page.total);

  // The kit's data-table markup contract (docs/ui-kit.md): `.arag-datatable` is the frame,
  // `.scroll` the horizontal scroller, `th[data-sort] > button` the sort control with
  // `aria-sort` on the th, `[data-check-all]`/`[data-check]` the selection, `[data-bulkbar]`
  // with `[data-bulk-count]`, `tr[data-href]` the row target and `[data-page]` the pager.
  host.innerHTML = `
    <div class="arag-datatable" id="docsTable">
      <div class="scroll">
      <table class="arag-table">
        <caption class="sr-only">Documents, ${esc(SORTS.find(([v]) => v === f.sort)?.[1] ?? "")}</caption>
        <thead><tr>
          <th class="check"><input type="checkbox" data-check-all aria-label="Select all documents on this page" /></th>
          ${COLUMNS.map(([key, text]) => {
            if (!key) return `<th>${esc(text)}</th>`;
            const sorted = key === sortKey ? (sortOrder === "asc" ? "ascending" : "descending") : "none";
            return `<th data-sort="${key}" aria-sort="${sorted}"><button type="button">${esc(text)}${icon("chevron-down", { cls: "sortic", size: 14 })}</button></th>`;
          }).join("")}
          <th class="rowactions"><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          ${page.items
            .map((d) => {
              const grounding = d.meta?.groundingScore;
              const href = buildHash(`/documents/${d.id}`);
              return `<tr data-id="${esc(d.id)}" data-href="${href}" aria-selected="${selected.has(d.id)}">
              <td class="check"><input type="checkbox" data-check="${esc(d.id)}" aria-label="Select ${esc(d.filename)}"${selected.has(d.id) ? " checked" : ""} /></td>
              <td>
                <a class="cell-title" href="${href}">${esc(d.filename)}</a>
                <span class="cell-sub">${subline(d)}</span>
              </td>
              <td>${esc(label(d.docType))}</td>
              <td>${statusChip(d)}</td>
              <td class="num">${d.fields?.length ? d.fields.length : '<span class="subtle">—</span>'}</td>
              <td class="num">${typeof grounding === "number" ? esc(pct(grounding)) : '<span class="subtle">—</span>'}</td>
              <td>${issueChip(d)}</td>
              <td class="rowactions"></td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      </div>
      <div class="arag-bulkbar" data-bulkbar${selected.size ? "" : " hidden"}>
        <span class="count" data-bulk-count aria-live="polite">${selected.size} selected</span>
        <button type="button" data-bulk="csv">Export CSV</button>
        <button type="button" data-bulk="json">Export JSON</button>
        <button type="button" data-bulk="xml">Export XML</button>
        <button type="button" class="danger" data-bulk="delete">Delete</button>
        <span class="spacer"></span>
        <button type="button" id="clearSelection">Clear selection</button>
      </div>
      <nav class="arag-pagination" aria-label="Pagination">
        <span class="range">${from}–${to} of ${page.total}</span>
        <span class="spacer"></span>
        <label class="sr-only" for="pageSize">Documents per page</label>
        <select class="arag-select" id="pageSize" style="width:auto">
          ${PAGE_SIZES.map((n) => option(String(n), `${n} per page`, f.page_size)).join("")}
        </select>
        <button type="button" data-page="prev"${page.page <= 1 ? " disabled" : ""}>Previous</button>
        <button type="button" data-page="next"${page.next_page ? "" : " disabled"}>Next</button>
      </nav>
    </div>`;

  // Sorting, selection (with a real indeterminate select-all and a polite count), row
  // activation and paging all come from the kit — delegated, so they survive a re-render.
  wireTable($("#docsTable", host), {
    selected,
    onSort: ({ key, dir }) =>
      navigate("/documents", {
        ...query,
        sort: dir === "none" ? undefined : `${key}:${dir === "ascending" ? "asc" : "desc"}`,
        page: undefined,
      }),
    onPage: (to_) =>
      navigate("/documents", {
        ...query,
        page: String(to_ === "prev" ? page.page - 1 : to_ === "next" ? page.page + 1 : Number(to_)),
      }),
  });

  $("#clearSelection", host)?.addEventListener("click", () => {
    selected.clear();
    for (const cb of $$("[data-check]", host)) cb.checked = false;
    wireTable($("#docsTable", host), { selected }).refresh();
  });

  for (const tr of $$("tr[data-id]", host)) {
    const doc = page.items.find((d) => d.id === tr.dataset.id);
    $(".rowactions", tr).appendChild(rowMenu(doc, main, query));
  }

  // bulk actions
  for (const b of $$("[data-bulk]", host)) {
    b.addEventListener("click", () => runBulk(b.dataset.bulk, page, main, query));
  }

  $("#pageSize", host).addEventListener("change", (e) =>
    navigate("/documents", { ...query, page_size: e.target.value, page: undefined }),
  );
}

function rowMenu(doc, main, query) {
  const state = docState(doc);
  return menuButton(
    () => [
      { label: "Open", onSelect: () => navigate(`/documents/${doc.id}`) },
      { label: "Ask this document", onSelect: () => navigate("/ask", { doc: doc.id }) },
      { label: "Export JSON", onSelect: () => exportOne(doc, "json") },
      { label: "Export XML", onSelect: () => exportOne(doc, "xml") },
      { label: "Export CSV", onSelect: () => exportOne(doc, "csv") },
      {
        label: "Export for SAP Sales Cloud",
        hidden: doc.docType !== "purchase_order" || doc.status !== "ready",
        onSelect: () => exportOne(doc, "sap-c4c"),
      },
      {
        label: "Reprocess",
        hidden: state !== "failed" && state !== "degraded",
        onSelect: () => reprocess(doc, main, query),
      },
      { label: "Delete", danger: true, onSelect: () => deleteOne(doc, main, query) },
    ],
    { ariaLabel: `Actions for ${doc.filename}` },
  );
}

export async function exportOne(doc, format) {
  const res = await fetch(`/api/v1/documents/${doc.id}/export?format=${format}`, {
    credentials: "same-origin",
  });
  if (!res.ok) return toast(`Export failed (${res.status})`, "error");
  const ext = format.startsWith("sap-") ? `${format}.json` : format;
  toast(`Downloaded ${await downloadResponse(res, `${doc.filename}.${ext}`)}`);
}

export async function reprocess(doc, main, query) {
  try {
    await api(`/api/v1/documents/${doc.id}/reprocess`, { method: "POST" });
    toast(`Reprocessing ${doc.filename}`);
    if (main) renderDocuments(main, { query: query ?? {}, stale: () => false });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteOne(doc, main, query) {
  const ok = await confirmDialog({
    title: "Delete document",
    body: `<p>Delete <strong>${esc(doc.filename)}</strong>? This also deletes the resource from the Knowledge Box. This cannot be undone.</p>`,
    confirmLabel: "Delete document",
  });
  if (!ok) return;
  try {
    await api(`/api/v1/documents/${doc.id}`, { method: "DELETE" });
    selected.delete(doc.id);
    toast("Document deleted — record and Knowledge Box resource");
    renderDocuments(main, { query: query ?? {}, stale: () => false });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function runBulk(kind, page, main, query) {
  const ids = [...selected];
  if (!ids.length) return;
  if (kind === "delete") {
    const names = page.items.filter((d) => ids.includes(d.id)).map((d) => d.filename);
    const ok = await confirmDialog({
      title: `Delete ${ids.length} document${ids.length === 1 ? "" : "s"}`,
      body: `<p>This also deletes ${ids.length === 1 ? "the resource" : "their resources"} from the Knowledge Box. This cannot be undone.</p>
        <ul class="">${names
          .slice(0, 5)
          .map((n) => `<li>${esc(n)}</li>`)
          .join("")}</ul>
        ${ids.length > names.slice(0, 5).length ? `<p class="small">…and ${ids.length - Math.min(5, names.length)} more.</p>` : ""}`,
      confirmLabel: `Delete ${ids.length} document${ids.length === 1 ? "" : "s"}`,
    });
    if (!ok) return;
    try {
      const out = await api("/api/v1/documents/bulk-delete", { method: "POST", json: { ids } });
      selected.clear();
      toast(
        out.failed.length
          ? `Deleted ${out.deleted.length}; ${out.failed.length} could not be deleted`
          : `Deleted ${out.deleted.length} documents`,
        out.failed.length ? "error" : "info",
      );
      renderDocuments(main, { query, stale: () => false });
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const res = await fetch("/api/v1/documents/bulk-export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, format: kind }),
  });
  if (!res.ok) return toast(`Export failed (${res.status})`, "error");
  toast(`Downloaded ${await downloadResponse(res, `documents.${kind}`)}`);
}

/** The upload drawer is a route over the list, so Back closes it. */
export async function renderUpload(main, ctx) {
  const query = { ...ctx.query };
  await renderDocuments(main, { query, stale: ctx.stale, keepEmpty: true });
  openUploadDrawer({
    onClose: () => navigate("/documents", query, { replace: true }),
    onUploaded: () => renderDocuments(main, { query, stale: () => false }),
    preselect: ctx.query.config,
  });
}

export { selected as documentSelection };
