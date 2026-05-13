import { useEffect, useRef, useState } from "react";
import { storage } from "@/lib/storage";
import { extractAndHints } from "@/lib/parser/resume-parser";
import { ResumeProfile, RuntimeMessage, UserSettings } from "@/lib/types";

type Phase = "idle" | "parsing" | "parsed" | "error";

export function Popup() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ResumeProfile | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [lastParse, setLastParse] = useState<{ fileName: string; parsedAt: number } | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const [p, s, lp] = await Promise.all([
        storage.getProfile(),
        storage.getSettings(),
        storage.getLastParse(),
      ]);
      setProfile(p ?? null);
      setSettings(s);
      setLastParse(lp ?? null);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setActiveUrl(tab?.url ?? null);
    })();
  }, []);

  const isOnWorkday = !!activeUrl && /workday|myworkdayjobs|myworkday/i.test(activeUrl);
  const hasApiKey = !!settings?.openaiApiKey;

  async function onPick(file: File) {
    setPhase("parsing");
    setError(null);
    try {
      if (!settings?.openaiApiKey) {
        throw new Error("Set your API key in Options first.");
      }
      const buffer = await file.arrayBuffer();
      const input = { fileName: file.name, mimeType: file.type, buffer };
      const { text, hints } = await extractAndHints(input);
      const resp = (await chrome.runtime.sendMessage({
        type: "STRUCTURE_RESUME",
        text,
        hints,
      } as RuntimeMessage)) as { profile?: ResumeProfile; error?: string } | undefined;
      if (!resp) {
        throw new Error(
          "Background service worker did not respond. Open brave://extensions and click the reload button on Workday Autofill, then try again.",
        );
      }
      if (resp.error) throw new Error(resp.error);
      if (!resp.profile) {
        throw new Error(
          "Background returned no profile. The service worker may be stale - reload it from brave://extensions.",
        );
      }
      const parsed = resp.profile;
      await storage.setProfile(parsed);
      await storage.setLastParse({ fileName: file.name, parsedAt: Date.now() });
      setProfile(parsed);
      setLastParse({ fileName: file.name, parsedAt: Date.now() });
      setPhase("parsed");
    } catch (e) {
      console.error(e);
      setError((e as Error).message);
      setPhase("error");
    }
  }

  async function onAutofill() {
    setRunStatus("Starting...");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");
      // Route through the background so it can inject the content script
      // on-demand if the tab pre-dates the current extension load.
      const resp = (await chrome.runtime.sendMessage({
        type: "START_AUTOFILL",
        tabId: tab.id,
      } as RuntimeMessage)) as { ok?: boolean; error?: string } | undefined;
      if (!resp) {
        throw new Error(
          "Background did not respond. Reload the extension from brave://extensions and try again.",
        );
      }
      if (resp.ok) setRunStatus("Autofill running on page.");
      else setRunStatus(resp.error ?? "Failed to start.");
    } catch (e) {
      setRunStatus((e as Error).message);
    }
  }

  return (
    <div className="pp">
      <header className="pp-h">
        <div className="pp-logo">WD</div>
        <div>
          <h1>Workday Autofill</h1>
          <p className="sub">AI-powered job application filler</p>
        </div>
        <button
          className="link"
          onClick={() => chrome.runtime.openOptionsPage()}
          title="Open settings"
        >
          Settings
        </button>
      </header>

      <section className="card">
        <h2>1. Resume</h2>
        {profile ? (
          <>
            <p className="ok">
              Loaded: <strong>{lastParse?.fileName ?? "(saved profile)"}</strong>
            </p>
            <p className="muted">
              {profile.contact.fullName ?? "(no name)"} -{" "}
              {profile.experience?.length ?? 0} roles,{" "}
              {profile.education?.length ?? 0} education,{" "}
              {profile.skills?.length ?? 0} skills
            </p>
          </>
        ) : (
          <p className="muted">No resume parsed yet.</p>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={!hasApiKey || phase === "parsing"}
            onClick={() => fileInput.current?.click()}
          >
            {phase === "parsing" ? "Parsing..." : profile ? "Replace resume" : "Upload resume"}
          </button>
          {!hasApiKey && (
            <span className="warn">Set API key in Settings first.</span>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = "";
          }}
        />
        {error && <p className="err">{error}</p>}
      </section>

      <section className="card">
        <h2>2. Autofill this page</h2>
        {isOnWorkday ? (
          <p className="ok">Workday application detected.</p>
        ) : (
          <p className="warn">
            Open a Workday job application page (e.g. *.myworkdayjobs.com) and click Apply.
          </p>
        )}
        <button
          className="primary"
          disabled={!profile || !isOnWorkday}
          onClick={onAutofill}
        >
          Autofill now
        </button>
        {runStatus && <p className="muted">{runStatus}</p>}
      </section>

      <footer className="pp-f">
        <span>v1.0 - AI: {settings?.model ?? "gpt-4o-mini"}</span>
        <a onClick={() => chrome.runtime.openOptionsPage()}>Edit profile JSON</a>
      </footer>
    </div>
  );
}
