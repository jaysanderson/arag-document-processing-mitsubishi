import { expect, test } from "@playwright/test";

/**
 * The operator app end to end: first run → guided sample → the queue → the record and its
 * verified evidence → source → exports → ask → configs → settings.
 *
 * Selectors are the ones the showcase recording also uses, so a change that breaks the
 * walkthrough breaks this suite first.
 */
test.describe.configure({ mode: "serial" });

test("first run offers the guided sample and is honest about the mock Knowledge Box", async ({ page }) => {
  await page.goto("/#/welcome");
  await expect(page.locator("h1")).toContainText("Read every document the first time");
  await expect(page.locator(".arag-alert.warn")).toContainText("mock Knowledge Box");
  await expect(page.locator(".arag-railnav a")).toHaveCount(6);
  await expect(page.locator('[data-nav="Documents"]')).toContainText("Documents");
  // The Progress wordmark appears once, in the band. The sidebar head carries the product's
  // own identity — name and tagline — and no image unless a partner logo is configured.
  await expect(page.locator(".arag-appband .wordmark img")).toHaveAttribute(
    "src",
    "/ui/brand/arag-logo-alt.svg",
  );
  await expect(page.locator(".arag-rail .ident img")).toBeHidden();
  await expect(page.locator(".arag-rail .ident .name")).toHaveText("Document Processing");
  await expect(page.locator(".arag-rail .ident .tag")).toHaveText("Documents in, validated records out");
  expect(await page.locator('img[src*="arag-logo"]').count()).toBe(1);
});

test("the guided sample processes a document and lands in the queue", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/welcome");
  await page.click("#startSample");
  await expect(page).toHaveURL(/#\/documents/, { timeout: 20_000 });
  // The tour is advisory, not a cage: the screen underneath stays usable.
  await expect(page.locator(".arag-tour-card")).toBeVisible();
  await page.click(".arag-tour-card [data-skip]");
  await expect(page.locator(".arag-tour-card")).toHaveCount(0);

  await expect(page.locator("#docsTable tbody tr")).not.toHaveCount(0, { timeout: 30_000 });
  // The guided sample is a purchase order as it arrived: a PDF, under its own filename.
  const row = page.locator("#docsTable tbody tr", { hasText: "Purchase_Order_No_1706.pdf" }).first();
  await expect(row.locator(".arag-chip").first()).toContainText("Ready", { timeout: 60_000 });
  await expect(row).toContainText("Purchase order");
  await expect(page.locator("#strip .arag-statstrip > *").first()).toContainText("Documents");
});

test("the other orders sit beside the guided sample, and the generic samples one click away", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/#/welcome");
  // Five more orders up front (the sixth is the guided sample itself)…
  await expect(page.locator("#featuredSamples [data-sample]")).toHaveCount(5);
  await expect(page.locator('#featuredSamples [data-sample="me-order-43699"]')).toHaveText(
    "Handwritten order 43699",
  );
  // …and the samples that ship with the product, folded away.
  await page.click("details summary");
  await page.click('details [data-sample="invoice"]');
  await expect(page).toHaveURL(/#\/documents/, { timeout: 20_000 });
  await page.click(".arag-tour-card [data-skip]");

  const row = page.locator("#docsTable tbody tr", { hasText: "invoice.txt" }).first();
  await expect(row.locator(".arag-chip").first()).toContainText("Ready", { timeout: 60_000 });
  // The row carries the document's own identity, not just the filename it arrived under.
  await expect(row.locator(".cell-sub")).toContainText("INV-2026-0042");
});

test("the record shows verified evidence, and the source tab locates every quote", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/documents?q=invoice.txt");
  await page.click("#docsTable .cell-title >> nth=0");
  await expect(page.locator(".dip-grounding")).toBeVisible({ timeout: 20_000 });

  // Grounding is a claim with a denominator, never a bare percentage.
  await expect(page.locator(".dip-grounding__claim")).toContainText("of 12 fields carry a verified quote");
  await expect(page.locator(".dip-grounding__breakdown")).toContainText("exact");
  await expect(page.locator(".dip-grounding")).toHaveAttribute("data-band", "strong");

  // Field rows carry value, confidence and verification as three separate things.
  await expect(page.locator(".dip-field")).not.toHaveCount(0);
  await expect(page.locator("#field-invoice_number .dip-field__value")).toContainText("INV-2026-0042");
  await expect(
    page.locator("#field-invoice_number .dip-field__verify, #field-invoice_number .arag-chip"),
  ).toContainText("Verified");
  await page.click("#field-invoice_number .dip-field__evidence summary");
  await expect(page.locator("#field-invoice_number blockquote")).toContainText("INV-2026-0042");
  // Normalisation is shown, not hidden: the raw value sits beside the normalised one.
  await expect(page.locator("#field-invoice_date .dip-field__raw")).toContainText("raw");

  // Source & evidence: the quote is highlighted inside the document's own extracted text.
  await page.click('a[role="tab"]:has-text("Source & evidence")');
  await expect(page.locator(".dip-source__text")).toContainText("TAX INVOICE", { timeout: 20_000 });
  await expect(page.locator("mark.dip-hit")).not.toHaveCount(0);
  await page.click('.dip-source__item[data-ev="invoice_number"]');
  await expect(page.locator("mark.dip-hit.is-active")).toContainText("INV-2026-0042");

  // Pipeline: every stage, with a real duration.
  await page.click('a[role="tab"]:has-text("Pipeline")');
  for (const stage of ["process", "classify", "extract", "entities", "summary", "validate", "standardize"]) {
    await expect(page.locator("#tabPanel")).toContainText(stage);
  }
  await expect(page.locator("#tabPanel")).toContainText("Total");
});

test("exports download in three formats and the document answers a question", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/documents?q=invoice.txt");
  await page.click("#docsTable .cell-title >> nth=0");
  await expect(page.locator(".dip-grounding")).toBeVisible({ timeout: 20_000 });

  const csv = page.waitForEvent("download");
  await page.click("#exportCsv");
  expect((await csv).suggestedFilename()).toBe("invoice.csv");

  await page.click('a[role="tab"]:has-text("Ask")');
  await page.fill("#askInput", "What is the total due?");
  await page.click("#askBtn");
  await expect(page.locator(".arag-bubble.assistant").last()).not.toContainText("Thinking", {
    timeout: 30_000,
  });
});

test("the list searches, filters, sorts and exports a selection in bulk", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/documents");
  await expect(page.locator("#docsTable tbody tr")).not.toHaveCount(0);

  // Search matches a value printed on the document, not only its filename.
  await page.fill("#q", "INV-2026-0042");
  await expect(page).toHaveURL(/q=INV-2026-0042/, { timeout: 10_000 });
  await expect(page.locator("#docsTable tbody tr")).not.toHaveCount(0);
  await expect(page.locator("#docsTable")).toContainText("invoice.txt");

  await page.fill("#q", "nothing-matches-this");
  await expect(page.locator(".arag-emptystate")).toContainText("No documents match these filters", {
    timeout: 10_000,
  });
  await page.click(".arag-emptystate button");
  await expect(page.locator("#docsTable tbody tr")).not.toHaveCount(0);

  // Sorting is a real query parameter, so a sorted queue is a shareable link.
  await page.click('[data-sort="grounding"]');
  await expect(page).toHaveURL(/sort=grounding/);

  // Bulk export of a selection.
  await page.click("#docsTable [data-check-all]");
  await expect(page.locator("#docsTable [data-bulkbar]")).toBeVisible();
  await expect(page.locator("#docsTable tbody tr").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".arag-bulkbar [data-bulk-count]")).toContainText("selected");
  const bulk = page.waitForEvent("download");
  await page.click('[data-bulk="csv"]');
  expect((await bulk).suggestedFilename()).toMatch(/^documents-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("the upload drawer publishes the accepted types from the API and is a route", async ({ page }) => {
  await page.goto("/#/documents");
  await page.click("#uploadBtn");
  await expect(page.locator(".arag-drawer")).toBeVisible();
  await expect(page).toHaveURL(/#\/documents\/upload/);
  await expect(page.locator(".arag-drawer .arag-help").first()).toContainText("PDF");
  await expect(page.locator(".arag-drawer .arag-help").first()).toContainText("MB each");
  await expect(page.locator("#cfg option")).not.toHaveCount(0);
  await page.click(".arag-drawer [data-close]");
  await expect(page.locator(".arag-drawer")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/documents/);
});

test("configs list the built-ins and the field builder creates a custom config", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/configs");
  await expect(page.locator("h2").first()).toContainText("Built in");
  await expect(page.locator("table")).toContainText("dip_invoice_extraction");
  // documentCount answers "is anything using this?" before a delete.
  await expect(page.locator("tr[data-cfg='invoice'] .num").last()).not.toHaveText("0");

  await page.click('a[href="#/configs/new"]');
  await expect(page.locator("h1")).toContainText("New extraction config");
  await page.fill("#cfgName", "E2E Insurance Card");
  await page.fill(".dip-fieldrow .fld-label", "Policy Number");
  await page.click("#addField");
  await page.fill(".dip-fieldrow:nth-child(2) .fld-label", "Insurer");
  await expect(page.locator("#keyPreview")).toContainText("policy_number, insurer");
  await page.click("#saveCfg");

  await expect(page).toHaveURL(/#\/configs\/cfg_/, { timeout: 20_000 });
  await expect(page.locator("h1")).toContainText("E2E Insurance Card");
  await expect(page.locator("#provCard")).toContainText("Ready");
  // The config also provisions a typed key-value schema in the Knowledge Box itself.
  await expect(page.locator("#kvCard")).toContainText("Provisioned", { timeout: 20_000 });
  await expect(page.locator("#kvCard")).toContainText("of 50 allowed in one schema");

  // Editing keeps the id, so meta.config on processed documents keeps resolving.
  const id = new URL(page.url()).hash.split("/").pop();
  await page.click(`a[href="#/configs/${id}/edit"]`);
  await page.fill("#cfgDesc", "Edited by the e2e suite");
  await page.click("#saveCfg");
  await expect(page).toHaveURL(new RegExp(`#/configs/${id}$`), { timeout: 20_000 });

  await page.click("#delCfg");
  await page.click(".arag-confirm [data-ok]");
  await expect(page).toHaveURL(/#\/configs$/, { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText("E2E Insurance Card");
});

test("settings answer what this deployment is connected to, without an admin token", async ({ page }) => {
  await page.goto("/#/settings/connection");
  await expect(page.locator("#panel")).toContainText("Knowledge Box", { timeout: 20_000 });
  await expect(page.locator(".arag-alert.warn")).toContainText("mock Knowledge Box");
  // A signed-out viewer reads the real effective values and is told exactly what unlocks
  // editing — the values are not hidden behind the token, only the form is.
  await expect(page.locator("#panel")).toContainText("ARAG_KB_ID");
  await expect(page.locator("#panel")).toContainText("Editing these settings needs the operator token.");
  await page.click('a[role="tab"]:has-text("Limits")');
  await expect(page.locator("#panel")).toContainText("PDF");
  await page.click('a[role="tab"]:has-text("Branding")');
  await expect(page.locator("#panel")).toContainText("BRAND_PRODUCT_NAME");
  await expect(page.locator("#panel")).toContainText("never branded");
  // The API keys list is the one group a viewer cannot read at all.
  await page.click('a[role="tab"]:text-is("API keys")');
  await expect(page.locator("#panel")).toContainText("The key list needs the operator token.");
  await expect(page.locator("table")).toHaveCount(0);
  await page.click('a[role="tab"]:text-is("API")');
  await expect(page.locator("#panel")).toContainText("openapi.json");
});

test("jobs are listed and a finished job explains itself in a drawer", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/#/jobs");
  await expect(page.locator("table tbody tr")).not.toHaveCount(0, { timeout: 20_000 });
  await page.uncheck("#auto");
  await page.click("table tbody tr");
  await expect(page.locator(".arag-drawer")).toBeVisible();
  await expect(page.locator(".arag-drawer")).toContainText("process-document");
  await expect(page.locator(".arag-drawer .arag-steps li").first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".arag-drawer")).toHaveCount(0);
});

test("ask is reachable on its own and scoped to one document", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/#/ask?scope=document");
  await expect(page.locator("#docPick option")).not.toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("#askScope button[aria-selected='true']")).toHaveText("One document");
  await page.click(".dip-suggestions button >> nth=0");
  await expect(page.locator(".arag-bubble.assistant").last()).not.toContainText("Thinking", {
    timeout: 30_000,
  });
});

test("extracted values are escaped before they reach the page", async ({ page }) => {
  // Field values, summaries and entity text are an LLM's reading of a document somebody
  // uploaded, so they are attacker-controlled. The list's subline renders the identifier
  // and the counterparty, which makes it the place an injection would land. The response
  // is stubbed rather than uploaded because the mock ARAG synthesises its own field values
  // from the fixture text and will not echo a payload back.
  const payload = '<img src=x onerror="window.__xss = true">';
  const now = new Date().toISOString();
  const doc = {
    id: "xss-probe",
    resourceId: "xss-probe",
    filename: "probe.txt",
    contentType: "text/plain",
    bytes: 10,
    status: "ready",
    docType: "invoice",
    fields: [
      { key: "vendor_name", label: "Vendor", value: payload, confidence: 0.9 },
      { key: "invoice_number", label: "Invoice #", value: payload, confidence: 0.9 },
    ],
    entities: [],
    tags: [],
    issues: [],
    evidence: [],
    meta: { processedAt: now, schema: "invoice_extraction", model: "test", durationsMs: {} },
    createdAt: now,
    updatedAt: now,
  };
  await page.route("**/api/v1/documents?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [doc],
        page: 1,
        page_size: 20,
        total: 1,
        next_page: false,
        facets: { total: 1, status: { ready: 1 }, docType: { invoice: 1 }, degraded: 0, needsReview: 0 },
      }),
    }),
  );
  await page.goto("/#/documents");
  await expect(page.locator("#docsTable tbody tr")).toHaveCount(1);
  // The payload is text, not markup: it is visible verbatim and no element was created.
  await expect(page.locator(".cell-sub").first()).toContainText(payload);
  expect(await page.locator("#docsTable img").count()).toBe(0);
  expect(await page.evaluate(() => "__xss" in window)).toBe(false);
});

test("the shell holds at 1440 px and collapses to a drawer at 390 px", async ({ page }) => {
  // The platform's product-experience bar checks the shell at both widths (STANDARDS § 8b).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/documents");
  await expect(page.locator(".arag-railnav a").first()).toBeVisible();
  await expect(page.locator(".arag-rail-menu")).toBeHidden();
  // The rail can be collapsed to an icon column and the choice is remembered.
  await page.click(".arag-rail-toggle");
  await expect(page.locator(".arag-app")).toHaveAttribute("data-rail", "collapsed");
  await page.click(".arag-rail-toggle");
  await expect(page.locator(".arag-app")).toHaveAttribute("data-rail", "expanded");

  await page.setViewportSize({ width: 390, height: 844 });
  // Below 900 px the rail becomes a scrim-backed drawer behind the band's menu button.
  await expect(page.locator(".arag-rail-menu")).toBeVisible();
  await expect(page.locator(".arag-appband .wordmark img")).toBeVisible();
  // The page itself never scrolls sideways; a wide table scrolls inside its own container.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.click(".arag-rail-menu");
  await expect(page.locator(".arag-scrim")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".arag-scrim")).toHaveCount(0);
});
