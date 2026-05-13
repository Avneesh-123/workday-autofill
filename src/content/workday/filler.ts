/**
 * Field filler. Given a `MappedValue` + the live element, perform the
 * correct sequence of DOM operations to set the value reliably.
 *
 * Strategy per field kind:
 *  - text/number/email/url/tel/textarea -> setNativeValue + blur
 *  - select (native)                    -> set .value + change event
 *  - combobox (Workday popup listbox)   -> click trigger, click matching option
 *  - multiselect                        -> repeat combobox flow for each value
 *  - radio                              -> click matching input
 *  - checkbox (single, bool)            -> click if state differs
 *  - checkbox group                     -> click matching values
 *  - date                               -> fill three sub-inputs (MM/DD/YYYY)
 *  - file                               -> not auto-filled (assignment requires
 *                                          file upload but security policy blocks
 *                                          us from forging a real File handle;
 *                                          we instead show a banner asking the
 *                                          user to drop the resume manually,
 *                                          and the navigator pauses there).
 */

import { DetectedField, MappedValue } from "@/lib/types";
import {
  isVisible,
  realClick,
  setNativeValue,
  simulateFocusBlur,
  sleep,
  text,
  waitFor,
} from "@/content/workday/dom-utils";

export interface FillContext {
  registry: Map<string, HTMLElement>;
  fields: Map<string, DetectedField>;
  preservePrefilled: boolean;
}

export interface FillResult {
  id: string;
  ok: boolean;
  message?: string;
  filledValue?: string;
}

export async function fillAll(
  answers: MappedValue[],
  ctx: FillContext,
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (const answer of answers) {
    const field = ctx.fields.get(answer.id);
    const el = ctx.registry.get(answer.id);
    if (!field || !el || !isVisible(el)) {
      results.push({ id: answer.id, ok: false, message: "Element no longer in DOM" });
      continue;
    }
    if (answer.value == null) {
      results.push({ id: answer.id, ok: false, message: "AI returned null" });
      continue;
    }
    if (
      ctx.preservePrefilled &&
      field.currentValue &&
      String(field.currentValue).trim().length > 0 &&
      field.kind !== "checkbox"
    ) {
      results.push({
        id: answer.id,
        ok: true,
        message: "Preserved pre-filled value",
        filledValue: String(field.currentValue),
      });
      continue;
    }
    try {
      await fillField(field, el, answer.value);
      results.push({ id: answer.id, ok: true, filledValue: String(answer.value) });
    } catch (err) {
      results.push({
        id: answer.id,
        ok: false,
        message: (err as Error).message,
      });
    }
    await sleep(80); // gentle pacing - Workday throttles fast input
  }
  return results;
}

async function fillField(
  field: DetectedField,
  el: HTMLElement,
  value: string | string[] | boolean | null,
): Promise<void> {
  switch (field.kind) {
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "textarea":
      return fillText(el, String(value ?? ""));
    case "select":
      return fillSelect(el as HTMLSelectElement, String(value ?? ""));
    case "combobox":
      return fillCombobox(el, String(value ?? ""));
    case "multiselect":
      return fillMultiselect(el, Array.isArray(value) ? value : [String(value ?? "")]);
    case "radio":
      return fillRadio(field, String(value ?? ""));
    case "checkbox":
      if (Array.isArray(value)) return fillCheckboxGroup(field, value);
      return fillSingleCheckbox(el as HTMLInputElement, value === true || value === "true" || value === "Yes");
    case "date":
      return fillDate(el, String(value ?? ""));
    case "file":
      // We can't programmatically forge a File - the user is prompted.
      return;
    default:
      throw new Error(`Unsupported field kind: ${field.kind}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Per-kind helpers                                                   */
/* ------------------------------------------------------------------ */

function fillText(el: HTMLElement, value: string): void {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error("Element is not an input/textarea");
  }
  el.focus();
  setNativeValue(el, value);
  simulateFocusBlur(el);
}

function fillSelect(el: HTMLSelectElement, value: string): void {
  const lc = value.toLowerCase();
  const opt =
    Array.from(el.options).find(
      (o) => o.value === value || o.text === value,
    ) ??
    Array.from(el.options).find(
      (o) =>
        o.value.toLowerCase() === lc ||
        o.text.toLowerCase() === lc ||
        o.text.toLowerCase().includes(lc),
    );
  if (!opt) throw new Error(`No matching option for "${value}"`);
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function fillCombobox(trigger: HTMLElement, value: string): Promise<void> {
  if (!value) return;
  trigger.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(trigger);

  // Workday opens a listbox in a portal. Wait for it.
  const listbox = await waitFor<HTMLElement>(
    () => document.querySelector<HTMLElement>('[role="listbox"]:not([hidden])'),
    { timeout: 4000 },
  );
  if (!listbox) throw new Error("Listbox did not appear");

  // Some comboboxes accept typing to filter.
  const input = trigger.querySelector<HTMLInputElement>("input") ??
    listbox.querySelector<HTMLInputElement>("input");
  if (input) {
    setNativeValue(input, value);
    await sleep(180);
  }

  const opts = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"], li, div[data-automation-id*="promptOption"]'),
  );
  const target = pickOption(opts, value);
  if (!target) {
    // Close the popup and report.
    document.body.click();
    throw new Error(`No combobox option matching "${value}"`);
  }
  target.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(target);
  await sleep(120);
}

async function fillMultiselect(trigger: HTMLElement, values: string[]): Promise<void> {
  for (const v of values) {
    if (!v) continue;
    await fillCombobox(trigger, v);
    await sleep(120);
  }
}

function fillRadio(field: DetectedField, value: string): void {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[type="radio"]`),
  );
  // Restrict to those whose group label matches the field label - we
  // do that by walking up to the nearest form-field wrapper.
  const wrapperLabel = field.label.toLowerCase();
  const candidates = inputs.filter((i) => {
    const wrap = i.closest('[data-automation-id^="formField"]');
    const lbl = wrap?.querySelector('[data-automation-id="formLabel"]');
    return (
      !wrap || !lbl || text(lbl).toLowerCase().includes(wrapperLabel) ||
      wrapperLabel.includes(text(lbl).toLowerCase())
    );
  });
  const lc = value.toLowerCase().trim();
  const match =
    candidates.find((r) => r.value.toLowerCase() === lc) ??
    candidates.find((r) => {
      const lbl = (r.labels?.[0]?.textContent ?? "").toLowerCase();
      return lbl === lc || lbl.includes(lc);
    });
  if (!match) throw new Error(`No radio option matching "${value}"`);
  match.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(match);
  match.checked = true;
  match.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillSingleCheckbox(input: HTMLInputElement, desired: boolean): void {
  if (input.checked === desired) return;
  input.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(input);
}

function fillCheckboxGroup(field: DetectedField, values: string[]): void {
  const want = new Set(values.map((v) => v.toLowerCase().trim()));
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ).filter((cb) => {
    const wrap = cb.closest('[data-automation-id^="formField"]');
    const lbl = wrap?.querySelector('[data-automation-id="formLabel"]');
    return !lbl || text(lbl).toLowerCase().includes(field.label.toLowerCase());
  });
  for (const cb of inputs) {
    const lbl = (cb.labels?.[0]?.textContent ?? cb.value).toLowerCase().trim();
    const should = want.has(lbl) || want.has(cb.value.toLowerCase().trim());
    if (cb.checked !== should) realClick(cb);
  }
}

/**
 * Date fill - Workday usually renders three text inputs whose
 * data-automation-id attributes are "dateSectionMonth-input" /
 * "dateSectionDay-input" / "dateSectionYear-input". We support both
 * ISO ("2023-05" / "2023-05-12") and slash formats.
 */
function fillDate(wrapper: HTMLElement, value: string): void {
  const parts = parseDateParts(value);
  if (!parts) throw new Error(`Cannot parse date "${value}"`);

  const month =
    wrapper.querySelector<HTMLInputElement>('[data-automation-id="dateSectionMonth-input"]') ??
    wrapper.querySelector<HTMLInputElement>('input[aria-label*="Month" i]');
  const day =
    wrapper.querySelector<HTMLInputElement>('[data-automation-id="dateSectionDay-input"]') ??
    wrapper.querySelector<HTMLInputElement>('input[aria-label*="Day" i]');
  const year =
    wrapper.querySelector<HTMLInputElement>('[data-automation-id="dateSectionYear-input"]') ??
    wrapper.querySelector<HTMLInputElement>('input[aria-label*="Year" i]');

  if (month) setNativeValue(month, parts.month);
  if (day && parts.day) setNativeValue(day, parts.day);
  if (year) setNativeValue(year, parts.year);

  // Fallback - single date input.
  if (!month && !year) {
    const lone = wrapper.querySelector<HTMLInputElement>("input");
    if (lone) setNativeValue(lone, `${parts.month}/${parts.day ?? "01"}/${parts.year}`);
  }
}

function parseDateParts(v: string): { month: string; day?: string; year: string } | null {
  if (!v) return null;
  if (v.toLowerCase() === "present") return null;
  let m = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) {
    return {
      year: m[1],
      month: m[2].padStart(2, "0"),
      day: m[3]?.padStart(2, "0"),
    };
  }
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { month: m[1].padStart(2, "0"), day: m[2].padStart(2, "0"), year: m[3] };
  m = v.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { month: m[1].padStart(2, "0"), year: m[2] };
  return null;
}

/* ------------------------------------------------------------------ */
/*  Option picking                                                     */
/* ------------------------------------------------------------------ */

function pickOption(opts: HTMLElement[], value: string): HTMLElement | null {
  const lc = value.toLowerCase().trim();
  // 1. exact label match
  let hit = opts.find((o) => text(o).toLowerCase() === lc);
  if (hit) return hit;
  // 2. contains
  hit = opts.find((o) => text(o).toLowerCase().includes(lc));
  if (hit) return hit;
  // 3. word match
  hit = opts.find((o) =>
    lc.split(/\s+/).every((tok) => text(o).toLowerCase().includes(tok)),
  );
  return hit ?? null;
}
