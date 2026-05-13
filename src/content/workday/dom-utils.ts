/**
 * Workday DOM utility helpers.
 *
 * Workday uses React internally, so setting `.value` directly does NOT
 * trigger React's onChange. We must use the prototype setter trick
 * (described here: https://github.com/facebook/react/issues/10135).
 *
 * Workday also makes heavy use of `data-automation-id` attributes -
 * these are FAR more stable than CSS classes or generated React IDs,
 * so we lean on them as our primary anchor.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isVisible(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Dispatch a "native" input event in a way that React picks up.
 * Works for <input>, <textarea>, contenteditable elements.
 */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = descriptor?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Fire focus/blur, mimicking a real user. Workday validators often
 * trigger on blur.
 */
export function simulateFocusBlur(el: HTMLElement): void {
  el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  // blur after a tick so React has the value
  setTimeout(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }, 30);
}

/**
 * Click an element with full mouse event sequence (mousedown, mouseup, click).
 * Workday dropdowns ignore programmatic .click() in some cases.
 */
export function realClick(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, button: 0 };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

/**
 * Wait until the predicate returns truthy, or the timeout fires.
 * Useful for waiting on dynamic Workday content to render.
 */
export async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  { timeout = 8000, interval = 120 }: { timeout?: number; interval?: number } = {},
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = predicate();
    if (result) return result as T;
    await sleep(interval);
  }
  return null;
}

/**
 * Wait until the DOM has been stable (no mutations) for `quietMs`.
 * Workday loads steps progressively, so we wait for the dust to settle
 * before reading fields.
 */
export function waitForStableDom(
  root: Element = document.body,
  quietMs = 700,
  maxMs = 10000,
): Promise<void> {
  return new Promise((resolve) => {
    let timer: number;
    const start = Date.now();
    const observer = new MutationObserver(() => {
      if (Date.now() - start > maxMs) {
        observer.disconnect();
        window.clearTimeout(timer);
        resolve();
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(done, quietMs);
    });
    function done() {
      observer.disconnect();
      resolve();
    }
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    timer = window.setTimeout(done, quietMs);
  });
}

/**
 * Find an element by `data-automation-id`. The Workday team uses these
 * consistently across customer tenants.
 */
export function byAuto<T extends Element = Element>(
  id: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector(`[data-automation-id="${id}"]`) as T | null;
}

export function allByAuto<T extends Element = Element>(
  id: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll(`[data-automation-id="${id}"]`)) as T[];
}

/** Generate a short, stable id we can use to reference detected fields. */
let _idCounter = 0;
export function stableId(prefix = "f"): string {
  return `${prefix}_${(++_idCounter).toString(36)}`;
}
