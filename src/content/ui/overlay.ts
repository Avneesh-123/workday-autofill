/**
 * Lightweight in-page overlay that shows live autofill status and a
 * pre-submission review screen. Built as raw DOM (no React in the
 * content script) so it loads instantly and never conflicts with
 * Workday's React tree.
 */

import { DetectedField, MappedValue } from "@/lib/types";

export interface OverlayHandle {
  setStatus: (text: string) => void;
  setProgress: (filled: number, total: number) => void;
  showReview: (
    items: ReviewItem[],
    actions: { onConfirm: () => void; onCancel: () => void; onRetryField: (id: string) => void },
  ) => void;
  /**
   * Pause before filling and let the user approve / edit AI answers that fell
   * below the confidence threshold. Resolves with the (possibly edited) values.
   * Items the user skipped have their value cleared to `null`.
   */
  reviewBeforeFill: (items: PreFillItem[]) => Promise<MappedValue[]>;
  appendLog: (msg: string) => void;
  destroy: () => void;
}

export interface ReviewItem {
  field: DetectedField;
  answer: MappedValue;
  status: "filled" | "skipped" | "error";
  message?: string;
}

export interface PreFillItem {
  field: DetectedField;
  answer: MappedValue;
}

export interface MountOverlayOptions {
  /** Called when user clicks Stop or × — must halt the autofill loop. */
  onUserStop?: () => void;
}

const STYLE_ID = "wda-overlay-style";
const OVERLAY_ID = "wda-overlay-root";

const CSS = `
#${OVERLAY_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 360px;
  max-height: 70vh;
  background: #0f172a;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,.35);
  z-index: 2147483646;
  overflow: hidden;
  display: flex; flex-direction: column;
}
#${OVERLAY_ID} .wda-h {
  padding: 12px 14px;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 600;
}
#${OVERLAY_ID} .wda-h-actions {
  display: flex; align-items: center; gap: 8px;
}
#${OVERLAY_ID} .wda-stop {
  background: #7f1d1d; color: #fecaca; border: 1px solid #fca5a5;
  border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700;
  cursor: pointer;
}
#${OVERLAY_ID} .wda-h button {
  background: transparent; border: 0; color: #fff; cursor: pointer;
  font-size: 16px;
}
#${OVERLAY_ID} .wda-body {
  padding: 10px 14px; overflow: auto; flex: 1 1 auto;
}
#${OVERLAY_ID} .wda-progress {
  height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; margin: 6px 0 10px;
}
#${OVERLAY_ID} .wda-progress > div {
  height: 100%; background: #22c55e; width: 0%; transition: width .25s ease;
}
#${OVERLAY_ID} .wda-status { font-size: 12px; color: #cbd5e1; }
#${OVERLAY_ID} .wda-log {
  margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: #94a3b8; max-height: 90px; overflow: auto;
  background: #020617; padding: 6px 8px; border-radius: 6px;
}
#${OVERLAY_ID} .wda-review { display: none; }
#${OVERLAY_ID} .wda-review h3 { margin: 0 0 6px; font-size: 13px; color: #f1f5f9; }
#${OVERLAY_ID} .wda-item {
  padding: 8px 0; border-bottom: 1px solid #1e293b;
}
#${OVERLAY_ID} .wda-item:last-child { border-bottom: 0; }
#${OVERLAY_ID} .wda-label { font-weight: 600; color: #e2e8f0; font-size: 12px; }
#${OVERLAY_ID} .wda-section { color: #94a3b8; font-size: 11px; }
#${OVERLAY_ID} .wda-val   { color: #38bdf8; font-size: 12px; word-break: break-word; }
#${OVERLAY_ID} .wda-warn  { color: #f59e0b; font-size: 11px; }
#${OVERLAY_ID} .wda-err   { color: #ef4444; font-size: 11px; }
#${OVERLAY_ID} .wda-actions {
  display: flex; gap: 8px; padding: 10px 14px;
  border-top: 1px solid #1e293b; background: #0b1224;
}
#${OVERLAY_ID} .wda-btn {
  flex: 1; padding: 8px 10px; border-radius: 8px; border: 0; cursor: pointer;
  font-size: 12px; font-weight: 600;
}
#${OVERLAY_ID} .wda-btn.primary { background: #22c55e; color: #052e10; }
#${OVERLAY_ID} .wda-btn.danger  { background: #ef4444; color: #fff; }
#${OVERLAY_ID} .wda-btn.ghost   { background: #1e293b; color: #e2e8f0; }
#${OVERLAY_ID} .wda-pill {
  display: inline-block; padding: 1px 6px; border-radius: 999px;
  background: #1e293b; color: #94a3b8; font-size: 10px; margin-left: 6px;
}
#${OVERLAY_ID} .wda-pill.ok { background: #064e3b; color: #6ee7b7; }
#${OVERLAY_ID} .wda-pill.skip { background: #1e293b; color: #94a3b8; }
#${OVERLAY_ID} .wda-pill.err { background: #450a0a; color: #fca5a5; }
#${OVERLAY_ID} .wda-pill.warn { background: #422006; color: #fcd34d; }

/* Pre-fill review panel (low-confidence answers). */
#${OVERLAY_ID} .wda-prefill { display: none; padding: 4px 0 8px; }
#${OVERLAY_ID} .wda-prefill h3 {
  margin: 0 0 8px; font-size: 13px; color: #fde68a;
}
#${OVERLAY_ID} .wda-prefill .wda-sub {
  font-size: 11px; color: #94a3b8; margin-bottom: 8px;
}
#${OVERLAY_ID} .wda-pf-item {
  background: #0b1224; border: 1px solid #1e293b; border-radius: 8px;
  padding: 8px 10px; margin-bottom: 8px;
}
#${OVERLAY_ID} .wda-pf-item.skipped { opacity: 0.5; }
#${OVERLAY_ID} .wda-pf-label {
  font-weight: 600; color: #e2e8f0; font-size: 12px;
}
#${OVERLAY_ID} .wda-pf-meta {
  color: #94a3b8; font-size: 11px; margin: 2px 0 6px;
}
#${OVERLAY_ID} .wda-pf-input {
  width: 100%; box-sizing: border-box; background: #020617;
  color: #e2e8f0; border: 1px solid #1e293b; border-radius: 6px;
  padding: 6px 8px; font-size: 12px; font-family: inherit;
  margin: 4px 0 6px;
}
#${OVERLAY_ID} .wda-pf-input:focus {
  outline: none; border-color: #4f46e5;
}
#${OVERLAY_ID} .wda-pf-actions {
  display: flex; gap: 6px;
}
#${OVERLAY_ID} .wda-pf-actions button {
  flex: 1; padding: 5px 8px; border-radius: 6px; border: 0;
  font-size: 11px; font-weight: 600; cursor: pointer;
}
#${OVERLAY_ID} .wda-pf-approve { background: #064e3b; color: #6ee7b7; }
#${OVERLAY_ID} .wda-pf-skip    { background: #1e293b; color: #94a3b8; }
#${OVERLAY_ID} .wda-pf-actions button:hover { filter: brightness(1.2); }
#${OVERLAY_ID} .wda-pf-foot {
  display: flex; gap: 8px; padding-top: 4px;
  border-top: 1px solid #1e293b; margin-top: 4px;
}
#${OVERLAY_ID} .wda-pf-foot button {
  flex: 1; padding: 7px 10px; border-radius: 8px; border: 0;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
#${OVERLAY_ID} .wda-pf-fill   { background: #22c55e; color: #052e10; }
#${OVERLAY_ID} .wda-pf-skipall { background: #1e293b; color: #e2e8f0; }
`;

export function mountOverlay(opts?: MountOverlayOptions): OverlayHandle {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.innerHTML = `
    <div class="wda-h">
      <span>Workday Autofill</span>
      <div class="wda-h-actions">
        <button type="button" class="wda-stop">Stop</button>
        <button type="button" class="wda-close" aria-label="Stop and close">×</button>
      </div>
    </div>
    <div class="wda-body">
      <div class="wda-status">Idle.</div>
      <div class="wda-progress"><div></div></div>
      <div class="wda-log" hidden></div>
      <div class="wda-prefill">
        <h3>Review uncertain fields</h3>
        <div class="wda-sub">
          The AI was not confident on these. Approve, edit, or skip each one
          before they're typed into the form.
        </div>
        <div class="wda-pf-list"></div>
        <div class="wda-pf-foot">
          <button type="button" class="wda-pf-skipall">Skip all</button>
          <button type="button" class="wda-pf-fill">Fill approved</button>
        </div>
      </div>
      <div class="wda-review">
        <h3>Review your answers</h3>
        <div class="wda-review-list"></div>
      </div>
    </div>
    <div class="wda-actions" hidden>
      <button class="wda-btn ghost wda-cancel">Cancel</button>
      <button class="wda-btn primary wda-confirm">Confirm &amp; Submit</button>
    </div>
  `;
  document.body.appendChild(root);

  const $ = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const statusEl = $<HTMLElement>(".wda-status");
  const barEl = $<HTMLElement>(".wda-progress > div");
  const logEl = $<HTMLElement>(".wda-log");
  const reviewBox = $<HTMLElement>(".wda-review");
  const reviewList = $<HTMLElement>(".wda-review-list");
  const actions = $<HTMLElement>(".wda-actions");
  const closeBtn = $<HTMLButtonElement>(".wda-close");
  const stopBtn = $<HTMLButtonElement>(".wda-stop");
  const prefillBox = $<HTMLElement>(".wda-prefill");
  const prefillList = $<HTMLElement>(".wda-pf-list");
  const prefillFill = $<HTMLButtonElement>(".wda-pf-fill");
  const prefillSkipAll = $<HTMLButtonElement>(".wda-pf-skipall");

  function requestStop() {
    opts?.onUserStop?.();
    statusEl.textContent = "Stopping… (will exit after this step)";
  }

  stopBtn.addEventListener("click", requestStop);
  closeBtn.addEventListener("click", requestStop);

  return {
    setStatus(t) {
      statusEl.textContent = t;
    },
    setProgress(filled, total) {
      const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
      barEl.style.width = `${pct}%`;
    },
    appendLog(msg) {
      logEl.hidden = false;
      const div = document.createElement("div");
      div.textContent = msg;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    },
    showReview(items, handlers) {
      reviewBox.style.display = "block";
      reviewList.innerHTML = "";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "wda-item";
        const pill =
          it.status === "filled" ? `<span class="wda-pill ok">filled</span>` :
          it.status === "skipped" ? `<span class="wda-pill skip">skipped</span>` :
          `<span class="wda-pill err">error</span>`;
        const warn = it.answer.needsReview
          ? `<span class="wda-pill warn">low-confidence</span>` : "";
        const valHtml = renderValue(it.answer.value);
        row.innerHTML = `
          <div class="wda-label">${escape(it.field.label || "(unlabeled)")} ${pill}${warn}</div>
          ${it.field.section ? `<div class="wda-section">${escape(it.field.section)}</div>` : ""}
          <div class="wda-val">${valHtml}</div>
          ${it.message ? `<div class="wda-err">${escape(it.message)}</div>` : ""}
          ${it.answer.reason ? `<div class="wda-section">${escape(it.answer.reason)}</div>` : ""}
        `;
        reviewList.appendChild(row);
      }
      actions.hidden = false;
      const confirm = $<HTMLButtonElement>(".wda-confirm");
      const cancel  = $<HTMLButtonElement>(".wda-cancel");
      confirm.onclick = () => { handlers.onConfirm(); };
      cancel.onclick  = () => { handlers.onCancel();  };
    },
    reviewBeforeFill(items) {
      return new Promise<MappedValue[]>((resolve) => {
        if (items.length === 0) {
          resolve([]);
          return;
        }
        // Hide the after-fill review while this pre-fill panel is up.
        reviewBox.style.display = "none";
        actions.hidden = true;
        prefillBox.style.display = "block";
        prefillList.innerHTML = "";

        // Local state: id -> { value, skipped }
        const state = new Map<
          string,
          { value: string; skipped: boolean; original: MappedValue }
        >();

        for (const it of items) {
          const initialVal = answerToInputString(it.answer.value);
          state.set(it.field.id, {
            value: initialVal,
            skipped: false,
            original: it.answer,
          });

          const row = document.createElement("div");
          row.className = "wda-pf-item";
          row.dataset.id = it.field.id;

          const conf = Math.round((it.answer.confidence ?? 0) * 100);
          const reasonHtml = it.answer.reason
            ? `<div class="wda-pf-meta">${escape(it.answer.reason)}</div>`
            : "";
          const sectionHtml = it.field.section
            ? `<span class="wda-pill skip">${escape(it.field.section)}</span>`
            : "";
          row.innerHTML = `
            <div class="wda-pf-label">
              ${escape(it.field.label || "(unlabeled)")}
              <span class="wda-pill warn">${conf}% confidence</span>
              ${sectionHtml}
            </div>
            ${reasonHtml}
            <input type="text" class="wda-pf-input" placeholder="Enter value to fill (leave empty to skip)" />
            <div class="wda-pf-actions">
              <button type="button" class="wda-pf-approve">Approve</button>
              <button type="button" class="wda-pf-skip">Skip</button>
            </div>
          `;
          const input = row.querySelector<HTMLInputElement>(".wda-pf-input")!;
          input.value = initialVal;
          input.addEventListener("input", () => {
            const s = state.get(it.field.id)!;
            s.value = input.value;
            s.skipped = false;
            row.classList.remove("skipped");
          });
          row.querySelector<HTMLButtonElement>(".wda-pf-approve")!.addEventListener(
            "click",
            () => {
              const s = state.get(it.field.id)!;
              s.skipped = false;
              row.classList.remove("skipped");
              input.focus();
            },
          );
          row.querySelector<HTMLButtonElement>(".wda-pf-skip")!.addEventListener(
            "click",
            () => {
              const s = state.get(it.field.id)!;
              s.skipped = true;
              row.classList.add("skipped");
            },
          );
          prefillList.appendChild(row);
        }

        function done() {
          const out: MappedValue[] = [];
          for (const [id, s] of state) {
            if (s.skipped || s.value.trim() === "") {
              out.push({
                id,
                value: null,
                confidence: 0,
                reason: "Skipped by user during review",
                needsReview: true,
              });
            } else {
              out.push({
                id,
                value: s.value,
                confidence: 1,
                reason: "Approved by user during review",
              });
            }
          }
          prefillBox.style.display = "none";
          prefillList.innerHTML = "";
          resolve(out);
        }

        prefillFill.onclick = done;
        prefillSkipAll.onclick = () => {
          for (const s of state.values()) s.skipped = true;
          prefillList.querySelectorAll(".wda-pf-item").forEach((r) =>
            r.classList.add("skipped"),
          );
          done();
        };
      });
    },
    destroy() {
      root.remove();
    },
  };
}

function answerToInputString(v: string | string[] | boolean | null): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function renderValue(v: string | string[] | boolean | null): string {
  if (v == null) return `<em>—</em>`;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(escape).join(", ");
  return escape(v);
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
