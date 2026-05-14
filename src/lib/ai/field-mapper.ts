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

import {
  chatComplete,
  ChatContentPart,
  isVisionCapableModel,
  safeParseJson,
} from "@/lib/ai/client";
import {
  FIELD_MAPPING_SYSTEM_PROMPT,
  FIELD_MAPPING_VISION_HINT,
} from "@/lib/ai/prompts";
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
  /** Optional base64 dataURL of the visible form (passed to vision models). */
  screenshot?: string;
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
  const useVision =
    !!args.screenshot &&
    !!args.settings.useVision &&
    isVisionCapableModel(args.settings.model);

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

    // Only attach the screenshot to the FIRST batch — it's the same image
    // for every batch on this step and resending it would burn tokens.
    const attachImage = useVision && i === 0 && !!args.screenshot;
    const userContent: string | ChatContentPart[] = attachImage
      ? [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: args.screenshot!, detail: "high" },
          },
        ]
      : userPrompt;

    const systemPrompt = attachImage
      ? `${FIELD_MAPPING_SYSTEM_PROMPT}\n\n${FIELD_MAPPING_VISION_HINT}`
      : FIELD_MAPPING_SYSTEM_PROMPT;

    try {
      const { content } = await chatComplete({
        apiKey: args.settings.openaiApiKey,
        apiBaseUrl: args.settings.apiBaseUrl,
        model: args.settings.model,
        temperature: 0,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
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

/**
 * Workday tenants split phone into 2-3 fields:
 *   Country Phone Code (combobox)  +  Phone Number  + optional Phone Extension
 *
 * If a separate country-code field exists on the form, the Phone Number must
 * be LOCAL digits (no +91 prefix). Otherwise we send E.164.
 */
function formatPhoneForWorkday(
  p: ResumeProfile,
  hasCountryCodeFieldOnForm: boolean,
): string | undefined {
  const override = p.demographics?.phoneFormatted?.trim();
  const raw = p.contact.phone?.trim() ?? override;
  if (!raw) return undefined;

  // Strip everything except digits / +
  const compact = raw.replace(/[^\d+]/g, "");
  const digitsOnly = compact.replace(/\D/g, "");

  // When the form has a Country Phone Code field, only send local digits.
  if (hasCountryCodeFieldOnForm) {
    // Drop a leading country code (most are 1-3 digits) to keep the local part.
    const local =
      compact.startsWith("+") && digitsOnly.length > 10
        ? digitsOnly.slice(digitsOnly.length - 10)
        : digitsOnly.length > 10
          ? digitsOnly.slice(digitsOnly.length - 10)
          : digitsOnly;
    return local;
  }

  // Otherwise send full E.164 if we can.
  if (compact.startsWith("+") && digitsOnly.length >= 10) return compact;
  const ccStored = (p.contact.phoneCountryCode ?? "").replace(/[^\d+]/g, "");
  const country = (p.contact.address?.country ?? "").toLowerCase();
  if (digitsOnly.length === 10 && (country.includes("india") || /^\+?91$/.test(ccStored))) {
    return "+91" + digitsOnly;
  }
  return (override ?? raw.replace(/[^\d+\-\s()]/g, "").trim()) || undefined;
}

/** Built fresh for each heuristic pass so rules can see sibling labels. */
interface RuleCtx {
  hasCountryCodeField: boolean;
}

interface Rule2 {
  match: RegExp;
  resolve: (
    p: ResumeProfile,
    f: DetectedField,
    ctx: RuleCtx,
  ) => string | string[] | null | undefined;
}

function pickExperience(p: ResumeProfile, idx: number): typeof p.experience[number] | undefined {
  return p.experience?.[idx];
}
function pickEducation(p: ResumeProfile, idx: number): typeof p.education[number] | undefined {
  return p.education?.[idx];
}

function fmtMmYyyy(d?: string): string | undefined {
  if (!d) return undefined;
  if (/^present$/i.test(d)) return "Present";
  const m = d.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, "0")}/${m[1]}`;
  return d;
}

/** Netflix / US tenants often expect MM/DD/YYYY on From/To prompts. */
function fmtWorkdayRangeDate(d?: string): string | undefined {
  if (!d) return undefined;
  if (/^present$/i.test(d)) return "Present";
  const full = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (full) {
    return `${full[2].padStart(2, "0")}/${full[3].padStart(2, "0")}/${full[1]}`;
  }
  const ym = d.match(/^(\d{4})-(\d{1,2})$/);
  if (ym) return `${ym[2].padStart(2, "0")}/01/${ym[1]}`;
  return fmtMmYyyy(d);
}

/**
 * Rules for fields inside a repeatable row (Work Experience / Education).
 * `f.repeatIndex` tells us which experience / education entry to use.
 * These run BEFORE the generic rules below.
 */
const REPEAT_RULES: Rule2[] = [
  {
    match: /\b(company|employer|organization)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const sect = (f.section ?? "").toLowerCase();
      if (/educat/.test(sect)) return null;
      return pickExperience(p, f.repeatIndex ?? 0)?.company ?? null;
    },
  },
  {
    match: /\b(job\s*title|position|role|^title$)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const sect = (f.section ?? "").toLowerCase();
      if (/educat/.test(sect)) return null;
      return pickExperience(p, f.repeatIndex ?? 0)?.title ?? null;
    },
  },
  {
    match: /\b(location|city)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const sect = (f.section ?? "").toLowerCase();
      if (/educat/.test(sect)) return null;
      return pickExperience(p, f.repeatIndex ?? 0)?.location ?? null;
    },
  },
  {
    match: /\b(from|start\s*date|start)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const sect = (f.section ?? "").toLowerCase();
      if (/educat/.test(sect)) {
        return fmtWorkdayRangeDate(pickEducation(p, f.repeatIndex ?? 0)?.startDate) ?? null;
      }
      return fmtWorkdayRangeDate(pickExperience(p, f.repeatIndex ?? 0)?.startDate) ?? null;
    },
  },
  {
    match: /\b(to|end\s*date|through|until)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const sect = (f.section ?? "").toLowerCase();
      if (/educat/.test(sect)) {
        return fmtWorkdayRangeDate(pickEducation(p, f.repeatIndex ?? 0)?.endDate) ?? null;
      }
      const e = pickExperience(p, f.repeatIndex ?? 0);
      if (e?.current) return "Present";
      return fmtWorkdayRangeDate(e?.endDate) ?? null;
    },
  },
  {
    match: /\b(summary|responsibilit|description|highlight|achievement)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const e = pickExperience(p, f.repeatIndex ?? 0);
      if (!e) return null;
      if (e.summary) return e.summary;
      if (e.bullets?.length) return e.bullets.join("\n");
      return null;
    },
  },
  {
    match: /\b(currently\s*work|i\s*currently\s*work)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      const e = pickExperience(p, f.repeatIndex ?? 0);
      return e?.current ? "true" : null;
    },
  },
  {
    match: /\b(school|university|institution|college)\b/i,
    resolve: (p, f) =>
      f.repeatable ? pickEducation(p, f.repeatIndex ?? 0)?.school ?? null : null,
  },
  {
    match: /\bdegree\b/i,
    resolve: (p, f) =>
      f.repeatable ? pickEducation(p, f.repeatIndex ?? 0)?.degree ?? null : null,
  },
  {
    match: /\b(field\s*of\s*study|major|discipline)\b/i,
    resolve: (p, f) =>
      f.repeatable ? pickEducation(p, f.repeatIndex ?? 0)?.fieldOfStudy ?? null : null,
  },
  {
    match: /\b(writing|reading|speaking|comprehension|overall|listening|oral)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      if (!/(language|languages|lingua|fluency|proficiency)/i.test(f.section ?? "")) return null;
      const lang = p.languages?.[f.repeatIndex ?? 0];
      const pr = lang?.proficiency?.trim();
      if (pr) return pr;
      return "Fluent";
    },
  },
  {
    match: /\b(language(\s*name)?|select\s*language|language\s*select|^\s*language\s*$)\b/i,
    resolve: (p, f) => {
      if (!f.repeatable) return null;
      if (!/(language|languages|lingua)/i.test(f.section ?? "")) return null;
      if (/\b(writing|reading|speaking|comprehension|overall)\b/i.test(`${f.label} ${f.ariaLabel}`)) {
        return null;
      }
      return p.languages?.[f.repeatIndex ?? 0]?.name ?? null;
    },
  },
];

const HEURISTIC_RULES: Rule2[] = [
  ...REPEAT_RULES,
  { match: /\b(given\s*name|first\s*name|forename)\b/i, resolve: (p) => p.contact.firstName },
  { match: /\b(family\s*name|last\s*name|surname)\b/i, resolve: (p) => p.contact.lastName },
  { match: /\bmiddle\s*name\b/i, resolve: (p) => p.contact.middleName },
  { match: /\b(full\s*name|legal\s*name|name)\b/i, resolve: (p, f) => {
    const h = `${f.label} ${f.ariaLabel ?? ""}`;
    if (/user\s*name|login|account\s*name/i.test(h)) return undefined;
    return p.contact.fullName;
  }},
  { match: /\b(e-?mail|email\s*address)\b/i, resolve: (p) => p.contact.email },

  // Must run BEFORE the generic phone rule.
  {
    match: /\b(phone\s*device\s*type|device\s*type|type\s*of\s*phone|phone\s*type)\b/i,
    resolve: (p) => p.demographics?.phoneDeviceType ?? "Mobile",
  },
  // Skip extension explicitly so it doesn't grab the phone number.
  { match: /\b(phone\s*extension|extension|ext\.?)\b/i, resolve: () => undefined },

  {
    match: /\b(phone|mobile|telephone|cell|contact\s*number)\b/i,
    resolve: (p, f, ctx) => {
      const h = `${f.label} ${f.ariaLabel ?? ""}`;
      if (/device\s*type|equipment\s*type|phone\s*type\b|extension|\bext\.?\b/i.test(h)) {
        return undefined;
      }
      return formatPhoneForWorkday(p, ctx.hasCountryCodeField);
    },
  },
  { match: /\b(country\s*phone\s*code|phone\s*country\s*code|country\s*code)\b/i, resolve: (p) => {
    const cc = (p.contact.phoneCountryCode ?? "").replace(/[^\d+]/g, "");
    if (cc) return cc.startsWith("+") ? cc : `+${cc}`;
    const country = (p.contact.address?.country ?? "").toLowerCase();
    if (country.includes("india")) return "+91";
    return undefined;
  }},
  { match: /\b(address\s*line\s*1|street)\b/i, resolve: (p) => p.contact.address?.line1 },
  { match: /\baddress\s*line\s*2\b/i, resolve: (p) => p.contact.address?.line2 },
  { match: /\b(city|town)\b/i, resolve: (p) => p.contact.address?.city },
  { match: /\b(state|province|region)\b/i, resolve: (p) => p.contact.address?.state },
  { match: /\b(zip|postal\s*code|postcode)\b/i, resolve: (p) => p.contact.address?.postalCode },
  { match: /\bcountry\b/i, resolve: (p) => p.contact.address?.country },
  {
    match: /\b(sponsorship|visa\s*sponsor|require\s*sponsorship|employment\s*visa)\b/i,
    resolve: (p, f) => {
      const h = `${f.label} ${f.ariaLabel ?? ""}`;
      if (!/sponsor|visa|immigration|legal|work|authori/i.test(h)) return undefined;
      const v = p.demographics?.requiresSponsorship;
      if (v === true || v === "Yes" || v === "yes") return "Yes";
      if (v === false || v === "No" || v === "no") return "No";
      if (typeof v === "string" && v.trim()) return v.trim();
      return "No";
    },
  },
  {
    match: /\bsubsidiar/i,
    resolve: (p, f) => {
      const h = `${f.label} ${f.ariaLabel ?? ""}`;
      if (!/\bnetflix\b/i.test(h)) return undefined;
      return p.demographics?.previouslyEmployedAtCompany === true ? "Yes" : "No";
    },
  },
  { match: /\blinkedin\b/i, resolve: (p) => p.contact.links?.linkedin },
  { match: /\bgithub\b/i, resolve: (p) => p.contact.links?.github },
  { match: /\b(portfolio|website|personal\s*site)\b/i, resolve: (p) => p.contact.links?.portfolio },
  { match: /\bhow did you hear\b/i, resolve: (p) => p.demographics?.howDidYouHear ?? "LinkedIn" },
  {
    match:
      /\b(are\s*you\s*currently|currently\s*working|do\s*you\s*currently)\b.*\b(contractor|contingent|vendor|temporary\s*worker|independent\s*contractor)\b/i,
    resolve: (p, f) => {
      const h = `${f.label} ${f.ariaLabel ?? ""}`;
      if (
        !/\b(netflix|this\s*company|for\s*us|for\s*the\s*company|the\s*organization|employer|here|this\s*role)\b/i.test(
          h,
        ) &&
        !/\bnetflix\b/i.test(h)
      ) {
        return undefined;
      }
      const v = p.demographics?.currentlyContractorAtEmployer;
      if (v === true) return "Yes";
      if (v === false) return "No";
      if (typeof v === "string") {
        const s = v.trim();
        if (s) return s;
      }
      return "No";
    },
  },
  {
    match: /\bpreviously employed\b/i,
    resolve: (p) =>
      p.demographics?.previouslyEmployedAtCompany === true ? "Yes" : "No",
  },
  {
    match: /\b(type\s*to\s*add\s*skills|add\s*skills|search\s*skills)\b/i,
    resolve: (p, f) => {
      const parts = (p.skills ?? []).filter(Boolean).slice(0, 20);
      if (!parts.length) return undefined;
      if (f.kind === "combobox" || f.kind === "multiselect") return parts;
      return parts.join(", ");
    },
  },
];

function heuristicMap(
  fields: DetectedField[],
  profile: ResumeProfile,
): MappedValue[] {
  const ctx: RuleCtx = {
    hasCountryCodeField: fields.some((f) =>
      /\b(country\s*phone\s*code|phone\s*country\s*code|country\s*code)\b/i.test(
        `${f.label} ${f.ariaLabel ?? ""}`,
      ),
    ),
  };
  const out: MappedValue[] = [];
  for (const f of fields) {
    if (f.kind === "file") continue;
    // Workday repeat rows often have blank labels for additional rows but
    // always set a unique `data-automation-id` like `formField-jobTitle$NNN`.
    // Include the base name (jobTitle, company, school, degree, ...) so the
    // regexes can still classify the field even when the visible label is
    // empty.
    const autoBase = (f.formFieldAutomationId ?? "")
      .replace(/^formField-?/, "")
      .replace(/\$.*$/, "")
      // camelCase → space-separated so /\bjob\s*title\b/ works robustly
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    const haystack = `${f.label} ${f.ariaLabel ?? ""} ${f.placeholder ?? ""} ${autoBase}`;
    for (const rule of HEURISTIC_RULES) {
      if (rule.match.test(haystack)) {
        const v = rule.resolve(profile, f, ctx);
        if (v === undefined) {
          // Rule explicitly opted out — skip remaining rules so generic
          // ones don't claim this field.
          break;
        }
        const hasValue = Array.isArray(v)
          ? v.length > 0
          : v != null && String(v).trim() !== "";
        if (hasValue) {
          out.push({
            id: f.id,
            value: v as string | boolean | string[],
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
  const autoBase = (f.formFieldAutomationId ?? "")
    .replace(/^formField-?/, "")
    .replace(/\$.*$/, "");
  return {
    id: f.id,
    label: f.label || autoBase,
    automationName: autoBase || undefined,
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
