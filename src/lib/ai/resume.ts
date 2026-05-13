import { chatComplete, safeParseJson } from "@/lib/ai/client";
import { RESUME_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { ResumeHints, ResumeProfile } from "@/lib/types";

interface StructureArgs {
  text: string;
  hints: ResumeHints;
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
}

export async function aiStructureResume(args: StructureArgs): Promise<ResumeProfile> {
  const userPrompt = [
    "Heuristic hints (may be wrong - verify against text):",
    JSON.stringify(args.hints, null, 2),
    "",
    "Resume text (raw extraction):",
    "----------------------------------",
    args.text.slice(0, 16000),
  ].join("\n");

  const res = await chatComplete({
    apiKey: args.apiKey,
    apiBaseUrl: args.apiBaseUrl,
    model: args.model,
    temperature: 0,
    responseFormat: "json_object",
    messages: [
      { role: "system", content: RESUME_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const parsed = safeParseJson<ResumeProfile>(res.content);
  return normalizeProfile(parsed);
}

function normalizeProfile(p: ResumeProfile): ResumeProfile {
  const contact = p.contact ?? {};
  if (contact.fullName && !contact.firstName && !contact.lastName) {
    const parts = contact.fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      contact.firstName = parts[0];
      contact.lastName = parts[parts.length - 1];
      if (parts.length > 2) contact.middleName = parts.slice(1, -1).join(" ");
    } else {
      contact.firstName = parts[0];
    }
  }
  if (!contact.fullName && contact.firstName) {
    contact.fullName = [contact.firstName, contact.middleName, contact.lastName]
      .filter(Boolean)
      .join(" ");
  }
  return {
    contact,
    summary: p.summary,
    experience: Array.isArray(p.experience) ? p.experience : [],
    education: Array.isArray(p.education) ? p.education : [],
    skills: Array.isArray(p.skills) ? p.skills : [],
    certifications: Array.isArray(p.certifications) ? p.certifications : [],
    languages: p.languages,
    custom: p.custom,
    demographics: p.demographics,
  };
}
