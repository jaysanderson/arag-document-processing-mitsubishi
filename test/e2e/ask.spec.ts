import { expect, test } from "@playwright/test";

/**
 * The cross-document ask.
 *
 * The distinction the old screen stated in prose — "there is no cross-document search" — is
 * now a control with two positions, and the corpus side has to say exactly what it is about
 * to search before it searches it. Every citation names its document, so "show me where"
 * still works across the corpus and not only inside one record.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  // Two invoices, so "asking N documents" is a real number and not always one.
  for (const name of ["ask-e2e-a.txt", "ask-e2e-b.txt"]) {
    const res = await request.post("/api/v1/documents?config=invoice", {
      headers: { "Content-Type": "text/plain", "X-Filename": name },
      data: [
        "TAX INVOICE",
        "GLOBEX SUPPLY CO PTY LTD",
        `Invoice Number: INV-${name.includes("-a") ? "2026-1188" : "2026-1187"}`,
        "Bill To: Progress Software Corporation",
        `TOTAL DUE: $${name.includes("-a") ? "25,750.00" : "14,200.00"} AUD`,
        "",
      ].join("\n"),
    });
    expect(res.status()).toBe(202);
  }
});

test("the scope switch is a route, and switching clears the thread", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/#/ask?scope=document");
  await expect(page.locator("#docPick option")).not.toHaveCount(0, { timeout: 30_000 });

  await page.click('#askScope button[data-value="corpus"]');
  await expect(page).toHaveURL(/scope=corpus/);
  await expect(page.locator("#corpusThread")).toBeEmpty();
  await expect(page.locator("#scopeLine")).toContainText("in this workspace's Knowledge Box");
  // The count is real: it is the same intersection the Documents list reports.
  const said = Number((await page.locator("#scopeLine strong").innerText()).trim());
  const listed = await page.request.get("/api/v1/documents?status=ready&page_size=1");
  expect(said).toBe((await listed.json()).total);
});

test("an answer carries numbered citations, each naming its own document", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/ask?scope=corpus");
  await expect(page.locator("#corpusInput")).toBeEnabled({ timeout: 30_000 });
  await page.fill("#corpusInput", "Which suppliers have invoiced the most?");
  await page.click("#corpusAsk");

  const answer = page.locator(".arag-bubble.assistant").last();
  await expect(answer).not.toContainText("Searching", { timeout: 60_000 });
  await expect(answer.locator(".arag-cite").first()).toHaveText("[1]");
  // The Sources block is per document, which is the whole difference from the per-record ask.
  await expect(answer.locator(".dip-sources .doc").first()).toContainText(/\.(txt|pdf)/);
  await expect(answer.locator(".dip-sources .open").first()).toHaveAttribute(
    "href",
    /#\/documents\/[0-9a-f]+\/source/,
  );
  await expect(answer).toContainText("searched");

  // A citation opens the quote in a drawer: the thread is the work, and checking a quote
  // must not cost it.
  await answer.locator(".arag-cite").first().click();
  await expect(page.locator(".arag-drawer")).toBeVisible();
  // Whichever document the answer cited first — the workspace holds invoices and an order.
  await expect(page.locator(".arag-drawer .dip-source__text")).toContainText(/INVOICE|PURCHASE ORDER/, {
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".arag-drawer")).toHaveCount(0);
  await expect(page.locator(".arag-bubble.user")).toHaveCount(1);
});

test("a filter narrows what will be searched, and says so before the question is asked", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/#/ask?scope=corpus");
  await expect(page.locator("#askQ")).toBeVisible({ timeout: 30_000 });
  await page.fill("#askQ", "INV-2026-1188");
  await expect(page).toHaveURL(/q=INV-2026-1188/, { timeout: 20_000 });
  await expect(page.locator("#scopeLine")).toContainText("matching these filters", { timeout: 20_000 });
  const said = Number((await page.locator("#scopeLine strong").innerText()).trim());
  expect(said).toBeGreaterThan(0);

  // The same filter on the Documents list returns the same set: two screens, one answer.
  const listed = await page.request.get("/api/v1/documents?status=ready&page_size=1&q=INV-2026-1188");
  expect(said).toBe((await listed.json()).total);
  await page.click("#askClear");
  await expect(page.locator("#scopeLine")).toContainText("in this workspace's Knowledge Box", {
    timeout: 20_000,
  });
});

test("the corpus ask holds at 390 px with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/ask?scope=corpus");
  await expect(page.locator("#corpusInput")).toBeVisible({ timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
