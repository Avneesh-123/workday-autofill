/**
 * Content-script entry point.
 *
 * Lifecycle:
 *  1. On message START_AUTOFILL from the popup -> begin pipeline.
 *  2. Detect fields on the current step.
 *  3. Send fields + profile to background worker for AI mapping.
 *  4. Fill fields, show overlay progress.
 *  5. If "Next/Continue" exists -> click, wait for next step, repeat.
 *  6. When a Submit-bearing step is reached -> show review overlay,
 *     wait for user confirmation, then click Submit.
 *
 * Safety:
 *  - User can click **Stop** or **×** at any time — the loop checks
 *    `userStopRequested` between steps and exits cleanly.
 *  - If **Next** does not change the page twice in a row (validation
 *    errors, disabled button), we stop instead of looping forever.
 */

import { detectFields } from "@/content/workday/detector";
import { fillAll, FillResult } from "@/content/workday/filler";
import {
  clickNext,
  detectStep,
  expandRepeatables,
  findSubmitButton,
  isApplicationPage,
} from "@/content/workday/navigator";
import { mountOverlay, OverlayHandle, PreFillItem, ReviewItem } from "@/content/ui/overlay";
import { waitForStableDom, sleep } from "@/content/workday/dom-utils";
import { workdayFatalErrorVisible } from "@/content/workday/field-resolve";
import { storage } from "@/lib/storage";
import {
  DetectedField,
  MappedValue,
  ResumeProfile,
  RuntimeMessage,
  UserSettings,
} from "@/lib/types";

let running = false;
/** Set true when user clicks Stop / × on the overlay. */
let userStopRequested = false;
let overlay: OverlayHandle | null = null;

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true, onApplication: isApplicationPage() });
    return true;
  }
  if (msg.type === "START_AUTOFILL") {
    startAutofill()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
    return true; // keep channel open for async
  }
});

/** Fingerprint of the current wizard screen — used to detect "stuck" Next clicks. */
function stepFingerprint(): string {
  const { fields, stepName } = detectFields();
  const si = detectStep();
  const title = stepName ?? si.stepName ?? location.pathname;
  const part = fields
    .map((f) => `${f.label}|${f.kind}|${(f.currentValue ?? "").slice(0, 40)}`)
    .sort()
    .join(";");
  return `${title}#${fields.length}#${part.slice(0, 900)}`;
}

async function startAutofill(): Promise<void> {
  if (running) return;

  if (workdayFatalErrorVisible()) {
    overlay?.destroy();
    overlay = mountOverlay({ onUserStop: () => {} });
    overlay.setStatus(
      "Workday's 'Something went wrong' page is already showing. Open a fresh job posting URL in a new tab and try again — autofill cannot run on this broken session.",
    );
    overlay.appendLog(
      "Refused to start: the Workday application form is no longer on the page.",
    );
    return;
  }

  running = true;
  userStopRequested = false;
  overlay?.destroy();
  overlay = mountOverlay({
    onUserStop: () => {
      userStopRequested = true;
      overlay?.appendLog("Stop requested — exiting after this step.");
    },
  });
  overlay.setStatus("Loading profile...");

  let noAdvanceCount = 0;

  try {
    const profile = await storage.getProfile();
    let settings = await storage.getSettings();
    // One-time housekeeping: earlier builds auto-enabled Safe Mode on the
    // first Workday crash and never turned it back off. The crash bug is
    // now fixed, so we reset the flag on every fresh run. If the user
    // *intentionally* wants Safe Mode they can re-enable it in Options.
    if (settings.safeMode) {
      try {
        settings = await storage.setSettings({ safeMode: false });
        overlay.appendLog("Safe Mode auto-reset (the earlier crash bug is fixed).");
      } catch {
        // non-fatal — proceed with whatever settings we have.
      }
    }
    if (!profile) {
      overlay.setStatus("No resume profile saved. Open the extension popup and upload a resume.");
      return;
    }

    let stepCount = 0;
    let cumulative: ReviewItem[] = [];

    const maxSteps = 12;

    while (stepCount < maxSteps) {
      if (userStopRequested) {
        overlay.setStatus("Stopped by you.");
        overlay.appendLog("Autofill stopped.");
        return;
      }

      stepCount++;
      await waitForStableDom(document.body, 500, 6000);

      if (workdayFatalErrorVisible()) {
        overlay.setStatus(
          "Workday hit an error. Refresh the tab, fix any red validation messages, then run autofill again.",
        );
        overlay.appendLog("Stopped: 'Something went wrong' is visible on the page.");
        return;
      }

      if (userStopRequested) {
        overlay.setStatus("Stopped by you.");
        return;
      }

      const stepInfo = detectStep();
      overlay.setStatus(`Step ${stepCount}/${maxSteps}: ${stepInfo.stepName ?? "(detecting)"}`);

      // Expand "Add" buttons (Work Experience, Education, Languages) ONCE
      // per step. Calling this multiple times stacks up duplicate empty
      // rows and Workday flags every one as a validation error.
      await expandRepeatables(
        profile.experience.length,
        profile.education.length,
        (profile.languages ?? []).length,
      );
      await waitForStableDom(document.body, 400, 4000);
      await sleep(150);

      if (userStopRequested) {
        overlay.setStatus("Stopped by you.");
        return;
      }

      const { fields, registry, stepName } = detectFields();
      if (fields.length === 0) {
        overlay.appendLog(`Step ${stepCount}: no fields detected, attempting to advance.`);
      } else {
        overlay.setStatus(`Mapping ${fields.length} fields with AI...`);
        const screenshot = settings.useVision ? await captureViewport() : undefined;
        if (screenshot) overlay.appendLog("Captured screenshot for vision model.");
        let answers = await requestMapping(fields, profile, stepName, screenshot);

        if (userStopRequested) {
          overlay.setStatus("Stopped by you.");
          return;
        }

        answers = await reviewLowConfidence(overlay, fields, answers, settings);

        if (userStopRequested) {
          overlay.setStatus("Stopped by you.");
          return;
        }

        overlay.setStatus(`Filling ${fields.length} fields...`);
        const fieldMap = new Map(fields.map((f) => [f.id, f]));
        const results = await fillAll(answers, {
          registry,
          fields: fieldMap,
          preservePrefilled: settings.preservePrefilled,
          fillPacingMs: settings.fillPacingMs,
          settleAfterFillMs: settings.settleAfterFillMs,
          safeMode: settings.safeMode,
        });
        const crashResult = results.find((r) =>
          r.message?.startsWith("Crashed Workday after filling"),
        );
        if (crashResult || workdayFatalErrorVisible()) {
          if (crashResult) {
            overlay.appendLog(crashResult.message ?? "Workday crashed during fill.");
          }
          overlay.setStatus(
            "Workday crashed during autofill. Refresh the tab and run autofill again. If the same field crashes twice, open Options and enable Safe Mode.",
          );
          overlay.appendLog("Stopped: 'Something went wrong' appeared after filling.");
          return;
        }
        const filled = results.filter((r) => r.ok).length;
        overlay.setProgress(filled, fields.length);

        // Surface per-field failure reasons so the user (and any reviewer)
        // can see exactly which fields could not be filled and why.
        for (const r of results) {
          if (r.ok) continue;
          const fld = fieldMap.get(r.id);
          const label = fld?.label ?? r.id;
          const kind = fld?.kind ?? "?";
          const reason = r.message ?? "unknown";
          overlay.appendLog(`✗ ${label} [${kind}] — ${reason}`);
        }

        // One re-detect pass: clicking "Add" earlier may have inserted new
        // form fields (Company / Title / dates) inside the same step. Map +
        // fill any field ids we haven't seen yet. NEVER re-expand here —
        // that creates duplicate empty rows and floods the form with
        // validation errors.
        await waitForStableDom(document.body, 400, 4000);
        const fresh = detectFields();
        const newOnes = fresh.fields.filter((f) => !fieldMap.has(f.id));
        if (newOnes.length > 0) {
          overlay.appendLog(`Discovered ${newOnes.length} new field(s) after expand.`);
          const screenshot2 = settings.useVision ? await captureViewport() : undefined;
          let moreAnswers = await requestMapping(newOnes, profile, fresh.stepName, screenshot2);
          moreAnswers = await reviewLowConfidence(overlay, newOnes, moreAnswers, settings);
          const moreMap = new Map(newOnes.map((f) => [f.id, f]));
          const moreResults = await fillAll(moreAnswers, {
            registry: fresh.registry,
            fields: moreMap,
            preservePrefilled: settings.preservePrefilled,
            fillPacingMs: settings.fillPacingMs,
            settleAfterFillMs: settings.settleAfterFillMs,
            safeMode: settings.safeMode,
          });
          const moreFilled = moreResults.filter((r) => r.ok).length;
          overlay.appendLog(`Re-pass: filled ${moreFilled}/${newOnes.length} new field(s).`);
          cumulative = cumulative.concat(
            buildReviewItems(newOnes, moreAnswers, moreResults),
          );
        }
        cumulative = cumulative.concat(
          buildReviewItems(fields, answers, results),
        );
        overlay.appendLog(`Step ${stepCount}: filled ${filled}/${fields.length}`);
      }

      if (userStopRequested) {
        overlay.setStatus("Stopped by you.");
        return;
      }

      const submit = findSubmitButton();
      if (submit) {
        overlay.setStatus("Review your answers before submitting.");
        await new Promise<void>((resolve, reject) => {
          overlay!.showReview(cumulative, {
            onConfirm: async () => {
              overlay!.setStatus("Submitting application...");
              submit.scrollIntoView({ block: "center" });
              submit.click();
              await sleep(500);
              await waitForStableDom(document.body, 800, 8000);
              overlay!.setStatus("Application submitted!");
              resolve();
            },
            onCancel: () => {
              overlay!.setStatus("Cancelled. You can edit any field manually before submitting.");
              reject(new Error("User cancelled before submit"));
            },
            onRetryField: () => {},
          });
        });
        return;
      }

      const sigBefore = stepFingerprint();

      const advanced = await clickNext();
      if (!advanced) {
        overlay.setStatus("No further steps detected.");
        await new Promise<void>((resolve, reject) => {
          overlay!.showReview(cumulative, {
            onConfirm: () => {
              overlay!.setStatus("Done.");
              resolve();
            },
            onCancel: () => {
              overlay!.setStatus("Cancelled.");
              reject(new Error("User dismissed review"));
            },
            onRetryField: () => {},
          });
        });
        return;
      }

      await sleep(400);
      await waitForStableDom(document.body, 600, 8000);

      if (userStopRequested) {
        overlay.setStatus("Stopped by you.");
        return;
      }

      const sigAfter = stepFingerprint();
      if (sigAfter === sigBefore) {
        noAdvanceCount++;
        overlay.appendLog(
          `Same screen after Next (${noAdvanceCount}/2). Often means required fields or validation errors.`,
        );
      } else {
        noAdvanceCount = 0;
      }
      if (noAdvanceCount >= 2) {
        overlay.setStatus(
          "Stopped: the form did not advance. Scroll up for red errors, fix them, then run autofill again.",
        );
        return;
      }
    }

    overlay.setStatus(`Stopped after ${maxSteps} steps (safety limit).`);
  } catch (err) {
    overlay?.setStatus(`Error: ${(err as Error).message}`);
    console.error("[wda]", err);
  } finally {
    running = false;
  }
}

function buildReviewItems(
  fields: DetectedField[],
  answers: MappedValue[],
  results: FillResult[],
): ReviewItem[] {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const resById = new Map(results.map((r) => [r.id, r]));
  return fields.map((f) => {
    const a = byId.get(f.id) ?? { id: f.id, value: null, confidence: 0 };
    const r = resById.get(f.id);
    let status: ReviewItem["status"] = "skipped";
    if (r?.ok && r.filledValue && !/Preserved/.test(r.message ?? "")) status = "filled";
    else if (r?.ok) status = "skipped";
    else status = "error";
    return { field: f, answer: a, status, message: r?.message };
  });
}

/**
 * Before typing values into the form, surface any field whose AI confidence
 * is below `reviewThreshold` for one-click approve / edit / skip. Returns the
 * (possibly edited) answers merged with the high-confidence ones.
 */
async function reviewLowConfidence(
  overlay: OverlayHandle,
  fields: DetectedField[],
  answers: MappedValue[],
  settings: UserSettings,
): Promise<MappedValue[]> {
  if (!settings.reviewLowConfidence) return answers;
  const threshold = settings.reviewThreshold ?? 0.6;
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const uncertain: PreFillItem[] = [];
  for (const a of answers) {
    const f = fieldsById.get(a.id);
    if (!f) continue;
    // File / hidden fields handled elsewhere; nothing to "type" anyway.
    if (f.kind === "file") continue;
    const c = a.confidence ?? 0;
    const isLow = c < threshold || a.needsReview === true;
    // Don't pester the user for fields the AI couldn't fill at all if the
    // current value is already non-empty (preservePrefilled handles it).
    const blankFromAi = a.value == null || a.value === "";
    if (!isLow) continue;
    if (blankFromAi && !f.required) continue;
    uncertain.push({ field: f, answer: a });
  }
  if (uncertain.length === 0) return answers;

  overlay.setStatus(`Review ${uncertain.length} uncertain field(s)…`);
  overlay.appendLog(`Pausing for review on ${uncertain.length} low-confidence field(s).`);
  const updated = await overlay.reviewBeforeFill(uncertain);

  const updatedById = new Map(updated.map((u) => [u.id, u]));
  return answers.map((a) => updatedById.get(a.id) ?? a);
}

async function captureViewport(): Promise<string | undefined> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "CAPTURE_SCREENSHOT",
    })) as { dataUrl?: string } | undefined;
    if (!res?.dataUrl) return undefined;
    // The raw screenshot can be 2-4 MB at retina resolution. Shrink it to
    // ~1280px wide so the vision model can still read labels but the
    // request fits comfortably in the 20 MB OpenAI limit.
    return await shrinkDataUrl(res.dataUrl, 1280, 0.7);
  } catch {
    return undefined;
  }
}

async function shrinkDataUrl(
  dataUrl: string,
  maxWidth: number,
  quality: number,
): Promise<string> {
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = dataUrl;
    });
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

async function requestMapping(
  fields: DetectedField[],
  profile: ResumeProfile,
  stepName?: string,
  screenshot?: string,
): Promise<MappedValue[]> {
  const response = await chrome.runtime.sendMessage<RuntimeMessage>({
    type: "MAP_FIELDS",
    fields,
    profile,
    stepName,
    screenshot,
  });
  if (!response || response.error) {
    throw new Error(response?.error ?? "Mapping failed");
  }
  return response.answers as MappedValue[];
}

chrome.runtime.sendMessage({ type: "AUTOFILL_STATUS", phase: "idle" }).catch(() => {});
