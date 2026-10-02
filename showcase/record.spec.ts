/**
 * Playwright walkthrough that records the Document Processing showcase (video + numbered
 * screenshots) against the mock ARAG. Run: `make showcase`.
 *
 * Follows showcase/SCRIPT.md beat by beat; screenshot names match showcase/STORYBOARD.md.
 * Selectors are the ones exercised (and kept working) by test/e2e/app.spec.ts and
 * test/e2e/admin.spec.ts — nothing here is a new, unverified selector.
 *
 * The click path follows design/PRODUCT-EXPERIENCE.md §6.3, with one deliberate change: the
 * guided sample (`#startSample`) posts a clean bundled sample (purchase order No. 1706), which
 * has nothing for the validation surfaces to show. So the tour is still run for its own sake —
 * it is a real, on-screen product feature worth recording — but the record the walkthrough
 * actually inspects is `showcase/fixtures/invoice-review.txt`, uploaded afterwards through
 * the upload drawer. That fixture's subtotal and tax deliberately do not reconcile with the
 * printed total, so the trust strip, the field evidence and the source highlight all have a
 * real validation issue to carry, not an empty one.
 *
 * The mock ARAG resolves the whole pipeline in well under a second (no simulated latency),
 * so a still screenshot cannot show a genuine mid-stage "processing" frame distinct from
 * "ready" — the video captures the real transition; the stills are taken once each screen
 * has settled.
 */
import { expect, test } from "@playwright/test";

// Chromium's full-page screenshot composites `position: sticky` elements oddly once the
// page is taller than one viewport: the band can be drawn twice and the sidebar's contents
// can vanish. Make both static for the instant of the capture — the sidebar column keeps
// its painted background either way, so the still looks exactly like the live screen. The
// video (not a stitched screenshot) is unaffected.
const PIN_STICKY =
  ".arag-appband{position:static!important}" + ".arag-rail{position:static!important;height:auto!important}";

async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
  const tag = await page.addStyleTag({ content: PIN_STICKY });
  await page.screenshot({ path: `showcase/out/${name}.png`, fullPage: true });
  await tag.evaluate((el) => (el as HTMLElement).remove());
}
/**
 * The beat clock.
 *
 * `showcase/SCRIPT.md` is the timeline: each `### mm:ss–mm:ss` section is a beat with a
 * narrated duration. The recording used to hurry through all of them in about 17 seconds
 * against a three-minute script, so the video and the narration could not be laid over each
 * other. Each beat now holds the screen until its scripted end time, which makes the video's
 * length the script's length rather than however long Playwright happened to take.
 *
 * Holding to an absolute end time rather than sleeping a fixed amount per beat is what keeps
 * it aligned: a beat that spends three seconds waiting for the mock pipeline simply has three
 * seconds less to hold, and the next beat still starts where the script says it does. If a
 * beat overruns — a slow machine, a new assertion — it logs by how much instead of silently
 * dragging everything after it out of sync.
 *
 * `SHOWCASE_PACE` scales the whole timeline (0.25 for a quick check, 1 to record for real).
 */
const PACE = Number(process.env.SHOWCASE_PACE ?? 1);

/** Scripted cumulative end time of each beat, in seconds. Keep in step with SCRIPT.md. */
const BEATS = {
  "01-welcome": 10,
  "02-tour": 21,
  "03-upload-drawer": 31,
  "04-fixture-ready": 42,
  "05-record": 56,
  "06-evidence-quote": 69,
  "07-source-highlight": 82,
  "08-keyvalues": 96,
  "09-pipeline": 106,
  "10-export": 113,
  "11-ask": 125,
  "12-config-builder": 137,
  "13-config-saved": 146,
  "14-settings": 154,
  "15-admin-overview": 164,
  "16-admin-connection": 174,
  "17-api-explorer": 184,
} as const;

let started = 0;

/** Hold the current screen until this beat's scripted end, then take its still. */
async function beat(page: import("@playwright/test").Page, name: keyof typeof BEATS): Promise<void> {
  const due = started + BEATS[name] * 1000 * PACE;
  const remaining = due - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  else console.log(`showcase: beat ${name} overran its script by ${Math.round(-remaining)} ms`);
  await shot(page, name);
}

test("showcase walkthrough", async ({ page }) => {
  // The script is ~3 minutes and every beat now holds for its scripted duration, so the
  // walkthrough takes about as long as the finished video does.
  test.setTimeout(420_000);
  started = Date.now();

  // ── 1. Welcome: first run, and the mock-Knowledge-Box honesty rule ───────────
  await page.goto("/#/welcome");
  await expect(page.locator("h1")).toContainText("Read every document the first time");
  await expect(page.locator(".arag-alert.warn")).toContainText("mock Knowledge Box");
  await expect(page.locator("#startSample")).toBeVisible();
  await beat(page, "01-welcome");

  // ── 2. The guided sample and its advisory tour ────────────────────────────────
  await page.click("#startSample");
  await expect(page).toHaveURL(/#\/documents/, { timeout: 20_000 });
  await expect(page.locator(".arag-tour-card")).toBeVisible();
  await expect(page.locator(".arag-tour-card")).toContainText("This is the queue");
  await beat(page, "02-tour");
  await page.click(".arag-tour-card [data-skip]");
  await expect(page.locator(".arag-tour-card")).toHaveCount(0);
  // The tour is advisory, not a cage: the sample keeps processing underneath it.
  await expect(page.locator("#docsTable tbody tr")).not.toHaveCount(0, { timeout: 30_000 });

  // ── 3. Upload the imperfect invoice through the drawer ────────────────────────
  await page.click("#uploadBtn");
  await expect(page).toHaveURL(/#\/documents\/upload/);
  await expect(page.locator(".arag-drawer")).toBeVisible();
  await expect(page.locator(".arag-drawer .arag-help").first()).toContainText("PDF");
  await expect(page.locator(".arag-drawer .arag-help").first()).toContainText("MB each");
  await beat(page, "03-upload-drawer");

  await page.setInputFiles("#fileInput", "showcase/fixtures/invoice-review.txt");
  await expect(page.locator("#queue .arag-chip")).toContainText("queued", { timeout: 20_000 });
  await page.click(".arag-drawer [data-close]");
  await expect(page.locator(".arag-drawer")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/documents(\?|$)/);

  // ── 4. The queue: the new row reads its way to Ready, worth reviewing ─────────
  const row = page.locator("#docsTable tbody tr", { hasText: "invoice-review.txt" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator(".arag-chip").first()).toContainText("Ready", { timeout: 30_000 });
  await expect(row.locator(".cell-sub")).toContainText("INV-2026-1188");
  await expect(row).toContainText("12"); // fields
  await expect(row).toContainText("100%"); // grounding
  await expect(row.locator(".arag-chip.warn, .arag-chip.danger")).toContainText("1"); // the reconciliation issue
  await beat(page, "04-fixture-ready");

  // ── 5. The record: the trust strip, worded not just coloured ─────────────────
  await row.locator(".cell-title").click();
  await expect(page.locator(".dip-grounding")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".dip-grounding__claim")).toContainText("of 12 fields carry a verified quote");
  await expect(page.locator(".dip-grounding__breakdown")).toContainText("exact");
  await expect(page.locator(".dip-grounding")).toHaveAttribute("data-band", "strong");
  await expect(page.locator(".arag-alert.warn").first()).toContainText("≠ total");
  await expect(page.locator("#field-total")).toBeVisible();
  await beat(page, "05-record");

  // ── 6. The evidence beat: a field's own quote, and the issue it carries ──────
  await page.click("#field-total .dip-field__evidence summary");
  await expect(page.locator("#field-total blockquote")).toBeVisible();
  await expect(page.locator("#field-total blockquote")).toContainText("TOTAL DUE");
  await expect(page.locator("#field-total blockquote")).toContainText("25,750");
  await expect(page.locator("#field-total .dip-field__issue")).toContainText("≠ total");
  // Normalisation is shown, not hidden: the raw value sits beside the normalised one.
  await expect(page.locator("#field-invoice_date .dip-field__raw")).toContainText("raw");
  await beat(page, "06-evidence-quote");

  // ── 7. Source & evidence: the same quote, found in the document's own text ───
  await page.click('a[role="tab"]:has-text("Source & evidence")');
  await expect(page.locator(".dip-source__text")).toContainText("TAX INVOICE", { timeout: 20_000 });
  await expect(page.locator("mark.dip-hit")).not.toHaveCount(0);
  await page.click('.dip-source__item[data-ev="invoice_number"]');
  await expect(page.locator("mark.dip-hit.is-active")).toContainText("INV-2026-1188");
  await page.click('.dip-source__item[data-ev="total"]');
  await expect(page.locator("mark.dip-hit.is-active")).toContainText("25,750.00");
  await beat(page, "07-source-highlight");

  // ── 8. The values as the Knowledge Box now holds them ─────────────────────────
  // The pass's headline capability, and the one claim a viewer cannot check anywhere else:
  // the structured record is not only in this product's store, it was written onto the
  // resource as typed key-value fields under a schema the config provisioned.
  await page.click('a[role="tab"]:has-text("JSON")');
  await expect(page.locator("#jsonView")).toBeVisible({ timeout: 20_000 });
  await page.click('#jsonView button[data-value="kv"]');
  await expect(page).toHaveURL(/view=kv/);
  await expect(page.locator("#jsonPane")).toContainText("dip_invoice_extraction", { timeout: 20_000 });
  await expect(page.locator("#jsonPane .arag-chip.ok")).toHaveText("Written");
  // The product's own property name, the Knowledge Box key it went in under, and the value.
  await expect(page.locator("#jsonPane table")).toContainText("Knowledge Box key");
  await expect(page.locator("#jsonPane table")).toContainText("INV-2026-1188");
  await beat(page, "08-keyvalues");

  // ── 9. Pipeline: the seven stages, with real timings ──────────────────────────
  await page.click('a[role="tab"]:has-text("Pipeline")');
  for (const stage of ["process", "classify", "extract", "entities", "summary", "validate", "standardize"]) {
    await expect(page.locator("#tabPanel")).toContainText(stage);
  }
  await expect(page.locator("#tabPanel")).toContainText("Total");
  await beat(page, "09-pipeline");

  // ── 10. Export the record ───────────────────────────────────────────────────────
  await page.click('a[role="tab"]:has-text("Record")');
  await expect(page.locator(".dip-grounding")).toBeVisible({ timeout: 20_000 });
  const csv = page.waitForEvent("download");
  await page.click("#exportCsv");
  expect((await csv).suggestedFilename()).toBe("invoice-review.csv");
  await expect(page.locator(".arag-toast")).toContainText("Downloaded invoice-review.csv");
  await beat(page, "10-export");

  // ── 11. Ask this document ──────────────────────────────────────────────────────
  await page.click('a[role="tab"]:has-text("Ask")');
  await page.fill("#askInput", "What is the total due and when?");
  await page.click("#askBtn");
  await expect(page.locator(".arag-bubble.assistant").last()).not.toContainText("Thinking", {
    timeout: 30_000,
  });
  await expect(page.locator(".arag-bubble.assistant").last()).toContainText("25,750");
  await expect(page.locator(".arag-bubble.assistant").last()).toContainText("Open in source");
  await beat(page, "11-ask");

  // ── 12. A custom extraction config: the five-minute new document type ────────
  await page.click('[data-nav="Configs"]');
  await expect(page.locator("h2").first()).toContainText("Built in");
  await page.click('a[href="#/configs/new"]');
  await expect(page.locator("h1")).toContainText("New extraction config");
  await page.fill("#cfgName", "Insurance Card");
  await page.fill(".dip-fieldrow .fld-label", "Policy Number");
  await page.click("#addField");
  await page.fill(".dip-fieldrow:nth-child(2) .fld-label", "Insurer");
  await expect(page.locator("#keyPreview")).toContainText("policy_number, insurer");
  await beat(page, "12-config-builder");

  await page.click("#saveCfg");
  await expect(page).toHaveURL(/#\/configs\/cfg_/, { timeout: 20_000 });
  await expect(page.locator("h1")).toContainText("Insurance Card");
  await expect(page.locator("#provCard")).toContainText("Ready");
  await expect(page.locator("#provCard")).toContainText("dip_custom_insurance_card");
  await expect(page.locator("#kvCard")).toContainText("Provisioned", { timeout: 20_000 });
  await beat(page, "13-config-saved");

  // ── 14. Settings: what this deployment is connected to, no admin token needed ──
  await page.click('[data-nav="Settings"]');
  await expect(page.locator("#panel")).toContainText("Knowledge Box", { timeout: 20_000 });
  await expect(page.locator(".arag-alert.warn")).toContainText("mock Knowledge Box");
  await expect(page.locator("#panel")).toContainText("ARAG_KB_ID");
  await expect(page.locator("#panel")).toContainText("Editing these settings needs the operator token.");
  await beat(page, "14-settings");

  // ── 15. Admin: sign in, and the operator's own view ───────────────────────────
  await page.click('a[href="/admin/"]');
  await expect(page.locator(".arag-signin")).toBeVisible({ timeout: 20_000 });
  await page.fill("#token", "e2e-admin-token");
  await page.press("#token", "Enter");
  await expect(page.locator(".arag-railnav")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("h1")).toContainText("Overview");
  await expect(page.locator(".arag-statstrip")).toContainText("Grounding");
  await expect(page.locator("body")).toContainText("Needs attention");
  await beat(page, "15-admin-overview");

  // ── 16. Admin → Connection: the stored ARAG search configurations ────────────
  await page.click('[data-nav="Connection"]');
  await expect(page.locator("table")).toContainText("dip_invoice_extraction", { timeout: 20_000 });
  await expect(page.locator("table")).toContainText("dip_custom_insurance_card");
  await page.click("tr[data-cfg='dip_invoice_extraction']");
  await expect(page.locator(".arag-drawer")).toContainText("full_resource", { timeout: 20_000 });
  await expect(page.locator(".arag-drawer")).toContainText("answer_json_schema");
  await beat(page, "16-admin-connection");
  await page.keyboard.press("Escape");

  // ── 17. The API explorer: every screen is a documented endpoint you can call ──
  // This used to end on the generated Redoc page. The explorer is the better ending and the
  // more honest one: it is not a rendering of the contract, it is the contract exercised
  // against this very deployment, generated from the same /api/v1/openapi.json — so an
  // operation that exists in the spec is an operation you can see and send from here.
  await page.goto("/#/api?op=listDocuments");
  await expect(page.locator("#apiList [data-op]").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#apiCount")).toContainText("operations");
  await page.fill('[name="query:page_size"]', "5");
  await page.click('#tryForm button[type="submit"]');
  await expect(page.locator("#responseOut .arag-chip")).toContainText("200", { timeout: 20_000 });
  await expect(page.locator("#curlOut")).toContainText("curl -i -X GET");
  await beat(page, "17-api-explorer");
});
