/**
 * Workday navigator: knows how to expand repeatable sections (Add Another),
 * click Next / Save and Continue, and detect the final Review/Submit step.
 *
 * The navigator NEVER clicks Submit on its own - the overlay shows a
 * review screen and waits for explicit user confirmation.
 */

import {
  isVisible,
  realClick,
  sleep,
  text,
  waitForStableDom,
} from "@/content/workday/dom-utils";

export interface NavStepInfo {
  isReviewStep: boolean;
  isSubmitStep: boolean;
  stepName?: string;
  hasNext: boolean;
}

const NEXT_BUTTON_LABELS = [
  /^next$/i,
  /^continue$/i,
  /save\s*(?:and\s*)?continue/i,
  /save\s*and\s*continue/i,
  /^save\s*(&|and)\s*continue/i,
];

const SUBMIT_BUTTON_LABELS = [
  /^submit/i,
  /submit\s*application/i,
];

const REVIEW_HEADING_RX = /review|summary|verify your information/i;

export function findNextButton(): HTMLButtonElement | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ).filter(isVisible);

  for (const b of buttons) {
    const t = text(b);
    if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
    if (NEXT_BUTTON_LABELS.some((rx) => rx.test(t))) return b;
  }
  return null;
}

export function findSubmitButton(): HTMLButtonElement | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ).filter(isVisible);

  for (const b of buttons) {
    if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
    const t = text(b);
    if (SUBMIT_BUTTON_LABELS.some((rx) => rx.test(t))) return b;
  }
  return null;
}

export function findAddAnotherButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ).filter((b) => isVisible(b) && /add (another|more|education|work\s*experience|experience)/i.test(text(b)));
}

export function detectStep(): NavStepInfo {
  const heading = document.querySelector<HTMLElement>(
    '[data-automation-id="pageHeader"], [data-automation-id="taskPageHeader"], h1, h2',
  );
  const stepName = heading ? text(heading) : undefined;
  const isReviewStep = !!stepName && REVIEW_HEADING_RX.test(stepName);
  const submit = findSubmitButton();
  const next = findNextButton();
  return {
    stepName,
    isReviewStep,
    isSubmitStep: !!submit,
    hasNext: !!next,
  };
}

/**
 * Expand all "Add Another <Section>" buttons up to `times` to ensure
 * enough rows exist for repeatable data. We pass `times` from the
 * profile (number of experiences / educations).
 */
export async function expandRepeatables(
  experiences: number,
  educations: number,
): Promise<void> {
  const buttons = findAddAnotherButtons();
  for (const b of buttons) {
    const label = text(b).toLowerCase();
    let need = 0;
    if (label.includes("work") || label.includes("experience")) need = Math.max(0, experiences - 1);
    else if (label.includes("education")) need = Math.max(0, educations - 1);
    else need = 0;
    for (let i = 0; i < need; i++) {
      realClick(b);
      await sleep(250);
      await waitForStableDom(document.body, 350, 4000);
    }
  }
}

export async function clickNext(): Promise<boolean> {
  const next = findNextButton();
  if (!next) return false;
  next.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(next);
  await sleep(300);
  await waitForStableDom(document.body, 600, 8000);
  return true;
}

/**
 * Detect whether the current page is a Workday job-application form
 * at all. Used to avoid running on the public job-listing pages.
 */
export function isApplicationPage(): boolean {
  if (
    document.querySelector('[data-automation-id^="formField-"]') ||
    document.querySelector('[data-automation-id="applyButton"]')
  ) {
    return true;
  }
  return /\/job-application\//i.test(location.pathname) ||
    /\/apply\//i.test(location.pathname);
}
