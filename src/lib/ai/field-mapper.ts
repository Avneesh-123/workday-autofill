/**
 * AI-driven field mapper.
 *
 * Workflow:
 *  1. We pre-fill obvious fields with deterministic heuristics
 *     (label keyword matching). These get confidence = 1.
 *  2. Remaining fields are batched and sent to the AI together with
 *     a *trimmed* resume profile (we drop large free-text blocks to
 *     save tokens).
 *  3. We merge the two sources of answers.
 *
 * This gives us robustness: even if the AI call fails, contact info
 * / common questions still get filled.
 */

import { chatComplete, safeParseJson } from "@/lib/ai/client";
import { FIELD_MAPPING_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import {
  DetectedField,
  MappedValue,
  ResumeProfile,
  UserSettings,
} from "@/lib/types";

interface MapArgs {
  fields: DetectedField[];
  profile: ResumeProfile;
  settings: UserSettings;
  stepName?: string;
}

export async function mapFields(args: MapArgs): Promise<MappedValue[]> {
  const heuristics = heuristicMap(args.fields, args.profile);
  const heuristicIds = new Set(heuristics.map((h) => h.id));
  const remaining = args.fields.filter((f) => !heuristicIds.has(f.id));

  if (remaining.length === 0) return heuristics;
  if (!args.settings.openaiApiKey) {
    // Without an API key, return the heuristic answers and leave the
    // rest for review.
    return [
      ...heuristics,
      ...remaining.map((f) => ({
        id: f.id,
        value: null,
        confidence: 0,
        reason: "No API key configured; only heuristic fields filled.",
        needsReview: true,
      })),
    ];
  }

  const trimmedProfile = trimProfileForPrompt(args.profile);

  const aiAnswers: MappedValue[] = [];
  const batchSize = Math.max(4, args.settings.batchSize ?? 12);

  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    const userPrompt = JSON.stringify(
      {
        stepName: args.stepName,
        profile: trimmedProfile,
        fields: batch.map(stripFieldForPrompt),
      },
      null,
      2,
    );

    try {
      const { content } = await chatComplete({
        apiKey: args.settings.openaiApiKey,
        apiBaseUrl: args.settings.apiBaseUrl,
        model: args.settings.model,
        temperature: 0,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: FIELD_MAPPING_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });
      const parsed = safeParseJson<{ answers: MappedValue[] }>(content);
      if (Array.isArray(parsed.answers)) aiAnswers.push(...parsed.answers);
    } catch (err) {
      console.warn("[wda] AI mapping batch failed:", err);
      for (const f of batch) {
        aiAnswers.push({
          id: f.id,
          value: null,
          confidence: 0,
          reason: `AI call failed: ${(err as Error).message}`,
          needsReview: true,
        });
      }
    }
  }

  return [...heuristics, ...aiAnswers];
}

/* ------------------------------------------------------------------ */
/*  Heuristics                                                         */
/* ------------------------------------------------------------------ */

interface Rule {
  match: RegExp;
  resolve: (p: ResumeProfile, f: DetectedField) => string | null | undefined;
}

const HEURISTIC_RULES: Rule[] = [
  { match: /\b(given\s*name|first\s*name|forename)\b/i, resolve: (p) => p.contact.firstName },
  { match: /\b(family\s*name|last\s*name|surname)\b/i, resolve: (p) => p.contact.lastName },
  { match: /\bmiddle\s*name\b/i, resolve: (p) => p.contact.middleName },
  { match: /\b(full\s*name|legal\s*name|name)\b/i, resolve: (p) => p.contact.fullName },
  { match: /\b(e-?mail|email\s*address)\b/i, resolve: (p) => p.contact.email },
  { match: /\b(phone|mobile|telephone|cell)\b/i, resolve: (p) => p.contact.phone },
  { match: /\b(country\s*code)\b/i, resolve: (p) => p.contact.phoneCountryCode },
  { match: /\b(address\s*line\s*1|street)\b/i, resolve: (p) => p.contact.address?.line1 },
  { match: /\baddress\s*line\s*2\b/i, resolve: (p) => p.contact.address?.line2 },
  { match: /\b(city|town)\b/i, resolve: (p) => p.contact.address?.city },
  { match: /\b(state|province|region)\b/i, resolve: (p) => p.contact.address?.state },
  { match: /\b(zip|postal\s*code|postcode)\b/i, resolve: (p) => p.contact.address?.postalCode },
  { match: /\bcountry\b/i, resolve: (p) => p.contact.address?.country },
  { match: /\blinkedin\b/i, resolve: (p) => p.contact.links?.linkedin },
  { match: /\bgithub\b/i, resolve: (p) => p.contact.links?.github },
  { match: /\b(portfolio|website|personal\s*site)\b/i, resolve: (p) => p.contact.links?.portfolio },
  { match: /\bhow did you hear\b/i, resolve: (p) => p.demographics?.howDidYouHear ?? "LinkedIn" },
  {
    match: /\bpreviously employed\b/i,
    resolve: (p) =>
      p.demographics?.previouslyEmployedAtCompany === true ? "Yes" : "No",
  },
];

function heuristicMap(
  fields: DetectedField[],
  profile: ResumeProfile,
): MappedValue[] {
  const out: MappedValue[] = [];
  for (const f of fields) {
    if (f.kind === "file") continue;
    // Repeatable sections (Experience/Education) handled by AI for full context.
    if (f.repeatable) continue;
    const haystack = `${f.label} ${f.ariaLabel ?? ""} ${f.placeholder ?? ""}`;
    for (const rule of HEURISTIC_RULES) {
      if (rule.match.test(haystack)) {
        const v = rule.resolve(profile, f);
        if (v != null && String(v).trim() !== "") {
          out.push({
            id: f.id,
            value: String(v),
            confidence: 0.95,
            reason: "Heuristic label match",
          });
          break;
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Prompt trimming                                                    */
/* ------------------------------------------------------------------ */

function stripFieldForPrompt(f: DetectedField) {
  return {
    id: f.id,
    label: f.label,
    kind: f.kind,
    required: f.required,
    options: f.options,
    helpText: f.helpText,
    section: f.section,
    currentValue: f.currentValue,
    repeatable: f.repeatable,
    repeatIndex: f.repeatIndex,
  };
}

function trimProfileForPrompt(p: ResumeProfile): ResumeProfile {
  return {
    contact: p.contact,
    summary: p.summary?.slice(0, 800),
    experience: (p.experience ?? []).slice(0, 6).map((e) => ({
      company: e.company,
      title: e.title,
      location: e.location,
      startDate: e.startDate,
      endDate: e.endDate,
      current: e.current,
      summary: e.summary?.slice(0, 400),
      bullets: e.bullets?.slice(0, 6),
    })),
    education: (p.education ?? []).slice(0, 4),
    skills: (p.skills ?? []).slice(0, 40),
    certifications: (p.certifications ?? []).slice(0, 10),
    languages: p.languages,
    demographics: p.demographics,
    custom: p.custom,
  };
}
