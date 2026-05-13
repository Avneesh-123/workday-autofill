# Workday Autofill (AI)

An AI-powered Chrome extension (**Manifest V3**) that automates job
application submission on **Workday** career portals.

It is designed for noisy, real-world Workday tenants - NVIDIA, Netflix,
PNC, Remitly, etc. - where field labels, layouts and step flows differ
across customers. Rather than hard-coding selectors per company, it
uses a combination of **DOM heuristics** (`data-automation-id` anchors)
and **GPT-4o-mini** for semantic field mapping.

---

## Highlights

- **Resume parsing** of PDF and DOCX via `pdf.js` + `mammoth`, with an
  AI structuring pass that returns a strict JSON schema.
- **AI-driven field mapping** with a two-stage pipeline: deterministic
  heuristics for trivial labels, batched GPT calls for everything else.
- **React-aware filling** - uses the native value setter trick so
  Workday's React-controlled inputs accept values reliably.
- **Multi-step navigation** - automatic "Save and Continue" detection,
  repeatable-section expansion (`Add Another`), MutationObserver-based
  step transitions.
- **In-page review overlay** - shows every answer (with confidence,
  reason and low-confidence warning) and submits **only** on explicit
  user confirmation.
- **Pre-fill respect** - never overwrites valid existing values.
- **All sensitive data stays local** - API key + parsed profile live
  in `chrome.storage.local`; the only network call goes directly to
  `api.openai.com`.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Build the extension
npm run build      # or: npm run dev for watch mode

# 3. Load in Chrome
#    chrome://extensions -> "Load unpacked" -> select ./dist
```

### First-run configuration

1. Click the extension icon -> **Settings**.
2. Choose an AI provider:
   - **Free (recommended if you have no OpenAI billing):** click **Use Groq (free tier)**,
     create a key at <https://console.groq.com/keys> (no credit card),
     paste it into **API key** (starts with `gsk_...`), and leave the base URL as
     `https://api.groq.com/openai/v1`. Pick a Groq model such as `llama-3.1-8b-instant`.
   - **OpenAI:** click **Use OpenAI**, paste an `sk-...` key, leave **API base URL** empty,
     pick `gpt-4o-mini` or `gpt-4o`.
3. Open the popup again -> **Upload resume** (PDF or DOCX).
   The extension parses it, structures it with the LLM, and stores the profile.
4. (Optional) In **Settings**, scroll down to **Resume profile (JSON)**
   to review/edit. Fill in `demographics` (work auth, sponsorship,
   `howDidYouHear`, `previouslyEmployedAtCompany`, gender, veteran, disability,
   salary, notice period) so common Workday questions answer correctly even
   with minimal AI calls.

### Running on a Workday application

1. Open any Workday job posting, e.g.
   <https://nvidia.wd5.myworkdayjobs.com>.
2. Click **Apply** to land on the application flow.
3. Open the extension popup -> **Autofill now**.
4. Watch the bottom-right overlay - it walks each step, fills fields,
   then stops on the final Submit step with a **Review** screen.
5. Verify the values, then click **Confirm & Submit**.

---

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full diagram and
module-by-module breakdown.

```
src/
  background/       - service worker (AI proxy, message router)
  content/          - injected into Workday pages
    workday/        - detector, filler, navigator, dom-utils
    ui/             - in-page status & review overlay
    index.ts        - orchestrates the multi-step pipeline
  lib/
    ai/             - OpenAI-compatible REST client, prompts, resume + mapper
    parser/         - PDF/DOCX text extraction + heuristics
    storage.ts      - thin chrome.storage wrapper
    types.ts        - shared TypeScript types / message protocol
  popup/            - React popup (resume upload + run button)
  options/          - React options page (API key, profile editor)
  styles/           - shared CSS
manifest.config.ts  - Manifest V3 declaration (via @crxjs/vite-plugin)
vite.config.ts      - build pipeline
```

---

## AI Prompting Strategy

See [`docs/AI_STRATEGY.md`](./docs/AI_STRATEGY.md) for the full prompts
and reasoning. Short version:

| Pass | Model role | Output |
|------|------------|--------|
| Resume structuring | System prompt with a strict TS interface; user message contains heuristic hints + raw text. | A single JSON `ResumeProfile`. |
| Field mapping | System prompt explaining Workday field kinds; user message contains a trimmed profile and a batch of detected fields. | `{ answers: [{ id, value, confidence, reason, needsReview? }] }` |

Both prompts force `response_format: json_object`, temperature 0, and
include explicit fall-through rules ("return `null` and set
`needsReview` if you can't decide").

---

## Limitations

- **File uploads** (`<input type="file">`) cannot be programmatically
  forged in a Chrome extension - the security model prevents us from
  attaching a real `File` to the input. The overlay flags the resume
  upload step and the user drops the file in manually (one click).
- **Captchas / Reauth** - if a Workday tenant gates the form behind a
  CAPTCHA or re-authentication challenge the extension pauses; we
  never bypass auth.
- **Brand-new Workday flows** - if a tenant uses a wildly custom step
  (e.g. video questions, in-page chat) those steps aren't auto-filled
  and the user proceeds manually.
- **PDF resumes that are scanned images** (no text layer) - we surface
  a clear error message; OCR is out of scope.
- **Cost** - each batch of 12 fields uses roughly 1.5-3k tokens. A
  typical Workday application costs **\< $0.01** on `gpt-4o-mini`.

---

## Testing checklist

The extension has been authored against the four sample tenants in
the assignment:

- `nvidia.wd5.myworkdayjobs.com`
- `remitly.wd5.myworkdayjobs.com`
- `pnc.wd5.myworkdayjobs.com`
- `netflix.wd108.myworkdayjobs.com`

Manual test matrix:

1. Resume formats: 1-page PDF, 2-page PDF, DOCX.
2. Field types: text, email, phone, dropdown, combobox (typeahead),
   date (3-input), radio, checkbox group, file upload, textarea.
3. Flows: Create profile, Add Another Experience (3 entries), Voluntary
   Self-Identification, Review, Submit.
4. Error recovery: Disconnect network during AI call -> heuristics
   still fill contact fields; AI fields are marked `needsReview`.

---

## Security & Privacy

- The API key never leaves the extension; it is read from
  `chrome.storage.local` and sent only to the OpenAI-compatible base URL
  you configure (OpenAI or Groq).
- No analytics, no telemetry.
- No automatic submission - the user always sees a review and clicks
  Confirm.
- We honour `preservePrefilled` - if a candidate has manually entered
  a value we never overwrite it.

---

## Deliverables map

| Assignment item | Where |
|-----------------|-------|
| Source code | this repo |
| Chrome extension build | `npm run build` -> `dist/` |
| Setup instructions | README (top) |
| Architecture design | `ARCHITECTURE.md` |
| AI prompting strategy | `docs/AI_STRATEGY.md` |
| Limitations | README + `docs/LIMITATIONS.md` |
| Demo video | Record after first install (see `docs/DEMO_SCRIPT.md`) |

---

## License

MIT (for the purpose of this assignment).
