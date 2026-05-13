/**
 * Shared type definitions used across background, content, popup and options.
 * Kept framework-free so it can be imported anywhere.
 */

export type ISODate = string; // YYYY-MM or YYYY-MM-DD

export interface ContactInfo {
  fullName?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneCountryCode?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  links?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
    other?: string[];
  };
}

export interface WorkExperience {
  company: string;
  title: string;
  location?: string;
  startDate?: ISODate;
  endDate?: ISODate | "Present";
  current?: boolean;
  summary?: string;
  bullets?: string[];
}

export interface Education {
  school: string;
  degree?: string;
  fieldOfStudy?: string;
  startDate?: ISODate;
  endDate?: ISODate;
  gpa?: string;
  location?: string;
}

export interface Certification {
  name: string;
  issuer?: string;
  issueDate?: ISODate;
  expirationDate?: ISODate;
  credentialId?: string;
  url?: string;
}

export interface Language {
  name: string;
  proficiency?: string;
}

/** Regex-derived anchors passed into the resume-structuring LLM. */
export interface ResumeHints {
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  links: string[];
}

export interface ResumeProfile {
  contact: ContactInfo;
  summary?: string;
  experience: WorkExperience[];
  education: Education[];
  skills: string[];
  certifications: Certification[];
  languages?: Language[];
  // free-form questions the AI inferred from the resume / user
  custom?: Record<string, string>;
  /** Demographic / EEO / work auth questions - user provided */
  demographics?: {
    gender?: string;
    ethnicity?: string;
    veteranStatus?: string;
    disabilityStatus?: string;
    requiresSponsorship?: boolean | string;
    authorizedToWork?: boolean | string;
    willingToRelocate?: boolean | string;
    desiredSalary?: string;
    noticePeriod?: string;
    referredBy?: string;
    howDidYouHear?: string;
    /** "Were you previously employed at {Company}?" — defaults to No if unset. */
    previouslyEmployedAtCompany?: boolean;
  };
}

export interface UserSettings {
  /** API key for the configured provider (OpenAI, Groq, etc.). */
  openaiApiKey?: string;
  /**
   * OpenAI-compatible API base URL (no trailing slash), e.g.
   * `https://api.openai.com/v1` or `https://api.groq.com/openai/v1`.
   * Empty string = OpenAI default.
   */
  apiBaseUrl: string;
  /**
   * Model used for resume parsing and field mapping.
   * Keep small + cheap by default; users can override in options page.
   */
  model: string;
  autoRunOnPage: boolean;
  confirmBeforeSubmit: boolean;
  /** Skip fields that already have non-empty values. */
  preservePrefilled: boolean;
  /** Maximum number of fields to map in a single AI batch. */
  batchSize: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  apiBaseUrl: "",
  model: "gpt-4o-mini",
  autoRunOnPage: false,
  confirmBeforeSubmit: true,
  preservePrefilled: true,
  batchSize: 12,
};

/** Groq offers a generous free tier (sign up at console.groq.com). */
export const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "llama-3.1-8b-instant";

/* ------------------------------------------------------------------ */
/*  DOM-side field representation                                      */
/* ------------------------------------------------------------------ */

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "textarea"
  | "select"
  | "multiselect"
  | "combobox"
  | "radio"
  | "checkbox"
  | "date"
  | "file"
  | "unknown";

export interface FieldOption {
  value: string;
  label: string;
}

export interface DetectedField {
  /** Stable id we generate so we can refer back to it across messages. */
  id: string;
  label: string;
  ariaLabel?: string;
  placeholder?: string;
  helpText?: string;
  required: boolean;
  kind: FieldKind;
  /** For select/radio/checkbox groups */
  options?: FieldOption[];
  /** Existing value, if any (for preservePrefilled). */
  currentValue?: string;
  /** Section / fieldset / step heading nearby. */
  section?: string;
  /** CSS-like locator (we resolve from id at fill time). */
  selector: string;
  /** True if part of a repeatable list (Experience, Education). */
  repeatable?: boolean;
  /** Index within the repeatable group. */
  repeatIndex?: number;
}

/* ------------------------------------------------------------------ */
/*  AI mapping types                                                   */
/* ------------------------------------------------------------------ */

export interface MappedValue {
  id: string;
  /** The literal value to type / select. For multi-select, comma separated. */
  value: string | string[] | boolean | null;
  /** 0..1 confidence score. */
  confidence: number;
  /** Why the AI picked this, for the review screen. */
  reason?: string;
  /** True if AI is unsure; show in review with warning. */
  needsReview?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Message protocol (content <-> background <-> popup)                */
/* ------------------------------------------------------------------ */

export type RuntimeMessage =
  | { type: "PING" }
  | { type: "STRUCTURE_RESUME"; text: string; hints: ResumeHints }
  | { type: "MAP_FIELDS"; fields: DetectedField[]; profile: ResumeProfile; stepName?: string }
  | { type: "GET_PROFILE" }
  | { type: "SET_PROFILE"; profile: ResumeProfile }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: Partial<UserSettings> }
  | { type: "START_AUTOFILL"; tabId?: number }
  | { type: "AUTOFILL_STATUS"; phase: AutofillPhase; detail?: string };

export type AutofillPhase =
  | "idle"
  | "detecting"
  | "mapping"
  | "filling"
  | "navigating"
  | "review"
  | "submitted"
  | "error";

export interface AutofillStatus {
  phase: AutofillPhase;
  detail?: string;
  stepName?: string;
  filled?: number;
  total?: number;
}
