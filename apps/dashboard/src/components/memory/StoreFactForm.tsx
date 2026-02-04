"use client";

import { useState, useCallback, type FormEvent } from "react";
import { Input } from "@/components/shared/Input";
import { Button } from "@/components/shared/Button";

interface StoreFactFormProps {
  onStore: (fact: {
    category: string;
    fact: string;
    tags?: string[];
    importance?: number;
  }) => Promise<void>;
}

export function StoreFactForm({ onStore }: StoreFactFormProps) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [fact, setFact] = useState("");
  const [tags, setTags] = useState("");
  const [importance, setImportance] = useState("0.5");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!category.trim() || !fact.trim()) return;
      setSaving(true);
      setMessage(null);
      try {
        await onStore({
          category: category.trim(),
          fact: fact.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          importance: Number(importance) || 0.5,
        });
        setMessage("Fact stored successfully");
        setFact("");
      } catch (err) {
        setMessage(
          `Error: ${err instanceof Error ? err.message : "Store failed"}`
        );
      } finally {
        setSaving(false);
      }
    },
    [category, fact, tags, importance, onStore]
  );

  return (
    <div className="os-panel">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-ctp-overlay1 hover:text-ctp-text transition-colors font-mono"
      >
        <span>+ Store new fact</span>
        <span className="text-ctp-overlay0">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <form onSubmit={handleSubmit} className="px-3 pb-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. user-preferences"
            />
            <Input
              label="Tags (comma-separated)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. prefs, ui"
            />
          </div>
          <Input
            label="Fact"
            value={fact}
            onChange={(e) => setFact(e.target.value)}
            placeholder="e.g. User prefers dark mode"
          />
          <div className="flex items-end gap-3">
            <div className="w-32">
              <Input
                label="Importance (0-1)"
                type="number"
                value={importance}
                onChange={(e) => setImportance(e.target.value)}
                min="0"
                max="1"
                step="0.1"
              />
            </div>
            <Button type="submit" disabled={saving || !fact.trim()}>
              {saving ? "Storing..." : "Store"}
            </Button>
          </div>
          {message && (
            <div
              className={`text-xs font-mono ${message.startsWith("Error") ? "text-ctp-red" : "text-ctp-green"}`}
            >
              {message}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
