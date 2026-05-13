import {
  DEFAULT_SETTINGS,
  ResumeProfile,
  UserSettings,
} from "@/lib/types";

const KEYS = {
  PROFILE: "wda:profile",
  SETTINGS: "wda:settings",
  LAST_PARSE: "wda:lastParse",
} as const;

async function get<T>(key: string): Promise<T | undefined> {
  const obj = await chrome.storage.local.get(key);
  return obj[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export const storage = {
  async getProfile(): Promise<ResumeProfile | undefined> {
    return get<ResumeProfile>(KEYS.PROFILE);
  },
  async setProfile(profile: ResumeProfile): Promise<void> {
    await set(KEYS.PROFILE, profile);
  },
  async clearProfile(): Promise<void> {
    await chrome.storage.local.remove(KEYS.PROFILE);
  },

  async getSettings(): Promise<UserSettings> {
    const s = (await get<Partial<UserSettings>>(KEYS.SETTINGS)) ?? {};
    return { ...DEFAULT_SETTINGS, ...s };
  },
  async setSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...partial };
    await set(KEYS.SETTINGS, next);
    return next;
  },

  async setLastParse(meta: { fileName: string; parsedAt: number }): Promise<void> {
    await set(KEYS.LAST_PARSE, meta);
  },
  async getLastParse(): Promise<{ fileName: string; parsedAt: number } | undefined> {
    return get(KEYS.LAST_PARSE);
  },
};
