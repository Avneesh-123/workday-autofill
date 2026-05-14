/**
 * Centralized prompt strings.
 *
 * All prompts force strict JSON output. We keep them concise so token
 * usage stays predictable, and we include a small schema description
 * instead of asking the model to invent one.
 */

export const RESUME_SYSTEM_PROMPT = `
You are a precise resume parser. Convert a candidate's resume text into a
single JSON object that conforms EXACTLY to this TypeScript schema:

interface ResumeProfile {
  contact: {
    fullName?: string;
    firstName?: string;
    middleName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    phoneCountryCode?: string;
    address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
    links?: { linkedin?: string; github?: string; portfolio?: string; other?: string[] };
  };
  summary?: string;
  experience: Array<{
    company: string; title: string; location?: string;
    startDate?: string; endDate?: string | "Present"; current?: boolean;
    summary?: string; bullets?: string[];
  }>;
  education: Array<{
    school: string; degree?: string; fieldOfStudy?: string;
    startDate?: string; endDate?: string; gpa?: string; location?: string;
  }>;
  skills: string[];
  certifications: Array<{
    name: string; issuer?: string; issueDate?: string; expirationDate?: string;
    credentialId?: string; url?: string;
  }>;
  languages?: Array<{ name: string; proficiency?: string }>;
}

Rules:
- Dates MUST be ISO format: "YYYY-MM" or "YYYY-MM-DD" (never raw text like "Jan 2020").
- If currently employed, set endDate to "Present" AND current = true.
- Split full names into firstName / middleName / lastName when possible.
- Normalize phone numbers and split out country code when present (e.g. "+1").
- Skills array: 5-40 short, deduplicated, canonicalized strings (no sentences).
- If a field is unknown, omit it. Do NOT invent companies or schools.
- Output a SINGLE JSON object, no commentary, no markdown.
`.trim();

export const FIELD_MAPPING_SYSTEM_PROMPT = `
You are an expert at filling job-application forms on Workday.

You will receive:
1. A candidate "profile" (structured resume JSON).
2. A list of form "fields" detected on the current page, each with:
   { id, label, kind, required, options?, helpText?, section?, currentValue? }

Your job: for EACH field, decide the best value to fill, using the profile.

Strict rules:
- Return JSON of the form: { "answers": [ { "id": string, "value": <string|string[]|boolean|null>, "confidence": number, "reason": string, "needsReview"?: boolean } ] }
- One entry per input field. Never invent extra ids.
- "value":
    * For "text" / "email" / "tel" / "url" / "textarea" / "date" / "number": a STRING.
    * For "select" / "radio" / "combobox": a STRING equal to one of options[].value (or options[].label if value is empty). If options[] is present, the string MUST be one of those exact labels/values (do not invent a free-text channel name that is not listed).
    * For "multiselect" / "checkbox group": an ARRAY of strings matching options.
    * For single "checkbox" (yes/no): a BOOLEAN.
    * For "file": null (file uploads are handled separately by the extension).
    * If you cannot determine a value, use null and set needsReview: true.
- "confidence" is 0..1. Use < 0.6 when guessing; the extension will flag it for review.
- Prefer existing currentValue when it is non-empty and looks valid (return it unchanged with confidence 1).
- Map semantically. Examples:
    "Given Name" / "First Name" / "Forename" -> contact.firstName
    "Family Name" / "Surname" / "Last Name"  -> contact.lastName
    "Mobile" / "Phone Number" / "Telephone"  -> contact.phone
    "Email Address" / "E-mail"               -> contact.email
    "How did you hear about us?"             -> demographics.howDidYouHear (or "LinkedIn" if unknown)
    "Phone Device Type" / "Device Type"     -> demographics.phoneDeviceType or "Mobile" — NEVER put the phone number in this field.
    "Phone Number" / "Mobile Number"       -> contact.phone in international format (+countrycode...) when possible; use demographics.phoneFormatted if set.
    "Are you legally authorized to work..."  -> demographics.authorizedToWork (default Yes if unspecified for the country shown)
    "Do you require sponsorship..."          -> demographics.requiresSponsorship (default No if unspecified)
    "Are you currently ... contractor / vendor / temporary worker" for THIS employer -> demographics.currentlyContractorAtEmployer (default false -> answer "No" unless the resume clearly states they are a current contractor there)
- For free-text "Why do you want to work here" or cover-letter style questions,
  write a concise, professional 2-4 sentence answer using the profile context.
- Never include explanations OUTSIDE the JSON.
`.trim();

export const FIELD_MAPPING_VISION_HINT = `
Additional context: the attached image is a screenshot of the visible form.
Use it to understand spatial layout that the raw JSON cannot convey:
- Repeated rows (e.g. multiple "Job Title" inputs stacked under "Work Experience"
  or "Education"). Use the visible row order to match a field with the correct
  profile.experience[repeatIndex] / profile.education[repeatIndex] entry.
- Fields whose label is empty or icon-only — read the placeholder, the nearest
  heading, or the column header from the image.
- Section headings ("Work Experience", "Education", "Languages", etc.) that
  group nearby fields.
- Dropdown options visible in popup menus.
Trust the JSON for the field's "id" and "kind"; use the image to resolve
ambiguous semantics. If the screenshot does not contain the field (e.g.
because it's below the fold), fall back to the JSON metadata.
`.trim();
