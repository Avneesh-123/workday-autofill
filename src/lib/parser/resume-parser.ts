import { extractDocxText } from "@/lib/parser/docx";
import { extractPdfText } from "@/lib/parser/pdf";
import { ResumeHints, ResumeProfile } from "@/lib/types";
import { aiStructureResume } from "@/lib/ai/resume";

export interface ParseInput {
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
}

export async function extractResumeText(input: ParseInput): Promise<string> {
  const name = input.fileName.toLowerCase();
  if (input.mimeType === "application/pdf" || name.endsWith(".pdf")) {
    return extractPdfText(input.buffer);
  }
  if (
    input.mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return extractDocxText(input.buffer);
  }
  // Fallback: assume utf-8 text.
  return new TextDecoder("utf-8").decode(new Uint8Array(input.buffer));
}

/**
 * Parses a resume file into a structured `ResumeProfile`.
 * Strategy:
 *  1. Deterministic text extraction (pdf.js / mammoth).
 *  2. Heuristic pre-extraction for email / phone / links - the AI uses
 *     these as anchors but is also free to override.
 *  3. AI call to structure the rest, infer missing fields and normalize
 *     dates/formatting.
 */
export async function parseResume(
  input: ParseInput,
  apiKey: string,
  model: string,
  apiBaseUrl?: string,
): Promise<ResumeProfile> {
  const text = await extractResumeText(input);
  if (!text || text.trim().length < 40) {
    throw new Error(
      "Could not extract enough text from the resume. Is the PDF scanned (image-only)?",
    );
  }

  const hints = heuristicHints(text);
  return aiStructureResume({ text, hints, apiKey, model, apiBaseUrl });
}

/** Used by the popup: extract text locally, then call background `STRUCTURE_RESUME`. */
export async function extractAndHints(input: ParseInput): Promise<{
  text: string;
  hints: ResumeHints;
}> {
  const text = await extractResumeText(input);
  if (!text || text.trim().length < 40) {
    throw new Error(
      "Could not extract enough text from the resume. Is the PDF scanned (image-only)?",
    );
  }
  return { text, hints: heuristicHints(text) };
}

/* ------------------------------------------------------------------ */
/*  Lightweight regex hints (helps the AI anchor on noisy text)       */
/* ------------------------------------------------------------------ */

export function heuristicHints(text: string): ResumeHints {
  const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const phoneMatch = text.match(
    /(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/,
  );
  const links = Array.from(
    text.matchAll(/https?:\/\/[^\s)<>"']+/gi),
    (m) => m[0],
  );
  const linkedin =
    links.find((l) => /linkedin\.com\/in\//i.test(l)) ||
    (text.match(/linkedin\.com\/in\/[A-Za-z0-9_-]+/i)?.[0] &&
      `https://${text.match(/linkedin\.com\/in\/[A-Za-z0-9_-]+/i)?.[0]}`) ||
    undefined;
  const github =
    links.find((l) => /github\.com\//i.test(l)) ||
    (text.match(/github\.com\/[A-Za-z0-9_-]+/i)?.[0] &&
      `https://${text.match(/github\.com\/[A-Za-z0-9_-]+/i)?.[0]}`) ||
    undefined;

  return {
    email: emailMatch?.[0],
    phone: phoneMatch?.[0]?.trim(),
    linkedin,
    github,
    links,
  };
}
