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

import { DetectedField, FieldKind, MappedValue } from "@/lib/types";
import {
  isVisible,
  realClick,
  setNativeValue,
  sleep,
  text,
  waitFor,
  waitForStableDom,
} from "@/content/workday/dom-utils";
import {
  queryFormFieldByAutomationId,
  resolveFieldElement,
  workdayFatalErrorVisible,
} from "@/content/workday/field-resolve";

export interface FillContext {
  registry: Map<string, HTMLElement>;
  fields: Map<string, DetectedField>;
  preservePrefilled: boolean;
  /** Override default ms between fields (from chrome.storage settings). */
  fillPacingMs?: number;
  settleAfterFillMs?: number;
  /** When true, only fill plain text-like fields (text/email/tel/url/number/textarea). */
  safeMode?: boolean;
}

const SAFE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "textarea",
]);

export interface FillResult {
  id: string;
  ok: boolean;
  message?: string;
  filledValue?: string;
}

function isSkillsTagField(field: DetectedField): boolean {
  const h = `${field.label} ${field.placeholder ?? ""} ${field.ariaLabel ?? ""}`.toLowerCase();
  return /\b(type\s*to\s*add\s*skills|add\s*skills|search\s*skills|relevant\s*skills)\b/i.test(h);
}

function isUsableFillTarget(
  field: DetectedField,
  node: HTMLElement | null | undefined,
): node is HTMLElement {
  if (!node || !document.contains(node)) return false;
  if (field.kind === "file") return node instanceof HTMLInputElement;
  return isVisible(node);
}

/** Fill plain inputs first; combobox / multi / native select last — fewer picker churn crashes. */
function fillPriority(kind: FieldKind | undefined): number {
  switch (kind) {
    case "combobox":
    case "multiselect":
      return 50;
    case "file":
      return 48;
    case "select":
      return 40;
    case "radio":
      return 35;
    case "checkbox":
      return 30;
    case "date":
      return 25;
    case "unknown":
      return 10;
    default:
      return 0;
  }
}

export async function fillAll(
  answers: MappedValue[],
  ctx: FillContext,
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  const pacing = ctx.fillPacingMs ?? 360;
  const settle = ctx.settleAfterFillMs ?? 260;

  const ordered = [...answers].sort((a, b) => {
    const ka = ctx.fields.get(a.id)?.kind;
    const kb = ctx.fields.get(b.id)?.kind;
    const pa = fillPriority(ka);
    const pb = fillPriority(kb);
    return pa !== pb ? pa - pb : 0;
  });

  for (const answer of ordered) {
    if (workdayFatalErrorVisible()) {
      results.push({
        id: answer.id,
        ok: false,
        message: "Stopped: Workday error page is showing",
      });
      break;
    }
    const field = ctx.fields.get(answer.id);
    if (!field) {
      results.push({ id: answer.id, ok: false, message: "Unknown field id" });
      continue;
    }
    if (ctx.safeMode && !SAFE_KINDS.has(field.kind)) {
      results.push({
        id: answer.id,
        ok: false,
        message: `Skipped in Safe Mode (${field.kind})`,
      });
      continue;
    }

    if (field.formFieldAutomationId) {
      const wrap = queryFormFieldByAutomationId(field.formFieldAutomationId, field.repeatIndex);
      if (wrap) {
        wrap.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        await sleep(70);
      }
    }

    const el = await waitFor<HTMLElement>(
      () => {
        const resolved = resolveFieldElement(field);
        const reg = ctx.registry.get(answer.id);
        if (isUsableFillTarget(field, resolved)) return resolved;
        if (isUsableFillTarget(field, reg)) return reg;
        return null;
      },
      { timeout: 5000, interval: 140 },
    );
    if (!el) {
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
      if (workdayFatalErrorVisible()) {
        results.push({
          id: answer.id,
          ok: false,
          message: `Crashed Workday after filling "${field.label}" (${field.kind}). Try Safe Mode or unset this field in profile.`,
        });
        break;
      }
      results.push({
        id: answer.id,
        ok: true,
        filledValue: Array.isArray(answer.value)
          ? answer.value.join(", ")
          : String(answer.value),
      });
    } catch (err) {
      results.push({
        id: answer.id,
        ok: false,
        message: (err as Error).message,
      });
      if (workdayFatalErrorVisible()) {
        // Don't keep filling on top of a broken page.
        break;
      }
    }
    await sleep(pacing);
    if (settle > 0) {
      await waitForStableDom(document.body, settle, 5000);
    }
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
      return fillNativeSelect(el as HTMLSelectElement, String(value ?? ""));
    case "combobox": {
      if (isSkillsTagField(field)) {
        const parts: string[] = Array.isArray(value)
          ? value.map((x) => String(x).trim()).filter(Boolean)
          : String(value ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
        const unique = [...new Set(parts)].slice(0, 20);
        if (unique.length === 0) return;
        for (let i = 0; i < unique.length; i++) {
          await fillCombobox(field, el, unique[i]);
          if (i < unique.length - 1) await sleep(220);
        }
        return;
      }
      return fillCombobox(field, el, String(value ?? ""));
    }
    case "multiselect": {
      let values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
      if (isSkillsTagField(field) && values.length === 1 && values[0].includes(",")) {
        values = values[0]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      for (const v of values) {
        if (!v) continue;
        await fillCombobox(field, el, v);
        await sleep(200);
      }
      return;
    }
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

async function fillText(el: HTMLElement, value: string): Promise<void> {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error("Element is not an input/textarea");
  }
  // Keep this path as lean as possible: setNativeValue alone fires the one
  // event React needs. Manual focus + simulated focusout/blur on top of that
  // has been observed to crash Workday's app shell on multiple tenants.
  setNativeValue(el, value);
  await sleep(60);
}

/* ------------------------------------------------------------------ */
/*  Dropdowns                                                          */
/* ------------------------------------------------------------------ */
/*
 * Workday combobox / prompt picker filling.
 *
 * 1. Prefer clicking the list / prompt *button* (not the inner search input).
 * 2. Wait for popup + options.
 * 3. Scroll the list (virtualized rows).
 * 4. Match value + synonyms.
 * 5. "How did you hear" style: drill into likely category rows, then match.
 * 6. Last resort: ONE short filter string + one `input` event (not per-char
 *    `setNativeValue` storms that crashed Netflix).
 */

function fillNativeSelect(el: HTMLSelectElement, value: string): void {
  if (!value) return;
  const candidates = nativeSelectCandidates(value);
  const opts = Array.from(el.options);
  let opt: HTMLOptionElement | undefined;
  for (const c of candidates) {
    const cl = c.toLowerCase().trim();
    opt =
      opts.find((o) => o.value === c || o.text === c) ??
      opts.find((o) => o.value.toLowerCase() === cl || o.text.toLowerCase() === cl) ??
      opts.find((o) => o.text.toLowerCase().includes(cl)) ??
      opts.find((o) => cl.split(/\s+/).filter(Boolean).every((t) => o.text.toLowerCase().includes(t)));
    if (opt) break;
  }
  if (!opt) throw new Error(`No matching option for "${value}"`);
  el.value = opt.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Extra strings to try for native &lt;select&gt; (country names, etc.). */
function nativeSelectCandidates(value: string): string[] {
  const v = value.trim();
  const lc = v.toLowerCase();
  const out = [v, ...geographyAliasesForValue(lc), ...comboboxAlternatives(v, "")];
  return [...new Set(out)];
}

/** Shared US/UK/etc. spellings for native selects and Workday country comboboxes. */
function geographyAliasesForValue(lc: string): string[] {
  const countryMap: Record<string, string[]> = {
    usa: ["United States", "United States of America", "US", "U.S.", "U.S.A."],
    uk: ["United Kingdom", "Great Britain", "GB", "England"],
    uae: ["United Arab Emirates", "UAE"],
    india: ["India", "IN"],
    canada: ["Canada", "CA"],
    germany: ["Germany", "DE"],
    australia: ["Australia", "AU"],
    singapore: ["Singapore", "SG"],
  };
  if (lc === "us" || lc === "u.s." || lc === "u.s.a.") return countryMap.usa;
  for (const [key, alts] of Object.entries(countryMap)) {
    if (lc === key) return alts;
    if (alts.some((a) => a.toLowerCase() === lc)) return alts;
  }
  return [];
}

function findOpenPopup(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(
      '[data-automation-widget="wd-popup"]:not([hidden])',
    ) ??
    document.querySelector<HTMLElement>('[role="listbox"]:not([hidden])') ??
    document.querySelector<HTMLElement>(
      '[data-automation-id="DropDownList"]:not([hidden])',
    ) ??
    document.querySelector<HTMLElement>(
      '[data-automation-id*="popup"][role="presentation"]:not([hidden])',
    ) ??
    null
  );
}

/**
 * Workday wires the open listbox to the control via aria-controls / aria-owns.
 * Using the global "first popup" grabs the wrong layer and clicks miss.
 */
function findListboxFromTrigger(trigger: HTMLElement): HTMLElement | null {
  const raw = trigger.getAttribute("aria-controls") ?? trigger.getAttribute("aria-owns");
  if (!raw?.trim()) return null;
  for (const part of raw.split(/\s+/)) {
    const id = part.trim();
    if (!id) continue;
    const node = document.getElementById(id);
    if (!(node instanceof HTMLElement)) continue;
    const listbox =
      node.matches('[role="listbox"]')
        ? node
        : node.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox instanceof HTMLElement && isVisible(listbox)) return listbox;
    if (
      isVisible(node) &&
      node.querySelector('[role="option"], [data-automation-id="promptOption"]')
    ) {
      return node;
    }
  }
  return null;
}

function pickerSurface(trigger: HTMLElement, fallback: HTMLElement): HTMLElement {
  return findListboxFromTrigger(trigger) ?? fallback;
}

/** Drop outer wrappers when an inner `[role=option]` was also matched. */
function pruneContainedOptions(nodes: HTMLElement[]): HTMLElement[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    return 0;
  });
  const out: HTMLElement[] = [];
  for (const el of sorted) {
    if (out.some((o) => o !== el && o.contains(el))) continue;
    out.push(el);
  }
  return out;
}

function collectOptionsFromSelector(root: ParentNode, selector: string): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    if (!isVisible(el)) return;
    const t = text(el);
    if (t.length < 2) return;
    const lc = t.toLowerCase();
    if (/^(search|clear|close|cancel|loading)/.test(lc)) return;
    seen.add(el);
  });
  return pruneContainedOptions(Array.from(seen));
}

function collectOptions(root: ParentNode): HTMLElement[] {
  const byRole = collectOptionsFromSelector(root, '[role="option"]');
  if (byRole.length > 0) return byRole;
  const msRows = collectMultiselectCheckboxRows(root);
  if (msRows.length > 0) return msRows;
  const wide = [
    "li[role=\"option\"]",
    '[data-automation-id="promptOption"]',
    '[data-automation-id*="promptLeafNode"]',
    '[data-automation-id*="menuItem"]',
    '[data-automation-id*="suggestedPrompt"]',
    '[data-automation-id*="selectable"]',
    '[data-automation-id*="MULTISELECT"]',
    '[data-automation-id="MULTISELECT_HOLDER"] > div',
  ].join(", ");
  return collectOptionsFromSelector(root, wide);
}

function normLabel(s: string): string {
  return s.replace(/\s+/g, " ").replace(/…|\.\.\./g, "").trim().toLowerCase();
}

function pickOption(opts: HTMLElement[], value: string): HTMLElement | null {
  const lc = normLabel(value);
  return (
    opts.find((o) => normLabel(text(o)) === lc) ??
    opts.find((o) => normLabel(text(o)).includes(lc)) ??
    opts.find((o) => lc.split(/\s+/).every((tok) => normLabel(text(o)).includes(tok))) ??
    null
  );
}

/** Try every synonym; then bidirectional substring (handles "Social · LinkedIn"). */
function pickOptionAmong(opts: HTMLElement[], candidates: string[]): HTMLElement | null {
  const uniq = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  for (const c of uniq) {
    const hit = pickOption(opts, c);
    if (hit) return hit;
  }
  const minLen = 4;
  for (const o of opts) {
    const nt = normLabel(text(o));
    if (nt.length < 2) continue;
    for (const c of uniq) {
      const cc = normLabel(c);
      if (cc.length < 2) continue;
      if (nt.includes(cc)) return o;
      if (cc.length >= minLen && nt.length >= minLen && cc.includes(nt)) return o;
    }
  }
  return null;
}

/** Netflix / WD multiselect prompts often render checkbox rows instead of `[role=option]`. */
function collectMultiselectCheckboxRows(root: ParentNode): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const tryAdd = (el: HTMLElement) => {
    if (!isVisible(el)) return;
    const cb = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!cb || cb.disabled) return;
    const t = text(el);
    if (t.length < 2) return;
    const lc = t.toLowerCase();
    if (/^(select all|deselect all|clear|close|cancel|loading)/.test(lc)) return;
    seen.add(el);
  };
  root.querySelectorAll<HTMLElement>("label").forEach(tryAdd);
  root.querySelectorAll<HTMLElement>('li, [role="row"], [role="listitem"]').forEach((el) => {
    if (!el.querySelector('input[type="checkbox"]')) return;
    tryAdd(el);
  });
  return pruneContainedOptions(Array.from(seen));
}

async function pressEscapeOnce(): Promise<void> {
  const init: KeyboardEventInit = {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  };
  const t = document.activeElement;
  if (t instanceof HTMLElement) t.dispatchEvent(new KeyboardEvent("keydown", init));
  document.body.dispatchEvent(new KeyboardEvent("keydown", init));
  await sleep(60);
}

/** Workday / ILR-style labels for language skill comboboxes (Writing, Reading, …). */
function isLanguageProficiencyFieldLabel(h: string): boolean {
  return /\b(writing|reading|speaking|comprehension|overall|listening|oral|proficiency|fluency)\b/i.test(
    h,
  );
}

function degreeComboboxSynonyms(value: string): string[] {
  const t = value.trim();
  const lc = t.toLowerCase();
  const alts: string[] = [];
  if (/^b\.?s\.?$|bachelor\s*of\s*sci|b\.?s\.?\s*\(/i.test(lc)) {
    alts.push(
      "Bachelor of Science (BS)",
      "Bachelor's Degree",
      "Bachelor of Science",
      "BS",
      "B.S.",
      "Bachelors",
    );
  }
  if (/^b\.?a\.?$|bachelor\s*of\s*art/i.test(lc)) {
    alts.push("Bachelor of Arts (BA)", "Bachelor's Degree", "BA", "B.A.");
  }
  if (/^m\.?s\.?$|master\s*of\s*sci|msc\b|m\.?s\.?\s*\(/i.test(lc)) {
    alts.push("Master of Science (MS)", "Master's Degree", "MS", "M.S.", "MSc");
  }
  if (/^m\.?a\.?$|master\s*of\s*art/i.test(lc)) {
    alts.push("Master of Arts (MA)", "Master's Degree", "MA");
  }
  if (/\bph\.?d\.?\b|doctorate/i.test(lc)) {
    alts.push("Doctorate", "PhD", "Ph.D.", "Doctor of Philosophy (PhD)");
  }
  if (/\bassociate/i.test(lc)) alts.push("Associate's Degree", "Associate Degree");
  if (/\bhigh\s*school|secondary/i.test(lc)) alts.push("High School Diploma", "Secondary");
  return alts;
}

/** Tenant-specific synonyms for common combobox values. */
function comboboxAlternatives(value: string, fieldLabel = ""): string[] {
  const trimmed = value.trim();
  const lc = trimmed.toLowerCase();
  const geo = geographyAliasesForValue(lc);
  if (geo.length) return [...new Set([trimmed, ...geo])];

  if (fieldLabel && isLanguageProficiencyFieldLabel(fieldLabel)) {
    return [
      ...new Set([
        trimmed,
        "Fluent",
        "Full Professional Proficiency",
        "Professional Working Proficiency",
        "Limited Working Proficiency",
        "Elementary Proficiency",
        "No Proficiency",
        "Native",
        "Native or bilingual",
        "Advanced",
        "Intermediate",
        "Beginner",
        "A",
        "B",
        "C",
        "1",
        "2",
        "3",
        "4",
        "5",
      ]),
    ];
  }
  if (fieldLabel && /\bdegree\b/i.test(fieldLabel)) {
    return [...new Set([trimmed, ...degreeComboboxSynonyms(trimmed)])];
  }
  if (["mobile", "cell", "cellular"].includes(lc)) {
    return [
      "Mobile",
      "Cell",
      "Cellular",
      "Cell Phone",
      "Mobile Phone",
      "Wireless",
      "Wireless Phone",
      "Smartphone",
      "Smart Phone",
    ];
  }
  if (["land line", "landline", "home"].includes(lc)) {
    return ["Land Line", "Landline", "Home", "Home Phone", "Fixed Line"];
  }
  if (lc === "linkedin") {
    return [
      "LinkedIn",
      "Linked In",
      "Linkedin",
      "LinkedIn Jobs",
      "Social Media",
      "Social Network",
      "Social Networks",
      "Internet",
      "Online",
      "Job Board",
      "Web",
    ];
  }
  if (lc === "referral") return ["Referral", "Employee Referral", "Friend", "Internal"];
  return [trimmed];
}

function isSourceChannelField(label: string): boolean {
  return /\b(how\s+did\s+you\s+hear|where\s+did\s+you\s+hear|hear\s+about|referral\s*source)\b/i.test(
    label,
  );
}

function isPhoneDeviceField(label: string): boolean {
  return /\b(phone\s*device|device\s*type|type\s*of\s*phone|phone\s*type)\b/i.test(label);
}

async function scrollPickerOptions(popup: HTMLElement): Promise<void> {
  const sc =
    popup.querySelector<HTMLElement>('[role="list"]') ??
    popup.querySelector<HTMLElement>('[data-automation-id*="scroll"]') ??
    popup;
  for (let i = 0; i < 14; i++) {
    sc.scrollTop += 100;
    await sleep(40);
  }
}

/** One short filter burst — avoids the multi-setNativeValue crash pattern. */
async function oneShotFilter(wrapper: HTMLElement, filter: string): Promise<void> {
  const input = wrapper.querySelector<HTMLInputElement>(
    'input[role="combobox"], input[role="searchbox"]',
  );
  if (!input || !document.contains(input)) return;
  const short = filter.slice(0, Math.min(8, filter.length));
  if (!short) return;
  input.focus();
  await sleep(50);
  try {
    input.select?.();
    if (typeof document.execCommand === "function" && document.queryCommandSupported?.("insertText")) {
      document.execCommand("insertText", false, short);
    } else {
      setNativeValue(input, short);
    }
  } catch {
    setNativeValue(input, short);
  }
  await sleep(600);
}

async function drillSourceCategoriesThenPick(
  trigger: HTMLElement,
  surface: HTMLElement,
  candidates: string[],
): Promise<HTMLElement | null> {
  const categoryRx = [
    /\bsocial\b/i,
    /\bonline\b/i,
    /\binternet\b/i,
    /\bweb\b/i,
    /\bmedia\b/i,
    /\bsearch\b/i,
    /\bjob\b/i,
    /\bemployee\b/i,
    /\bcompany\b/i,
    /\bcareer\b/i,
  ];
  const live = (): HTMLElement => pickerSurface(trigger, surface);
  let hit = pickOptionAmong(collectOptions(live()), candidates);
  if (hit) return hit;
  for (const rx of categoryRx) {
    const rows = collectOptions(live());
    const cat = rows.find((o) => {
      const t = text(o);
      return rx.test(t) && t.length < 80;
    });
    if (!cat) continue;
    cat.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    await activatePickerChoice(cat);
    await sleep(500);
    hit = pickOptionAmong(collectOptions(live()), candidates);
    if (hit) return hit;
  }
  return null;
}

async function resolveComboboxPick(
  field: DetectedField,
  trigger: HTMLElement,
  surface: HTMLElement,
  candidates: string[],
): Promise<HTMLElement | null> {
  let live = pickerSurface(trigger, surface);
  let hit = pickOptionAmong(collectOptions(live), candidates);
  if (hit) return hit;
  await scrollPickerOptions(live);
  live = pickerSurface(trigger, surface);
  hit = pickOptionAmong(collectOptions(live), candidates);
  if (hit) return hit;
  if (isSourceChannelField(field.label)) {
    const drilled = await drillSourceCategoriesThenPick(trigger, surface, candidates);
    if (drilled) return drilled;
  }
  return null;
}

function leafClickTarget(el: HTMLElement): HTMLElement {
  const rowCb = el.querySelector<HTMLInputElement>('input[type="checkbox"]:not([disabled])');
  if (rowCb && el.contains(rowCb) && isVisible(rowCb)) return rowCb;
  const closestOpt = el.closest('[role="option"]');
  const opt = closestOpt instanceof HTMLElement ? closestOpt : el;
  const inner =
    opt.querySelector<HTMLElement>("button:not([disabled])") ??
    opt.querySelector<HTMLElement>('[data-automation-id*="promptIcon"]');
  if (inner && isVisible(inner) && opt.contains(inner)) return inner;
  return opt;
}

/** Workday often ignores synthetic MouseEvent-only clicks on option rows. */
async function activatePickerChoice(target: HTMLElement): Promise<void> {
  const clickEl = leafClickTarget(target);
  clickEl.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await sleep(40);
  realClick(clickEl);
  await sleep(50);
  if (typeof clickEl.click === "function") clickEl.click();
  await sleep(120);
  if (findOpenPopup()) {
    const init: KeyboardEventInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    };
    clickEl.dispatchEvent(new KeyboardEvent("keydown", init));
    clickEl.dispatchEvent(new KeyboardEvent("keyup", init));
    await sleep(80);
  }
}

async function fillCombobox(
  field: DetectedField,
  hintEl: HTMLElement,
  value: string,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;

  const trigger =
    (document.contains(hintEl) && isVisible(hintEl) ? hintEl : null) ??
    resolveFieldElement(field);
  if (!trigger || !document.contains(trigger)) {
    throw new Error("Combobox no longer in DOM");
  }

  const wrapper =
    trigger.closest<HTMLElement>(
      '[data-automation-id^="formField-"], [data-automation-id="formField"]',
    ) ?? trigger.parentElement ?? trigger;
  const input = wrapper.querySelector<HTMLInputElement>(
    'input[role="combobox"], input[role="searchbox"], input:not([type=hidden]):not([type=button])',
  );

  const cleanup = async () => {
    if (input && document.contains(input)) {
      try {
        setNativeValue(input, "");
        input.blur();
      } catch {
        /* ignore */
      }
    }
    await pressEscapeOnce();
  };

  trigger.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await sleep(50);
  realClick(trigger);

  const popup = await waitFor<HTMLElement>(() => {
    const scoped = findListboxFromTrigger(trigger);
    if (scoped) return scoped;
    return findOpenPopup();
  }, {
    timeout: 5000,
    interval: 80,
  });
  if (!popup) {
    await cleanup();
    throw new Error("Picker popup did not open");
  }

  const surface = pickerSurface(trigger, popup);

  // Options may stream in slowly; don't hard-fail if the first paint is empty
  // (hierarchical pickers sometimes show category chrome first).
  await waitFor(() => collectOptions(pickerSurface(trigger, popup)).length > 0, {
    timeout: 3000,
    interval: 100,
  });

  // Netflix-style multiselect + "how did you hear" often populate only after typing in the search box.
  if (field.kind === "multiselect" || isSourceChannelField(field.label)) {
    const early =
      trimmed.length <= 2 ? trimmed : trimmed.slice(0, Math.min(8, trimmed.length));
    await oneShotFilter(wrapper, early);
    await sleep(450);
  }

  const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];
  const candidates = uniq([trimmed, ...comboboxAlternatives(trimmed, field.label)]);

  let target = await resolveComboboxPick(field, trigger, surface, candidates);

  // One short filter burst — only after scroll + drill failed. Uses a tiny
  // hint string (not the full synonym storm) to avoid Netflix crashes.
  if (!target) {
    const filterHint = isPhoneDeviceField(field.label)
      ? "Cell"
      : trimmed.length > 6
        ? trimmed.slice(0, 6)
        : trimmed;
    await oneShotFilter(wrapper, filterHint);
    target = await resolveComboboxPick(field, trigger, surface, candidates);
  }

  // Multiselect: opening via the prompt button sometimes leaves the list empty; the search input is more reliable.
  if (
    !target &&
    field.kind === "multiselect" &&
    input &&
    document.contains(input) &&
    input !== trigger
  ) {
    await cleanup();
    await sleep(120);
    input.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    await sleep(40);
    realClick(input);
    const popup2 = await waitFor<HTMLElement>(() => {
      const scoped = findListboxFromTrigger(input);
      if (scoped) return scoped;
      return findOpenPopup();
    }, { timeout: 4500, interval: 80 });
    if (popup2) {
      const surface2 = pickerSurface(input, popup2);
      await waitFor(() => collectOptions(pickerSurface(input, popup2)).length > 0, {
        timeout: 2500,
        interval: 100,
      });
      await oneShotFilter(wrapper, trimmed.slice(0, Math.min(8, trimmed.length)));
      await sleep(450);
      target = await resolveComboboxPick(field, input, surface2, candidates);
    }
  }
  if (!target) {
    const live = pickerSurface(trigger, popup);
    const visible = collectOptions(live)
      .map((o) => text(o).slice(0, 80))
      .filter(Boolean);
    if (visible.length > 0) {
      console.warn(
        `[wda] No option matching "${value}" in "${field.label}". Sample:`,
        visible.slice(0, 40),
      );
    } else {
      console.warn(`[wda] No options collected for "${field.label}".`);
    }
    await cleanup();
    throw new Error(`No option matching "${value}"`);
  }

  await activatePickerChoice(target);
  await sleep(220);

  if (findOpenPopup()) {
    await pressEscapeOnce();
  }
}

function fillRadio(field: DetectedField, value: string): void {
  const scope: ParentNode =
    field.formFieldAutomationId != null
      ? queryFormFieldByAutomationId(field.formFieldAutomationId) ?? document
      : document;
  const inputs = Array.from(
    scope.querySelectorAll<HTMLInputElement>(`input[type="radio"]`),
  );
  // Restrict to those whose group label matches the field label - we
  // do that by walking up to the nearest form-field wrapper.
  const wrapperLabel = field.label.toLowerCase();
  const candidates =
    scope === document
      ? inputs.filter((i) => {
          const wrap = i.closest('[data-automation-id^="formField"]');
          const lbl = wrap?.querySelector('[data-automation-id="formLabel"]');
          return (
            !wrap ||
            !lbl ||
            text(lbl).toLowerCase().includes(wrapperLabel) ||
            wrapperLabel.includes(text(lbl).toLowerCase())
          );
        })
      : inputs;
  const lc = value.toLowerCase().trim();
  const match =
    candidates.find((r) => r.value.toLowerCase() === lc) ??
    candidates.find((r) => {
      const lbl = (r.labels?.[0]?.textContent ?? "").toLowerCase();
      return lbl === lc || lbl.includes(lc);
    });
  if (!match) throw new Error(`No radio option matching "${value}"`);
  match.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  // A real mouse click already toggles `.checked` and fires `change` via React.
  // Setting `.checked` manually afterwards and dispatching a second `change`
  // has caused Workday to enter an inconsistent state on Netflix.
  realClick(match);
}

function fillSingleCheckbox(input: HTMLInputElement, desired: boolean): void {
  if (input.checked === desired) return;
  input.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  realClick(input);
}

function fillCheckboxGroup(field: DetectedField, values: string[]): void {
  const want = new Set(values.map((v) => v.toLowerCase().trim()));
  const scope: ParentNode =
    field.formFieldAutomationId != null
      ? queryFormFieldByAutomationId(field.formFieldAutomationId) ?? document
      : document;
  const inputs = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ).filter((cb) => {
    if (scope !== document) return true;
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
async function fillDate(wrapper: HTMLElement, value: string): Promise<void> {
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

  if (month) {
    setNativeValue(month, parts.month);
    await sleep(45);
  }
  if (day && parts.day) {
    setNativeValue(day, parts.day);
    await sleep(45);
  }
  if (year) {
    setNativeValue(year, parts.year);
    await sleep(45);
  }

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

// Option-picking helpers were removed alongside the dropdown handlers.
