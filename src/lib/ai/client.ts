/**
 * Minimal OpenAI Chat Completions client.
 *
 * Works with any OpenAI-compatible endpoint:
 * - OpenAI: https://api.openai.com/v1
 * - Groq (free tier): https://api.groq.com/openai/v1
 *
 * We avoid the heavyweight `openai` SDK and call the REST endpoint
 * directly so the bundle stays small and the code works identically
 * from the MV3 service worker and from extension pages.
 */

import { GROQ_DEFAULT_BASE } from "@/lib/types";

export type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain string for text-only, or array of parts for multimodal (vision). */
  content: string | ChatContentPart[];
}

export interface ChatOptions {
  apiKey: string;
  /** Empty / omitted = OpenAI default `https://api.openai.com/v1`. */
  apiBaseUrl?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: "json_object" | "text";
  /** Max retries on 429 / 5xx. */
  retries?: number;
}

/**
 * Models we know support image inputs via the OpenAI Chat Completions
 * `image_url` content part. Used by the field-mapper to decide whether
 * a screenshot is worth attaching.
 */
const VISION_MODEL_RX =
  /^(gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o|gpt-5|o1|o3|o4|claude-3(?:\.5|-5)?-sonnet|claude-3(?:\.5|-5)?-opus|claude-3-haiku|claude-sonnet-|claude-opus-|claude-haiku-|gemini-1\.5|gemini-2|gemini-pro-vision|llama-3\.2.*vision|llava)/i;

export function isVisionCapableModel(model: string): boolean {
  return VISION_MODEL_RX.test(model.trim());
}

export interface ChatResponse {
  content: string;
}

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/**
 * If the user picks a Groq model from the dropdown but forgets to set
 * API base URL (still empty), we route to Groq automatically. Otherwise
 * a `gsk_...` key hits OpenAI and returns a confusing 401.
 */
function effectiveApiBase(apiBaseUrl: string | undefined, model: string): string {
  const trimmed = (apiBaseUrl ?? "").trim();
  if (trimmed.length > 0) return trimmed;
  const m = (model ?? "").trim().toLowerCase();
  if (
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("chatgpt-")
  ) {
    return OPENAI_DEFAULT_BASE;
  }
  return GROQ_DEFAULT_BASE;
}

/** Build `.../v1/chat/completions` from a base like `https://api.groq.com/openai/v1`. */
export function resolveChatCompletionsUrl(
  apiBaseUrl: string | undefined,
  model: string,
): string {
  const base = effectiveApiBase(apiBaseUrl, model).replace(/\/$/, "");
  return `${base}/chat/completions`;
}

export async function chatComplete(opts: ChatOptions): Promise<ChatResponse> {
  if (!opts.apiKey) {
    throw new Error(
      "Missing API key. Please set it in the extension's Options page.",
    );
  }

  const url = resolveChatCompletionsUrl(opts.apiBaseUrl, opts.model);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
  };
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const maxRetries = opts.retries ?? 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let res = await postJson(url, opts.apiKey, body);

      // Some free-tier providers reject `response_format`; retry without it.
      if (!res.ok && body.response_format) {
        const t = await res.clone().text();
        if (
          res.status === 400 &&
          /response_format|json_object|unsupported/i.test(t)
        ) {
          const { response_format: _rf, ...rest } = body;
          res = await postJson(url, opts.apiKey, rest);
        }
      }

      if (!res.ok) {
        const text = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
      }

      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return { content };
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "Failed to fetch") {
      throw new Error(
        "Network request failed (Failed to fetch). Reload the extension, disable VPN/ad-blockers for api.groq.com, or try Chrome instead of Brave.",
      );
    }
    throw err;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Safe JSON parsing that tolerates the model wrapping its answer in
 * ```json fences or trailing commentary.
 */
export function safeParseJson<T = unknown>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // try to find the first { .. } or [ .. ] block
    const objMatch = cleaned.match(/\{[\s\S]*\}$/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]$/);
    const candidate = objMatch?.[0] ?? arrMatch?.[0];
    if (candidate) return JSON.parse(candidate) as T;
    throw new Error("AI returned non-JSON content: " + raw.slice(0, 300));
  }
}
