"use client";

import { ChevronDown, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import type { SkillConfig } from "@/lib/db";

export default function SettingsSkillsPage() {
  const [skills, setSkills] = useState<SkillConfig[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  async function load() {
    const data = await fetch("/api/settings/skills").then((response) => response.json());
    setSkills(data.data ?? []);
  }

  useEffect(() => { void load(); }, []);

  async function add() {
    if (!name.trim() || !description.trim() || !instructions.trim()) return;
    await fetch("/api/settings/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, trigger, description, instructions, enabled: true }),
    });
    setName("");
    setTrigger("");
    setDescription("");
    setInstructions("");
    await load();
  }

  return (
    <SettingsLayout title="Skills">
      <div className="skills-settings">
        <div className="skills-hero">
          <div>
            <h2>Custom skills</h2>
            <p>Skills appear in composer suggestions for both <b>/</b> commands and <b>@</b> mentions.</p>
          </div>
          <span className="skills-count">{skills.length} custom</span>
        </div>

        <div className="skills-form">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
            <label className="config-field">
              <span>Skill name</span>
              <input className="config-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: API Auditor" />
            </label>
            <label className="config-field">
              <span>Trigger</span>
              <input className="config-input" value={trigger} onChange={(event) => setTrigger(event.target.value)} placeholder="api-auditor" />
            </label>
          </div>
          <label className="config-field mt-3">
            <span>Description</span>
            <input className="config-input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Shown in / and @ suggestion panel" />
          </label>
          <label className="config-field mt-3">
            <span>Instructions</span>
            <textarea className="skills-textarea" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Tell FCode how to behave when this skill is selected..." />
          </label>
          <button className="primary-button mt-3" onClick={() => void add()}>Add skill</button>
        </div>

        <div className="skills-list">
          {skills.length ? skills.map((skill) => (
            <div key={skill.id} className="skills-card">
              <div className="skills-card-icon"><Sparkles size={16} /></div>
              <div className="skills-card-main">
                <div className="skills-card-head">
                  <div>
                    <strong>{skill.name}</strong>
                    <span>/{skill.trigger}</span>
                  </div>
                  <div className="skills-card-actions">
                    <button
                      className={`skills-expand${expanded[skill.id] ? " open" : ""}`}
                      aria-label={`Toggle ${skill.name}`}
                      onClick={() => setExpanded((current) => ({ ...current, [skill.id]: !current[skill.id] }))}
                    >
                      <ChevronDown size={15} />
                    </button>
                    <button
                      className="skills-delete"
                      aria-label={`Delete ${skill.name}`}
                      onClick={async () => {
                        await fetch(`/api/settings/skills/${skill.id}`, { method: "DELETE" });
                        await load();
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <p>{skill.description}</p>
                {expanded[skill.id] ? (
                  <div className="skills-markdown">
                    <MarkdownMessage text={skill.instructions} />
                  </div>
                ) : null}
              </div>
            </div>
          )) : (
            <div className="skills-empty">No custom skills yet. Built-in and workspace skills still appear automatically.</div>
          )}
        </div>
      </div>
    </SettingsLayout>
  );
}
