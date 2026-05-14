/**
 * Workday field detector.
 *
 * Walks the live DOM, looking for "form-like" widgets and producing a
 * normalized `DetectedField[]` along with a registry that the filler
 * uses later to resolve our generated ids back to real elements.
 *
 * We do NOT rely on selectors only - we keep an in-memory map from id
 * -> live element. If the page re-renders we re-detect, which is
 * cheaper than maintaining unique CSS paths.
 */

import { DetectedField, FieldKind, FieldOption } from "@/lib/types";
import { isVisible, stableId, text } from "@/content/workday/dom-utils";

/** Workday's stable wrapper id, e.g. `formField-givenName` or `formField-addressLine1$47281`. */
function workdayAnchor(wrapper: HTMLElement): string | undefined {
  const a = wrapper.getAttribute("data-automation-id");
  return a && /^formField/i.test(a) ? a : undefined;
}

/**
 * Deterministic field id + anchor so we can re-query the DOM after React
 * re-renders (stale HTMLElement pointers were crashing Netflix / Workday).
 */
function shell(
  wrapper: HTMLElement,
  kind: FieldKind,
  tag = "",
): Pick<DetectedField, "id" | "formFieldAutomationId"> {
  const anchor = workdayAnchor(wrapper);
  const id = anchor ? `${anchor}__${kind}${tag ? `__${tag}` : ""}` : stableId(kind);
  return { id, formFieldAutomationId: anchor };
}

/** True if this wrapper is a dropdown we intentionally do not autofill. */
function wrapperContainsSkippedDropdown(wrapper: HTMLElement): boolean {
  return (
    !!wrapper.querySelector<HTMLSelectElement>("select") ||
    !!wrapper.querySelector<HTMLElement>(
      '[role="combobox"], [data-automation-id="multiselectInputContainer"], button[aria-haspopup="listbox"], button[aria-haspopup="true"]',
    )
  );
}

/** Prevent loose-input detection from grabbing combobox inner inputs. */
function markFormControlsInsideSeen(wrapper: HTMLElement, seen: Set<Element>): void {
  wrapper
    .querySelectorAll<HTMLElement>(
      'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea',
    )
    .forEach((el) => {
      seen.add(el);
    });
}

export interface DetectionResult {
  fields: DetectedField[];
  registry: Map<string, HTMLElement>;
  stepName?: string;
}

/** Run a fresh detection pass over the page. */
export function detectFields(root: ParentNode = document): DetectionResult {
  const registry = new Map<string, HTMLElement>();
  const fields: DetectedField[] = [];

  const stepName = detectStepName(root);

  // Each Workday form control is wrapped in a fieldset / div with
  // data-automation-id="formField-<name>". We use this as our primary
  // anchor and fall back to scanning bare inputs.
  const wrappers = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-automation-id^="formField-"], [data-automation-id="formField"], [data-automation-id="dateInputWrapper"]',
    ),
  );

  const seen = new Set<Element>();
  // Some Workday tenants (Netflix) emit the SAME `data-automation-id` on
  // every repeated row of Work Experience / Education without a unique
  // suffix. `shell()` would then generate identical ids for every row,
  // collapsing the registry to a single element. We disambiguate by
  // appending a per-id occurrence counter so row 1's "Job Title" gets
  // a distinct id from row 0's.
  const idOccurrences = new Map<string, number>();

  for (const wrapper of wrappers) {
    if (!isVisible(wrapper)) continue;
    const detected = detectInsideWrapper(wrapper, stepName);
    for (const d of detected) {
      const baseId = d.field.id;
      const n = idOccurrences.get(baseId) ?? 0;
      idOccurrences.set(baseId, n + 1);
      if (n > 0) {
        d.field.id = `${baseId}__row${n}`;
      }
      registry.set(d.field.id, d.element);
      fields.push(d.field);
      seen.add(d.element);
      // For combobox / multiselect / <select>, the wrapper may also contain
      // a search <input> that would otherwise be picked up as a plain text
      // field by the loose-input pass below. Mark every form control inside
      // the wrapper as seen so the dropdown is detected once, as a dropdown.
      if (d.field.kind === "combobox" || d.field.kind === "multiselect" || d.field.kind === "select") {
        markFormControlsInsideSeen(wrapper, seen);
      }
    }
  }

  // Pick up loose inputs (rare but happens for "I agree" checkboxes etc.)
  const loose = Array.from(
    root.querySelectorAll<HTMLElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea",
    ),
  ).filter((el) => isVisible(el) && !seen.has(el));

  for (const el of loose) {
    const detected = describeBareInput(el, stepName);
    if (!detected) continue;
    registry.set(detected.field.id, detected.element);
    fields.push(detected.field);
  }

  // Annotate repeatable fields with their row index. Workday repeats sections
  // like Work Experience / Education with `data-automation-id` suffixes such
  // as `formField-jobTitle$48721`. All fields in the same row share the same
  // `$NNN` suffix. We assign repeatIndex by the row's first DOM-appearance.
  annotateRepeatableRows(fields, registry);

  return { fields, registry, stepName };
}

function annotateRepeatableRows(
  fields: DetectedField[],
  registry: Map<string, HTMLElement>,
): void {
  // Workday tenants vary in how they tag repeat-row fields:
  //   - Some use `formField-jobTitle$48721` (dollar + numeric suffix).
  //   - Netflix often uses unsuffixed `formField-jobTitle` per row, distinguished
  //     only by DOM position.
  // Strategy: classify each DetectedField by its semantic "kind" (jobTitle,
  // company, from, to, school, degree, ...), group same-kind fields, sort by
  // DOM y-position, and assign repeatIndex by that order.
  //
  // This works regardless of whether the automation IDs are suffixed.
  type Kind =
    | "exp-title"
    | "exp-company"
    | "exp-location"
    | "exp-from"
    | "exp-to"
    | "exp-current"
    | "exp-summary"
    | "edu-school"
    | "edu-degree"
    | "edu-field"
    | "edu-from"
    | "edu-to"
    | "lang-name"
    | "lang-prof";
  type Section = "experience" | "education" | "language";

  function pickKind(f: DetectedField): { kind: Kind; section: Section } | null {
    const aid = (f.formFieldAutomationId ?? "")
      .replace(/^formField-?/, "")
      .replace(/\$.*$/, "")
      .toLowerCase();
    const lbl = `${f.label} ${f.ariaLabel ?? ""} ${f.placeholder ?? ""}`.toLowerCase();
    const hay = `${aid} ${lbl}`;
    const section = (f.section ?? "").toLowerCase();
    const inEdu = /educat|school|university|college|academic|qualification|degree/.test(section);
    const inLang =
      /language|languages|locale|fluency|proficiency|lingua|bilingual/i.test(section) ||
      /\b(languages?|fluency|proficiency)\b/i.test(lbl);

    // Classify Writing / Reading / … as `lang-prof` BEFORE generic "language name",
    // otherwise every column becomes `lang-name` and repeatIndex is wrong.
    if (inLang || /^language(name)?$/i.test(aid) || /\blanguage\b/.test(hay)) {
      if (
        /\b(writing|reading|speaking|comprehension|overall|listening|oral|verbal|interaction|punctuation)\b/i.test(
          hay,
        )
      ) {
        return { kind: "lang-prof", section: "language" };
      }
      return { kind: "lang-name", section: "language" };
    }
    if (/\bproficien|fluency\b/.test(hay) && !/\b(how|what|which)\b/.test(hay))
      return { kind: "lang-prof", section: "language" };

    if (inEdu || /\bschool|university|institution|college\b/.test(hay))
      return { kind: "edu-school", section: "education" };
    if (inEdu && /\bdegree\b/.test(hay)) return { kind: "edu-degree", section: "education" };
    if (/\bdegree\b/.test(hay)) return { kind: "edu-degree", section: "education" };
    if (/\bfield\s*of\s*study|major|discipline\b/.test(hay))
      return { kind: "edu-field", section: "education" };

    if (/\bjob\s*title|jobtitle|position|role|^title$/.test(hay) && !/\bcert/.test(hay))
      return { kind: "exp-title", section: inEdu ? "education" : "experience" };
    if (/\bcompany|employer|organization\b/.test(hay))
      return { kind: "exp-company", section: "experience" };
    if (/\b(location|city)\b/.test(hay) && !/\bcountry\b/.test(hay))
      return { kind: "exp-location", section: "experience" };
    if (/\b(currently\s*work|currentlywork)\b/.test(hay))
      return { kind: "exp-current", section: "experience" };
    if (/\b(summary|responsibilit|description|highlight)\b/.test(hay))
      return { kind: "exp-summary", section: "experience" };

    // "From" / "To" are ambiguous (could be education OR experience). Route by
    // the section heading; experience is the default.
    if (/\b(from|start\s*date|start)\b/.test(hay) && !/\b(country|state|city)\b/.test(hay)) {
      return { kind: inEdu ? "edu-from" : "exp-from", section: inEdu ? "education" : "experience" };
    }
    if (/\b(to|end\s*date|through|until)\b/.test(hay) && !/\b(country|state|city)\b/.test(hay)) {
      return { kind: inEdu ? "edu-to" : "exp-to", section: inEdu ? "education" : "experience" };
    }

    return null;
  }

  // Group fields by kind. We also exclude obviously single-occurrence cases
  // (header "Job Title" search box, etc.) by requiring repeatable kinds to
  // appear at least once — annotation is harmless even for a single row.
  const byKind = new Map<Kind, { field: DetectedField; section: Section; pos: number }[]>();
  for (const f of fields) {
    if (f.kind === "file") continue;
    const k = pickKind(f);
    if (!k) continue;
    const el = registry.get(f.id);
    const rect = el?.getBoundingClientRect();
    const pos = rect ? rect.top + window.scrollY : 0;
    if (!byKind.has(k.kind)) byKind.set(k.kind, []);
    byKind.get(k.kind)!.push({ field: f, section: k.section, pos });
  }

  for (const [, entries] of byKind) {
    entries.sort((a, b) => a.pos - b.pos);
    entries.forEach((e, idx) => {
      e.field.repeatable = true;
      e.field.repeatIndex = idx;
      // Override section so the heuristic rules dispatch correctly.
      e.field.section =
        e.section === "education"
          ? "Education"
          : e.section === "language"
            ? "Languages"
            : "Work Experience";
    });
  }

  rebucketLanguageRepeatIndexes(fields, registry);
}

/** One repeatIndex per language *row* (name + Writing/Reading/… share the same index). */
function rebucketLanguageRepeatIndexes(
  fields: DetectedField[],
  registry: Map<string, HTMLElement>,
): void {
  const langFs = fields.filter(
    (f) =>
      /language|languages|fluency|proficiency/i.test(f.section ?? "") ||
      /\b(writing|reading|speaking|comprehension|overall)\b/i.test(f.label),
  );
  if (langFs.length === 0) return;
  const withPos = langFs
    .map((f) => ({
      f,
      top: registry.get(f.id)?.getBoundingClientRect().top ?? 0,
    }))
    .sort((a, b) => a.top - b.top);
  let row = -1;
  let anchorTop = Number.NEGATIVE_INFINITY;
  for (const { f, top } of withPos) {
    if (row < 0 || top - anchorTop > 72) {
      row++;
      anchorTop = top;
    }
    f.repeatIndex = row;
  }
}

/* ------------------------------------------------------------------ */

interface DetectedOne {
  field: DetectedField;
  element: HTMLElement;
}

function detectInsideWrapper(
  wrapper: HTMLElement,
  stepName: string | undefined,
): DetectedOne[] {
  const label = readLabel(wrapper);
  const helpText = readHelpText(wrapper);
  const sectionName = readSection(wrapper) ?? stepName;

  // 1. Single <input>/<textarea>
  const textInput = wrapper.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]), textarea',
  );

  // 2. Native <select>
  const selectEl = wrapper.querySelector<HTMLSelectElement>("select");

  // 3. Workday combobox (button + listbox)
  const combobox = wrapper.querySelector<HTMLElement>(
    '[role="combobox"], [data-automation-id="multiselectInputContainer"], button[aria-haspopup="listbox"], button[aria-haspopup="true"]',
  );

  // 4. Radio group / checkboxes
  const radios = Array.from(
    wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
  const checkboxes = Array.from(
    wrapper.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );

  // 5. File input
  const fileInput = wrapper.querySelector<HTMLInputElement>('input[type="file"]');

  // 6. Date input (Workday usually splits into three sub-inputs)
  const dateWrapper = wrapper.matches('[data-automation-id="dateInputWrapper"]')
    ? wrapper
    : wrapper.querySelector<HTMLElement>('[data-automation-id="dateInputWrapper"]');

  const required = isRequired(wrapper);

  if (dateWrapper) {
    return [
      {
        element: dateWrapper,
        field: {
          ...shell(wrapper, "date"),
          label,
          helpText,
          required,
          kind: "date",
          section: sectionName,
          selector: `[data-automation-id="dateInputWrapper"]`,
          currentValue: readDateValue(dateWrapper),
        },
      },
    ];
  }

  if (fileInput) {
    return [
      {
        element: fileInput,
        field: {
          ...shell(wrapper, "file"),
          label,
          helpText,
          required,
          kind: "file",
          section: sectionName,
          selector: "input[type=file]",
        },
      },
    ];
  }

  if (radios.length > 0) {
    const options: FieldOption[] = radios.map((r) => ({
      value: r.value || readRadioLabel(r),
      label: readRadioLabel(r),
    }));
    const checked = radios.find((r) => r.checked);
    return [
      {
        element: radios[0],
        field: {
          ...shell(wrapper, "radio"),
          label,
          helpText,
          required,
          kind: "radio",
          options,
          section: sectionName,
          selector: 'input[type="radio"]',
          currentValue: checked?.value,
        },
      },
    ];
  }

  if (checkboxes.length > 1) {
    const options: FieldOption[] = checkboxes.map((c) => ({
      value: c.value || readRadioLabel(c),
      label: readRadioLabel(c),
    }));
    const checked = checkboxes.filter((c) => c.checked).map((c) => c.value);
    return [
      {
        element: checkboxes[0],
        field: {
          ...shell(wrapper, "checkbox", "group"),
          label,
          helpText,
          required,
          kind: "checkbox",
          options,
          section: sectionName,
          selector: 'input[type="checkbox"]',
          currentValue: checked.join(","),
        },
      },
    ];
  }

  if (checkboxes.length === 1) {
    const cb = checkboxes[0];
    return [
      {
        element: cb,
        field: {
          ...shell(wrapper, "checkbox"),
          label,
          helpText,
          required,
          kind: "checkbox",
          section: sectionName,
          selector: 'input[type="checkbox"]',
          currentValue: cb.checked ? "true" : "false",
        },
      },
    ];
  }

  if (selectEl) {
    const options = Array.from(selectEl.options).map<FieldOption>((o) => ({
      value: o.value,
      label: o.text,
    }));
    return [
      {
        element: selectEl,
        field: {
          ...shell(wrapper, "select"),
          label,
          helpText,
          required,
          kind: "select",
          options,
          section: sectionName,
          selector: "select",
          currentValue: selectEl.value,
        },
      },
    ];
  }

  if (combobox) {
    const isMulti =
      combobox.getAttribute("aria-multiselectable") === "true" ||
      !!wrapper.querySelector('[data-automation-id="multiselectInputContainer"]');
    const kind: FieldKind = isMulti ? "multiselect" : "combobox";
    return [
      {
        element: combobox,
        field: {
          ...shell(wrapper, kind),
          label,
          helpText,
          required,
          kind,
          section: sectionName,
          selector: '[role="combobox"]',
          currentValue: readComboboxValue(combobox, wrapper) ?? undefined,
        },
      },
    ];
  }

  if (textInput) {
    const kind = classifyInput(textInput);
    return [
      {
        element: textInput,
        field: {
          ...shell(wrapper, kind),
          label,
          ariaLabel: textInput.getAttribute("aria-label") ?? undefined,
          placeholder: textInput.getAttribute("placeholder") ?? undefined,
          helpText,
          required,
          kind,
          section: sectionName,
          selector: textInput.tagName.toLowerCase(),
          currentValue: textInput.value,
        },
      },
    ];
  }

  return [];
}

function describeBareInput(
  el: HTMLElement,
  stepName: string | undefined,
): DetectedOne | null {
  const label =
    el.getAttribute("aria-label") ||
    findLabelFor(el) ||
    el.getAttribute("placeholder") ||
    "";
  if (!label) return null;

  const wrap = el.closest<HTMLElement>(
    '[data-automation-id^="formField-"], [data-automation-id="formField"]',
  );
  if (wrap && wrapperContainsSkippedDropdown(wrap)) return null;

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") {
      return {
        element: el,
        field: {
          ...(wrap ? shell(wrap, "checkbox") : { id: stableId("ck"), formFieldAutomationId: undefined }),
          label,
          required: el.required,
          kind: "checkbox",
          section: stepName,
          selector: 'input[type="checkbox"]',
          currentValue: el.checked ? "true" : "false",
        },
      };
    }
    if (el.type === "radio") return null; // detected via groups
    return {
      element: el,
      field: {
        ...(wrap ? shell(wrap, classifyInput(el)) : { id: stableId("inp"), formFieldAutomationId: undefined }),
        label,
        required: el.required,
        kind: classifyInput(el),
        section: stepName,
        selector: "input",
        currentValue: el.value,
      },
    };
  }
  if (el instanceof HTMLTextAreaElement) {
    return {
      element: el,
      field: {
        ...(wrap ? shell(wrap, "textarea") : { id: stableId("ta"), formFieldAutomationId: undefined }),
        label,
        required: el.required,
        kind: "textarea",
        section: stepName,
        selector: "textarea",
        currentValue: el.value,
      },
    };
  }
  if (el instanceof HTMLSelectElement) {
    // Skip native <select> as well — dropdowns are intentionally unhandled.
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Label / metadata extraction                                        */
/* ------------------------------------------------------------------ */

function readLabel(wrapper: HTMLElement): string {
  // Workday's labels live in <label> elements with data-automation-id="formLabel"
  const labelEl =
    wrapper.querySelector<HTMLElement>(
      '[data-automation-id="formLabel"], label, legend',
    ) ?? null;
  if (labelEl) return text(labelEl).replace(/\*$/, "").trim();

  const aria =
    wrapper.querySelector<HTMLElement>("[aria-label]")?.getAttribute("aria-label") ?? "";
  if (aria) return aria;

  // automation-id often encodes the field name: formField-givenName
  const auto = wrapper.getAttribute("data-automation-id") ?? "";
  return auto.replace(/^formField-/, "").replace(/([A-Z])/g, " $1").trim();
}

function readHelpText(wrapper: HTMLElement): string | undefined {
  const help = wrapper.querySelector<HTMLElement>(
    '[data-automation-id="formFieldHelpText"], .help-text, [class*="HelpText"]',
  );
  return help ? text(help) : undefined;
}

function readSection(wrapper: HTMLElement): string | undefined {
  let cur: HTMLElement | null = wrapper.parentElement;
  while (cur) {
    const heading = cur.querySelector<HTMLElement>(
      "h1, h2, h3, h4, [role='heading']",
    );
    if (heading && cur.contains(heading) && heading.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const t = text(heading);
      if (t) return t;
    }
    if (cur.tagName === "FORM" || cur === document.body) break;
    cur = cur.parentElement;
  }
  return undefined;
}

function readRadioLabel(input: HTMLInputElement): string {
  if (input.labels && input.labels.length > 0) return text(input.labels[0]);
  const parent = input.closest("label") ?? input.parentElement;
  return text(parent ?? input) || input.value;
}

function findLabelFor(el: HTMLElement): string {
  const id = el.id;
  if (id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (lbl) return text(lbl);
  }
  const wrapping = el.closest("label");
  if (wrapping) return text(wrapping);
  return "";
}

function isRequired(wrapper: HTMLElement): boolean {
  if (wrapper.querySelector('[aria-required="true"], [required]')) return true;
  const label = wrapper.querySelector('[data-automation-id="formLabel"]');
  return text(label).endsWith("*");
}

function classifyInput(el: HTMLInputElement | HTMLTextAreaElement): FieldKind {
  if (el instanceof HTMLTextAreaElement) return "textarea";
  switch (el.type) {
    case "email": return "email";
    case "tel": return "tel";
    case "url": return "url";
    case "number": return "number";
    case "date": return "date";
    default: return "text";
  }
}

function readDateValue(wrapper: HTMLElement): string {
  const inputs = Array.from(
    wrapper.querySelectorAll<HTMLInputElement>("input"),
  );
  if (inputs.length === 0) return "";
  return inputs.map((i) => i.value).filter(Boolean).join("/");
}

function readComboboxValue(
  _combobox: HTMLElement,
  wrapper: HTMLElement,
): string | null {
  // Only treat the field as "filled" when there is a committed selection
  // pill. Otherwise visible text in a search input is uncommitted and we
  // would incorrectly skip the field with "preservePrefilled".
  const selectedPill = wrapper.querySelector<HTMLElement>(
    '[data-automation-id="selectedItem"], [data-automation-id="DELETE_TAG"]',
  );
  if (selectedPill) {
    const t = text(selectedPill);
    if (t) return t;
  }
  return null;
}

function detectStepName(root: ParentNode): string | undefined {
  // Workday wizards put the current step name into an h2 with
  // data-automation-id="jobApplicationProgressBar..." or similar.
  const candidates = [
    '[data-automation-id="pageHeader"]',
    '[data-automation-id="taskPageHeader"]',
    '[data-automation-id="step"] [aria-current]',
    "h2",
    "h1",
  ];
  for (const sel of candidates) {
    const el = (root as Document).querySelector<HTMLElement>(sel);
    const t = text(el);
    if (t && t.length < 100) return t;
  }
  return undefined;
}
