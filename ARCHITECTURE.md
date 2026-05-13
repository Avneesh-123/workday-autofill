# Architecture

## 1. High-level diagram

```
+-----------------+        +-------------------+        +------------------+
|  Popup (React)  |  --->  |  Background SW    |  --->  |  api.openai.com  |
|  - upload PDF   |        |  (service worker) |        +------------------+
|  - start run    |        |  - AI proxy       |
+--------+--------+        |  - storage ops    |
         |                 +---------+---------+
         |                           |
         v                           v
+-----------------+        +-------------------+
|  Options (React)|        |   Content script  |
|  - API key      |        |   on Workday tab  |
|  - profile JSON |        |  - detector       |
+-----------------+        |  - filler         |
                           |  - navigator      |
                           |  - in-page overlay|
                           +-------------------+
```

## 2. Module responsibilities

### `src/lib/types.ts`

Single source of truth for shared types: `ResumeProfile`,
`DetectedField`, `MappedValue`, the runtime message protocol, and
`UserSettings`. Every other module imports from here so the popup,
background and content scripts speak the same language.

### `src/lib/storage.ts`

Thin wrapper over `chrome.storage.local`. Centralizes keys (`wda:*`)
and applies `DEFAULT_SETTINGS` so we never have to deal with
undefined preference values downstream.

### `src/lib/parser/`

| File | Responsibility |
|------|----------------|
| `pdf.ts` | `pdf.js` text extraction. Groups items by Y-coordinate so we preserve line order. |
| `docx.ts` | `mammoth.extractRawText` wrapper. |
| `resume-parser.ts` | Format-aware dispatch + heuristic hints (email/phone/links regex) + call to `aiStructureResume`. |

### `src/lib/ai/`

| File | Responsibility |
|------|----------------|
| `client.ts` | Minimal `fetch` wrapper around `POST /v1/chat/completions` with exponential-backoff retries and a tolerant JSON parser. |
| `prompts.ts` | Frozen system prompts for resume structuring and field mapping. |
| `resume.ts` | Calls the resume prompt, normalizes the JSON, derives `firstName`/`lastName` from `fullName` if missing. |
| `field-mapper.ts` | Two-stage mapping: heuristic label matcher first, then GPT for the remainder. Falls back to heuristics-only if no API key is configured. |

### `src/content/workday/`

| File | Responsibility |
|------|----------------|
| `dom-utils.ts` | Native-value setter, real-click sequence, focus/blur, `waitForStableDom`, `waitFor`, `byAuto` (Workday `data-automation-id` selector). |
| `detector.ts` | Walks the DOM, finds every Workday "form field", normalizes into `DetectedField[]` and returns a registry mapping IDs back to live elements. |
| `filler.ts` | Per-kind fill routines: text, select, combobox, multiselect, radio, checkbox, date, file. |
| `navigator.ts` | Step detection, Next/Submit button location, repeatable section ("Add Another") expansion. |

### `src/content/index.ts`

Pipeline orchestrator running inside the Workday page:

```
loop steps:
  wait for stable DOM
  expand "Add Another <Experience|Education>" rows
  detectFields() -> DetectedField[]
  background: mapFields(profile, fields) -> MappedValue[]
  filler.fillAll(answers)
  if submit button visible -> overlay.showReview() -> wait user confirm -> click submit
  else -> clickNext() and continue
```

### `src/content/ui/overlay.ts`

Plain DOM widget that mounts a status panel + review screen. Built
without React on purpose - lighter, no clashing roots, and works even
if Workday's React tree mutates aggressively.

### `src/background/service-worker.ts`

The only place that uses the OpenAI key for field mapping. Receives:
- `MAP_FIELDS` -> calls `mapFields(...)` from `lib/ai/field-mapper.ts`.
- Profile / settings get/set.
- `START_AUTOFILL` -> forwards to active tab content script.

Resume parsing is intentionally **not** done here because `pdf.js`
workers don't behave well inside Manifest V3 service workers. The
popup (a normal extension page) does the parsing instead.

## 3. Data flow on a typical application

1. User loads a Workday application.
2. Content script lazy-mounts (no work until messaged).
3. User clicks **Autofill now** in the popup.
4. Popup -> `chrome.tabs.sendMessage({ type: "START_AUTOFILL" })`.
5. Content script: detect step -> detect fields -> send to background.
6. Background: heuristic fill + GPT batch mapping -> returns answers.
7. Content script: fill each field, update overlay progress.
8. Content script: click Next, wait for next step, repeat.
9. On final step: render Review overlay -> wait for `Confirm & Submit`.
10. Submit clicked -> Workday confirmation page detected -> overlay
    shows "Application submitted!".

## 4. Resilience strategies

- **Stable selectors**: We anchor on `data-automation-id` first
  (Workday-owned, contract-stable across tenants); CSS classes are
  only fallback.
- **Native event simulation**: React inputs only react to events
  dispatched via the prototype setter trick. We use it everywhere.
- **MutationObserver-based waits**: We never `sleep(N)` blindly between
  steps. `waitForStableDom` ensures the DOM is quiet before we read.
- **Per-batch AI failures**: If one mapping batch fails (rate limit,
  500), only that batch's fields are flagged `needsReview`; the rest
  still fill.
- **Heuristic floor**: Even with no API key (offline / quota exhausted)
  the extension fills the deterministic 80% (contact, address, links).

## 5. Why these technology choices?

- **Vite + @crxjs/vite-plugin** - first-class MV3 support, automatic
  manifest entry-point wiring, fast HMR for the popup/options pages.
- **React (popup/options) + vanilla DOM (overlay)** - React is great
  for UI surfaces we own, but the in-page overlay must coexist with
  Workday's React tree without root collisions, so we use plain DOM
  for that one widget.
- **OpenAI REST directly** - no SDK lock-in, smaller bundle, works
  identically from service worker, popup or content script.
- **`pdf.js` + `mammoth`** - mature, MIT-licensed, run entirely
  in-browser; no server round-trip needed for parsing.
