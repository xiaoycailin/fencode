import type { BundledLanguage } from "shiki";
import type { ThemeRegistrationAny } from "shiki/types";

const highlightCache = new Map<string, string>();

const oneMonokaiDark: ThemeRegistrationAny = {
  name: "fencode-one-monokai-dark",
  type: "dark",
  colors: {
    "editor.background": "#171812",
    "editor.foreground": "#f8f8f2",
  },
  settings: [
    { settings: { foreground: "#f8f8f2" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8b8f7a", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#f92672" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#a6e22e" } },
    { scope: ["constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#ae81ff" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#66d9ef" } },
    { scope: ["variable", "meta.definition.variable", "support.variable"], settings: { foreground: "#fd971f" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "#a1efe4" } },
    { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#f92672" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#a6e22e" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#f8f8f2" } },
  ],
};

const oneMonokaiLight: ThemeRegistrationAny = {
  name: "fencode-one-monokai-light",
  type: "light",
  colors: {
    "editor.background": "#fffdf7",
    "editor.foreground": "#2d2a2e",
  },
  settings: [
    { settings: { foreground: "#2d2a2e" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8d8a84", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#d33682" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#3f8f1f" } },
    { scope: ["constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#7c4dff" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#0b75b7" } },
    { scope: ["variable", "meta.definition.variable", "support.variable"], settings: { foreground: "#d35400" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "#008b8b" } },
    { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#d33682" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#3f8f1f" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#2d2a2e" } },
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
