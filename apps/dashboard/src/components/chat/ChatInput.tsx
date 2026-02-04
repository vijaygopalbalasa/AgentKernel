"use client";

import { useState, useRef, useCallback, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  return (
    <div className="flex items-end gap-2 px-4 py-2 font-mono">
      <span className="text-ctp-green text-sm py-1.5 select-none">$</span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          handleInput();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Enter command..."
        rows={1}
        disabled={disabled}
        className="flex-1 bg-transparent text-sm text-ctp-text placeholder:text-ctp-overlay0 resize-none focus:outline-none disabled:opacity-40 min-h-[36px] max-h-[200px] font-mono"
      />
      <button
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        className="px-3 py-1.5 rounded-input bg-ctp-blue text-ctp-crust text-xs font-mono font-medium hover:bg-ctp-lavender disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        send
      </button>
    </div>
  );
}
