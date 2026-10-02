/**
 * Mock-only: let the mock ARAG return a bundled PDF sample's own text.
 *
 * The mock has no PDF reader. It picks a fixture by filename hint, so a PDF sample would
 * otherwise come back as an unrelated fictional purchase order (any name containing "po")
 * or as a one-line placeholder. A sample that has a text layer ships it beside the PDF as
 * `<name>.txt` (`pdftotext -layout`), and this registers that text under the sample's
 * filename — the mock's own fixture table, its documented keying, no vendored file edited.
 *
 * A scan has no text layer and so no sidecar: it keeps the mock's placeholder, which is the
 * honest answer — reading it takes the live visual model.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type MockAragServer, mockFixtures } from "../../vendor/arag-platform/src/index.ts";
import { SAMPLES } from "./samples.ts";

/**
 * Stop the mock presenting a PDF's raw bytes as its text.
 *
 * The mock decides "is this text?" by sniffing the first 512 bytes for control characters,
 * and a PDF whose header and metadata are mostly printable passes — so the record's source
 * text, and every field read from it, became `%PDF-1.7` and stream garbage. A PDF is never
 * its own text: it gets its fixture when one is registered and the placeholder otherwise.
 */
export function fixMockPdfText(mock: MockAragServer["mock"]): void {
  const seed = mock.seedResource.bind(mock);
  mock.seedResource = (s) => {
    const contentType = (s.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/pdf" || !s.filename) return seed(s);
    const text =
      mockFixtures.sampleTextFor(s.filename) ??
      `Scanned document ${s.filename}\n\n(Visual extraction placeholder)`;
    return seed({ ...s, text });
  };
}

/** Register every PDF sample's text sidecar with the mock. Returns the filenames registered. */
export function registerMockSampleTexts(publicDir: string): string[] {
  const registered: string[] = [];
  for (const sample of SAMPLES) {
    if (sample.kind !== "pdf") continue;
    const sidecar = resolve(publicDir, sample.url.replace(/^\//, "").replace(/\.pdf$/i, ".txt"));
    let text: string;
    try {
      text = readFileSync(sidecar, "utf8").trim();
    } catch {
      continue;
    }
    if (!text) continue;
    mockFixtures.SAMPLE_DOCS[sample.filename.toLowerCase()] = text;
    registered.push(sample.filename);
  }
  return registered;
}
