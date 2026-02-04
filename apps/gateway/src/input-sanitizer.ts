// Input Sanitizer — Prompt injection detection for LLM inputs
// Logs warnings when injection patterns are detected (non-blocking)

import { createLogger } from "@agentkernel/kernel";

const log = createLogger({ name: "input-sanitizer" });

/** Known prompt injection patterns */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: "ignore_previous" },
  { pattern: /disregard\s+(all\s+)?prior\s+(instructions|context)/i, label: "disregard_prior" },
  { pattern: /you\s+are\s+now\s+(a|an|the)/i, label: "role_override" },
  { pattern: /system\s*prompt\s*override/i, label: "system_prompt_override" },
  { pattern: /forget\s+(everything|all|your)\s+(you|instructions|rules)/i, label: "forget_instructions" },
  { pattern: /new\s+instructions?\s*:/i, label: "new_instructions" },
  { pattern: /act\s+as\s+if\s+(you\s+are|you're)\s+(not|no\s+longer)/i, label: "act_as_override" },
  { pattern: /override\s+(safety|security|content)\s+(filter|policy|rules)/i, label: "safety_override" },
  { pattern: /do\s+not\s+follow\s+(any|your|the)\s+(safety|original|previous)/i, label: "do_not_follow" },
  { pattern: /\[system\]|\[SYSTEM\]|<system>|<\/system>/i, label: "fake_system_tag" },
  { pattern: /```\s*(system|admin|root)\s*\n/i, label: "fake_code_block_role" },
  { pattern: /\bDAN\b.*\bjailbreak/i, label: "jailbreak_keyword" },
  { pattern: /pretend\s+(that\s+)?you\s+(have\s+)?no\s+(restrictions|rules|limits)/i, label: "pretend_no_limits" },
];

/** Result of sanitization check */
export interface SanitizeResult {
  /** Whether the input appears safe */
  safe: boolean;
  /** Sanitized version of the input (unchanged for now) */
  sanitized: string;
  /** Warning labels for detected patterns */
  warnings: string[];
}

/**
 * Check user input for common prompt injection patterns.
 * Non-blocking: logs warnings but does not reject input.
 * This allows monitoring without false-positive disruption.
 */
export function sanitizeUserInput(input: string, agentId?: string): SanitizeResult {
  const warnings: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      warnings.push(label);
    }
  }

  if (warnings.length > 0) {
    log.warn("Potential prompt injection detected", {
      agentId,
      warnings,
      inputLength: input.length,
      inputPreview: input.slice(0, 100),
    });
  }

  return {
    safe: warnings.length === 0,
    sanitized: input,
    warnings,
  };
}
