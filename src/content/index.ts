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
 *  7. Detect "Application Submitted" confirmation.
 *
 * MutationObserver re-detects fields whenever the page changes,
 * which handles conditional fields appearing mid-step.
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
import { mountOverlay, OverlayHandle, ReviewItem } from "@/content/ui/overlay";
import { waitForStableDom, sleep } from "@/content/workday/dom-utils";
import { storage } from "@/lib/storage";
import {
  DetectedField,
  MappedValue,
  ResumeProfile,
  RuntimeMessage,
} from "@/lib/types";

let running = false;
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

async function startAutofill(): Promise<void> {
  if (running) return;
  running = true;
  overlay?.destroy();
  overlay = mountOverlay();
  overlay.setStatus("Loading profile...");

  try {
    const profile = await storage.getProfile();
    const settings = await storage.getSettings();
    if (!profile) {
      overlay.setStatus("No resume profile saved. Open the extension popup and upload a resume.");
      return;
    }

    let stepCount = 0;
    let cumulative: ReviewItem[] = [];

    while (stepCount < 20) {
      stepCount++;
      await waitForStableDom(document.body, 500, 6000);

      const stepInfo = detectStep();
      overlay.setStatus(`Step ${stepCount}: ${stepInfo.stepName ?? "(detecting)"}`);

      // Expand repeatable sections so all rows exist.
      await expandRepeatables(profile.experience.length, profile.education.length);
      await sleep(150);

      const { fields, registry, stepName } = detectFields();
      if (fields.length === 0) {
        overlay.appendLog(`Step ${stepCount}: no fields detected, attempting to advance.`);
      } else {
        overlay.setStatus(`Mapping ${fields.length} fields with AI...`);
        const answers = await requestMapping(fields, profile, stepName);

        overlay.setStatus(`Filling ${fields.length} fields...`);
        const fieldMap = new Map(fields.map((f) => [f.id, f]));
        const results = await fillAll(answers, {
          registry,
          fields: fieldMap,
          preservePrefilled: settings.preservePrefilled,
        });
        const filled = results.filter((r) => r.ok).length;
        overlay.setProgress(filled, fields.length);
        cumulative = cumulative.concat(
          buildReviewItems(fields, answers, results),
        );
        overlay.appendLog(`Step ${stepCount}: filled ${filled}/${fields.length}`);
      }

      // Decide where to go next.
      const submit = findSubmitButton();
      if (submit) {
        overlay.setStatus("Review your answers before submitting.");
        await new Promise<void>((resolve, reject) => {
          overlay!.showReview(cumulative, {
            onConfirm: async () => {
              if (!settings.confirmBeforeSubmit) return resolve();
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

      const advanced = await clickNext();
      if (!advanced) {
        overlay.setStatus("No further steps detected. Pausing.");
        overlay.showReview(cumulative, {
          onConfirm: () => { overlay!.setStatus("Done."); },
          onCancel: () => { overlay!.setStatus("Cancelled."); },
          onRetryField: () => {},
        });
        return;
      }
      // small pause to let next step render
      await sleep(400);
    }
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

async function requestMapping(
  fields: DetectedField[],
  profile: ResumeProfile,
  stepName?: string,
): Promise<MappedValue[]> {
  const response = await chrome.runtime.sendMessage<RuntimeMessage>({
    type: "MAP_FIELDS",
    fields,
    profile,
    stepName,
  });
  if (!response || response.error) {
    throw new Error(response?.error ?? "Mapping failed");
  }
  return response.answers as MappedValue[];
}

// Tell background we are ready (for popup state).
chrome.runtime.sendMessage({ type: "AUTOFILL_STATUS", phase: "idle" }).catch(() => {});
