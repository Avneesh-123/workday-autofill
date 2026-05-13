/**
 * Background service worker.
 *
 * Responsibilities:
 *  - Centralized place for the API key (never leaks into page context).
 *  - Hosts AI calls: field mapping (`MAP_FIELDS`) and resume structuring
 *    (`STRUCTURE_RESUME`) so network requests run here instead of the
 *    popup (avoids "Failed to fetch" from extension-page / Brave quirks).
 *  - Routes `START_AUTOFILL` from the popup to the active tab.
 *
 * PDF/DOCX text extraction still runs in the popup (pdf.js worker), then
 * the popup sends raw text + hints to `STRUCTURE_RESUME`.
 */

import { mapFields } from "@/lib/ai/field-mapper";
import { aiStructureResume } from "@/lib/ai/resume";
import { storage } from "@/lib/storage";
import { RuntimeMessage } from "@/lib/types";

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  void handle(msg, sender).then((res) => sendResponse(res)).catch((err) => {
    console.error("[wda:bg]", err);
    sendResponse({ error: (err as Error).message });
  });
  return true; // async
});

async function handle(msg: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  switch (msg.type) {
    case "PING":
      return { ok: true };

    case "MAP_FIELDS": {
      const settings = await storage.getSettings();
      const answers = await mapFields({
        fields: msg.fields,
        profile: msg.profile,
        settings,
        stepName: msg.stepName,
      });
      return { answers };
    }

    case "GET_PROFILE":
      return { profile: await storage.getProfile() };
    case "SET_PROFILE":
      await storage.setProfile(msg.profile);
      return { ok: true };
    case "GET_SETTINGS":
      return { settings: await storage.getSettings() };
    case "SET_SETTINGS":
      return { settings: await storage.setSettings(msg.settings) };

    case "START_AUTOFILL": {
      const tabId = msg.tabId ?? (await activeTabId());
      if (!tabId) throw new Error("No active tab");
      try {
        return await chrome.tabs.sendMessage(tabId, { type: "START_AUTOFILL" });
      } catch {
        // Tab was opened before extension load; inject content script now.
        await ensureContentScript(tabId);
        return chrome.tabs.sendMessage(tabId, { type: "START_AUTOFILL" });
      }
    }

    case "STRUCTURE_RESUME": {
      const settings = await storage.getSettings();
      if (!settings.openaiApiKey?.trim()) {
        throw new Error("Set your API key in Options first.");
      }
      const profile = await aiStructureResume({
        text: msg.text,
        hints: msg.hints,
        apiKey: settings.openaiApiKey,
        model: settings.model,
        apiBaseUrl: settings.apiBaseUrl,
      });
      return { profile };
    }

    case "AUTOFILL_STATUS":
      return { ok: true };
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * Pull the content-script file list from the manifest at runtime so we
 * pick up Vite's hashed filenames (e.g. assets/index.ts-loader-XYZ.js).
 */
async function ensureContentScript(tabId: number): Promise<void> {
  const m = chrome.runtime.getManifest();
  const files = m.content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return;
  await chrome.scripting.executeScript({ target: { tabId }, files });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[wda] Workday Autofill installed.");
});
