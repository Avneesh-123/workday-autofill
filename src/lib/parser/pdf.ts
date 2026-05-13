/**
 * Extract raw text from a PDF using pdf.js.
 *
 * pdf.js is loaded as an ES module dependency. We disable the worker
 * (workerSrc = false) so the parser runs on the main thread of the
 * extension page that calls it (popup / options). This avoids the
 * cross-origin worker headaches inside Manifest V3 service workers.
 */
import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - vite resolves the worker URL at build time
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = workerSrc;

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str: string; transform: number[] }>;

    // Group items by Y coordinate so we keep visual line ordering.
    const rows = new Map<number, string[]>();
    for (const item of items) {
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push(item.str);
    }
    const sortedYs = Array.from(rows.keys()).sort((a, b) => b - a);
    const pageText = sortedYs.map((y) => rows.get(y)!.join(" ")).join("\n");
    pageTexts.push(pageText);
  }

  return pageTexts.join("\n\n");
}
