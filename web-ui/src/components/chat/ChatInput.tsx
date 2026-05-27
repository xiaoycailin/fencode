"use client";

import { Box, ChevronDown, FolderOpen, Loader2, LockKeyhole, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Session } from "@/types/session";
import type { AgentInputItem } from "@/types/agentInput";
import type { ModelConfig, WorkspaceConfig } from "@/lib/db";
import { SlashCommandPanel } from "./SlashCommandPanel";

type ContextChip = {
  id: string;
  text: string;
};

type ComposerAttachment = {
  id: string;
  name: string;
  marker?: string;
  kind: "text" | "image" | "binary";
  previewUrl?: string;
  dataUrl?: string;
  textContent?: string;
  size: number;
};

type MentionItem = {
  marker: string;
  label: string;
  value: string;
  kind: "file" | "feature" | "skill" | "command";
  source?: "builtin" | "custom" | "workspace" | "feature" | "file" | "command";
  commandId?: "memories" | "plan_mode" | "status" | "personality" | "compact";
};
type SkillConfigItem = { id: string; name: string; description: string; trigger: string; enabled: boolean };
type ImageGenSettings = { selectedModel: string; models: string[] };
export type GitChangeSummary = {
  changedFiles: number;
  additions: number;
  deletions: number;
  files: Array<{ path: string }>;
};

type Props = {
  disabled: boolean;
  hasChanges: boolean;
  changeSummary: GitChangeSummary | null;
  session: Session;
  models: ModelConfig[];
  workspaces: WorkspaceConfig[];
  text: string;
  onTextChange: (value: string) => void;
  contextChips: ContextChip[];
  onRemoveContext: (id: string) => void;
  onPatchSession: (patch: Partial<Pick<Session, "model" | "workspacePath" | "permission">>) => Promise<void>;
  onSend: (text: string, input: AgentInputItem[]) => Promise<void>;
  onStop: () => void | Promise<void>;
  onCompact: () => Promise<void>;
  compacting: boolean;
};

export function ChatInput({
  disabled,
  hasChanges,
  changeSummary,
  session,
  models,
  workspaces,
  text,
  contextChips,
  onTextChange,
  onRemoveContext,
  onPatchSession,
  onSend,
  onStop,
  onCompact,
  compacting,
}: Props) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [activePreview, setActivePreview] = useState<ComposerAttachment | null>(null);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionOptions, setMentionOptions] = useState<MentionItem[]>(defaultMentionOptions());
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandOptions, setCommandOptions] = useState<MentionItem[]>(defaultCommandOptions());
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [showStatusPanel, setShowStatusPanel] = useState(false);
  const [showMemoriesPanel, setShowMemoriesPanel] = useState(false);
  const [showPersonalityPanel, setShowPersonalityPanel] = useState(false);
  const [imageGenSettings, setImageGenSettings] = useState<ImageGenSettings>({ selectedModel: "", models: [] });
  const [selectedImageModel, setSelectedImageModel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const suggestionMenuRef = useRef<HTMLDivElement | null>(null);
  const hasImagegenMentionInDraft = mentions.some((item) => isImagegenMention(item) && text.includes(item.marker));
  const changedFileCount = changeSummary?.changedFiles ?? 0;

  useEffect(() => {
    if (!activePreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActivePreview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePreview]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const focused = document.activeElement === editor;
    if (focused && text) return;
    renderEditorContent(editor, text, attachments, mentions);
  }, [attachments, mentions, text]);

  useEffect(() => {
    void loadMentionOptions();
    void loadImageGenSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspacePath]);

  useEffect(() => {
    if (session.status !== "idle") return;
    void loadMentionOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, session.updatedAt]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPlanModeEnabled(window.localStorage.getItem("fcode:plan-mode") === "1");
  }, []);

  useEffect(() => {
    const menu = suggestionMenuRef.current;
    if (!menu || (!mentionOpen && !commandOpen)) return;
    const active = menu.querySelector<HTMLElement>(`[data-suggestion-index="${activeSuggestionIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionIndex, mentionOpen, commandOpen, mentionQuery, commandQuery]);

  useEffect(() => {
    if (hasImagegenMentionInDraft) return;
    setSelectedImageModel("");
  }, [hasImagegenMentionInDraft]);

  async function submit() {
    const value = text.trim();
    if (disabled) {
      await onStop();
      return;
    }
    if (!value && !attachments.length && !contextChips.length) return;
    const displayText = buildDisplayMessage(value, contextChips, attachments, mentions);
    const input = buildAgentInput(value, contextChips, attachments, mentions, planModeEnabled, selectedImageModel || imageGenSettings.selectedModel);
    onTextChange("");
    setMentions([]);
    clearAttachments();
    await onSend(displayText.trim(), input);
  }

  function clearAttachments() {
    setAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  }

  async function handleFiles(fileList: FileList | null, insertInline: "cursor" | "append" = "append") {
    if (!fileList?.length) return;
    const next = await Promise.all([...fileList].map(readAttachment));
    const imageMarkers = next.filter((item) => item.kind === "image" && item.marker).map((item) => item.marker!);
    if (imageMarkers.length) {
      insertInlineMarkers(imageMarkers, insertInline);
    }
    setAttachments((current) => [...current, ...next]);
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = event.clipboardData.files;
    if (files?.length) {
      event.preventDefault();
      await handleFiles(files, "cursor");
      return;
    }
    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText) return;
    event.preventDefault();
    insertPlainTextAtSelection(event.currentTarget, pastedText);
    onTextChange(serializeEditor(event.currentTarget));
  }

  function insertInlineMarkers(markers: string[], mode: "cursor" | "append") {
    const editor = editorRef.current;
    if (!markers.length || !editor) return;
    if (mode === "cursor") {
      editor.focus();
      for (const marker of markers) insertMarkerAtSelection(editor, marker);
      onTextChange(serializeEditor(editor));
      return;
    }
    const current = serializeEditor(editor) || text;
    const next = `${current}${current.trim() ? "\n" : ""}${markers.join(" ")}`.trimStart();
    onTextChange(next);
    window.requestAnimationFrame(() => {
      renderEditorContent(editor, next, attachments, mentions);
      moveCaretToEnd(editor);
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      if (target?.marker) {
        const editor = editorRef.current;
        if (editor) {
          const token = editor.querySelector(`[data-marker="${cssEscape(target.marker)}"]`);
          token?.remove();
          onTextChange(serializeEditor(editor));
        } else {
          onTextChange(text.replace(target.marker, "").trim());
        }
      }
      return current.filter((item) => item.id !== id);
    });
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        {hasChanges ? (
          <div className="review-bar">
            <span>
              {formatFileCount(changedFileCount)}
              {changeSummary ? <>
                {" "}<span className="diff-plus">+{changeSummary.additions}</span>
                {" "}<span className="diff-minus">-{changeSummary.deletions}</span>
              </> : null}
            </span>
            <button className="ghost-button">Review here</button>
          </div>
        ) : null}
        {contextChips.length ? (
          <div className="composer-meta-row">
            {contextChips.map((chip) => (
              <button key={chip.id} className="context-chip" type="button" onClick={() => onRemoveContext(chip.id)}>
                <span>{chip.text}</span>
                <X size={12} />
              </button>
            ))}
          </div>
        ) : null}
        {attachments.some((attachment) => attachment.kind !== "image") ? (
          <div className="composer-meta-row">
            {attachments.filter((attachment) => attachment.kind !== "image").map((attachment) => (
              <button
                key={attachment.id}
                className="attachment-chip"
                type="button"
              >
                <Paperclip size={12} />
                <span>{attachment.name}</span>
                <span className="attachment-chip-meta">{formatSize(attachment.size)}</span>
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    removeAttachment(attachment.id);
                  }}
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          ref={editorRef}
          className="composer-editor"
          contentEditable={!disabled}
          aria-label="Message"
          data-placeholder="Ask FCode to code, inspect, explain, or refactor..."
          role="textbox"
          suppressContentEditableWarning
          onClick={(event) => handleEditorClick(event)}
          onInput={(event) => handleEditorInput(event.currentTarget)}
          onPaste={(event) => void handlePaste(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              const mentionItems = orderedSuggestionItems(filteredMentionOptions(mentionOptions, mentionQuery), false);
              const commandItems = orderedSuggestionItems(filteredMentionOptions(commandOptions, commandQuery), true);
              const firstMention = mentionItems[activeSuggestionIndex] ?? mentionItems[0];
              const firstCommand = commandItems[activeSuggestionIndex] ?? commandItems[0];
              if (mentionOpen && firstMention) {
                event.preventDefault();
                pickMention(firstMention, "@");
                return;
              }
              if (commandOpen && firstCommand) {
                event.preventDefault();
                pickMention(firstCommand, "/");
                return;
              }
              event.preventDefault();
              void submit();
              return;
            }
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              insertLineBreak(event.currentTarget);
              onTextChange(serializeEditor(event.currentTarget));
              return;
            }
            if (event.key === "@" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              window.setTimeout(() => refreshSuggestionState(), 0);
              return;
            }
            if (event.key === "/" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              setCommandOpen(true);
              setMentionOpen(false);
              setCommandQuery("");
              setActiveSuggestionIndex(0);
              window.setTimeout(() => refreshSuggestionState(), 0);
              return;
            }
            if (mentionOpen || commandOpen) {
              if (event.key === "Escape") {
                setMentionOpen(false);
                setCommandOpen(false);
                return;
              }
              const activeItems = mentionOpen
                ? orderedSuggestionItems(filteredMentionOptions(mentionOptions, mentionQuery), false)
                : orderedSuggestionItems(filteredMentionOptions(commandOptions, commandQuery), true);
              if (event.key === "ArrowDown" && activeItems.length) {
                event.preventDefault();
                setActiveSuggestionIndex((value) => (value + 1) % activeItems.length);
                return;
              }
              if (event.key === "ArrowUp" && activeItems.length) {
                event.preventDefault();
                setActiveSuggestionIndex((value) => (value - 1 + activeItems.length) % activeItems.length);
                return;
              }
              window.setTimeout(() => refreshSuggestionState(), 0);
            }
          }}
        />
        {mentionOpen && filteredMentionOptions(mentionOptions, mentionQuery).length ? (
          <div className="mention-menu" ref={suggestionMenuRef}>
            {renderSuggestionGroups(filteredMentionOptions(mentionOptions, mentionQuery), activeSuggestionIndex, (item) => pickMention(item, "@"))}
          </div>
        ) : null}
        {commandOpen && filteredMentionOptions(commandOptions, commandQuery).length ? (
          <div className="mention-menu" ref={suggestionMenuRef}>
            {renderSuggestionGroups(filteredMentionOptions(commandOptions, commandQuery), activeSuggestionIndex, (item) => pickMention(item, "/"), true)}
          </div>
        ) : null}
        {showStatusPanel ? <SlashCommandPanel kind="status" session={session} planModeEnabled={planModeEnabled} onClose={() => setShowStatusPanel(false)} /> : null}
        {showMemoriesPanel ? <SlashCommandPanel kind="memories" session={session} planModeEnabled={planModeEnabled} onClose={() => setShowMemoriesPanel(false)} /> : null}
        {showPersonalityPanel ? <SlashCommandPanel kind="personality" session={session} planModeEnabled={planModeEnabled} onClose={() => setShowPersonalityPanel(false)} /> : null}
        {planModeEnabled ? (
          <div className="composer-meta-row">
            <span className="context-chip"><span>Plan mode active</span></span>
          </div>
        ) : null}
        {hasImagegenMentionInDraft ? (
          <div className="composer-meta-row">
            <MiniDropdown
              icon={<Box size={13} />}
              label={selectedImageModel || imageGenSettings.selectedModel || "Image model"}
              items={imageGenSettings.models.map((model) => ({ value: model, label: model }))}
              onSelect={(value) => setSelectedImageModel(value)}
            />
          </div>
        ) : null}
        <div className="composer-actions">
          <div className="composer-actions-left">
            <input
              ref={inputRef}
              hidden
              type="file"
              multiple
              onChange={(event) => void handleFiles(event.target.files, "append")}
            />
            <button className="pill" aria-label="Attach files" onClick={() => inputRef.current?.click()}><Paperclip size={14} /> Attach</button>
            <MiniDropdown
              icon={<LockKeyhole size={13} />}
              label={permissionLabel(session.permission)}
              items={[
                { value: "read-only", label: "Read only" },
                { value: "workspace-write", label: "Workspace write" },
                { value: "full-access", label: "Full access" },
              ]}
              onSelect={(value) => void onPatchSession({ permission: value as Session["permission"] })}
            />
            <MiniDropdown
              icon={<FolderOpen size={13} />}
              label={workspaces.find((workspace) => workspace.path === session.workspacePath)?.label ?? shortPath(session.workspacePath)}
              items={workspaces.map((workspace) => ({ value: workspace.path, label: workspace.label, detail: workspace.path }))}
              onSelect={(value) => void onPatchSession({ workspacePath: value })}
            />
            <MiniDropdown
              icon={<Box size={13} />}
              label={models.find((model) => model.id === session.model)?.name ?? session.model}
              items={models.map((model) => ({ value: model.id, label: model.name, detail: `${model.contextWindow.toLocaleString()} ctx` }))}
              onSelect={(value) => void onPatchSession({ model: value })}
            />
          </div>
          <div className="composer-actions-right">
            <CompactStatusButton
              session={session}
              compacting={compacting}
              disabled={disabled}
              onCompact={onCompact}
            />
            <button className="primary-button" onClick={submit} disabled={!disabled && !text.trim()}>
              {disabled ? <Square size={14} /> : <Send size={14} />}
              {disabled ? "Stop" : "Send"}
            </button>
          </div>
        </div>
      </div>
      {activePreview?.previewUrl ? (
        <div className="image-preview-overlay" onClick={() => setActivePreview(null)}>
          <div className="image-preview-dialog" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button image-preview-close" onClick={() => setActivePreview(null)}><X size={16} /></button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={activePreview.previewUrl} alt={activePreview.name} className="image-preview-image" />
            <p className="image-preview-caption">{activePreview.name}</p>
          </div>
        </div>
      ) : null}
    </div>
  );

  function handleEditorClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const removeMarker = target.closest<HTMLElement>("[data-remove-marker]")?.dataset.removeMarker;
    if (removeMarker) {
      event.preventDefault();
      const targetAttachment = attachments.find((item) => item.marker === removeMarker);
      if (targetAttachment) removeAttachment(targetAttachment.id);
      return;
    }
    const marker = target.closest<HTMLElement>("[data-marker]")?.dataset.marker;
    if (!marker) return;
    const mentionMarker = target.closest<HTMLElement>("[data-mention-marker]")?.dataset.mentionMarker;
    if (mentionMarker) {
      const next = mentions.filter((item) => item.marker !== mentionMarker);
      setMentions(next);
      const node = target.closest<HTMLElement>("[data-mention-marker]");
      node?.remove();
      const editor = editorRef.current;
      if (editor) onTextChange(serializeEditor(editor));
      return;
    }
    const targetAttachment = attachments.find((item) => item.marker === marker);
    if (targetAttachment?.kind === "image") setActivePreview(targetAttachment);
  }

  async function loadMentionOptions() {
    try {
      const [treeResponse, skillsResponse] = await Promise.all([
        fetch(`/api/workspace/tree?root=${encodeURIComponent(session.workspacePath)}&depth=6`),
        fetch("/api/settings/skills"),
      ]);
      const payload = await treeResponse.json();
      const skillsPayload = await skillsResponse.json() as { data?: SkillConfigItem[] };
      const filePaths = flattenFiles(payload.data ?? []).filter(isMentionCandidatePath);
      const files = filePaths.slice(0, 600).map((path) => ({
        marker: `[mention:file:${path}]`,
        label: path.split("/").at(-1) ?? path,
        value: path,
        kind: "file" as const,
        source: "file" as const,
      }));
      const skills = filePaths
        .filter((path) => /(^|\/)(skills?\/|SKILL\.md$)/i.test(path))
        .map((path) => ({
          marker: `[mention:skill:${path}]`,
          label: skillNameFromPath(path),
          value: path,
          kind: "skill" as const,
          source: "workspace" as const,
        }));
      const customSkillCommands = (skillsPayload.data ?? [])
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          marker: `[mention:skill:custom/${skill.trigger}]`,
          label: skill.name,
          value: skill.description,
          kind: "skill" as const,
          source: "custom" as const,
        }));
      const mergedSkills = dedupeMentions([...defaultBuiltinSkillCommands(), ...customSkillCommands, ...skills]);
      setMentionOptions([...defaultMentionOptions(), ...files, ...mergedSkills]);
      setCommandOptions([
        ...defaultCommandOptions(),
        ...mergedSkills,
      ]);
    } catch {
      setMentionOptions(defaultMentionOptions());
      setCommandOptions([...defaultCommandOptions(), ...defaultBuiltinSkillCommands()]);
    }
  }

  async function loadImageGenSettings() {
    try {
      const data = await fetch("/api/settings/imagegen").then((response) => response.json()) as ImageGenSettings;
      setImageGenSettings(data);
      setSelectedImageModel((current) => current || data.selectedModel);
    } catch {
      setImageGenSettings({ selectedModel: "cx/gpt-5.5-image", models: ["cx/gpt-5.5-image"] });
      setSelectedImageModel((current) => current || "cx/gpt-5.5-image");
    }
  }

  function handleEditorInput(editor: HTMLDivElement) {
    const serialized = serializeEditor(editor);
    onTextChange(serialized);
    setMentions((current) => current.filter((item) => serialized.includes(item.marker)));
    refreshSuggestionState();
  }

  function refreshSuggestionState() {
    const editor = editorRef.current;
    if (!editor) return;
    const before = readTextBeforeCaret(editor);
    const mentionToken = /(?:^|\s)@([^\s@/]{0,40})$/.exec(before);
    const commandToken = /(?:^|\s)\/([^\s/@]{0,40})$/.exec(before);
    if (mentionToken) {
      setMentionQuery((mentionToken[1] ?? "").toLowerCase());
      setMentionOpen(true);
      setCommandOpen(false);
      setActiveSuggestionIndex(0);
      return;
    }
    if (commandToken) {
      setCommandQuery((commandToken[1] ?? "").toLowerCase());
      setCommandOpen(true);
      setMentionOpen(false);
      setActiveSuggestionIndex(0);
      return;
    }
    setMentionOpen(false);
    setCommandOpen(false);
    setMentionQuery("");
    setCommandQuery("");
    setActiveSuggestionIndex(0);
  }

  function pickMention(item: MentionItem, trigger: "@" | "/") {
    const editor = editorRef.current;
    if (!editor) return;
    if (trigger === "/" && item.kind === "command" && item.commandId) {
      const content = serializeEditor(editor).replace(/(?:^|\s)\/[^\s/@]{0,40}$/m, "").trimEnd();
      renderEditorContent(editor, content, attachments, mentions);
      onTextChange(content);
      setMentionOpen(false);
      setCommandOpen(false);
      setMentionQuery("");
      setCommandQuery("");
      setActiveSuggestionIndex(0);
      executeSlashCommand(item.commandId);
      return;
    }
    replaceTriggerQueryWithMention(editor, item, trigger === "@" ? mentionQuery : commandQuery, trigger);
    setMentionOpen(false);
    setCommandOpen(false);
    setMentionQuery("");
    setCommandQuery("");
    setActiveSuggestionIndex(0);
    setMentions((current) => [...current.filter((entry) => entry.marker !== item.marker), item]);
    onTextChange(serializeEditor(editor));
  }

  function executeSlashCommand(commandId: "memories" | "plan_mode" | "status" | "personality" | "compact") {
    if (commandId === "plan_mode") {
      const next = !planModeEnabled;
      setPlanModeEnabled(next);
      if (typeof window !== "undefined") window.localStorage.setItem("fcode:plan-mode", next ? "1" : "0");
      return;
    }
    if (commandId === "status") {
      setShowStatusPanel((value) => !value);
      setShowMemoriesPanel(false);
      setShowPersonalityPanel(false);
      return;
    }
    if (commandId === "memories") {
      setShowMemoriesPanel((value) => !value);
      setShowStatusPanel(false);
      setShowPersonalityPanel(false);
      return;
    }
    if (commandId === "personality") {
      setShowPersonalityPanel((value) => !value);
      setShowStatusPanel(false);
      setShowMemoriesPanel(false);
      return;
    }
    if (commandId === "compact") {
      void onCompact();
    }
  }
}

function permissionLabel(permission: Session["permission"]) {
  if (permission === "read-only") return "Read only";
  if (permission === "full-access") return "Full access";
  return "Workspace write";
}

function CompactStatusButton({
  session,
  compacting,
  disabled,
  onCompact,
}: {
  session: Session;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => Promise<void>;
}) {
  const usage = Math.max(0, Math.min(100, session.contextUsagePct ?? 0));
  const tokens = session.contextUsageTokens ?? 0;
  const windowSize = session.contextWindow ?? 128000;
  const warn = usage >= 80;
  return (
    <button
      className={`compact-status-button${warn ? " warn" : ""}`}
      type="button"
      onClick={() => void onCompact()}
      disabled={disabled || compacting}
      aria-label={`Compact context, ${usage}% full`}
      style={{ "--context-progress": `${usage * 3.6}deg` } as CSSProperties}
    >
      {compacting ? <Loader2 size={13} className="spin" /> : <RotateCcw size={12} />}
      <span className="compact-status-tooltip">
        <strong>Compact</strong>
        <span>Compact this thread&apos;s context ({usage}% full)</span>
        <em>{tokens.toLocaleString()} / {windowSize.toLocaleString()} tokens</em>
      </span>
    </button>
  );
}

function shortPath(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) || value || "Workspace";
}

function formatAttachmentForDisplay(attachment: ComposerAttachment) {
  if (attachment.kind === "text" && attachment.textContent) {
    return `- ${attachment.name} (${formatSize(attachment.size)})`;
  }
  if (attachment.kind === "image") {
    return `- ${attachment.name} (image)`;
  }
  return `- ${attachment.name} (${formatSize(attachment.size)})`;
}

function buildDisplayMessage(text: string, contextChips: ContextChip[], attachments: ComposerAttachment[], mentions: MentionItem[]) {
  const markerMap = new Map(
    attachments
      .filter((item) => item.kind === "image" && item.marker && item.dataUrl)
      .map((item) => [item.marker!, item]),
  );
  const mentionMap = new Map(mentions.map((item) => [item.marker, item]));
  const withInlineImages = text.replace(/\[image:[^\]]+\]/g, (marker) => {
    const attachment = markerMap.get(marker);
    if (!attachment?.dataUrl) return marker;
    return `![${attachment.name}](${attachment.dataUrl})`;
  }).replace(/\[mention:[^\]]+\]/g, (marker) => {
    const mention = mentionMap.get(marker);
    if (!mention) return marker;
    return `[${mention.label}](fcode-mention://${mention.kind}/${encodeMentionValue(mention.value)})`;
  });
  const nonImageAttachments = attachments.filter((item) => item.kind !== "image");
  return [
    withInlineImages.trim(),
    contextChips.length ? `\n\nSelected context:\n${contextChips.map((chip, index) => `${index + 1}. ${chip.text}`).join("\n")}` : "",
    nonImageAttachments.length ? `\n\nAttachments:\n${nonImageAttachments.map(formatAttachmentForDisplay).join("\n")}` : "",
  ].join("").trim();
}

function encodeMentionValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildAgentInput(
  text: string,
  contextChips: ContextChip[],
  attachments: ComposerAttachment[],
  mentions: MentionItem[],
  planModeEnabled = false,
  imageModel = "",
): AgentInputItem[] {
  const mentionNote = mentions.length
    ? `\n\nMentions:\n${mentions.map((item) => `- ${item.kind}: ${item.value}`).join("\n")}`
    : "";
  const prompt = [
    text.trim(),
    planModeEnabled ? "\n\nSystem mode: Plan mode is enabled. Provide a concise plan first before implementation." : "",
    mentionNote,
    contextChips.length ? `\n\nSelected context:\n${contextChips.map((chip, index) => `${index + 1}. ${chip.text}`).join("\n")}` : "",
    attachments.some((item) => item.kind === "text" && item.textContent)
      ? `\n\nAttached files:\n${attachments
        .filter((item) => item.kind === "text" && item.textContent)
        .map((item) => `- ${item.name}\n\`\`\`\n${item.textContent!.slice(0, 8000)}\n\`\`\``)
        .join("\n")}`
      : "",
  ].join("").trim();
  const markerMap = new Map(
    attachments
      .filter((item) => item.kind === "image" && item.marker && item.dataUrl)
      .map((item) => [item.marker!, item.dataUrl!]),
  );
  const markerRegex = /\[image:[^\]]+\]/g;
  const input: AgentInputItem[] = [];
  let cursor = 0;
  for (const match of prompt.matchAll(markerRegex)) {
    const marker = match[0];
    const index = match.index ?? 0;
    const before = prompt.slice(cursor, index);
    if (before.trim()) input.push({ type: "text", text: before, textElements: [], text_elements: [] });
    const imageUrl = markerMap.get(marker);
    if (imageUrl) input.push({ type: "image", url: imageUrl, detail: "high" });
    else input.push({ type: "text", text: marker, textElements: [], text_elements: [] });
    cursor = index + marker.length;
  }
  const tail = prompt.slice(cursor);
  if (tail.trim()) input.push({ type: "text", text: tail, textElements: [], text_elements: [] });
  for (const mention of mentions) {
    if (mention.kind !== "skill") continue;
    input.push({
      type: "skill",
      id: normalizeSkillId(mention.marker, mention.value),
      label: mention.label,
      value: mention.value,
      executable: true,
      options: isImagegenMention(mention) && imageModel ? { imageModel } : undefined,
    });
  }
  if (!input.length && prompt) input.push({ type: "text", text: prompt, textElements: [], text_elements: [] });
  return input;
}

function isImagegenMention(item: MentionItem) {
  return normalizeSkillId(item.marker, item.value).endsWith("imagegen") || item.label.toLowerCase().replace(/\s+/g, "") === "imagegen";
}

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function formatFileCount(count: number) {
  if (count <= 1) return `${count || 1} file changed`;
  return `${count} files changed`;
}

function renderEditorContent(editor: HTMLDivElement, value: string, attachments: ComposerAttachment[], mentions: MentionItem[] = []) {
  editor.replaceChildren();
  const markerMap = new Map(attachments.filter((item) => item.marker).map((item) => [item.marker!, item]));
  const mentionMap = new Map(mentions.map((item) => [item.marker, item]));
  let cursor = 0;
  for (const match of value.matchAll(/\[(image:[^\]]+|mention:[^\]]+)\]/g)) {
    const marker = match[0];
    const index = match.index ?? 0;
    if (index > cursor) editor.append(document.createTextNode(value.slice(cursor, index)));
    const attachment = markerMap.get(marker);
    const mention = mentionMap.get(marker);
    editor.append(
      attachment ? createImageToken(marker, attachment.name, true) :
      mention ? createMentionToken(mention) :
      document.createTextNode(marker),
    );
    cursor = index + marker.length;
  }
  if (cursor < value.length) editor.append(document.createTextNode(value.slice(cursor)));
}

function serializeEditor(root: HTMLElement) {
  let output = "";
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const marker = node.dataset.marker;
    if (marker) {
      output += marker;
      return;
    }
    if (node.tagName === "BR") {
      output += "\n";
      return;
    }
    for (const child of [...node.childNodes]) walk(child);
    if (node.tagName === "DIV" || node.tagName === "P") output += "\n";
  }
  for (const child of [...root.childNodes]) walk(child);
  return output.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n");
}

function insertMarkerAtSelection(editor: HTMLDivElement, marker: string) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const token = createImageToken(marker, marker.slice(7, -1), true);
  const space = document.createTextNode(" ");
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    editor.append(token, space);
    moveCaretToEnd(editor);
    return;
  }
  range.deleteContents();
  range.insertNode(space);
  range.insertNode(token);
  range.setStartAfter(space);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertLineBreak(editor: HTMLDivElement) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const br = document.createElement("br");
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    editor.append(br);
    moveCaretToEnd(editor);
    return;
  }
  range.deleteContents();
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertPlainTextAtSelection(editor: HTMLDivElement, text: string) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const fragment = document.createDocumentFragment();
  const parts = text.replace(/\r\n?/g, "\n").split("\n");
  parts.forEach((part, index) => {
    if (part) fragment.append(document.createTextNode(part));
    if (index < parts.length - 1) fragment.append(document.createElement("br"));
  });
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    editor.append(fragment);
    moveCaretToEnd(editor);
    return;
  }
  range.deleteContents();
  range.insertNode(fragment);
  moveCaretToEnd(editor);
}

function createImageToken(marker: string, name: string, removable = false) {
  const token = document.createElement("span");
  token.className = "inline-image-token";
  token.contentEditable = "false";
  token.dataset.marker = marker;
  token.innerHTML = `<span class="inline-image-token-name">▧ ${escapeHtml(name)}</span>${removable ? `<button type="button" class="inline-image-token-remove" data-remove-marker="${escapeHtml(marker)}">×</button>` : ""}`;
  return token;
}

function createMentionToken(item: MentionItem) {
  const token = document.createElement("span");
  token.className = "inline-mention-token";
  token.contentEditable = "false";
  token.dataset.marker = item.marker;
  token.dataset.mentionMarker = item.marker;
  token.textContent = item.label;
  return token;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function moveCaretToEnd(element: HTMLElement) {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function flattenFiles(nodes: Array<{ type: "file" | "directory"; path: string; children?: unknown[] }>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") out.push(node.path);
    if (node.type === "directory" && Array.isArray(node.children)) {
      out.push(...flattenFiles(node.children as Array<{ type: "file" | "directory"; path: string; children?: unknown[] }>));
    }
  }
  return out;
}

function isMentionCandidatePath(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const blockedSegments = [
    "/.git/",
    "/node_modules/",
    "/.next/",
    "/.next-v2/",
    "/.next-v2-dev/",
    "/dist/",
    "/build/",
    "/.tmp-",
    "/tmp/",
  ];
  if (normalized.startsWith(".tmp-")) return false;
  if (blockedSegments.some((segment) => normalized.includes(segment))) return false;
  if (/\.(db|db-shm|db-wal|log|tmp)$/i.test(normalized)) return false;
  return true;
}

function filteredMentionOptions(items: MentionItem[], query: string) {
  if (!query) return items;
  return items
    .filter((item) => `${item.label} ${item.value} ${item.kind} ${item.source ?? ""}`.toLowerCase().includes(query));
}

function renderSuggestionGroups(
  items: MentionItem[],
  activeIndex: number,
  onPick: (item: MentionItem) => void,
  slashMode = false,
) {
  let offset = 0;
  const groups = suggestionGroups(slashMode);
  return groups.map((group) => {
    const groupItems = items.filter((item) => group.match(item)).slice(0, group.limit);
    if (!groupItems.length) return null;
    const start = offset;
    offset += groupItems.length;
    return (
      <div key={group.title} className="mention-group">
        <div className="mention-menu-label">{group.title}</div>
        {groupItems.map((item, index) => {
          const absoluteIndex = start + index;
          return (
            <button
              key={item.marker}
              type="button"
              data-suggestion-index={absoluteIndex}
              className={`mention-option${absoluteIndex === activeIndex ? " active" : ""}`}
              onClick={() => onPick(item)}
            >
              <span className="mention-option-icon">{iconForSuggestion(item)}</span>
              <span className="mention-option-main">
                <span className="mention-option-title">{slashMode && item.kind === "command" ? "/" : ""}{item.label}</span>
                <span className="mention-option-desc">{item.value}</span>
              </span>
              <span className={`mention-option-source ${item.kind}`}>{sourceLabelForSuggestion(item)}</span>
            </button>
          );
        })}
      </div>
    );
  });
}

function orderedSuggestionItems(items: MentionItem[], slashMode: boolean) {
  const groups = suggestionGroups(slashMode);
  return groups.flatMap((group) => items.filter((item) => group.match(item)).slice(0, group.limit));
}

function suggestionGroups(slashMode: boolean) {
  return slashMode
      ? [
        { title: "Commands", limit: 8, match: (item: MentionItem) => item.kind === "command" },
        { title: "Built-in Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "builtin" },
        { title: "Custom Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "custom" },
        { title: "Workspace Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "workspace" },
        { title: "Files", limit: 8, match: (item: MentionItem) => item.kind === "file" },
      ]
    : [
        { title: "Files", limit: 8, match: (item: MentionItem) => item.kind === "file" },
        { title: "Built-in Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "builtin" },
        { title: "Custom Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "custom" },
        { title: "Workspace Skills", limit: 8, match: (item: MentionItem) => item.kind === "skill" && item.source === "workspace" },
        { title: "Features", limit: 8, match: (item: MentionItem) => item.kind === "feature" },
      ];
}

function iconForSuggestion(item: MentionItem) {
  if (item.kind === "file") return "#";
  if (item.kind === "skill") return "*";
  if (item.kind === "feature") return "@";
  if (item.commandId === "compact") return "c";
  if (item.commandId === "status") return "i";
  if (item.commandId === "plan_mode") return "p";
  if (item.commandId === "memories") return "m";
  return "/";
}

function sourceLabelForSuggestion(item: MentionItem) {
  if (item.kind === "file") return "File";
  if (item.kind === "feature") return "FCode";
  if (item.kind === "command") return "Action";
  if (item.source === "builtin") return "Built-in";
  if (item.source === "custom") return "Custom";
  return "Workspace";
}

function readTextBeforeCaret(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.anchorNode ?? editor, selection.anchorOffset);
  return range.toString().replace(/\s+$/g, "");
}

function replaceTriggerQueryWithMention(editor: HTMLElement, item: MentionItem, query: string, trigger: "@" | "/") {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const token = createMentionToken(item);
  const backtrack = document.createTextNode("");
  const textNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer as Text : null;
  if (textNode) {
    const text = textNode.textContent ?? "";
    const suffix = `${trigger}${query}`;
    const index = text.lastIndexOf(suffix, range.startOffset);
    if (index >= 0) {
      textNode.textContent = `${text.slice(0, index)}${text.slice(range.startOffset)}`;
      const r = document.createRange();
      r.setStart(textNode, index);
      r.collapse(true);
      r.insertNode(backtrack);
      backtrack.replaceWith(token, document.createTextNode(" "));
      placeCaretAfter(token);
      return;
    }
  }
  range.insertNode(token);
  range.insertNode(document.createTextNode(" "));
  placeCaretAfter(token);
}

function placeCaretAfter(node: Node) {
  const range = document.createRange();
  range.setStartAfter(node.nextSibling ?? node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function defaultMentionOptions(): MentionItem[] {
  return [
    { marker: "[mention:feature:browser-search]", label: "browser-search", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:web-search]", label: "web-search", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:file-search]", label: "file-search", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:workspace]", label: "workspace", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:git-diff]", label: "git-diff", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:terminal]", label: "terminal", value: "FCode feature", kind: "feature", source: "feature" },
    { marker: "[mention:feature:mcp-tools]", label: "mcp-tools", value: "FCode feature", kind: "feature", source: "feature" },
  ];
}

function defaultCommandOptions(): MentionItem[] {
  return [
    { marker: "[mention:command:compact]", label: "compact", value: "Compact thread context now", kind: "command", source: "command", commandId: "compact" },
    { marker: "[mention:command:memories]", label: "memories", value: "Open memories panel", kind: "command", source: "command", commandId: "memories" },
    { marker: "[mention:command:personality]", label: "personality", value: "Open personality panel", kind: "command", source: "command", commandId: "personality" },
    { marker: "[mention:command:plan-mode]", label: "plan mode", value: "Toggle plan mode", kind: "command", source: "command", commandId: "plan_mode" },
    { marker: "[mention:command:status]", label: "status", value: "Show session status", kind: "command", source: "command", commandId: "status" },
  ];
}

function defaultBuiltinSkillCommands(): MentionItem[] {
  return [
    { marker: "[mention:skill:.fencode/system/imagegen]", label: "Imagegen", value: "Generate or edit bitmap images", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/openai-docs]", label: "OpenAI Docs", value: "Official OpenAI API documentation", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/plugin-creator]", label: "Plugin Creator", value: "Scaffold Codex plugins", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/skill-creator]", label: "Skill Creator", value: "Create or update local skills", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/skill-installer]", label: "Skill Installer", value: "Install curated or GitHub skills", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/browser]", label: "Browser", value: "Test and inspect local web UI", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/chrome]", label: "Chrome", value: "Use user Chrome profile when needed", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/code-review]", label: "Code Review", value: "Review bugs, risks, and missing tests", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/remote-tests]", label: "Remote Tests", value: "Run test jobs through remote executor", kind: "skill", source: "builtin" },
    { marker: "[mention:skill:.fencode/system/babysit-pr]", label: "Babysit PR", value: "Watch PR checks and review feedback", kind: "skill", source: "builtin" },
  ];
}

function dedupeMentions(items: MentionItem[]) {
  const map = new Map<string, MentionItem>();
  for (const item of items) map.set(item.marker, item);
  return [...map.values()];
}

function skillNameFromPath(path: string) {
  const parts = path.split("/");
  const idx = parts.findIndex((part) => /^skills?$/i.test(part));
  const raw = idx >= 0 && parts[idx + 1]
    ? parts[idx + 1]
    : parts.at(-1)?.replace(/\.md$/i, "") ?? path;
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeSkillId(marker: string, value: string) {
  const markerMatch = marker.match(/\[mention:skill:([^\]]+)\]/i)?.[1];
  const candidate = markerMatch ?? value;
  return candidate
    .toLowerCase()
    .replace(/^\.f(?:code|encode)\//, "")
    .replace(/[\\/]+/g, "/");
}

async function readAttachment(file: File): Promise<ComposerAttachment> {
  const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (file.type.startsWith("image/")) {
    const dataUrl = await readFileAsDataUrl(file);
    const marker = `[image:${file.name}-${Math.random().toString(36).slice(2, 5)}]`;
    return {
      id,
      name: file.name,
      marker,
      kind: "image",
      previewUrl: URL.createObjectURL(file),
      dataUrl,
      size: file.size,
    };
  }
  if (file.type.startsWith("text/") || /\.(ts|tsx|js|jsx|json|md|rs|py|toml|yml|yaml|txt|css|html|sql)$/i.test(file.name)) {
    const textContent = await file.text();
    return {
      id,
      name: file.name,
      kind: "text",
      textContent,
      size: file.size,
    };
  }
  return {
    id,
    name: file.name,
    kind: "binary",
    size: file.size,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function MiniDropdown({
  label,
  icon,
  items,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  items: Array<{ value: string; label: string; detail?: string }>;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mini-dropdown">
      <button className="pill mini-trigger" type="button" onClick={() => setOpen((value) => !value)}>
        <span className="mini-icon">{icon}</span>
        <span>{label}</span>
        <ChevronDown className="mini-chevron" size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mini-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.value}
              className="mini-menu-item"
              type="button"
              onClick={() => {
                onSelect(item.value);
                setOpen(false);
              }}
            >
              <span>{item.label}</span>
              {item.detail ? <small>{item.detail}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
