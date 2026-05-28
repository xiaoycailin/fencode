import type { BundledLanguage } from "shiki";
import type { ThemeRegistrationAny } from "shiki/types";

const highlightCache = new Map<string, string>();

const oneMonokaiDark: ThemeRegistrationAny = {
  name: "fencode-one-monokai-dark",
  type: "dark",
  colors: {
    "editor.background": "#242b38",
    "editor.foreground": "#d7deea",
  },
  settings: [
    { settings: { foreground: "#d7deea" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#5f7394", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#ff5ea0" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#8be38a" } },
    { scope: ["constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#ffb86b" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#66c9ff" } },
    { scope: ["variable", "meta.definition.variable", "support.variable"], settings: { foreground: "#ff7f8e" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "#ffd76d" } },
    { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#ff5ea0" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#66c9ff" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#aab9d2" } },
  ],
};

const oneMonokaiLight: ThemeRegistrationAny = {
  name: "fencode-one-monokai-light",
  type: "light",
  colors: {
    "editor.background": "#f7f9fc",
    "editor.foreground": "#2f3542",
  },
  settings: [
    { settings: { foreground: "#2f3542" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8894a1", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#d63384" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#2b8a3e" } },
    { scope: ["constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#e67700" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#1971c2" } },
    { scope: ["variable", "meta.definition.variable", "support.variable"], settings: { foreground: "#d6336c" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "#c77d00" } },
    { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#c2255c" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#0b7285" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#5f6d7e" } },
  ],
};

export function normalizeCodeLanguage(value: string): BundledLanguage {
  const normalized = value.toLowerCase().trim() || "text";
  const aliases: Record<string, BundledLanguage> = {
    ps: "powershell",
    ps1: "powershell",
    shell: "bash",
    sh: "bash",
    rs: "rust",
    ts: "typescript",
    js: "javascript",
    py: "python",
    yml: "yaml",
  };
  return (aliases[normalized] ?? normalized) as BundledLanguage;
}

export async function highlightCodeToHtml(code: string, language: string, isDark: boolean) {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const cacheKey = `${isDark ? "dark" : "light"}:${normalizedLanguage}:${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
  const { codeToHtml } = await import("shiki");
  const html = await codeToHtml(code, {
    lang: normalizedLanguage,
    theme: isDark ? oneMonokaiDark : oneMonokaiLight,
  });
  highlightCache.set(cacheKey, html);
  if (highlightCache.size > 400) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey) highlightCache.delete(oldestKey);
  }
  return html;
}

export function extractCodeInnerHtml(shikiHtml: string) {
  const matched = shikiHtml.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
  return matched?.[1] ?? escapeHtml(shikiHtml);
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
