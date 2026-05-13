# Demo Recording Script

Use this as a shot list when recording the deliverable demo video.
Target length: 2-3 minutes.

## 0. Setup (off-camera)

- Chrome with the unpacked extension installed (`dist/`).
- A funded OpenAI API key already saved in the **Options** page.
- A sample resume `sample-resume.pdf` on the desktop.
- Have one Workday tenant open and the apply button visible, e.g.
  <https://nvidia.wd5.myworkdayjobs.com>.

## 1. Resume upload (~25 s)

1. Click the extension icon -> the popup opens.
2. Click **Upload resume** and pick `sample-resume.pdf`.
3. Show the popup updating to:
   - `Loaded: sample-resume.pdf`
   - Name + counts of experience / education / skills
4. Click **Settings** and scroll to the **Resume profile (JSON)** card
   to show the structured output. Mention this is editable.

## 2. Workday application start (~10 s)

1. Switch to the Workday tab on the job posting page.
2. Click **Apply** -> show the Workday wizard step 1 (Personal Info).

## 3. Autofill run (~60 s)

1. Open the extension popup -> click **Autofill now**.
2. The overlay appears bottom-right. Show:
   - Step counter + step name (e.g. "My Information").
   - Live progress bar filling.
   - Log lines: "Step 1: filled 11/12".
3. Let it navigate through Experience, Education and Voluntary
   Self-Identification steps.

## 4. Review & confirm (~30 s)

1. Show the Review overlay on the final step.
2. Scroll through to highlight:
   - Filled fields (green pill).
   - Skipped fields (grey).
   - Low-confidence pills on any free-text answers.
3. Edit one answer directly in the Workday DOM (to demonstrate the
   extension never overwrites manual edits).
4. Click **Confirm & Submit**.

## 5. Outcome (~10 s)

- Show Workday's "Application Submitted" confirmation page.
- Overlay updates to "Application submitted!".

## 6. Wrap-up (~10 s)

- Mention key talking points:
  - Manifest V3.
  - Two-stage AI pipeline (parse + map).
  - No automatic submission - user always confirms.
  - All data stays local; only AI call goes to OpenAI.
