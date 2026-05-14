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

/** Heading text for the Workday form section that contains this control. */
function ancestorFormSectionHeading(el: HTMLElement): string {
  const sec = el.closest<HTMLElement>('[data-automation-id^="formSection"]');
  if (!sec) return "";
  const title =
    sec.querySelector<HTMLElement>('[data-automation-id="formSectionTitle"]') ??
    sec.querySelector<HTMLElement>("h2, h3");
  return text(title);
}

/**
 * Walks nested formSection wrappers (Netflix stacks several on "My Experience")
 * and classifies which repeatable list this "Add" belongs to.
 */
function inferRepeatableSectionKind(btn: HTMLElement): "work" | "education" | "language" | null {
  // 1. Walk formSection ancestors (older flows).
  let sec: HTMLElement | null = btn.closest<HTMLElement>('[data-automation-id^="formSection"]');
  while (sec) {
    const aid = (sec.getAttribute("data-automation-id") ?? "").toLowerCase();
    const titleEl =
      sec.querySelector<HTMLElement>('[data-automation-id="formSectionTitle"]') ??
      sec.querySelector<HTMLElement>("h2, h3");
    const t = text(titleEl).toLowerCase();
    const blob = `${aid} ${t}`;
    if (/language|locale|bilingual|fluency/i.test(blob)) return "language";
    if (/education|school|university|degree|academic|qualification/i.test(blob)) return "education";
    if (/work|employment|job|company|experience|position|career|professional/i.test(blob)) return "work";
    sec = sec.parentElement?.closest<HTMLElement>('[data-automation-id^="formSection"]') ?? null;
  }
  // 2. Netflix-style: heading is a plain sibling above the button.
  let node: Element | null = btn;
  for (let i = 0; node && i < 8; i++) {
    let prev: Element | null = node.previousElementSibling;
    while (prev) {
      const blob = (text(prev as HTMLElement) ?? "").toLowerCase();
      if (/language|locale|bilingual|fluency/i.test(blob)) return "language";
      if (/education|school|university|degree|academic|qualification/i.test(blob)) return "education";
      if (/work\s*experience|employment|career\s*history|professional|most\s*recent/i.test(blob)) return "work";
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Buttons that add rows to Work Experience, Education, Languages, etc.
 * Netflix and other tenants use a bare label "Add" inside the section; older
 * flows use "Add Another Work Experience".
 */
export function findAddAnotherButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ).filter((b) => {
    if (!isVisible(b) || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    const raw = text(b).trim();
    if (/add (another|more|education|work\s*experience|experience|language)/i.test(raw)) return true;
    if (/^add$/i.test(raw) || raw.toLowerCase() === "add") {
      const head = ancestorFormSectionHeading(b).toLowerCase();
      const inferred = inferRepeatableSectionKind(b);
      if (inferred) return true;
      if (
        (/work\s*experience|professional\s*experience|most\s*recent|employment|career\s*history/i.test(head) &&
          !/education|language/i.test(head)) ||
        /education|school|university|academic/i.test(head) ||
        /language/i.test(head)
      ) {
        return true;
      }
      // Last-chance heuristic: look at the nearest preceding heading on the
      // page (Netflix renders the section title as a plain h2/h3 sibling
      // rather than inside a data-automation-id=formSection).
      const near = nearestHeadingText(b).toLowerCase();
      if (/work\s*experience|employment|career|professional|education|school|university|language/i.test(near)) {
        return true;
      }
    }
    return false;
  });
}

/** Walk up + look for the closest heading-like text before this button. */
function nearestHeadingText(btn: HTMLElement): string {
  let node: Element | null = btn;
  while (node) {
    let prev: Element | null = node.previousElementSibling;
    while (prev) {
      if (/^H[1-4]$/.test(prev.tagName)) return text(prev as HTMLElement);
      const inner = prev.querySelector<HTMLElement>("h1, h2, h3, h4");
      if (inner) return text(inner);
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
    if (!node || node === document.body) break;
  }
  return "";
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
 * Expand all "Add Another …" / plain "Add" section buttons so enough rows exist
 * for repeatable data. Plain "Add" tenants (e.g. Netflix) usually show **no**
 * prefilled row — use `experiences` clicks, not `experiences - 1`.
 */
/**
 * Count how many rows of a kind currently exist on the page. We try several
 * heuristics because Workday tenants are wildly inconsistent in how they tag
 * repeat-row fields:
 *
 *  1. `data-automation-id*="jobTitle"` (Workday standard, suffixed or not)
 *  2. Visible label / aria-label text count (e.g. "Job Title" appearing N times)
 *
 * Whichever is highest wins — we'd rather *undercount* (miss adding a row)
 * than overcount and create empty validation-error rows.
 */
function countRows(kind: "work" | "education" | "language"): number {
  const idPatterns: Record<typeof kind, string[]> = {
    work: ["jobTitle", "jobtitle", "company", "employer"],
    education: ["school", "degree", "university", "institution"],
    language: ["language"],
  };
  const labelPatterns: Record<typeof kind, RegExp> = {
    work: /^\s*(job\s*title|position|role|title)\s*\*?\s*$/i,
    education: /^\s*(school|university|institution|college|degree)\s*\*?\s*$/i,
    language: /^\s*(language)\s*\*?\s*$/i,
  };

  // 1. Count by automation-id occurrences.
  let idCount = 0;
  for (const needle of idPatterns[kind]) {
    const wrappers = document.querySelectorAll<HTMLElement>(
      `[data-automation-id*="${needle}" i]`,
    );
    // Group by automation-id (so 2 controls inside the same wrapper count once).
    const seenIds = new Set<string>();
    let local = 0;
    for (const el of wrappers) {
      if (!isVisible(el)) continue;
      const aid = el.getAttribute("data-automation-id") ?? "";
      // Only count wrappers, not inner inputs (which sometimes also carry an id).
      if (!/^formField/i.test(aid) && !el.matches('[data-automation-id^="formField"]')) {
        // Walk up to nearest formField wrapper.
        const wrap = el.closest<HTMLElement>('[data-automation-id^="formField"]');
        if (wrap) {
          const wid = wrap.getAttribute("data-automation-id") ?? "";
          if (!seenIds.has(wid)) {
            seenIds.add(wid);
            local++;
          }
          continue;
        }
        continue;
      }
      if (seenIds.has(aid)) continue;
      seenIds.add(aid);
      local++;
    }
    idCount = Math.max(idCount, local);
  }

  // 2. Count by visible <label> text matches (works even when automation IDs
  //    are missing or share a base name without a row suffix).
  let labelCount = 0;
  const labels = document.querySelectorAll<HTMLElement>("label, [role='label']");
  for (const l of labels) {
    if (!isVisible(l)) continue;
    if (labelPatterns[kind].test(text(l))) labelCount++;
  }

  return Math.max(idCount, labelCount);
}

function classifyAddButton(b: HTMLElement): "work" | "education" | "language" | null {
  const raw = text(b).trim();
  const btnWork = /work|experience/i.test(raw) && !/education|language/i.test(raw);
  const btnEdu = /education/i.test(raw);
  const btnLang = /language/i.test(raw);
  if (btnLang) return "language";
  if (btnEdu) return "education";
  if (btnWork) return "work";
  const inferred = inferRepeatableSectionKind(b);
  if (inferred) return inferred;
  const head = ancestorFormSectionHeading(b).toLowerCase();
  if (/language/i.test(head) && !/programming|coding/i.test(head)) return "language";
  if (/education|school|university|academic/i.test(head)) return "education";
  if (/work|experience|employment|career|professional|most\s*recent/i.test(head)) return "work";
  return null;
}

/**
 * Expand repeatable sections. We never just count "click N times" — we count
 * the actual row count in the DOM before/after each click and stop the moment
 * we hit the target. This prevents the duplicate-row stacking we saw on
 * Netflix where multiple "Add" buttons exist for the same section.
 */
export async function expandRepeatables(
  experiences: number,
  educations: number,
  languages = 0,
): Promise<void> {
  const targets = {
    work: Math.min(Math.max(0, experiences), 5),
    education: Math.min(Math.max(0, educations), 4),
    language: Math.min(Math.max(0, languages), 4),
  } as const;

  for (const kind of ["work", "education", "language"] as const) {
    const target = targets[kind];
    if (!target) continue;
    // Safety stop: bound total Adds across all buttons of this kind.
    for (let safety = 0; safety < target + 2; safety++) {
      const have = countRows(kind);
      if (have >= target) break;

      // Pick the FIRST visible Add button of this kind. Don't iterate all
      // matching buttons — that's how we ended up with 7 rows for 4 roles.
      const btn = findAddAnotherButtons().find((b) => classifyAddButton(b) === kind);
      if (!btn) break;

      realClick(btn);
      await sleep(250);
      await waitForStableDom(document.body, 350, 4000);

      // Bail if the click didn't add a row (button may be disabled/hidden now).
      if (countRows(kind) <= have) break;
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
