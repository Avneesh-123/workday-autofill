/**
 * Re-resolve a Workday form control after React re-renders.
 *
 * We keep `formFieldAutomationId` (the wrapper's `data-automation-id`)
 * stable across DOM updates; the HTMLElement from the initial detect pass
 * becomes stale as soon as Workday mutates the wizard.
 */

import { DetectedField } from "@/lib/types";

function escAttr(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isInDom(el: Element | null): boolean {
  return !!el && document.contains(el);
}

function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

/**
 * Workday tenants that don't suffix `data-automation-id` per row produce
 * duplicate wrappers (e.g. four `formField-jobTitle` rows). Sort by Y
 * position so caller can pick the Nth via repeatIndex.
 */
function queryFormFieldsAllByAutomationId(aid: string): HTMLElement[] {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-automation-id="${escAttr(aid)}"]`),
  ).filter((el) => isInDom(el) && isElementVisible(el));
  all.sort(
    (a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top,
  );
  return all;
}

export function queryFormFieldByAutomationId(
  aid: string,
  repeatIndex?: number,
): HTMLElement | null {
  const all = queryFormFieldsAllByAutomationId(aid);
  if (all.length === 0) return null;
  const idx = typeof repeatIndex === "number" ? repeatIndex : 0;
  return all[Math.min(idx, all.length - 1)] ?? null;
}

export function resolveFieldElement(f: DetectedField): HTMLElement | null {
  const aid = f.formFieldAutomationId;
  if (!aid) return null;

  // When automation IDs aren't suffixed per-row, multiple wrappers share the
  // same `aid`. Use repeatIndex to pick the correct one (top-to-bottom).
  const wrap = queryFormFieldByAutomationId(aid, f.repeatIndex);
  if (!wrap) return null;

  switch (f.kind) {
    case "date": {
      return (
        wrap.querySelector<HTMLElement>('[data-automation-id="dateInputWrapper"]') ??
        wrap
      );
    }
    case "combobox":
    case "multiselect":
      // Prefer the visible opener control over the inner search <input>.
      // Clicking the input first often leaves Workday in a bad state; the
      // list icon / prompt button opens the real option surface.
      return (
        wrap.querySelector<HTMLElement>('button[aria-haspopup="listbox"]') ??
        wrap.querySelector<HTMLElement>('button[aria-haspopup="true"]') ??
        wrap.querySelector<HTMLElement>('[data-automation-id$="promptIcon"]') ??
        wrap.querySelector<HTMLElement>('[data-automation-id*="promptIcon"]') ??
        wrap.querySelector<HTMLElement>('[data-automation-id*="dropdownIcon"]') ??
        wrap.querySelector<HTMLElement>('[role="combobox"]') ??
        wrap.querySelector<HTMLElement>('input[role="searchbox"]') ??
        wrap.querySelector<HTMLElement>('input[role="combobox"]')
      );
    case "select":
      return wrap.querySelector("select");
    case "radio":
      return wrap.querySelector<HTMLElement>('input[type="radio"]');
    case "checkbox":
      return wrap.querySelector<HTMLElement>('input[type="checkbox"]');
    case "file":
      return wrap.querySelector<HTMLElement>('input[type="file"]');
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "textarea":
    default:
      return (
        wrap.querySelector<HTMLElement>(
          'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit])',
        ) ?? wrap.querySelector<HTMLElement>("textarea")
      );
  }
}

/** True if Workday replaced the page with its fatal-error shell. */
export function workdayFatalErrorVisible(): boolean {
  const t = document.body?.innerText ?? "";
  return (
    /something went wrong/i.test(t) &&
    (/refresh the page/i.test(t) || /try again/i.test(t))
  );
}
