import fs from "node:fs";
import path from "node:path";
import { addMessage, getSession, patchSession, readImageGenSettings, updateMessage, upsertSkill } from "./db";
import { readFcodeConfig } from "./fcodeConfig";
import { resolveFencodeHome } from "./runtimeHome";
import { makeId, nowIso } from "./id";
import { publishEvent } from "./sse";
import { cancelTodoProgress, failTodoProgress } from "./todoProgress";
import type { AgentInputItem } from "@/types/agentInput";

type SkillInput = Extract<AgentInputItem, { type: "skill" }>;
type ActiveSkillRun = {
  controller: AbortController;
  runId: string;
  assistantId: string;
};

const IMAGE_SKILL_IDS = new Set(["system/imagegen", "skills/imagegen", "imagegen"]);
const activeSkillRuns = new Map<string, ActiveSkillRun>();

export function interruptExecutableSkill(sessionId: string) {
  const active = activeSkillRuns.get(sessionId);
  if (!active) return { interrupted: false };
  active.controller.abort();
  activeSkillRuns.delete(sessionId);
  cancelTodoProgress(sessionId, active.runId);
  updateMessage(sessionId, active.assistantId, { content: "", status: "done" });
  publishEvent(sessionId, "thinking.done", { message: "Stopped by user" }, { runId: active.runId });
  publishEvent(sessionId, "session.done", { message: "Stopped by user" }, { runId: active.runId });
  patchSession(sessionId, { status: "idle" });
  return { interrupted: true };
}

export async function runExecutableSkillIfAny(sessionId: string, runId: string, content: string, input: AgentInputItem[]) {
  const installed = await runSkillInstallIfRequested(sessionId, runId, content);
  if (installed.handled) return installed;
  const skills = input.filter((item): item is SkillInput => item.type === "skill");
  if (!skills.length) return { handled: false as const };
  const imageSkill = skills.find((item) => isImageSkill(item.id));
  if (!imageSkill) {
    return { handled: false as const };
  }
  await runImagegenSkill(sessionId, runId, content, imageSkill);
  return { handled: true as const };
}

async function runSkillInstallIfRequested(sessionId: string, runId: string, content: string) {
  const skillUrl = extractSkillUrl(content);
  if (!skillUrl) return { handled: false as const };
  if (!shouldInstallSkillFromText(content, skillUrl)) return { handled: false as const };

  const assistantId = makeId("msg");
  const meta = { runId, messageId: assistantId };
  patchSession(sessionId, { status: "streaming" });
  addMessage({
    id: assistantId,
    sessionId,
    runId,
    role: "assistant",
    content: "",
    createdAt: nowIso(),
    status: "streaming",
  });
  publishEvent(sessionId, "thinking.start", { message: "Using Skill Installer" }, { runId });
  publishEvent(sessionId, "tool.start", { tool: "skill-installer", input: { url: skillUrl, target: "FCode Custom Skills" } }, { runId });

  try {
    const markdown = await fetchSkillMarkdown(skillUrl);
    const parsed = parseSkillMarkdown(markdown, skillUrl);
    const skill = upsertSkill({
      name: parsed.name,
      trigger: parsed.trigger,
      description: parsed.description,
      instructions: markdown,
      enabled: true,
    });
    const finalText = `Skill ${skill.name} sudah masuk Custom Skills. Trigger: /${skill.trigger}`;
    updateMessage(sessionId, assistantId, { content: finalText, status: "done" });
    publishEvent(sessionId, "tool.done", { tool: "skill-installer", output: `/${skill.trigger}` }, { runId });
    publishEvent(sessionId, "message.done", { content: finalText, role: "assistant" }, meta);
    publishEvent(sessionId, "thinking.done", { message: "Skill installed" }, { runId });
    publishEvent(sessionId, "session.done", { message: "Agent idle" }, { runId });
    patchSession(sessionId, { status: "idle" });
    return { handled: true as const };
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : "Skill install failed");
    updateMessage(sessionId, assistantId, { content: message, status: "error" });
    publishEvent(sessionId, "tool.error", { tool: "skill-installer", message }, { runId });
    publishEvent(sessionId, "message.done", { content: message, role: "assistant" }, meta);
    publishEvent(sessionId, "session.error", { message }, { runId });
    patchSession(sessionId, { status: "idle" });
    return { handled: true as const };
  }
}

async function runImagegenSkill(sessionId: string, runId: string, promptRaw: string, skill: SkillInput) {
  const assistantId = makeId("msg");
  const meta = { runId, messageId: assistantId };
  const controller = new AbortController();
  activeSkillRuns.set(sessionId, { controller, runId, assistantId });
  patchSession(sessionId, { status: "streaming" });
  addMessage({
    id: assistantId,
    sessionId,
    runId,
    role: "assistant",
    content: "",
    createdAt: nowIso(),
    status: "streaming",
  });

  publishEvent(sessionId, "thinking.start", { message: `Executing skill: ${skill.label}` }, { runId });
  publishEvent(sessionId, "tool.start", { tool: "imagegen", status: "running" }, { runId });

  const prompt = sanitizeImagePrompt(promptRaw);
  if (!prompt) {
    return failSkill(sessionId, assistantId, runId, "Prompt kosong. Tulis deskripsi gambar dulu.");
  }
  if (containsBlockedSexualPrompt(prompt)) {
    return failSkill(sessionId, assistantId, runId, "Prompt terlalu eksplisit. Gunakan deskripsi dewasa non-eksplisit.");
  }

  const provider = readImageProvider();
  if (!provider.apiKey) {
    return failSkill(
      sessionId,
      assistantId,
      runId,
      "Imagegen belum bisa jalan. OPENAI_API_KEY tidak ditemukan di env atau active FenCode auth.json.",
    );
  }

  try {
    const model = skill.options?.imageModel || readImageGenSettings().selectedModel;
    publishEvent(sessionId, "thinking.delta", { message: `Generating image with ${model}` }, { runId });
    const dataUrl = await generateImageDataUrl(prompt, provider.apiKey, provider.baseUrl, model, controller.signal);
    const saved = await saveGeneratedImage(sessionId, dataUrl, controller.signal);
    publishEvent(sessionId, "file.create", {
      path: saved.relativePath,
      content: "<binary image>",
      language: "image/png",
      size: saved.size,
      expandable: false,
    }, { runId });
    publishEvent(sessionId, "tool.done", { tool: "imagegen", status: "completed", output: saved.relativePath }, { runId });

    const finalText = `![${path.basename(saved.relativePath)}](${saved.publicUrl})`;
    updateMessage(sessionId, assistantId, { content: finalText, status: "done" });
    publishEvent(sessionId, "message.done", { content: finalText, role: "assistant" }, meta);
    publishEvent(sessionId, "thinking.done", { message: "Image generated" }, { runId });
    publishEvent(sessionId, "session.done", { message: "Agent idle" }, { runId });
    patchSession(sessionId, { status: "idle" });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : "Image generation failed");
    failSkill(sessionId, assistantId, runId, message);
  } finally {
    const active = activeSkillRuns.get(sessionId);
    if (active?.runId === runId) activeSkillRuns.delete(sessionId);
  }
}

function failSkill(sessionId: string, assistantId: string, runId: string, message: string) {
  failTodoProgress(sessionId, runId);
  updateMessage(sessionId, assistantId, { content: message, status: "error" });
  publishEvent(sessionId, "tool.error", { tool: "imagegen", message }, { runId });
  publishEvent(sessionId, "session.error", { message }, { runId });
  publishEvent(sessionId, "message.done", { content: message, role: "assistant" }, { runId, messageId: assistantId });
  patchSession(sessionId, { status: "idle" });
}

function isImageSkill(id: string) {
  const normalized = id.toLowerCase().replace(/^\.f(?:code|encode)\//, "").replace(/[\\/]+/g, "/");
  return [...IMAGE_SKILL_IDS].some((token) => normalized.endsWith(token));
}

function sanitizeImagePrompt(prompt: string) {
  return prompt
    .replace(/\[\/?[A-Za-z0-9 _-]+\]\(fcode-mention:\/\/[^\s)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsBlockedSexualPrompt(prompt: string) {
  const text = prompt.toLowerCase();
  const blocked = [
    "nude",
    "nudity",
    "porn",
    "explicit",
    "telanjang",
    "seks",
    "payudara",
    "bokong",
    "puting",
    "vagina",
    "penis",
  ];
  return blocked.some((token) => text.includes(token));
}

function extractSkillUrl(content: string) {
  const urls = content.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return urls.find(isLikelyGithubSkillUrl) ?? "";
}

function shouldInstallSkillFromText(content: string, skillUrl: string) {
  const withoutUrl = content.replace(skillUrl, "").trim();
  const explicitlyAsked = /\b(install|pasang|tambah|tambahkan)\b/i.test(content) && /\bskill\b/i.test(content);
  if (explicitlyAsked) return true;
  return isLikelyGithubSkillUrl(skillUrl) && (!withoutUrl || /\b(skill|skills?)\b/i.test(content));
}

function isLikelyGithubSkillUrl(url: string) {
  try {
    const parsed = new URL(url);
    const isGithub = parsed.hostname === "github.com" || parsed.hostname === "raw.githubusercontent.com";
    if (!isGithub) return false;
    return /(?:^|\/)(skills?|SKILL\.md)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function fetchSkillMarkdown(url: string) {
  const candidates = await resolveSkillMarkdownUrls(url);
  let lastError = "";
  for (const rawUrl of candidates) {
    const response = await fetch(rawUrl, {
      headers: { Accept: "text/markdown,text/plain,*/*" },
    });
    if (!response.ok) {
      lastError = `${response.status} ${rawUrl}`;
      continue;
    }
    const markdown = await response.text();
    if (!isValidSkillMarkdown(markdown)) {
      lastError = `invalid SKILL.md ${rawUrl}`;
      continue;
    }
    if (markdown.length > 120_000) throw new Error("SKILL.md terlalu besar.");
    return markdown;
  }
  throw new Error(`Gagal menemukan SKILL.md valid dari URL itu.${lastError ? ` Terakhir: ${lastError}` : ""}`);
}

async function fetchGithubJson<T>(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub API gagal (${response.status}).`);
  return response.json() as Promise<T>;
}

async function resolveSkillMarkdownUrls(url: string) {
  const parsed = parseGithubUrl(url);
  const candidates = new Set<string>();
  try {
    candidates.add(toRawSkillUrl(url));
  } catch {
    // Folder/repo URLs can still be resolved through GitHub metadata below.
  }
  if (!parsed) return [...candidates];
  const contents = await findSkillViaGithubContents(parsed).catch(() => []);
  for (const candidate of contents) candidates.add(candidate);
  const tree = await findSkillViaGithubTree(parsed).catch(() => []);
  for (const candidate of tree) candidates.add(candidate);
  return [...candidates];
}

function isValidSkillMarkdown(markdown: string) {
  const text = markdown.trim();
  return Boolean(text && (/^#\s+/m.test(text) || /^name:\s*.+$/im.test(text) || /^description:\s*.+$/im.test(text)));
}

function toRawSkillUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname === "raw.githubusercontent.com") return parsed.toString();
  if (parsed.hostname !== "github.com") throw new Error("Untuk sekarang install skill hanya support GitHub/raw GitHub.");
  const parts = parsed.pathname.split("/").filter(Boolean);
  const blobIndex = parts.indexOf("blob");
  const treeIndex = parts.indexOf("tree");
  if (parts.length < 2) throw new Error("URL GitHub skill tidak valid.");
  if (blobIndex >= 0 && parts[blobIndex + 1]) {
    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[blobIndex + 1];
    const filePath = parts.slice(blobIndex + 2).join("/");
    if (!/SKILL\.md$/i.test(filePath)) throw new Error("Pakai URL file SKILL.md, bukan file lain.");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  }
  if (treeIndex >= 0 && parts[treeIndex + 1]) {
    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[treeIndex + 1];
    const dirPath = parts.slice(treeIndex + 2).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/SKILL.md`;
  }
  throw new Error("Pakai URL GitHub ke SKILL.md atau folder skill.");
}

function parseGithubUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  const treeIndex = parts.indexOf("tree");
  const blobIndex = parts.indexOf("blob");
  const modeIndex = treeIndex >= 0 ? treeIndex : blobIndex;
  if (modeIndex >= 0 && parts[modeIndex + 1]) {
    return {
      owner,
      repo,
      ref: parts[modeIndex + 1],
      path: parts.slice(modeIndex + 2).join("/"),
    };
  }
  return { owner, repo, ref: "main", path: "" };
}

type GithubContent = {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url?: string | null;
};

async function findSkillViaGithubContents(parsed: { owner: string; repo: string; ref: string; path: string }) {
  const apiPath = parsed.path ? `/${parsed.path}` : "";
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents${apiPath}?ref=${encodeURIComponent(parsed.ref)}`;
  const payload = await fetchGithubJson<GithubContent | GithubContent[]>(url);
  const items = Array.isArray(payload) ? payload : [payload];
  return items
    .filter((item) => item.type === "file" && /^SKILL\.md$/i.test(item.name) && item.download_url)
    .map((item) => item.download_url!)
    .concat(items
      .filter((item) => item.type === "dir")
      .map((item) => rawGithubUrl(parsed.owner, parsed.repo, parsed.ref, `${item.path}/SKILL.md`)));
}

type GithubTree = {
  tree?: Array<{ path: string; type: "blob" | "tree" }>;
};

async function findSkillViaGithubTree(parsed: { owner: string; repo: string; ref: string; path: string }) {
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(parsed.ref)}?recursive=1`;
  const payload = await fetchGithubJson<GithubTree>(url);
  const base = parsed.path.replace(/\/+$/, "");
  return (payload.tree ?? [])
    .filter((item) => item.type === "blob" && /(^|\/)SKILL\.md$/i.test(item.path))
    .filter((item) => !base || item.path === `${base}/SKILL.md` || item.path.startsWith(`${base}/`))
    .sort((a, b) => scoreSkillPath(a.path, base) - scoreSkillPath(b.path, base))
    .slice(0, 6)
    .map((item) => rawGithubUrl(parsed.owner, parsed.repo, parsed.ref, item.path));
}

function rawGithubUrl(owner: string, repo: string, ref: string, filePath: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

function scoreSkillPath(filePath: string, base: string) {
  if (base && filePath === `${base}/SKILL.md`) return 0;
  if (/\/skills?\/[^/]+\/SKILL\.md$/i.test(filePath)) return 1;
  return filePath.split("/").length;
}

function parseSkillMarkdown(markdown: string, sourceUrl: string) {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const explicitName = markdown.match(/^name:\s*(.+)$/im)?.[1]?.trim();
  const description = markdown.match(/^description:\s*(.+)$/im)?.[1]?.trim()
    ?? firstParagraph(markdown)
    ?? "Custom FCode skill";
  const fallbackName = skillNameFromUrl(sourceUrl);
  const name = cleanSkillName(explicitName || heading || fallbackName);
  return {
    name,
    trigger: name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
    description: description.replace(/^["']|["']$/g, "").slice(0, 240),
  };
}

function firstParagraph(markdown: string) {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("---"))
    ?.replace(/\s+/g, " ")
    .slice(0, 240);
}

function skillNameFromUrl(sourceUrl: string) {
  const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
  const skillMdIndex = parts.findIndex((part) => /^SKILL\.md$/i.test(part));
  const raw = skillMdIndex > 0 ? parts[skillMdIndex - 1] : parts.at(-1) ?? "custom-skill";
  return cleanSkillName(raw.replace(/\.md$/i, ""));
}

function cleanSkillName(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
    .slice(0, 80) || "Custom Skill";
}

function readImageProvider() {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  const defaultBaseUrl = readFcodeConfig().provider.baseUrl || "https://api.openai.com/v1";
  if (fromEnv) return { apiKey: fromEnv, baseUrl: process.env.OPENAI_BASE_URL?.trim() || defaultBaseUrl };
  const authPath = path.join(resolveFencodeHome(), "auth.json");
  if (!fs.existsSync(authPath)) return { apiKey: "", baseUrl: defaultBaseUrl };
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as { OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string; openai_base_url?: string; base_url?: string };
    return {
      apiKey: raw.OPENAI_API_KEY?.trim() ?? "",
      baseUrl: (raw.OPENAI_BASE_URL || raw.openai_base_url || raw.base_url || defaultBaseUrl).replace(/\/+$/, ""),
    };
  } catch {
    return { apiKey: "", baseUrl: defaultBaseUrl };
  }
}

async function generateImageDataUrl(prompt: string, apiKey: string, baseUrl: string, model: string, signal: AbortSignal) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
  const imageLayout = inferImageLayout(prompt);
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: `${prompt}. Keep output non-explicit, non-nude, safe for work.`,
      n: 1,
      size: imageLayout.size,
      aspect_ratio: imageLayout.aspectRatio,
      quality: "auto",
      background: "auto",
      image_detail: "high",
      output_format: "png",
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Image API failed (${response.status}). ${sanitizeErrorMessage(text).slice(0, 240)}`);
  }
  const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = payload.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error("Image API response kosong.");
}

function inferImageLayout(prompt: string) {
  const rawRatio = prompt.match(/\b(\d{1,2})\s*[:x\/]\s*(\d{1,2})\b/i);
  if (!rawRatio) return { size: "auto", aspectRatio: undefined as string | undefined };
  const width = Number(rawRatio[1]);
  const height = Number(rawRatio[2]);
  if (!width || !height) return { size: "auto", aspectRatio: undefined as string | undefined };
  const ratio = width / height;
  const aspectRatio = `${width}:${height}`;
  if (ratio >= 1.6) return { size: "1536x1024", aspectRatio };
  if (ratio <= 0.75) return { size: "1024x1536", aspectRatio };
  return { size: "1024x1024", aspectRatio };
}

function sanitizeErrorMessage(message: string) {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/Incorrect API key provided:[\s\S]*?(?=\. You can find|$)/, "Incorrect API key provided: [redacted-api-key]");
}

async function saveGeneratedImage(sessionId: string, dataUrlOrUrl: string, signal: AbortSignal) {
  const detail = getSession(sessionId);
  const workspacePath = detail?.session.workspacePath || process.env.DEFAULT_WORKSPACE_PATH || process.cwd();
  const outputDir = path.join(workspacePath, "artifacts");
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `${buildImageTimestampName()}.png`;
  const absolutePath = path.join(outputDir, filename);
  if (dataUrlOrUrl.startsWith("data:image/")) {
    const base64 = dataUrlOrUrl.split(",", 2)[1] ?? "";
    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(absolutePath, buffer);
  } else {
    const response = await fetch(dataUrlOrUrl, { signal });
    if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(absolutePath, buffer);
  }
  const stat = fs.statSync(absolutePath);
  const relativePath = path.join("artifacts", filename).replace(/\\/g, "/");
  const publicUrl = `/api/workspace/blob?root=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(relativePath)}`;
  return {
    absolutePath,
    relativePath,
    publicUrl,
    size: stat.size,
  };
}

function buildImageTimestampName() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  const hh = `${now.getHours()}`.padStart(2, "0");
  const mi = `${now.getMinutes()}`.padStart(2, "0");
  const ss = `${now.getSeconds()}`.padStart(2, "0");
  return `FCode Image ${yyyy}-${mm}-${dd} ${hh}-${mi}-${ss}`;
}
