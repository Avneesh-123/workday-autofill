# Limitations & Known Issues

## 1. File uploads cannot be programmatically forged

Chrome's security model prevents extension-injected JS from
attaching a `File` to an `<input type="file">`. We detect file-upload
fields, surface them in the overlay, and pause for the user to drop
the resume in manually. This is a one-click action and is industry
standard (LinkedIn Easy Apply does the same).

## 2. CAPTCHA / re-authentication

The assignment explicitly forbids bypassing authentication, and we
don't try. If a tenant inserts a CAPTCHA or MFA challenge mid-flow,
the extension's autofill pauses on that step and the user completes
it manually before resuming.

## 3. Scanned PDF resumes

`pdf.js` can only read text layers. Scanned image PDFs return an
empty string. We detect this and surface a clear error message in the
popup. OCR is out of scope for this assignment.

## 4. Highly custom Workday tenants

While Workday provides `data-automation-id` for most controls, some
customers ship custom React widgets (e.g. interactive video questions,
LinkedIn import buttons, embedded chats). These widgets aren't part
of the assignment's success criteria and are skipped gracefully.

## 5. Very long resumes

We send up to 16 000 characters of resume text to the AI for
structuring. Resumes longer than that get truncated. In practice
this affects no normal CV (a verbose 4-page CV is ~12 000 chars).

## 6. AI cost & latency

Each step that needs mapping costs **\< $0.01** with `gpt-4o-mini`
and roughly 1-3 seconds of latency. On `gpt-4o` quality is slightly
higher (better at tricky open-ended questions) but cost ~10x and
latency ~2x.

## 7. Repeatable sections cap

We call "Add Another" up to (`profile.experience.length - 1`) times
and similarly for education. If the candidate has 10 jobs and the
form caps at 5, the navigator stops at the form's limit.

## 8. Field re-detection cost

After every step transition we re-run the detector instead of trying
to diff. This is intentional (Workday rewrites the DOM aggressively
on step changes) but adds ~150 ms per step. The trade-off is worth
it for reliability.

## 9. Locale handling

Currently the prompt and date parsing assume English-locale Workday
tenants (which is what the assignment's sample postings use). Adding
locale-specific date formats and label dictionaries is a clean
extension: just add localized rules to `HEURISTIC_RULES` and pass
locale into the AI prompt.

## 10. Network privacy

The only network destinations the extension contacts are:

- `api.openai.com` (resume parsing + field mapping).
- The Workday tenant origin (passively, via the page itself).

No analytics, no telemetry. The OpenAI key lives only in
`chrome.storage.local` on the user's machine.
