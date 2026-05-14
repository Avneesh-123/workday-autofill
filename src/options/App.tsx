import { useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { DEFAULT_SETTINGS, GROQ_DEFAULT_BASE, GROQ_DEFAULT_MODEL, ResumeProfile, UserSettings } from "@/lib/types";

const EMPTY_PROFILE: ResumeProfile = {
  contact: {},
  experience: [],
  education: [],
  skills: [],
  certifications: [],
};

export function Options() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [profileText, setProfileText] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState("");

  useEffect(() => {
    void (async () => {
      const [s, p] = await Promise.all([storage.getSettings(), storage.getProfile()]);
      setSettings(s);
      setProfileText(JSON.stringify(p ?? EMPTY_PROFILE, null, 2));
    })();
  }, []);

  const isValidProfile = useMemo(() => {
    try {
      JSON.parse(profileText);
      return true;
    } catch {
      return false;
    }
  }, [profileText]);

  async function saveSettings(partial: Partial<UserSettings>) {
    const next = await storage.setSettings(partial);
    setSettings(next);
    flash("Settings saved");
  }

  async function saveProfile() {
    setProfileError(null);
    try {
      const parsed = JSON.parse(profileText) as ResumeProfile;
      await storage.setProfile(parsed);
      flash("Profile saved");
    } catch (e) {
      setProfileError((e as Error).message);
    }
  }

  function flash(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(""), 1500);
  }

  async function clearProfile() {
    if (!confirm("Clear saved resume profile?")) return;
    await storage.clearProfile();
    setProfileText(JSON.stringify(EMPTY_PROFILE, null, 2));
    flash("Profile cleared");
  }

  return (
    <div className="op">
      <header className="op-h">
        <h1>Workday Autofill - Settings</h1>
        <p className="muted">
          Configure your AI provider (OpenAI or a free OpenAI-compatible API
          like Groq), then review or edit your parsed resume profile. All data
          stays in chrome.storage.local on this machine.
        </p>
      </header>

      <section className="card">
        <h2>AI provider</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="primary"
            onClick={() =>
              saveSettings({
                apiBaseUrl: GROQ_DEFAULT_BASE,
                model: GROQ_DEFAULT_MODEL,
              })
            }
          >
            Use Groq (free tier)
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              saveSettings({
                apiBaseUrl: "",
                model: "gpt-4o-mini",
              })
            }
          >
            Use OpenAI
          </button>
        </div>
        <p className="muted">
          <strong>Free option:</strong> create a key at{" "}
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
            console.groq.com/keys
          </a>{" "}
          (no credit card). Click <em>Use Groq (free tier)</em>, paste the key
          below, then upload your resume again.
        </p>
        <label>
          API key
          <input
            type="password"
            placeholder="sk-... (OpenAI) or gsk_... (Groq)"
            value={settings.openaiApiKey ?? ""}
            onChange={(e) => setSettings({ ...settings, openaiApiKey: e.target.value })}
            onBlur={() => saveSettings({ openaiApiKey: settings.openaiApiKey })}
          />
        </label>
        <label>
          API base URL (OpenAI-compatible)
          <input
            type="text"
            spellCheck={false}
            placeholder="Leave empty for OpenAI, or https://api.groq.com/openai/v1"
            value={settings.apiBaseUrl ?? ""}
            onChange={(e) => setSettings({ ...settings, apiBaseUrl: e.target.value })}
            onBlur={() => saveSettings({ apiBaseUrl: settings.apiBaseUrl })}
          />
        </label>
        <label>
          Model
          <select
            value={settings.model}
            onChange={(e) => saveSettings({ model: e.target.value })}
          >
            <optgroup label="OpenAI">
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4.1-mini">gpt-4.1-mini</option>
              <option value="gpt-4.1">gpt-4.1</option>
            </optgroup>
            <optgroup label="Groq (free tier)">
              <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
              <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
              <option value="mixtral-8x7b-32768">mixtral-8x7b-32768</option>
            </optgroup>
          </select>
        </label>
        <p className="muted">
          Requests go to the base URL you configure (default: OpenAI). The key
          is never sent anywhere except that host.
        </p>
      </section>

      <section className="card">
        <h2>Behaviour</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.safeMode}
            onChange={(e) => saveSettings({ safeMode: e.target.checked })}
          />
          <span>
            <strong>Safe Mode</strong> — only fill plain text fields (name,
            email, phone, address line, etc.). Skip dropdowns, country pickers,
            radios, checkboxes, dates and file uploads. Enable this if Workday
            shows &quot;Something went wrong&quot; during autofill on this
            tenant (Netflix is a known offender). You can fill the skipped
            fields manually in a few seconds.
          </span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.confirmBeforeSubmit}
            onChange={(e) => saveSettings({ confirmBeforeSubmit: e.target.checked })}
          />
          Always show a review screen and require my confirmation before clicking Submit.
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.preservePrefilled}
            onChange={(e) => saveSettings({ preservePrefilled: e.target.checked })}
          />
          Never overwrite fields that already have a value.
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.useVision}
            onChange={(e) => saveSettings({ useVision: e.target.checked })}
          />
          <span>
            <strong>Use AI vision</strong> — attach a screenshot of the visible
            form so the model can see weird/blank labels and repeating-row
            layouts. Requires a vision-capable model (gpt-4o, gpt-4o-mini,
            claude-3.5-sonnet, gemini-1.5, etc.). Adds ~$0.001 per page on
            gpt-4o-mini.
          </span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.reviewLowConfidence}
            onChange={(e) => saveSettings({ reviewLowConfidence: e.target.checked })}
          />
          <span>
            <strong>Review low-confidence answers</strong> — before typing,
            pause on fields where the AI is unsure (confidence below the
            threshold) and ask you to confirm or edit each one.
          </span>
        </label>
        <label>
          Low-confidence threshold: {settings.reviewThreshold.toFixed(2)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.reviewThreshold}
            onChange={(e) => saveSettings({ reviewThreshold: Number(e.target.value) })}
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.autoRunOnPage}
            onChange={(e) => saveSettings({ autoRunOnPage: e.target.checked })}
          />
          Start autofilling automatically when a Workday application loads.
        </label>
        <label>
          AI batch size: {settings.batchSize}
          <input
            type="range"
            min={4}
            max={24}
            step={1}
            value={settings.batchSize}
            onChange={(e) => saveSettings({ batchSize: Number(e.target.value) })}
          />
        </label>
        <label>
          Pause after each field (ms) — raise if Workday shows &quot;Something went wrong&quot;
          <input
            type="number"
            min={0}
            max={5000}
            step={20}
            value={settings.fillPacingMs}
            onChange={(e) =>
              setSettings({ ...settings, fillPacingMs: Math.max(0, Number(e.target.value) || 0) })
            }
            onBlur={() => saveSettings({ fillPacingMs: settings.fillPacingMs })}
          />
        </label>
        <label>
          Wait for quiet DOM after each field (ms, 0 = off)
          <input
            type="number"
            min={0}
            max={5000}
            step={20}
            value={settings.settleAfterFillMs}
            onChange={(e) =>
              setSettings({
                ...settings,
                settleAfterFillMs: Math.max(0, Number(e.target.value) || 0),
              })
            }
            onBlur={() => saveSettings({ settleAfterFillMs: settings.settleAfterFillMs })}
          />
        </label>
      </section>

      <section className="card">
        <h2>Resume profile (JSON)</h2>
        <p className="muted">
          This is the parsed resume the extension uses. You can fix mistakes
          directly here. Demographic / EEO / work-authorization answers under
          <code> demographics </code> let you control how those questions are
          answered without exposing them in the resume itself.
        </p>
        <textarea
          rows={22}
          value={profileText}
          onChange={(e) => setProfileText(e.target.value)}
          spellCheck={false}
        />
        {!isValidProfile && (
          <p className="err">Invalid JSON. Fix syntax before saving.</p>
        )}
        {profileError && <p className="err">{profileError}</p>}
        <div className="row">
          <button className="primary" disabled={!isValidProfile} onClick={saveProfile}>
            Save profile
          </button>
          <button className="ghost" onClick={clearProfile}>
            Clear profile
          </button>
        </div>
      </section>

      {savedToast && <div className="toast">{savedToast}</div>}
    </div>
  );
}
