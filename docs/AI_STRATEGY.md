# AI Prompting Strategy

We use two distinct prompts: **resume structuring** (one-time per
upload) and **field mapping** (per step, batched).

Both prompts share the same hard rules:

- `temperature: 0` for determinism.
- `response_format: { type: "json_object" }` to guarantee parseable JSON.
- Strict schema documented inline in the system prompt.
- Explicit "omit / null / `needsReview`" fallbacks - we'd rather get
  no answer than a hallucinated one.

---

## 1. Resume structuring

**Goal:** convert noisy resume text into a typed `ResumeProfile` JSON
object.

**System prompt (excerpt):**

```
You are a precise resume parser. Convert a candidate's resume text
into a single JSON object that conforms EXACTLY to this TypeScript
schema: { contact, experience[], education[], skills[], ... }.

Rules:
- Dates MUST be ISO format: "YYYY-MM" or "YYYY-MM-DD".
- Set endDate="Present" + current=true for current jobs.
- Split fullName into firstName / middleName / lastName when possible.
- Normalize phone numbers and split out country code.
- Skills: 5-40 short, deduplicated strings (no sentences).
- If a field is unknown, omit it. Do NOT invent companies or schools.
- Output a SINGLE JSON object - no commentary, no markdown.
```

**User message** contains:

1. Heuristic hints (email/phone/linkedin/github regex matches) -
   gives the model strong anchors it can confirm or reject.
2. The first 16 000 characters of the extracted resume text.

**Post-processing** (`src/lib/ai/resume.ts`):

- If the model returned `fullName` but not `firstName` / `lastName`,
  we split it deterministically.
- We coerce missing arrays to `[]` so downstream code never crashes
  on undefined.

---

## 2. Field mapping

**Goal:** for each detected field, produce the literal value to fill,
plus a confidence and a one-line reason for the review screen.

**System prompt (excerpt):**

```
You are an expert at filling job-application forms on Workday.

You will receive:
1. profile: structured resume JSON.
2. fields: list of form fields with
   { id, label, kind, required, options?, helpText?, section?, currentValue? }

Return JSON of the form:
{ "answers": [
  { "id": <string>, "value": <string|string[]|boolean|null>,
    "confidence": <0..1>, "reason": <string>, "needsReview"?: <bool> }
] }

- One entry per field.
- For select/radio -> string equal to one of options[].value (or label).
- For multiselect / checkbox group -> array of strings.
- For single yes/no checkbox -> boolean.
- For file -> null (handled separately).
- If you cannot decide -> null + needsReview: true.

Examples of mapping:
  "Given Name" / "Forename"  -> contact.firstName
  "Family Name" / "Surname"  -> contact.lastName
  "How did you hear about us?" -> demographics.howDidYouHear
  "Are you legally authorized..." -> demographics.authorizedToWork
```

**Batching strategy:**

- Fields are sent in batches (default 12, configurable 4-24).
- Each batch is a fresh chat; we never reuse a long conversation.
- We trim the profile aggressively before sending: truncate summary
  to 800 chars, cap experience to 6 entries with 400-char summaries
  and 6 bullets each, etc. This keeps prompt tokens bounded.

**Hybrid heuristic + AI:**

Before calling the model, `field-mapper.ts` runs a deterministic regex
matcher (`HEURISTIC_RULES`) for trivial labels (first/last name,
email, phone, address parts, LinkedIn, GitHub). Those answers come
back with `confidence: 0.95` and `reason: "Heuristic label match"`.

Only the unresolved fields go to the AI. This:

1. Reduces token cost (~40% on a typical Workday Personal Info step).
2. Improves reliability - heuristics work even without an API key.
3. Eliminates failure modes where the AI misclassifies a clearly-named
   field.

---

## 3. Long-form questions ("Why do you want to work here?")

The mapping prompt includes:

> For free-text "Why do you want to work here" or cover-letter style
> questions, write a concise, professional 2-4 sentence answer using
> the profile context.

These answers are flagged `needsReview: true` in the review overlay so
the candidate can edit them before submitting.

---

## 4. Failure modes and how we handle them

| Failure | Mitigation |
|--------|------------|
| Rate limit / 5xx from OpenAI | `client.ts` retries with exponential backoff up to 2 times. |
| Model returns prose instead of JSON | `safeParseJson` strips ``` fences and falls back to a regex match for the trailing JSON block. |
| Model invents an option not in `options[]` | `filler.ts` does fuzzy matching against `options`; if no match found, returns an error which surfaces in the review screen. |
| Field has no obvious answer | Model is instructed to return `null` + `needsReview` rather than guess. |

---

## 5. Token budget (representative)

Per Workday step with ~15 fields on `gpt-4o-mini`:

- System prompt: ~700 tokens.
- Trimmed profile: ~1 500 tokens.
- Fields batch (12): ~700 tokens.
- Response: ~800 tokens.
- **Total: ~3 700 tokens** -> well under $0.01/step at
  `gpt-4o-mini` pricing.
