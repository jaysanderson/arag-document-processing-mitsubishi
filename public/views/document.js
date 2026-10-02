/**
 * Document detail — the verified-evidence record.
 *
 * This is the screen the product is judged on, so the three signals that arrive with
 * every record are kept apart on purpose: confidence is the model's self-report,
 * verification is our check of the quote against the document's own text, and validation
 * is deterministic arithmetic. Verification outranks confidence everywhere: nothing here
 * gives a confident-but-unverified value a green treatment.
 */

import { highlightJson } from "/ui/arag-ui.js";
import {
  $,
  $$,
  announce,
  api,
  buildHash,
  confirmDialog,
  docState,
  emptyState,
  errorState,
  esc,
  failureAdvice,
  fmtAbsolute,
  fmtBytes,
  fmtMs,
  headline,
  icon,
  jobChip,
  label,
  menuButton,
  navigate,
  onLeave,
  parseHash,
  pct,
  popover,
  skeletonRows,
  sse,
  statusChip,
  toast,
  verifyOf,
  wireSegmented,
  wireTabs,
} from "../lib/core.js";
import { canWrite } from "../lib/session.js";
import { exportOne, reprocess } from "./documents.js";

const TABS = [
  ["", "Record"],
  ["source", "Source & evidence"],
  ["pipeline", "Pipeline"],
  ["ask", "Ask"],
  ["json", "JSON"],
];

/**
 * Compare is not a greyed tab waiting for something to exist: it appears when a generator
 * agent has been provisioned for this document's config, and the place that provisions one
 * is the config, where the schema it needs is defined.
 */
const COMPARE_TAB = ["compare", "Compare"];

/**
 * The SAP hand-off is offered on purchase orders only: a customer's purchase order is the
 * one document that becomes a sales order. It sits before JSON because it is the reason an
 * order desk opened the record, where the raw record is not.
 */
const SAP_TAB = ["sap", "SAP order"];
const withSap = (tabs) => {
  const at = tabs.findIndex(([slug]) => slug === "json");
  return [...tabs.slice(0, at), SAP_TAB, ...tabs.slice(at)];
};

const STAGE_GLOSSARY = [
  [
    "process",
    "Progress Agentic RAG reads the file — OCR, visual layout and embeddings — and waits until it is searchable.",
  ],
  [
    "classify",
    "An agent picks one of the built-in document types. Skipped when a config is forced on upload.",
  ],
  [
    "extract",
    "The type's stored ARAG search configuration runs, forcing the declared fields plus a verbatim quote for each.",
  ],
  ["entities", "People, organisations, dates, amounts and locations."],
  ["summary", "A plain-language summary and topic tags."],
  [
    "validate",
    "Deterministic checks: amounts re-added, dates normalised, required fields confirmed. No model involved.",
  ],
  [
    "standardize",
    "Everything is assembled into the canonical record and each quote is checked against the document's own text.",
  ],
];

const ISSUE_CONSEQUENCE = [
  [/≠ total|does not reconcile|subtotal/i, "Check the printed total against the line items before posting."],
  [
    /required field/i,
    "The schema requires this field. The document may not contain it, or it may be on a page that did not read cleanly.",
  ],
  [/could not parse amount/i, "The value is kept exactly as written and has not been converted to a number."],
  [
    /not iso|left as-is/i,
    "The value is kept as written. Downstream systems expecting ISO dates will need to handle it.",
  ],
  [/stage failed|stage error/i, "This part of the record is missing. Reprocess to try again."],
  [
    /quote|evidence/i,
    "The value is not backed by the document. Check it against the source before using it.",
  ],
];

const consequence = (msg) => ISSUE_CONSEQUENCE.find(([re]) => re.test(msg))?.[1] ?? "";

/**
 * Fields are shown in schema order — a person reads an invoice in the shape of an invoice —
 * with the rest behind a disclosure so a fourteen-field claim form is still scannable. The
 * exception is above: anything unverified is pinned into "Check these first", because trust
 * beats familiarity when the two conflict.
 */
const FIELD_PREVIEW = 10;

let closeStream = null;

export async function renderDocument(main, { params, query, stale }, tab = "") {
  closeStream?.();
  closeStream = null;
  main.innerHTML = `<div class="arag-skeleton" style="width:40%"></div>${'<div class="arag-skeleton"></div>'.repeat(5)}`;
  let doc;
  try {
    doc = await api(`/api/v1/documents/${params.id}`);
  } catch (err) {
    if (stale()) return;
    main.innerHTML =
      err.status === 404
        ? errorState(
            { message: "This document no longer exists. It may have been deleted or purged." },
            {
              retry: `<a class="arag-btn secondary sm" href="${buildHash("/documents")}">Back to documents</a>`,
            },
          )
        : errorState(err);
    return;
  }
  if (stale()) return;

  const h = headline(doc);
  const title = [h.counterparty, h.identifier].filter(Boolean).join(" — ") || doc.filename;
  const generator =
    doc.status === "ready" && doc.meta?.config
      ? await api(`/api/v1/extraction-configs/${encodeURIComponent(doc.meta.config)}/generator`)
          .then((r) => r.agent ?? null)
          .catch(() => null)
      : null;
  const isOrder = doc.docType === "purchase_order" && doc.status === "ready";
  const base = isOrder || tab === "sap" ? withSap(TABS) : TABS;
  const tabs = generator || tab === "compare" ? [...base, COMPARE_TAB] : base;
  main.innerHTML = `
    <header class="arag-pagehead">
      <nav class="arag-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li><a href="${buildHash("/documents")}">Documents</a></li>
          <li aria-current="page" title="${esc(doc.filename)}">${esc(doc.filename)}</li>
        </ol>
      </nav>
      <div class="row">
        <h1>${esc(title)}</h1>
        <div class="actions" id="docActions">
          <button class="arag-btn secondary" type="button" id="exportCsv">${icon("download")} Export CSV</button>
          <a class="arag-btn ghost" href="${buildHash(`/documents/${doc.id}/ask`)}">Ask</a>
        </div>
      </div>
    </header>
    <div class="arag-tabs" role="tablist">
      ${tabs
        .map(([slug, text]) => {
          const href = buildHash(`/documents/${doc.id}${slug ? `/${slug}` : ""}`);
          const on = slug === tab;
          return `<a role="tab" href="${href}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(text)}</a>`;
        })
        .join("")}
    </div>
    <div id="tabPanel" role="tabpanel" tabindex="0"></div>`;

  $("#exportCsv", main).addEventListener("click", () => exportOne(doc, "csv"));
  $("#docActions", main).appendChild(
    menuButton(
      () => [
        { label: "Export JSON", onSelect: () => exportOne(doc, "json") },
        { label: "Export XML", onSelect: () => exportOne(doc, "xml") },
        { label: "Export for SAP Sales Cloud", hidden: !isOrder, onSelect: () => exportOne(doc, "sap-c4c") },
        { label: "Export for SAP S/4HANA", hidden: !isOrder, onSelect: () => exportOne(doc, "sap-s4") },
        { label: "Reprocess", onSelect: () => reprocess(doc, null) },
        { label: "Copy document id", onSelect: () => copy(doc.id, "Document id copied") },
        { label: "Copy job id", hidden: !doc.jobId, onSelect: () => copy(doc.jobId, "Job id copied") },
        { label: "Delete document", danger: true, onSelect: () => remove(doc) },
      ],
      { ariaLabel: `More actions for ${doc.filename}` },
    ),
  );

  const panel = $("#tabPanel", main);
  const refresh = () => renderDocument(main, { params, query, stale: () => false }, tab);
  wireTabs($(".arag-tabs", main), panel);
  if (tab === "source") await renderSource(panel, doc, query);
  else if (tab === "pipeline") await renderPipeline(panel, doc);
  else if (tab === "ask") renderAskTab(panel, doc);
  else if (tab === "json") await renderJson(panel, doc, query);
  else if (tab === "sap") await renderSap(panel, doc, query);
  else if (tab === "compare") await renderCompare(panel, doc, refresh);
  else renderRecord(panel, doc, query, refresh);

  // A document that is still moving should move on screen too — and the stream is closed
  // when the screen is left, not only when this screen renders again.
  if ((doc.status === "pending" || doc.status === "processing") && doc.jobId) {
    onLeave(() => {
      closeStream?.();
      closeStream = null;
    });
    closeStream = sse(`/api/v1/jobs/${doc.jobId}/events`, {
      job: (payload) => {
        const j = payload.job ?? payload;
        if (["succeeded", "failed", "cancelled"].includes(j.status)) {
          closeStream?.();
          closeStream = null;
          renderDocument(main, { params, query, stale: () => false }, tab);
        }
      },
    });
  }
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Copy failed — select the text manually.", "error");
  }
}

async function remove(doc) {
  const ok = await confirmDialog({
    title: "Delete document",
    body: `<p>Delete <strong>${esc(doc.filename)}</strong>? This also deletes the resource from the Knowledge Box. This cannot be undone.</p>`,
    confirmLabel: "Delete document",
  });
  if (!ok) return;
  await api(`/api/v1/documents/${doc.id}`, { method: "DELETE" });
  toast("Document deleted — record and Knowledge Box resource");
  navigate("/documents");
}

// ── record tab ───────────────────────────────────────────────────────────────

/**
 * The trust strip's sentence.
 *
 * A corrected field is **not** excluded from the score. It stays in the denominator and
 * counts in the numerator only when the value a reviewer typed is itself found in the
 * document — which is exactly what the API re-checks when the correction lands. A score
 * that rose because somebody typed over the evidence would be the most dishonest number
 * this product could publish, and one that silently shrank its own denominator would be
 * the second. The corrections are named alongside the ratio instead, so the reader can see
 * both facts at once.
 */
function groundingStrip(doc) {
  const fields = doc.fields ?? [];
  const evidence = doc.evidence ?? [];
  const byField = new Map(evidence.map((e) => [e.field, e]));
  const exact = evidence.filter((e) => e.verified === "exact").length;
  const near = evidence.filter((e) => e.verified === "normalised").length;
  const none = fields.length - exact - near;
  const score = doc.meta?.groundingScore;
  const corrected = doc.meta?.correctedFields ?? new Set((doc.corrections ?? []).map((c) => c.field)).size;
  const correctedNote = corrected ? ` · ${corrected} corrected by a reviewer` : "";

  let band = "strong";
  let scoreHtml = "";
  let claim = "";
  if (!fields.length) {
    band = "empty";
    claim = "No fields were extracted, so there is nothing to check against the document.";
  } else if (!evidence.length) {
    // A missing measurement and a measured zero are different facts. Never show 0%.
    band = "none";
    claim = `No evidence returned. This record's fields are not backed by quotes — treat every value as unchecked.${correctedNote}`;
  } else {
    const verified = fields.filter((f) => {
      const v = byField.get(f.key);
      return v && v.verified !== "unverified";
    }).length;
    const ratio = typeof score === "number" ? score : verified / fields.length;
    band = ratio >= 0.85 ? "strong" : ratio >= 0.5 ? "partial" : "weak";
    claim = `${verified} of ${fields.length} fields carry a verified quote${correctedNote}.`;
    scoreHtml = `<div class="dip-grounding__score">
        <span class="dip-grounding__label">Grounding</span>
        <span class="dip-grounding__pct">${esc(pct(ratio))}</span>
        <span class="arag-progress" role="img" aria-label="Grounding: ${band}, ${claim}"><i style="width:${Math.round(ratio * 100)}%"></i></span>
        <span class="small muted">${esc(label(band))}</span>
      </div>`;
  }

  const durations = Object.values(doc.meta?.durationsMs ?? {}).reduce((a, b) => a + b, 0);
  const issues = (doc.issues ?? []).filter((i) => i.severity !== "info");
  return `<section class="dip-grounding" data-band="${band}">
    ${scoreHtml}
    <div>
      <p class="dip-grounding__claim">${esc(claim)}</p>
      ${
        evidence.length
          ? `<p class="dip-grounding__breakdown">${exact} exact · ${near} near match · ${Math.max(0, none)} no quote</p>`
          : ""
      }
    </div>
    <div class="dip-grounding__facts">
      ${statusChip(doc)}
      <span>${esc(doc.meta?.forced ? (doc.meta.configLabel ?? label(doc.meta.config)) : label(doc.docType))}${
        doc.meta?.forced
          ? ' <span class="subtle" title="Auto-classification was skipped — this config was chosen on upload.">· config forced</span>'
          : doc.docTypeConfidence
            ? ` · ${esc(pct(doc.docTypeConfidence))} classifier`
            : ""
      }</span>
      ${issues.length ? `<span class="arag-chip ${issues.some((i) => i.severity === "error") ? "danger" : "warn"}">${issues.length} ${issues.length === 1 ? "issue" : "issues"}</span>` : ""}
      <span>${esc(fmtMs(durations))}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="dip-help" type="button" id="groundingHelp">${icon("info", { size: 14 })} What is this?</button>
    </div>
  </section>`;
}

function valueHtml(f) {
  if (Array.isArray(f.value)) {
    const shown = f.value.slice(0, 5);
    return `<ul>${shown.map((v) => `<li>${esc(String(v))}</li>`).join("")}</ul>${
      f.value.length > 5 ? `<span class="small muted">+ ${f.value.length - 5} more</span>` : ""
    }`;
  }
  const v = f.value;
  if (v === null || v === undefined || v === "") return '<span class="dip-field__empty">Not found</span>';
  const raw =
    f.raw && String(f.raw) !== String(v)
      ? `<span class="dip-field__raw">raw “${esc(String(f.raw))}”</span>`
      : "";
  return `${esc(String(v))} ${raw}`;
}

const flatValue = (v) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));

/** What the Knowledge Box now holds for a corrected field, stated rather than implied. */
function kvNote(correction) {
  const kv = correction?.kv;
  if (!kv) return "";
  if (!kv.written)
    return `<p class="small dip-field__who"><strong>Not written to the Knowledge Box.</strong>
        ${esc(kv.error ?? "The key-value write did not succeed.")} Filters and searches there still
        see the extracted value.</p>`;
  const stale = kv.filterIndexStale
    ? ` The Knowledge Box's filter index also keeps the value this correction replaced, so a filter
       on “${esc(flatValue(correction.previousValue))}” still matches this document.`
    : "";
  return `<p class="small dip-field__who">The Knowledge Box holds the corrected value, so filters and
      searches see it.${stale} Who corrected it, when and why lives in this product's record and in the
      audit log.</p>`;
}

function correctedMeta(correction) {
  const when = new Date(correction.at).toLocaleString();
  const why = correction.reason ? ` · ${esc(correction.reason)}` : "";
  return `<p class="dip-field__who">Corrected by ${esc(correction.actor)} · ${esc(when)}${why}</p>`;
}

function fieldRow(
  doc,
  f,
  evidence,
  issues,
  { correction = null, editing = false, writer = true, id = null } = {},
) {
  const ev = evidence.get(f.key);
  const v = verifyOf(ev);
  const unverified = !ev || ev.verified === "unverified";
  const conf = typeof f.confidence === "number" ? Math.round(f.confidence * 100) : null;
  const mine = issues.filter((i) => i.field === f.key);
  return `<div class="dip-field${unverified ? " dip-field--unverified" : ""}${
    correction ? " is-corrected" : ""
  }${editing ? " is-editing" : ""}" id="${esc(id ?? `field-${f.key}`)}" tabindex="-1">
    <div class="dip-field__labelrow">
      <div class="dip-field__label">${esc(f.label)}</div>
      <span class="dip-field__actions" data-field-actions="${esc(f.key)}"></span>
    </div>
    <div class="dip-field__value">${valueHtml(f)}</div>
    ${
      correction
        ? `<div class="dip-field__was">was <b>${esc(flatValue(correction.previousValue) || "Not found")}</b> · extracted</div>`
        : ""
    }
    <div class="dip-field__meta">
      ${
        conf === null
          ? ""
          : `<span class="dip-field__conf" title="How sure the model was of this value. It is not a check against the document.">
               <span class="arag-progress" role="img" aria-label="Confidence ${conf} per cent"><i style="width:${conf}%"></i></span> ${conf}%</span>`
      }
      ${correction ? '<span class="arag-chip info">Corrected</span>' : ""}
      <span class="arag-chip ${v.cls}">${esc(v.text)}</span>
    </div>
    ${
      ev
        ? `<details class="dip-field__evidence"><summary>Evidence</summary>
             <blockquote class="dip-quote">“${esc(ev.quote)}”</blockquote>
             ${
               correction
                 ? '<p class="small muted" style="margin:6px 0 0">This quote was found for the corrected value, so the field is still scored for grounding.</p>'
                 : ""
             }
             <a class="dip-field__jump" href="${buildHash(`/documents/${doc.id}/source`, { ev: f.key })}">${icon("external-link", { size: 13 })} Open in source</a>
           </details>`
        : correction
          ? `<p class="small muted" style="margin:6px 0 0">The corrected value is not in this document's
               text, so it carries no quote and it no longer counts towards the grounding score.
               <a class="dip-field__jump" href="${buildHash(`/documents/${doc.id}/source`)}">Open source</a></p>`
          : `<p class="small muted" style="margin:6px 0 0">This value is not backed by a quote from the document. Check it against the source before using it.
             <a class="dip-field__jump" href="${buildHash(`/documents/${doc.id}/source`)}">Open source</a></p>`
    }
    ${correction ? correctedMeta(correction) : ""}
    ${correction ? kvNote(correction) : ""}
    ${editing ? editorHtml(f, ev, writer) : ""}
    ${mine
      .map(
        (i) =>
          `<div class="arag-alert ${i.severity === "error" ? "error" : i.severity === "warning" ? "warn" : ""} dip-field__issue">${esc(i.message)}</div>`,
      )
      .join("")}
  </div>`;
}

const REASONS = [
  "Wrong value read from the page",
  "The value is on a page that did not read cleanly",
  "The document itself is wrong",
  "Other — say why",
];

/**
 * The editor is inline, never a drawer: the quote that supports the current value has to
 * stay on screen beside the value being changed, or the reviewer is guessing.
 */
function editorHtml(f, ev, writer) {
  const current = flatValue(f.value);
  const kind = Array.isArray(f.value)
    ? "list"
    : typeof f.value === "number"
      ? "number"
      : typeof f.value === "boolean"
        ? "boolean"
        : "text";
  const control =
    kind === "boolean"
      ? `<select class="arag-select" id="correctValue"><option value="true"${
          f.value === true ? " selected" : ""
        }>Yes</option><option value="false"${f.value === false ? " selected" : ""}>No</option></select>`
      : `<input class="arag-input${kind === "number" ? "" : ""}" id="correctValue" type="${
          kind === "number" ? "number" : "text"
        }" step="any" value="${esc(current)}" data-kind="${kind}" />`;
  return `<div class="dip-editor" data-editor="${esc(f.key)}">
      <div class="arag-field">
        <label for="correctValue">Correct the value of ${esc(f.label)}</label>
        <div class="dip-editor__value">
          ${control}
          <span class="dip-editor__extracted">${
            ev ? `extracted “${esc(ev.quote)}”` : "no quote was returned for the extracted value"
          }</span>
        </div>
        ${kind === "list" ? '<p class="arag-help">Separate repeated values with commas.</p>' : ""}
      </div>
      <div class="arag-field">
        <label for="correctReason">Why is it changing?</label>
        <select class="arag-select" id="correctReason">
          ${REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}
        </select>
      </div>
      <div class="arag-field" id="otherWrap" hidden>
        <label for="correctOther">Say why</label>
        <input class="arag-input" id="correctOther" maxlength="140" />
      </div>
      <p class="arag-help" id="correctHelp">The extracted value and its quote are kept. The new value is
        re-checked against this document's own text: if it is there it earns a real quote, and if it is
        not, the field loses its quote and the grounding score falls. This correction is recorded
        against your session.</p>
      <div id="correctError"></div>
      <div class="dip-editor__actions">
        <button class="arag-btn ghost" type="button" id="cancelCorrect">Cancel</button>
        <button class="arag-btn" type="button" id="saveCorrect"${writer ? "" : " disabled"}>Save correction</button>
      </div>
    </div>`;
}

function renderRecord(panel, doc, query = {}, refresh = null) {
  const evidence = new Map((doc.evidence ?? []).map((e) => [e.field, e]));
  const issues = doc.issues ?? [];
  const fields = doc.fields ?? [];
  const writer = canWrite();
  // The newest correction per field is the one the row tells the story of; the whole list
  // is the Pipeline tab's Corrections timeline.
  const latest = new Map();
  for (const c of doc.corrections ?? []) latest.set(c.field, c);
  const editKey = typeof query.edit === "string" ? query.edit : "";
  // An unverified field is *also* pinned into "Check these first", so it is rendered twice.
  // The pinned copy takes its own id (`risk-<key>`) — leaving `field-<key>` unique for the
  // issue anchors — and the editor is placed in whichever copy is rendered first, so there is
  // never a second input claiming the same id.
  const placed = new Set();
  const rowOpts = (f, pinned = false) => {
    const editing = editKey === f.key && !placed.has(f.key);
    if (editing) placed.add(f.key);
    return {
      correction: latest.get(f.key) ?? null,
      editing,
      writer,
      id: `${pinned ? "risk" : "field"}-${f.key}`,
    };
  };
  // Schema order, because a person reads an invoice in the shape of an invoice — with one
  // exception: an unverified field is pinned to the top, because trust beats familiarity.
  const risky = fields.filter((f) => {
    const ev = evidence.get(f.key);
    return !ev || ev.verified === "unverified";
  });
  const stageErrors = doc.meta?.stageErrors ?? [];

  panel.innerHTML = `
    ${groundingStrip(doc)}
    ${
      docState(doc) === "failed"
        ? `<div class="arag-alert error arag-prose" role="alert"><strong>Processing failed.</strong> ${esc(doc.error ?? "")}<br />${esc(failureAdvice(doc.error))}
             <div style="margin-top:8px"><button class="arag-btn sm" type="button" id="retryDoc">Reprocess</button></div></div>`
        : ""
    }
    ${
      stageErrors.length
        ? `<div class="arag-alert warn arag-prose"><strong>Degraded.</strong> ${esc(stageErrors.join("; "))}. The extracted fields are unaffected.
             <div style="margin-top:8px"><button class="arag-btn sm secondary" type="button" id="retryDoc2">Reprocess</button></div></div>`
        : ""
    }
    ${issues
      .filter((i) => i.severity !== "info")
      .map(
        (i) => `<div class="arag-alert ${i.severity === "error" ? "error" : "warn"} arag-prose">
            <strong>${esc(label(i.field))}</strong> — ${esc(i.message)}
            ${consequence(i.message) ? `<div class="small" style="margin-top:4px">${esc(consequence(i.message))}</div>` : ""}
            <div style="margin-top:6px"><a href="#field-${esc(i.field)}" data-focus-field="${esc(i.field)}">Go to field ›</a></div>
          </div>`,
      )
      .join("")}

    <div class="arag-split" style="margin-top:16px">
      <section>
        ${
          risky.length && fields.length
            ? `<h2>Check these first (${risky.length})</h2>
               <div class="dip-fields">${risky
                 .map((f) => fieldRow(doc, f, evidence, issues, rowOpts(f, true)))
                 .join("")}</div>`
            : ""
        }
        <h2>Extracted fields (${fields.length})</h2>
        ${
          fields.length
            ? `<div class="dip-fields">${fields
                .slice(0, FIELD_PREVIEW)
                .map((f) => fieldRow(doc, f, evidence, issues, rowOpts(f)))
                .join("")}</div>
               ${
                 fields.length > FIELD_PREVIEW
                   ? `<details id="allFields"><summary class="arag-btn ghost sm" style="display:inline-flex;margin-top:12px">Show all fields (${fields.length - FIELD_PREVIEW} more)</summary>
                        <div class="dip-fields">${fields
                          .slice(FIELD_PREVIEW)
                          .map((f) => fieldRow(doc, f, evidence, issues, rowOpts(f)))
                          .join("")}</div>
                      </details>`
                   : ""
               }`
            : `<div class="arag-empty">No fields were extracted. Nothing matched this schema — try a different extraction config.</div>`
        }
      </section>
      <aside class="arag-stack">
        <div class="arag-card">
          <div class="head"><h3>Summary</h3></div>
          <div class="body">
            ${
              doc.summary
                ? `<p class="arag-prose">${esc(doc.summary)}</p>
                   <div class="arag-chips">${(doc.tags ?? []).map((t) => `<span class="arag-chip neutral">${esc(t)}</span>`).join("")}</div>`
                : `<p class="muted">${stageErrors.some((s) => s.startsWith("summary")) ? "Not produced — the summary stage failed." : "No summary was produced."}</p>`
            }
          </div>
        </div>
        <div class="arag-card">
          <div class="head"><h3>Entities (${(doc.entities ?? []).length})</h3></div>
          <div class="body">
            ${
              (doc.entities ?? []).length
                ? `<div class="arag-chips">${doc.entities
                    .slice(0, 24)
                    .map((e) => `<span class="dip-entity"><b>${esc(e.type)}</b>${esc(e.text)}</span>`)
                    .join("")}</div>`
                : '<p class="muted">No entities surfaced.</p>'
            }
          </div>
        </div>
        <div class="arag-card">
          <div class="head"><h3>How this was produced</h3></div>
          <div class="body">
            <dl class="arag-kv">
              <dt>Config</dt><dd>${esc(doc.meta?.config ?? doc.docType)}${doc.meta?.forced ? " (forced)" : " (auto-detected)"}</dd>
              <dt>Schema</dt><dd class="mono">${esc(doc.meta?.schema ?? "—")}</dd>
              <dt>Model</dt><dd>${esc(doc.meta?.model ?? "—")}</dd>
              <dt>ARAG config</dt><dd class="mono">${esc(doc.meta?.searchConfiguration ?? "—")}</dd>
              <dt>Source</dt><dd>${doc.meta?.sourceChars ? `${doc.meta.sourceChars.toLocaleString()} characters` : "—"} · ${doc.bytes == null ? "—" : esc(fmtBytes(doc.bytes))}</dd>
              <dt>Run</dt><dd>${esc(fmtAbsolute(doc.meta?.processedAt))}</dd>
              <dt>Document id</dt><dd class="mono small">${esc(doc.id)}</dd>
            </dl>
          </div>
        </div>
        <div class="arag-card dip-danger-zone">
          <div class="head"><h3>Danger zone</h3></div>
          <div class="body">
            <p class="muted small">Deleting removes the record and the Knowledge Box resource.</p>
            <button class="arag-btn danger sm" type="button" id="deleteDoc">Delete document</button>
          </div>
        </div>
      </aside>
    </div>`;

  $("#groundingHelp", panel)?.addEventListener("click", (e) => {
    e.currentTarget.id = "groundingHelp";
    popover(
      e.currentTarget,
      `<p>Each extracted value is asked for with the sentence that supports it. We then look for that sentence in the text Progress Agentic RAG read from your document.</p>
       <p><strong>Exact</strong> means we found it character for character; <strong>near match</strong> means we found it after ignoring case, spacing and punctuation; <strong>no quote</strong> means we did not find it, or the model returned none.</p>
       <p>A field a reviewer corrected stays in this count. It earns its place in the numerator only if the value they typed is itself in the document — so a correction can lower this score, and typing over the evidence can never raise it.</p>
       <p>The Knowledge Box holds the corrected value, so filters and searches see it. Who corrected it, when and why lives in this product's record and in the audit log.</p>`,
    );
  });
  wireCorrections(panel, doc, latest, editKey, writer, refresh);
  for (const a of $$("[data-focus-field]", panel)) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const el = document.getElementById(`field-${a.dataset.focusField}`);
      if (!el) return;
      // The field may be inside the "Show all fields" disclosure.
      el.closest("details")?.setAttribute("open", "");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("is-highlighted");
      el.focus();
      setTimeout(() => el.classList.remove("is-highlighted"), 1400);
    });
  }
  $("#deleteDoc", panel)?.addEventListener("click", () => remove(doc));
  for (const id of ["retryDoc", "retryDoc2"]) {
    $(`#${id}`, panel)?.addEventListener("click", () => reprocess(doc, null));
  }
}

// ── correction ───────────────────────────────────────────────────────────────

/**
 * The row menu and the inline editor.
 *
 * `?edit=<fieldKey>` lives in the hash, so Back cancels an edit and a link can open a record
 * with one field ready to correct. The menu is not an always-visible pencil: a persistent
 * edit affordance on every field makes a checked record read as a draft.
 */
function wireCorrections(panel, doc, latest, editKey, writer, refresh) {
  const byKey = new Map((doc.fields ?? []).map((f) => [f.key, f]));
  const evidence = new Map((doc.evidence ?? []).map((e) => [e.field, e]));
  const ready = doc.status === "ready";
  const go = (edit) => {
    const { path, query } = parseHash();
    navigate(path, { ...query, edit }, { replace: false });
  };

  for (const host of $$("[data-field-actions]", panel)) {
    const key = host.dataset.fieldActions;
    const f = byKey.get(key);
    if (!f || host.childElementCount) continue;
    host.appendChild(
      menuButton(
        () => [
          { label: "Copy value", onSelect: () => copy(flatValue(f.value), `${f.label} copied`) },
          {
            label: "Jump to source",
            hidden: !evidence.get(key),
            href: buildHash(`/documents/${doc.id}/source`, { ev: key }),
          },
          {
            label: "Correct this value",
            hidden: !ready,
            onSelect: () =>
              writer
                ? go(key)
                : toast(
                    "Corrections need a credential: an API key, the operator token, or a same-origin session.",
                    "error",
                  ),
          },
          {
            label: "Revert to the extracted value",
            hidden: !latest.has(key),
            onSelect: () => revertField(doc, f, refresh),
          },
        ],
        { ariaLabel: `More actions for ${f.label}` },
      ),
    );
  }

  const editor = $("[data-editor]", panel);
  if (!editor) return;
  const f = byKey.get(editKey);
  const value = $("#correctValue", editor);
  const reason = $("#correctReason", editor);
  const other = $("#correctOther", editor);
  const otherWrap = $("#otherWrap", editor);
  value?.focus();
  value?.select?.();
  reason.addEventListener("change", () => {
    otherWrap.hidden = !reason.value.startsWith("Other");
    if (!otherWrap.hidden) other.focus();
  });
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      go(undefined);
    }
  });
  $("#cancelCorrect", editor).addEventListener("click", () => go(undefined));
  $("#saveCorrect", editor).addEventListener("click", async () => {
    const kind = value.dataset?.kind ?? "boolean";
    let next;
    if (kind === "boolean") next = value.value === "true";
    else if (kind === "number") next = value.value === "" ? null : Number(value.value);
    else if (kind === "list")
      next = value.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else next = value.value;
    const why = reason.value.startsWith("Other") ? other.value.trim() : reason.value;
    if (reason.value.startsWith("Other") && !why) {
      $("#correctError", editor).innerHTML =
        '<div class="arag-alert error" role="alert">Say why, so the record explains itself later.</div>';
      other.focus();
      return;
    }
    const btn = $("#saveCorrect", editor);
    btn.disabled = true;
    btn.textContent = "Saving…";
    editor.setAttribute("aria-busy", "true");
    try {
      const out = await api(`/api/v1/documents/${doc.id}/fields/${encodeURIComponent(editKey)}`, {
        method: "PUT",
        json: { value: next, reason: why },
      });
      toast(`${f.label} corrected`);
      announce(
        out.correction.verified === "unverified"
          ? `${f.label} corrected to ${flatValue(next)}. That value is not in this document, so the field lost its quote and the grounding score fell.`
          : `${f.label} corrected to ${flatValue(next)}. That value was found in this document, so it keeps a verified quote.`,
      );
      // Dropping `?edit=` from the hash is itself the re-render: the router refetches the
      // record, so the row, the trust strip and the Corrections timeline all agree.
      go(undefined);
    } catch (err) {
      editor.removeAttribute("aria-busy");
      btn.disabled = false;
      btn.textContent = "Save correction";
      $("#correctError", editor).innerHTML = `<div class="arag-alert error" role="alert">${esc(err.message)}${
        err.status === 401
          ? " Corrections need a credential: an API key, the operator token, or a same-origin session."
          : ""
      }</div>`;
    }
  });
}

async function revertField(doc, f, refresh) {
  const ok = await confirmDialog({
    title: `Revert ${esc(f.label)}?`,
    body: "<p>The extracted value and its original verification come back, and the grounding score returns to what the pipeline earned. The correction stays in this record's history.</p>",
    confirmLabel: "Revert to the extracted value",
    danger: false,
  });
  if (!ok) return;
  await api(`/api/v1/documents/${doc.id}/fields/${encodeURIComponent(f.key)}`, { method: "DELETE" });
  toast(`${f.label} reverted`);
  announce(`${f.label} reverted to the extracted value.`);
  await refresh?.();
}

// ── source & evidence tab ────────────────────────────────────────────────────

function markUp(text, evidence) {
  // Build the marked HTML in one pass over sorted, non-overlapping spans.
  const spans = evidence
    .filter((e) => typeof e.start === "number" && typeof e.end === "number" && e.end > e.start)
    .sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out += esc(text.slice(cursor, s.start));
    out += `<mark class="dip-hit" id="hit-${esc(s.field)}" tabindex="-1">${esc(text.slice(s.start, s.end))}</mark>`;
    cursor = s.end;
  }
  out += esc(text.slice(cursor));
  return out;
}

const ORDER = { unverified: 0, normalised: 1, exact: 2 };

async function renderSource(panel, doc, query) {
  panel.innerHTML = `<div class="arag-skeleton" style="width:30%"></div>${'<div class="arag-skeleton"></div>'.repeat(8)}`;
  let text = null;
  let textError = null;
  try {
    text = await api(`/api/v1/documents/${doc.id}/text`);
  } catch (err) {
    textError = err;
  }

  const evidence = [...(doc.evidence ?? [])].sort(
    (a, b) => (ORDER[a.verified] ?? 0) - (ORDER[b.verified] ?? 0),
  );
  const fieldLabels = new Map((doc.fields ?? []).map((f) => [f.key, f.label]));
  const missing = (doc.fields ?? []).filter((f) => !evidence.some((e) => e.field === f.key));

  panel.innerHTML = `
    <div class="dip-source">
      <section class="arag-card">
        <div class="head"><h3>Evidence (${evidence.length + missing.length})</h3></div>
        <div class="dip-source__rail" id="rail">
          ${missing
            .map(
              (f) => `<div class="dip-source__item"><strong>${esc(f.label)}</strong>
                <div class="small muted">No quote returned for this field. Nothing to verify.</div></div>`,
            )
            .join("")}
          ${evidence
            .map((e) => {
              const v = verifyOf(e);
              const locatable = typeof e.start === "number";
              return `<button class="dip-source__item" type="button" data-ev="${esc(e.field)}"${locatable ? "" : " disabled"}
                        title="${locatable ? "Show this quote in the source text" : "This quote could not be located in the source text"}">
                  <span class="arag-chip ${v.cls}">${esc(v.text)}</span>
                  <strong style="display:block;margin-top:4px">${esc(fieldLabels.get(e.field) ?? e.field)}</strong>
                  <span class="dip-quote" style="margin:4px 0 0">“${esc(e.quote)}”</span>
                  <span class="small subtle">${locatable ? `characters ${e.start}–${e.end}` : "position not found"}</span>
                </button>`;
            })
            .join("")}
        </div>
        <div class="body small muted">
          Legend: <span class="arag-chip ok">Verified</span> found verbatim ·
          <span class="arag-chip warn">Near match</span> found after ignoring case, spacing and punctuation ·
          <span class="arag-chip danger">Quote not found</span>
        </div>
      </section>
      <section class="arag-card">
        <div class="head">
          <h3>Source text</h3>
          <div class="arag-row">
            <button class="arag-btn ghost sm" type="button" data-view="text" aria-pressed="true">Extracted text</button>
            <button class="arag-btn ghost sm" type="button" data-view="file" aria-pressed="false">Original file</button>
          </div>
        </div>
        <div class="body">
          <div id="viewText">
            ${
              textError
                ? errorState({
                    message:
                      "The source text is no longer available, so the quotes above cannot be located in the document.",
                  })
                : `<pre class="dip-source__text" id="sourceText">${markUp(text.text, doc.evidence ?? [])}</pre>
                   <p class="small muted" style="margin-top:8px">${text.chars.toLocaleString()} characters extracted by Progress Agentic RAG at ingestion. This is the text every extraction stage read.${text.truncated ? " Showing the first part only." : ""}</p>`
            }
          </div>
          <div id="viewFile" hidden></div>
        </div>
      </section>
    </div>`;

  const select = (field) => {
    for (const b of $$("[data-ev]", panel)) b.setAttribute("aria-current", String(b.dataset.ev === field));
    for (const m of $$("mark.dip-hit", panel)) m.classList.remove("is-active");
    const mark = document.getElementById(`hit-${field}`);
    if (!mark) return;
    mark.classList.add("is-active");
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.focus();
  };
  for (const b of $$("[data-ev]", panel)) {
    b.addEventListener("click", () => {
      history.replaceState(null, "", buildHash(`/documents/${doc.id}/source`, { ev: b.dataset.ev }));
      select(b.dataset.ev);
    });
  }
  for (const m of $$("mark.dip-hit", panel)) {
    m.addEventListener("click", () => select(m.id.replace("hit-", "")));
  }
  if (query.ev) setTimeout(() => select(query.ev), 60);

  // The original file is fetched only when asked for: a 20 MB scan should not load
  // because someone opened the evidence tab.
  const views = { text: $("#viewText", panel), file: $("#viewFile", panel) };
  for (const b of $$("[data-view]", panel)) {
    b.addEventListener("click", async () => {
      for (const other of $$("[data-view]", panel)) other.setAttribute("aria-pressed", String(other === b));
      views.text.hidden = b.dataset.view !== "text";
      views.file.hidden = b.dataset.view !== "file";
      if (b.dataset.view === "file" && !views.file.dataset.loaded) {
        views.file.dataset.loaded = "1";
        views.file.innerHTML = '<div class="arag-skeleton" style="height:200px"></div>';
        const url = `/api/v1/documents/${doc.id}/source`;
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) {
          views.file.innerHTML = errorState({
            message: "The original file is no longer available for this document.",
          });
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (doc.contentType.startsWith("image/")) {
          views.file.innerHTML = `<div class="dip-preview"><img src="${objectUrl}" alt="${esc(doc.filename)}" /></div>`;
        } else if (doc.contentType === "application/pdf") {
          // <iframe>, not <embed>: the CSP sets object-src 'none' and allows frame-src blob:
          views.file.innerHTML = `<div class="dip-preview"><iframe src="${objectUrl}#toolbar=0" title="${esc(doc.filename)}"></iframe></div>`;
        } else {
          views.file.innerHTML = `<pre class="dip-source__text">${esc((await blob.text()).slice(0, 20000))}</pre>`;
        }
      }
    });
  }
}

// ── pipeline tab ─────────────────────────────────────────────────────────────

async function renderPipeline(panel, doc) {
  const durations = doc.meta?.durationsMs ?? {};
  const stageErrors = doc.meta?.stageErrors ?? [];
  const errorFor = (stage) => stageErrors.find((e) => e.startsWith(`${stage}:`));
  const max = Math.max(1, ...Object.values(durations));
  const job = doc.jobId ? await api(`/api/v1/jobs/${doc.jobId}`).catch(() => null) : null;
  const messages = new Map();
  for (const e of job?.events ?? []) if (e.message) messages.set(e.stage, e.message);
  const total = Object.values(durations).reduce((a, b) => a + b, 0);

  panel.innerHTML = `
    ${
      stageErrors.length
        ? `<div class="arag-alert warn arag-prose"><strong>Degraded</strong> — ${esc(stageErrors.join("; "))}. The rest of the record is complete.
             <div style="margin-top:8px"><button class="arag-btn sm secondary" type="button" id="rerun">Reprocess</button></div></div>`
        : ""
    }
    <table class="arag-table">
      <thead><tr><th>Stage</th><th>Duration</th><th>Status</th></tr></thead>
      <tbody>
        ${STAGE_GLOSSARY.map(([stage]) => {
          const ms = durations[stage];
          const failed = errorFor(stage);
          const width = ms ? Math.max(2, Math.round((ms / max) * 100)) : 0;
          return `<tr>
            <td><strong>${esc(stage)}</strong>${messages.get(stage) ? ` <span class="subtle small">${esc(messages.get(stage))}</span>` : ""}</td>
            <td style="width:240px"><span class="dip-stagecell">
              <span class="dip-timeline__bar"><i style="width:${width}%;${failed ? "background:var(--arag-danger-fg)" : ""}"></i></span>
              <span class="dip-timeline__ms">${ms === undefined ? "—" : esc(fmtMs(ms))}</span>
            </span></td>
            <td>${failed ? '<span class="arag-chip danger">Failed</span>' : ms === undefined ? '<span class="arag-chip neutral">Not run</span>' : '<span class="arag-chip ok">Done</span>'}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <p class="muted small" style="margin-top:12px">
      Total ${esc(fmtMs(total))}${job ? ` · Job <span class="mono">${esc(job.id)}</span> ${jobChip(job.status)} · Started ${esc(fmtAbsolute(job.createdAt))}` : " · the job for this document is no longer stored"}
      ${job ? ` · <a href="${buildHash("/jobs", { q: job.id })}">Open in Jobs</a>` : ""}
    </p>
    ${correctionsHtml(doc)}
    <details class="arag-card pad" style="margin-top:16px" id="glossary">
      <summary><strong>What each stage does</strong></summary>
      <dl class="arag-kv" style="margin-top:12px">
        ${STAGE_GLOSSARY.map(([s, d]) => `<dt>${esc(s)}</dt><dd>${esc(d)}</dd>`).join("")}
      </dl>
    </details>`;
  $("#rerun", panel)?.addEventListener("click", () => reprocess(doc, null));
  const glossary = $("#glossary", panel);
  if (localStorage.getItem("dip.glossarySeen") !== "1") glossary.open = true;
  glossary.addEventListener("toggle", () => {
    try {
      localStorage.setItem("dip.glossarySeen", "1");
    } catch {
      /* private window — the disclosure simply opens again next time */
    }
  });
}

/**
 * The record's own review history, next to the record's own timeline. Newest last, so it
 * reads in the order it happened — the stage table above does the same.
 */
function correctionsHtml(doc) {
  const items = doc.corrections ?? [];
  if (!items.length) return "";
  return `<section class="arag-card" style="margin-top:16px" aria-labelledby="correctionsHead">
      <div class="head"><h3 id="correctionsHead">Corrections (${items.length})</h3></div>
      <div class="body">
        <ol class="arag-timeline">
          ${items
            .map((c) => {
              const v = verifyOf({ verified: c.verified });
              return `<li class="${c.verified === "unverified" ? "" : "ok"}"><span class="dot"></span>
                <div>
                  <strong>${esc(c.label)}</strong>
                  <div class="small">${esc(flatValue(c.previousValue) || "Not found")} →
                    <b>${esc(flatValue(c.value) || "Not found")}</b>
                    <span class="arag-chip ${v.cls}">${esc(v.text)}</span></div>
                  <div class="small muted">${esc(c.actor)} · ${esc(fmtAbsolute(c.at))}${
                    c.reason ? ` · ${esc(c.reason)}` : ""
                  }</div>
                  ${
                    c.kv
                      ? `<div class="small muted">${
                          c.kv.written
                            ? `Written to the Knowledge Box${c.kv.filterIndexStale ? "; its filter index still also matches the superseded value" : ""}.`
                            : `Not written to the Knowledge Box — ${esc(c.kv.error ?? "the write did not succeed")}.`
                        }</div>`
                      : ""
                  }
                </div></li>`;
            })
            .join("")}
        </ol>
        <p class="muted small" style="margin-top:12px">Every correction is also in the operator's audit
          log as <span class="mono">document.field.correct</span>, with the actor, the field and the
          before → after values.</p>
      </div>
    </section>`;
}

// ── compare: this product's pipeline against the generator agent ─────────────

const AGREEMENT = {
  agree: ["Agreed", "ok"],
  differ: ["Differs", "warn"],
  "pipeline-only": ["Pipeline only", "neutral"],
  "generator-only": ["Agent only", "info"],
  neither: ["Neither", "neutral"],
};

/**
 * Two ways of getting the same values out of the same document, side by side — and the
 * asymmetry between them rendered rather than smoothed over. The pipeline's column carries a
 * verification badge because every value came with a quote that was checked against the
 * document's own text. The agent's column carries none, because it returns none: there is
 * nothing to check, and a badge here would imply a parity that does not exist.
 */
async function renderCompare(panel, doc, refresh) {
  panel.innerHTML = skeletonRows(6);
  let c;
  try {
    c = await api(`/api/v1/documents/${doc.id}/generator-comparison`);
  } catch (err) {
    panel.innerHTML = errorState(err);
    return;
  }
  const s = c.summary ?? {};
  const tile = (labelText, value, sub) =>
    `<div><div class="label">${esc(labelText)}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`;

  panel.innerHTML = `
    <div class="arag-statstrip">
      ${tile("Agreed", s.agree ?? 0, "same value both ways")}
      ${tile("Differs", s.differ ?? 0, "needs a person")}
      ${tile("Pipeline only", s["pipeline-only"] ?? 0, "the agent has no value")}
      ${tile("Agent only", s["generator-only"] ?? 0, "the pipeline has no value")}
    </div>
    ${
      c.agent
        ? ""
        : `<div class="arag-alert" style="margin-top:16px">
             <strong>No generator agent is provisioned for this config.</strong>
             The comparison below is the pipeline's own record with an empty column beside it.
             <div style="margin-top:8px"><a class="arag-btn sm secondary" href="${buildHash(
               `/configs/${doc.meta?.config ?? ""}`,
             )}">Provision one on the config</a></div>
           </div>`
    }
    ${
      c.agent && !c.generatorHasWritten
        ? `<div class="arag-alert warn" style="margin-top:16px">
             <strong>The agent has not written anything to this resource yet.</strong>
             Its schema is <span class="mono">${esc(c.generatorKvSchemaId ?? "—")}</span> and it is
             ${esc(c.agent.state)}; until it writes, every row below reads “pipeline only”.
             <div style="margin-top:8px"><button class="arag-btn sm" type="button" id="runAgent">Run the agent on this document</button></div>
           </div>`
        : ""
    }
    <div class="arag-alert" style="margin-top:16px">
      <strong>These two columns are not the same kind of claim.</strong>
      <div class="small" style="margin-top:6px"><strong>Pipeline —</strong> ${esc(c.evidenceContract?.pipeline ?? "")}</div>
      <div class="small" style="margin-top:4px"><strong>Generator agent —</strong> ${esc(c.evidenceContract?.generator ?? "")}</div>
    </div>
    <div class="arag-datatable" style="margin-top:16px"><div class="scroll">
      <table class="arag-table">
        <thead><tr>
          <th>Field</th><th>This product's pipeline</th><th>Generator agent</th><th>Agreement</th>
        </tr></thead>
        <tbody>${(c.fields ?? [])
          .map((f) => {
            const [text, cls] = AGREEMENT[f.agreement] ?? [f.agreement, "neutral"];
            const v = f.pipeline?.evidence ? verifyOf(f.pipeline.evidence) : null;
            return `<tr>
              <td><span class="cell-title">${esc(f.label ?? f.field)}</span>
                  <span class="cell-sub mono">${esc(f.field)}</span></td>
              <td>${
                f.pipeline?.present
                  ? `${esc(flatValue(f.pipeline.value))}
                     ${v ? `<span class="arag-chip ${v.cls}">${esc(v.text)}</span>` : ""}`
                  : '<span class="dip-field__empty">Not extracted</span>'
              }</td>
              <td>${
                f.generator?.present
                  ? `${esc(flatValue(f.generator.value))}
                     <span class="cell-sub">no quote — nothing to verify against</span>`
                  : '<span class="dip-field__empty">Not written</span>'
              }</td>
              <td><span class="arag-chip ${cls}">${esc(text)}</span></td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div></div>
    ${
      c.observed && c.observed.endToEndLatency === false
        ? `<div class="arag-alert warn" style="margin-top:16px">
             <strong>How long the agent takes has not been observed.</strong>
             <div class="small" style="margin-top:6px">${esc(c.observed.note ?? "")}</div>
           </div>`
        : ""
    }
    <p class="muted small" style="margin-top:12px">Schemas: pipeline
      <span class="mono">${esc(c.kvSchemaId ?? "—")}</span>, agent
      <span class="mono">${esc(c.generatorKvSchemaId ?? "—")}</span>. They are separate, so the two paths
      never overwrite each other's values.</p>`;

  $("#runAgent", panel)?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api(`/api/v1/documents/${doc.id}/generator-run`, { method: "POST", json: {} });
      toast("The agent was asked to run on this document");
      announce("The generator agent was started for this document. Values appear when it writes them.");
      await refresh?.();
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ── ask tab ──────────────────────────────────────────────────────────────────

const SUGGESTIONS = {
  invoice: [
    "What is the total due and when?",
    "Who issued this invoice?",
    "What tax was charged?",
    "What was purchased?",
  ],
  purchase_order: [
    "What is the PO number?",
    "Who is the supplier?",
    "What was ordered?",
    "What is the delivery date?",
  ],
  contract: [
    "What is the termination notice period?",
    "Who are the parties?",
    "What is the governing law?",
    "What is the total value?",
  ],
  medical_claim: [
    "What is the claim number?",
    "What is the amount claimed?",
    "Which member is this for?",
    "What was the date of service?",
  ],
  preauthorisation: [
    "What length of stay was approved?",
    "What is the authorisation number?",
    "What is the co-payment?",
    "Which procedure was requested?",
  ],
  bank_statement: [
    "What is the closing balance?",
    "What period does this cover?",
    "What were the largest transactions?",
    "Whose account is this?",
  ],
  receipt: ["What was the total?", "Where was this bought?", "When was it bought?", "How was it paid for?"],
  resume: [
    "What is this candidate's most recent role?",
    "What skills are listed?",
    "How can they be contacted?",
    "How many years of experience?",
  ],
};
const DEFAULT_SUGGESTIONS = [
  "What is this document about?",
  "What dates does it mention?",
  "What amounts does it mention?",
  "Who is it from?",
];

export function renderAskPanel(panel, doc) {
  const suggestions = SUGGESTIONS[doc.docType] ?? DEFAULT_SUGGESTIONS;
  panel.innerHTML = `
    <p class="muted arag-prose">Answers come from this document only. Nothing is remembered between visits — this conversation is not saved.</p>
    <div class="dip-suggestions">
      ${suggestions.map((s) => `<button class="arag-btn ghost sm" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}
    </div>
    <div class="arag-chat" id="answers"></div>
    <div class="arag-row" style="margin-top:12px">
      <label class="sr-only" for="askInput">Ask a question about this document</label>
      <input class="arag-input" id="askInput" placeholder="Ask a question about this document…" style="flex:1" />
      <button class="arag-btn" type="button" id="askBtn">Ask</button>
    </div>
    <p class="arag-help">Answers are drawn from this document, not from the model's general knowledge. If it is not in the document, you will be told so.</p>`;

  const box = $("#answers", panel);
  const input = $("#askInput", panel);
  async function ask(question) {
    const q = (question ?? input.value).trim();
    if (!q) return;
    input.value = "";
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="arag-bubble user">${esc(q)}</div><div class="arag-bubble assistant" id="pending">Thinking…</div>`,
    );
    box.lastElementChild.scrollIntoView({ block: "nearest" });
    try {
      const r = await api(`/api/v1/documents/${doc.id}/ask`, { method: "POST", json: { question: q } });
      const cites = (r.citations ?? []).slice(0, 3);
      $("#pending", panel).outerHTML = `<div class="arag-bubble assistant">${esc(r.answer || "(no answer)")}
        <div class="arag-row small" style="margin-top:8px">
          ${
            cites.length
              ? cites
                  .map(
                    (c) =>
                      `<a class="arag-cite" href="${buildHash(`/documents/${doc.id}/source`)}" title="${esc(c.text)}">${icon("quote", { size: 12 })} Open in source</a>`,
                  )
                  .join("")
              : '<span class="subtle">No source returned</span>'
          }
          <span class="subtle">${r.ms} ms</span>
        </div></div>`;
    } catch (err) {
      $("#pending", panel).outerHTML =
        `<div class="arag-alert error" role="alert">That question could not be answered. ${esc(err.message)}</div>`;
      input.value = q;
    }
  }
  $("#askBtn", panel).addEventListener("click", () => ask());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ask();
  });
  for (const b of $$("[data-suggest]", panel)) b.addEventListener("click", () => ask(b.dataset.suggest));
  input.focus();
}

function renderAskTab(panel, doc) {
  if (doc.status !== "ready") {
    panel.innerHTML = `<div class="arag-alert warn">This document is ${esc(docState(doc))}. Ask becomes available once it is ready.</div>`;
    return;
  }
  renderAskPanel(panel, doc);
}

// ── JSON / key-value tab ─────────────────────────────────────────────────────

/**
 * Two views of the same record: the canonical JSON this API returns, and the typed
 * key-value fields that were written into the Knowledge Box itself.
 *
 * The second one is the pass's headline capability and the one that has to be honest: a
 * value the Knowledge Box does not have is exactly what a reader needs to know, so skipped
 * and rejected fields are shown as prominently as written ones, and the filter-index trap —
 * the Knowledge Box keeps every value ever written to a field — is stated rather than
 * buried.
 */
function renderJson(panel, doc, query) {
  const view = query.view === "kv" ? "kv" : "record";
  panel.innerHTML = `
    <div class="dip-scope">
      <div class="arag-segmented" id="jsonView" aria-label="What to show">
        <button type="button" data-value="record" aria-selected="${view === "record"}">Record</button>
        <button type="button" data-value="kv" aria-selected="${view === "kv"}">Key-value fields</button>
      </div>
    </div>
    <div id="jsonPane"></div>`;
  wireSegmented($("#jsonView", panel), (value) => {
    if (value === view) return;
    const { path, query: q } = parseHash();
    navigate(path, { ...q, view: value === "kv" ? "kv" : undefined });
  });
  const pane = $("#jsonPane", panel);
  if (view === "kv") return renderKeyValues(pane, doc);
  pane.innerHTML = `<p class="muted arag-prose">The canonical record exactly as
      <span class="mono">GET /api/v1/documents/${esc(doc.id)}</span> returns it.</p>
    <arag-json id="recJson"></arag-json>`;
  $("#recJson", pane).data = doc;
}

// ── SAP order ────────────────────────────────────────────────────────────────

const SAP_TARGETS = [
  ["sap-c4c", "SAP Sales Cloud"],
  ["sap-s4", "SAP S/4HANA"],
];

/** Friendly names for the values the payload does not carry. */
const SAP_CARRIED = {
  orderDate: "Order date",
  requestedDeliveryDate: "Requested delivery",
  quoteReference: "Quote reference",
  jobReference: "Job reference",
  orderedBy: "Ordered by",
  shipTo: "Ship to",
  deliveryInstructions: "Delivery instructions",
  currency: "Currency",
  total: "Total",
};

/**
 * The record as an SAP sales-order request body — and, first, whether it is fit to post.
 *
 * The readiness report leads because that is the decision the screen exists for: an order
 * with no account number is not an order SAP can take, and saying so here is cheaper than
 * finding out from a failed post. Every payload field then names the record field it came
 * from and carries that value's verification, so the trust the record earned travels with it.
 */
async function renderSap(panel, doc, query) {
  const target = SAP_TARGETS.some(([id]) => id === query.target) ? query.target : "sap-c4c";
  panel.innerHTML = skeletonRows(4);
  let out;
  try {
    out = await api(`/api/v1/documents/${doc.id}/export?format=${target}`);
  } catch (err) {
    panel.innerHTML = errorState(err);
    return;
  }
  const labelOf = new Map((doc.fields ?? []).map((f) => [f.key, f.label]));
  const carried = Object.entries(out.notInPayload ?? {});
  const lines = out.lines ?? [];
  const itemKey = target === "sap-c4c" ? "ProductID" : "Material";
  const qtyKey = target === "sap-c4c" ? "Quantity" : "RequestedQuantity";

  panel.innerHTML = `
    <div class="dip-scope">
      <div class="arag-segmented" id="sapTarget" aria-label="SAP system">
        ${SAP_TARGETS.map(
          ([id, text]) =>
            `<button type="button" data-value="${id}" aria-selected="${id === target}">${esc(text)}</button>`,
        ).join("")}
      </div>
      <button class="arag-btn secondary sm" type="button" id="sapDownload">${icon("download")} Download payload</button>
    </div>

    <div class="arag-alert ${out.ready ? "ok" : "warn"}" id="sapReady" role="status" style="margin-bottom:16px">
      <strong>${
        out.ready
          ? "Ready to post."
          : `${out.blockers.length} thing${out.blockers.length === 1 ? "" : "s"} to resolve before this can be posted.`
      }</strong>
      ${out.ready ? `Every line has a part number and a quantity, and the order names its account.` : ""}
      ${out.blockers.length ? `<ul>${out.blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    </div>
    ${
      out.warnings.length
        ? `<details class="arag-prose" style="margin-bottom:16px" ${out.ready ? "" : "open"}>
             <summary>${out.warnings.length} thing${out.warnings.length === 1 ? "" : "s"} worth a look</summary>
             <ul>${out.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
           </details>`
        : ""
    }

    <h2>Order header</h2>
    <div class="arag-datatable"><div class="scroll">
      <table class="arag-table" id="sapMapping">
        <thead><tr><th>SAP field</th><th>Value</th><th>Read from</th><th>Evidence</th></tr></thead>
        <tbody>${
          out.mapping.length
            ? out.mapping
                .map(
                  (m) => `<tr>
                    <td class="mono small">${esc(m.sapField)}</td>
                    <td>${esc(m.value)}</td>
                    <td><span class="cell-title">${esc(labelOf.get(m.from) ?? m.from)}</span>
                        <span class="cell-sub mono">${esc(m.from)}</span></td>
                    <td>${m.verified ? verifyChip(m.verified) : '<span class="muted small">No quote</span>'}</td>
                  </tr>`,
                )
                .join("")
            : `<tr><td colspan="4" class="muted">Nothing on this record maps to the order header.</td></tr>`
        }</tbody>
      </table></div></div>

    <h2 style="margin-top:20px">Order lines (${lines.length})</h2>
    <div class="arag-datatable"><div class="scroll">
      <table class="arag-table" id="sapLines">
        <thead><tr><th class="num">#</th><th>${itemKey}</th><th class="num">${qtyKey}</th><th>Description</th><th>As written on the order</th></tr></thead>
        <tbody>${
          lines.length
            ? lines
                .map(
                  (l) => `<tr>
                    <td class="num">${l.line}</td>
                    <td class="mono">${l.productId ? esc(l.productId) : '<span class="arag-chip danger">Missing</span>'}</td>
                    <td class="num">${l.quantity === null ? '<span class="arag-chip danger">Missing</span>' : esc(String(l.quantity))}</td>
                    <td class="small">${esc(l.description ?? "—")}</td>
                    <td class="mono small muted">${esc(l.asWritten)}</td>
                  </tr>`,
                )
                .join("")
            : `<tr><td colspan="5" class="muted">No order lines were read.</td></tr>`
        }</tbody>
      </table></div></div>

    ${
      carried.length
        ? `<h2 style="margin-top:20px">Read from the order, not in this payload</h2>
           <p class="muted small">Where these belong depends on how the SAP tenant is set up — a text,
             a partner, a pricing element — so they travel beside the payload instead of being dropped.</p>
           <dl class="arag-kv" id="sapCarried">${carried
             .map(([k, v]) => `<dt>${esc(SAP_CARRIED[k] ?? k)}</dt><dd>${esc(v)}</dd>`)
             .join("")}</dl>`
        : ""
    }

    <h2 style="margin-top:20px">Request body</h2>
    <p class="muted arag-prose"><span class="mono">${esc(out.target.method)} ${esc(out.target.path)}</span>
      on ${esc(out.target.system)}. This product builds the request; it does not send it.</p>
    <pre class="arag-json" id="sapJson">${highlightJson(out.payload)}</pre>`;

  $("#sapDownload", panel).addEventListener("click", () => exportOne(doc, target));
  wireSegmented($("#sapTarget", panel), (value) => {
    if (value === target) return;
    const { path, query: q } = parseHash();
    navigate(path, { ...q, target: value === "sap-c4c" ? undefined : value });
  });
}

/** The verification chip the record view uses, for a value outside a field row. */
function verifyChip(verified) {
  const v = verifyOf({ verified });
  return `<span class="arag-chip ${v.cls}">${esc(v.text)}</span>`;
}

const kvValueHtml = (v) =>
  v === null || v === undefined
    ? '<span class="dip-field__empty">Not written</span>'
    : Array.isArray(v)
      ? `<ul>${v.map((x) => `<li>${esc(String(x))}</li>`).join("")}</ul>`
      : esc(String(v));

async function renderKeyValues(pane, doc) {
  const kv = doc.meta?.kv;
  if (!kv) {
    pane.innerHTML = `${emptyState({
      icon: "layers",
      title: "Nothing was written to the Knowledge Box for this record",
      body: "A config provisions a matching key-value schema, and the verified record is written to it after extraction. This record has no schema behind it — either the config was never provisioned, or it was processed before the schema existed.",
      actions: `<a class="arag-btn secondary" href="${buildHash(`/configs/${doc.meta?.config ?? ""}`)}">Open the config</a>`,
    })}`;
    return;
  }
  // The config supplies the declared kv type for each property; without it the values are
  // still shown, just without their type column.
  const cfg = doc.meta?.config
    ? await api(`/api/v1/extraction-configs/${encodeURIComponent(doc.meta.config)}`).catch(() => null)
    : null;
  const typeOf = new Map((cfg?.fields ?? []).map((f) => [f.key, f.kvType ?? f.type]));
  const labelOf = new Map((doc.fields ?? []).map((f) => [f.key, f.label]));
  const keys = Object.entries(kv.keys ?? {});
  const skipped = kv.skipped ?? [];
  const rejected = kv.rejected ?? [];
  const superseded = kv.superseded ?? [];

  pane.innerHTML = `
    <p class="muted arag-prose">The typed values this record wrote into the Knowledge Box. They live on
      the resource itself, so a search or a catalogue filter can match them — this product's store is not
      the only place they exist.</p>
    <div class="arag-card" style="margin-bottom:16px">
      <div class="head"><h3>Schema</h3>
        ${
          kv.written
            ? '<span class="arag-chip ok">Written</span>'
            : '<span class="arag-chip danger">Not written</span>'
        }
      </div>
      <div class="body">
        <dl class="arag-kv">
          <dt>Key-value schema</dt><dd class="mono">${esc(kv.schemaId ?? "—")}</dd>
          <dt>Fields written</dt><dd>${kv.fields ?? 0}${skipped.length ? ` · ${skipped.length} skipped` : ""}${
            rejected.length ? ` · ${rejected.length} rejected` : ""
          }</dd>
          <dt>Writes</dt><dd>${kv.writes ?? 0}</dd>
          <dt>Last written</dt><dd>${esc(fmtAbsolute(kv.at))}</dd>
        </dl>
        ${kv.error ? `<div class="arag-alert error" style="margin-top:12px">${esc(kv.error)}</div>` : ""}
      </div>
    </div>
    ${
      kv.filterIndexStale
        ? `<div class="arag-alert warn" style="margin-bottom:16px">
             <strong>The Knowledge Box's filter index also matches earlier values.</strong>
             A key-value field keeps every value ever written to it for filtering, so this document still
             matches a filter on ${superseded
               .map((sv) => `<span class="mono">${esc(sv.field)} = ${esc(String(sv.value))}</span>`)
               .join(", ")} even though the current value is different. A search over the values
             themselves is unaffected.
           </div>`
        : ""
    }
    <h2>Written values (${keys.length})</h2>
    <div class="arag-datatable"><div class="scroll">
      <table class="arag-table">
        <thead><tr><th>Field</th><th>Knowledge Box key</th><th>Type</th><th>Value written</th></tr></thead>
        <tbody>${keys
          .map(
            ([prop, kvKey]) => `<tr>
              <td><span class="cell-title">${esc(labelOf.get(prop) ?? prop)}</span>
                  <span class="cell-sub mono">${esc(prop)}</span></td>
              <td class="mono small">${esc(kvKey)}</td>
              <td class="small">${esc(typeOf.get(prop) ?? "—")}</td>
              <td>${kvValueHtml(kv.values?.[kvKey])}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table></div></div>
    ${
      skipped.length
        ? `<h2 style="margin-top:20px">Not written (${skipped.length})</h2>
           <div class="arag-datatable"><div class="scroll"><table class="arag-table">
             <thead><tr><th>Field</th><th>Why the Knowledge Box does not have it</th></tr></thead>
             <tbody>${skipped
               .map(
                 (sk) => `<tr><td><span class="cell-title">${esc(labelOf.get(sk.field) ?? sk.field)}</span>
                     <span class="cell-sub mono">${esc(sk.field)}</span></td>
                   <td class="small">${esc(sk.reason)}</td></tr>`,
               )
               .join("")}</tbody>
           </table></div></div>`
        : ""
    }
    ${
      rejected.length
        ? `<h2 style="margin-top:20px">Rejected by the Knowledge Box (${rejected.length})</h2>
           <p class="muted small">A key-value write is validated against the schema, so a value of the
             wrong type is refused rather than silently coerced. The record keeps the value as extracted;
             the Knowledge Box does not have it.</p>
           <div class="arag-datatable"><div class="scroll"><table class="arag-table">
             <thead><tr><th>Field</th><th>Reason</th><th>Expected</th><th>Got</th></tr></thead>
             <tbody>${rejected
               .map(
                 (r) => `<tr><td><span class="cell-title">${esc(labelOf.get(r.field) ?? r.field)}</span>
                     <span class="cell-sub mono">${esc(r.kind ?? "")}</span></td>
                   <td class="small">${esc(r.message ?? "")}</td>
                   <td class="mono small">${esc(String(r.expected ?? "—"))}</td>
                   <td class="mono small">${esc(String(r.got ?? "—"))}</td></tr>`,
               )
               .join("")}</tbody>
           </table></div></div>`
        : ""
    }
    <p class="muted small" style="margin-top:16px">The schema this record was written against is on the
      config: <a href="${buildHash(`/configs/${doc.meta?.config ?? ""}`)}">${esc(doc.meta?.config ?? "—")} ›</a></p>`;
}
