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

  for (const wrapper of wrappers) {
    if (!isVisible(wrapper)) continue;
    const detected = detectInsideWrapper(wrapper, stepName);
    for (const d of detected) {
      registry.set(d.field.id, d.element);
      fields.push(d.field);
      seen.add(d.element);
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

  // Detect "Add Another" repeatable sections so the navigator can
  // expand them before mapping.
  return { fields, registry, stepName };
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
    // We expose the wrapper itself; the filler knows how to fill the
    // three sub-inputs.
    const id = stableId("date");
    return [
      {
        element: dateWrapper,
        field: {
          id,
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
    const id = stableId("file");
    return [
      {
        element: fileInput,
        field: {
          id,
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
    const id = stableId("radio");
    const options: FieldOption[] = radios.map((r) => ({
      value: r.value || readRadioLabel(r),
      label: readRadioLabel(r),
    }));
    const checked = radios.find((r) => r.checked);
    return [
      {
        element: radios[0],
        field: {
          id,
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
    const id = stableId("ckg");
    const options: FieldOption[] = checkboxes.map((c) => ({
      value: c.value || readRadioLabel(c),
      label: readRadioLabel(c),
    }));
    const checked = checkboxes.filter((c) => c.checked).map((c) => c.value);
    return [
      {
        element: checkboxes[0],
        field: {
          id,
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
    const id = stableId("ck");
    return [
      {
        element: cb,
        field: {
          id,
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
    const id = stableId("sel");
    const options = Array.from(selectEl.options).map<FieldOption>((o) => ({
      value: o.value,
      label: o.text,
    }));
    return [
      {
        element: selectEl,
        field: {
          id,
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
    const id = stableId("cb");
    const isMulti =
      combobox.getAttribute("aria-multiselectable") === "true" ||
      !!wrapper.querySelector('[data-automation-id="multiselectInputContainer"]');
    return [
      {
        element: combobox,
        field: {
          id,
          label,
          helpText,
          required,
          kind: isMulti ? "multiselect" : "combobox",
          section: sectionName,
          selector: '[role="combobox"]',
          currentValue: readComboboxValue(combobox, wrapper) ?? undefined,
        },
      },
    ];
  }

  if (textInput) {
    const id = stableId("inp");
    return [
      {
        element: textInput,
        field: {
          id,
          label,
          ariaLabel: textInput.getAttribute("aria-label") ?? undefined,
          placeholder: textInput.getAttribute("placeholder") ?? undefined,
          helpText,
          required,
          kind: classifyInput(textInput),
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

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") {
      return {
        element: el,
        field: {
          id: stableId("ck"),
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
        id: stableId("inp"),
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
        id: stableId("ta"),
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
    return {
      element: el,
      field: {
        id: stableId("sel"),
        label,
        required: el.required,
        kind: "select",
        options: Array.from(el.options).map((o) => ({ value: o.value, label: o.text })),
        section: stepName,
        selector: "select",
        currentValue: el.value,
      },
    };
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
  combobox: HTMLElement,
  wrapper: HTMLElement,
): string | null {
  const selectedPill = wrapper.querySelector<HTMLElement>(
    '[data-automation-id="selectedItem"], [data-automation-id="DELETE_TAG"]',
  );
  if (selectedPill) return text(selectedPill);
  const fromAria = combobox.getAttribute("aria-activedescendant");
  if (fromAria) {
    const labelled = document.getElementById(fromAria);
    if (labelled) return text(labelled);
  }
  const inner = text(combobox);
  if (inner && !/select one/i.test(inner)) return inner;
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
