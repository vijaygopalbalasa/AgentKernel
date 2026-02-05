#!/usr/bin/env node

/**
 * Generates an asciinema v2 cast file from the demo output.
 * This gives us precise control over timing for a polished recording.
 *
 * Usage: node scripts/generate-demo-cast.mjs > docs/demo.cast
 */

import { execFileSync } from "node:child_process";

// Get raw demo output using execFileSync (safe, no shell injection)
const raw = execFileSync("node", ["scripts/demo.mjs", "--fast"], {
  encoding: "utf-8",
  cwd: import.meta.dirname + "/..",
});

const lines = raw.split("\n");

// Asciinema v2 header
const header = {
  version: 2,
  width: 80,
  height: 45,
  timestamp: Math.floor(Date.now() / 1000),
  env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
  title: "AgentKernel Security Demo",
};

const events = [];
let t = 0.0;

function addOutput(text, delayAfter = 0.05) {
  events.push([t, "o", text + "\r\n"]);
  t += delayAfter;
}

// Classify lines for timing
for (const line of lines) {
  if (line === "") {
    addOutput("", 0.1);
  } else if (line.includes("\u250C\u2500") || line.includes("\u2514\u2500") || line.includes("\u2502")) {
    // Banner lines - fast sequence
    addOutput(line, 0.08);
  } else if (line.includes("$ ")) {
    // Typed commands - character by character
    const prefix = line.match(/^(\s*)/)[1];
    const cmd = line.trimStart();
    events.push([t, "o", prefix]);
    t += 0.05;
    for (const ch of cmd) {
      events.push([t, "o", ch]);
      t += 0.035;
    }
    events.push([t, "o", "\r\n"]);
    t += 0.6;
  } else if (line.includes("\u2500\u2500\u2500\u2500\u2500")) {
    // Phase headers - pause before
    t += 0.3;
    addOutput(line, 0.5);
  } else if (line.includes("Agent calls")) {
    // Agent action - build up
    addOutput(line, 0.3);
  } else if (line.includes("\u2717 BLOCKED")) {
    // Blocked - dramatic pause then show
    t += 0.15;
    addOutput(line, 0.6);
  } else if (line.includes("\u2713 ALLOWED")) {
    // Allowed - quick
    t += 0.1;
    addOutput(line, 0.4);
  } else if (line.includes("RESULTS") || line.includes("PROTECTED AGAINST")) {
    t += 0.3;
    addOutput(line, 0.4);
  } else if (line.includes("attacks blocked")) {
    t += 0.2;
    addOutput(line, 0.8);
  } else if (line.includes("npm install")) {
    t += 0.3;
    addOutput(line, 1.0);
  } else {
    addOutput(line, 0.15);
  }
}

// Final pause
t += 2.0;

// Output
process.stdout.write(JSON.stringify(header) + "\n");
for (const event of events) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
