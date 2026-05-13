import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "Workday Autofill (AI)",
  version: pkg.version,
  description:
    "AI-powered Chrome extension that auto-fills job applications on Workday portals using your resume.",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Workday Autofill",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  permissions: ["storage", "activeTab", "scripting", "tabs"],
  host_permissions: [
    "https://*.myworkdayjobs.com/*",
    "https://*.workday.com/*",
    "https://*.myworkday.com/*",
    "https://api.openai.com/*",
    "https://api.groq.com/*",
    "https://*.groq.com/*",
  ],
  content_scripts: [
    {
      matches: [
        "https://*.myworkdayjobs.com/*",
        "https://*.workday.com/*",
        "https://*.myworkday.com/*",
      ],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: ["assets/*", "icons/*", "pdfjs/*"],
      matches: ["<all_urls>"],
    },
  ],
  icons: {
    "16": "public/icons/icon-16.png",
    "32": "public/icons/icon-32.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png",
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://api.openai.com https://*.openai.com https://api.groq.com https://*.groq.com",
  },
});
