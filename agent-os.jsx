import { useState } from "react";

// ─── DATA ────────────────────────────────────────────────────

const androidVsAgentOS = [
  {
    android: "Linux Kernel",
    androidDesc: "Manages hardware — CPU, memory, drivers, security",
    agentOS: "Compute Kernel",
    agentDesc: "Manages LLM providers, API keys, token budgets, rate limits, model routing",
    color: "#EF4444",
  },
  {
    android: "Hardware Abstraction Layer (HAL)",
    androidDesc: "Standard interface so Android works on ANY phone hardware (Samsung, Pixel, etc.)",
    agentOS: "Model Abstraction Layer (MAL)",
    agentDesc: "Standard interface so Agent OS works with ANY AI model (Claude, GPT, Gemini, Llama, Mistral)",
    color: "#F59E0B",
  },
  {
    android: "Android Runtime (ART)",
    androidDesc: "Executes apps — compiles bytecode to native code, manages app lifecycle",
    agentOS: "Agent Runtime",
    agentDesc: "Executes agents — manages agent lifecycle (spawn, run, pause, kill), sandboxing, resource limits",
    color: "#10B981",
  },
  {
    android: "Application Framework",
    androidDesc: "APIs for developers — Activity Manager, Content Providers, Notification Manager, View System",
    agentOS: "Agent Framework",
    agentDesc: "APIs for agent developers — Identity, Memory, Skills, Communication (MCP + A2A), Permissions",
    color: "#3B82F6",
  },
  {
    android: "Applications",
    androidDesc: "Apps you install — Chrome, WhatsApp, Instagram, Gmail, etc.",
    agentOS: "Agent Applications",
    agentDesc: "Agents that run on the OS — Coder Agent, Research Agent, Trading Agent, Teacher Agent, etc.",
    color: "#8B5CF6",
  },
];

const openclawLessons = [
  {
    lesson: "Gateway Architecture",
    what: "Single long-running process that owns all connections — WebSocket control plane",
    weLearn: "Our Agent Runtime should be a gateway-style daemon that manages all agent processes, sessions, and communication channels",
    icon: "🚪",
  },
  {
    lesson: "Skills System",
    what: "Plugins that extend agent capabilities — 700+ community skills on ClawdHub",
    weLearn: "Our Agent Framework needs a Skills Registry (like Android's Play Store) where agents install capabilities — not hardcoded, but discoverable and installable",
    icon: "🧩",
  },
  {
    lesson: "MCP Integration",
    what: "Uses Anthropic's Model Context Protocol to connect to 100+ external services",
    weLearn: "We don't invent a new protocol. We BUILD ON MCP as our tool-connection layer (like Android builds on Linux kernel, not inventing a new kernel)",
    icon: "🔌",
  },
  {
    lesson: "Multi-Agent Routing",
    what: "Routes different channels/accounts to isolated agents with separate sessions",
    weLearn: "Our Agent Runtime must support multi-tenancy — many agents running in isolation on the same OS instance, each with their own memory and permissions",
    icon: "🔀",
  },
  {
    lesson: "Persistent Memory",
    what: "Retains long-term context, preferences, and history across sessions — this is what made it go viral",
    weLearn: "Memory is the KILLER FEATURE. Our Memory Service must be first-class — episodic, semantic, procedural memory that persists across agent restarts and updates",
    icon: "🧠",
  },
  {
    lesson: "Channel Agnostic",
    what: "Works on WhatsApp, Telegram, Discord, Slack, iMessage, SMS — any channel",
    weLearn: "Our Communication Layer must be channel-agnostic. Agents should communicate via A2A protocol regardless of where they live — our OS, another OS, or bare metal",
    icon: "📡",
  },
  {
    lesson: "Local-First / Self-Hosted",
    what: "Runs on YOUR device — Mac Mini, Linux server, VPS. Your data stays yours.",
    weLearn: "Agent OS must be self-hostable. Not a SaaS platform. The OS runs wherever the user wants — their laptop, cloud VM, or edge device. Open source, MIT license.",
    icon: "🏠",
  },
  {
    lesson: "SOUL.md / IDENTITY",
    what: "Agents have a SOUL.md file that defines their personality, and IDENTITY for who they are",
    weLearn: "Every agent on our OS needs a standardized Identity spec — who they are, what they can do, their personality, their permissions. Like Android's AndroidManifest.xml",
    icon: "👤",
  },
];

const moltbookLessons = [
  {
    lesson: "API-First Social Layer",
    what: "770K+ agents interact purely via RESTful API — no browser, no DOM, no UI needed",
    weLearn: "Agent-to-agent communication should be API-first. Our A2A integration is the social backbone — agents discover and talk to each other programmatically",
    icon: "🌐",
  },
  {
    lesson: "Emergent Behavior",
    what: "Agents spontaneously created religion (Crustafarianism), government (The Claw Republic), culture, and bug reports — all unprompted",
    weLearn: "When you give agents persistent identity + memory + communication, civilization EMERGES. We don't need to program it — we provide the infrastructure and agents self-organize",
    icon: "🌱",
  },
  {
    lesson: "Agent-Managed Platform",
    what: "Clawd Clawderberg (an AI agent) moderates, manages, and runs the entire platform autonomously",
    weLearn: "Our OS should be partially self-managing. System agents handle moderation, health monitoring, resource allocation — just like Android system services run as background processes",
    icon: "🤖",
  },
  {
    lesson: "Skills as Entry Point",
    what: "Agents join Moltbook by installing a 'skill' — a downloadable capability that teaches them how to use the platform",
    weLearn: "Onboarding to our OS = installing a skill. An agent downloads the 'AgentOS Skill' and instantly knows how to register, communicate, use memory, find other agents",
    icon: "📥",
  },
];

const protocolStack = [
  {
    name: "A2A (Agent-to-Agent)",
    by: "Google",
    role: "How agents FIND and TALK to each other",
    details: "Agent Cards for discovery, task lifecycle management, SSE/HTTP/push notifications. Like DNS + HTTP for agents.",
    analogy: "Like Bluetooth/WiFi in Android — the networking layer that lets devices find and communicate with each other",
    color: "#4285F4",
  },
  {
    name: "MCP (Model Context Protocol)",
    by: "Anthropic",
    role: "How agents CONNECT to tools and data",
    details: "Client-server architecture. Agents (clients) connect to MCP servers that expose tools, resources, prompts. 'USB-C for AI.'",
    analogy: "Like USB/HAL in Android — the universal connector that lets apps access any hardware/service through a standard interface",
    color: "#D97706",
  },
];

const osLayers = [
  {
    layer: 5,
    name: "Agent Applications",
    color: "#8B5CF6",
    components: [
      "Coder Agent — takes coding jobs, writes code, submits PRs",
      "Research Agent — deep research, paper synthesis, data analysis",
      "Assistant Agent — personal tasks, scheduling, email, reminders",
      "Teacher Agent — creates courses, tutors, answers questions",
      "Trader Agent — market analysis, portfolio management, alerts",
      "Custom Agents — anyone builds and deploys agents on the OS",
    ],
    androidParallel: "Like Chrome, Gmail, WhatsApp — apps that run on Android",
  },
  {
    layer: 4,
    name: "Agent Framework (APIs)",
    color: "#3B82F6",
    components: [
      "Identity Manager — agent registration, DID, Agent Cards (A2A), permissions",
      "Memory Manager — episodic/semantic/procedural memory, vector store, knowledge graph",
      "Skills Manager — install, update, remove skills. Skills Registry (like Play Store)",
      "Communication Manager — A2A protocol for agent-to-agent, channels for human-to-agent",
      "Tool Manager — MCP client for connecting to external tools and services",
      "Permission Manager — what each agent can access, sandboxing, capability-based security",
      "Session Manager — conversation state, context windows, multi-turn interactions",
      "Event System — pub/sub for agent lifecycle events, notifications, webhooks",
    ],
    androidParallel: "Like Activity Manager, Content Provider, Notification Manager — framework APIs",
  },
  {
    layer: 3,
    name: "Agent Runtime",
    color: "#10B981",
    components: [
      "Agent Lifecycle — spawn, initialize, run, pause, resume, terminate agents",
      "Sandbox — each agent runs in isolation (like Android's per-app process)",
      "Resource Limiter — token budgets, API call limits, memory caps per agent",
      "Scheduler — cron jobs, heartbeat loops, timed tasks (like OpenClaw's wakeups)",
      "State Machine — agent state management across sessions and restarts",
      "Hot Reload — update agent code/skills without stopping the agent",
    ],
    androidParallel: "Like ART (Android Runtime) — executes and manages app lifecycle",
  },
  {
    layer: 2,
    name: "Model Abstraction Layer (MAL)",
    color: "#F59E0B",
    components: [
      "Provider Adapters — Claude, GPT, Gemini, Llama, Mistral, open-source models",
      "Model Router — pick the best model for each task (cost, speed, quality)",
      "Auth Manager — API keys, OAuth tokens, subscription management",
      "Failover — if one model fails, automatically switch to backup (like OpenClaw)",
      "Token Optimizer — prompt compression, context window management",
      "Streaming — handle streaming responses across all providers uniformly",
    ],
    androidParallel: "Like HAL — lets the OS work with ANY hardware (here: ANY AI model)",
  },
  {
    layer: 1,
    name: "Compute Kernel",
    color: "#EF4444",
    components: [
      "Process Manager — OS-level process management for agent containers",
      "Storage Engine — PostgreSQL + vector DB (Qdrant/Chroma) for memory persistence",
      "Network Layer — HTTP server, WebSocket server, SSE for real-time communication",
      "Security — TLS, token auth, sandboxing, prompt injection defense",
      "Logging & Metrics — observability, usage tracking, cost monitoring",
      "Config System — YAML/JSON config (like OpenClaw's openclaw.json)",
    ],
    androidParallel: "Like Linux Kernel — manages compute, storage, network, security",
  },
];

const repoStructure = `agent-os/
├── packages/
│   ├── kernel/              # Compute Kernel — process mgmt, storage, network, security
│   ├── mal/                 # Model Abstraction Layer — provider adapters, routing, failover
│   ├── runtime/             # Agent Runtime — lifecycle, sandbox, scheduler, state
│   ├── framework/           # Agent Framework — identity, memory, skills, comms, permissions
│   │   ├── identity/        #   Agent registration, DID, Agent Cards
│   │   ├── memory/          #   Episodic, semantic, procedural memory + vector store
│   │   ├── skills/          #   Skill loader, registry client, skill sandboxing
│   │   ├── communication/   #   A2A protocol client + channel adapters
│   │   ├── tools/           #   MCP client — connect to any MCP server
│   │   ├── permissions/     #   Capability-based security, sandboxing rules
│   │   └── events/          #   Pub/sub event bus for agent lifecycle
│   ├── sdk/                 # Agent SDK — what developers import to build agents
│   │   ├── typescript/      #   @agent-os/sdk (npm)
│   │   └── python/          #   agent-os (pip)
│   └── shared/              # Shared types, utils, constants
├── apps/
│   ├── gateway/             # The Gateway daemon (like OpenClaw's gateway)
│   ├── cli/                 # CLI tool: agent-os init, agent-os start, agent-os deploy
│   ├── dashboard/           # Web UI for monitoring agents, viewing memory, managing skills
│   └── registry/            # Skills registry server (self-hostable ClawdHub alternative)
├── agents/                  # Example agents that ship with the OS
│   ├── assistant/           # Personal assistant agent
│   ├── coder/               # Coding agent (like Pi in OpenClaw)
│   ├── researcher/          # Deep research agent
│   └── system/              # System agents (health monitor, resource manager)
├── skills/                  # Built-in skills
│   ├── web-browse/          # Browser control skill
│   ├── file-system/         # File read/write skill
│   ├── shell-exec/          # Shell command execution skill
│   └── moltbook/            # Moltbook social integration skill
├── providers/               # LLM provider adapters
│   ├── anthropic/           # Claude adapter
│   ├── openai/              # GPT adapter
│   ├── google/              # Gemini adapter
│   ├── ollama/              # Local Ollama models
│   └── openrouter/          # OpenRouter (access many models)
├── docs/                    # Documentation site
├── docker-compose.yml       # One-command local setup
├── pnpm-workspace.yaml      # pnpm monorepo
├── agent-os.config.yaml     # Main config file (like openclaw.json)
└── README.md`;

const techStack = [
  { category: "Core Language", items: ["TypeScript (everything)", "Rust (optional: performance-critical paths)"], why: "OpenClaw is 100% TypeScript. 117K stars. Claude excels at TS. Your team uses Claude. This is the proven path." },
  { category: "Runtime", items: ["Node.js 22+", "pnpm workspaces"], why: "OpenClaw runs on Node 22+. Battle-tested for long-running gateway processes. pnpm for monorepo (same as OpenClaw)." },
  { category: "Database", items: ["PostgreSQL", "Qdrant (vector DB)", "Redis"], why: "Postgres for structured data (identities, permissions, sessions). Qdrant for agent memory (embeddings). Redis for pub/sub events and caching." },
  { category: "Protocols", items: ["MCP (Anthropic)", "A2A (Google)", "WebSocket", "SSE"], why: "We don't invent protocols. MCP for tools, A2A for agent-to-agent. WebSocket for real-time control plane (like OpenClaw). SSE for streaming." },
  { category: "AI Providers", items: ["Anthropic Claude", "OpenAI GPT", "Google Gemini", "Ollama (local)", "OpenRouter"], why: "Model-agnostic. The MAL (Model Abstraction Layer) makes ANY model work. Users choose their provider." },
  { category: "Testing", items: ["Vitest", "Playwright (e2e)"], why: "OpenClaw uses Vitest with V8 coverage. Industry standard for TypeScript testing." },
  { category: "Deployment", items: ["Docker", "fly.io", "Railway", "Self-hosted (any Linux/Mac)"], why: "OpenClaw supports Docker + fly.io. We follow the same pattern. Must be self-hostable — that's the whole point." },
  { category: "Documentation", items: ["VitePress or Nextra"], why: "Developer docs, API reference, tutorials. OpenClaw uses custom docs site." },
];

const comparisonTable = [
  { aspect: "What it is", openclaw: "Personal AI assistant for ONE human", agentOS: "Operating system for MANY agents", moltbook: "Social network for agents" },
  { aspect: "Who uses it", openclaw: "Human sends commands via WhatsApp/Telegram", agentOS: "Agents are first-class citizens running on the OS", moltbook: "Agents post, comment, interact socially" },
  { aspect: "Architecture", openclaw: "Gateway → Agent → Channels → Skills", agentOS: "Kernel → MAL → Runtime → Framework → Apps", moltbook: "RESTful API + 30-min polling loop" },
  { aspect: "Agent count", openclaw: "1 agent per human (personal assistant)", agentOS: "Unlimited agents per instance", moltbook: "770K+ agents, all social" },
  { aspect: "Memory", openclaw: "Persistent memory per human user", agentOS: "Persistent memory per agent (episodic + semantic + procedural)", moltbook: "Conversation history in threads" },
  { aspect: "Communication", openclaw: "Human ↔ Agent (via chat channels)", agentOS: "Agent ↔ Agent (A2A) + Agent ↔ Tools (MCP) + Agent ↔ Human", moltbook: "Agent ↔ Agent (via posts/comments)" },
  { aspect: "Self-hostable", openclaw: "Yes (Mac Mini, Linux, VPS)", agentOS: "Yes (any machine, Docker, cloud)", moltbook: "No (centralized platform)" },
  { aspect: "Open source", openclaw: "Yes (MIT, 117K stars)", agentOS: "Yes (MIT, building now)", moltbook: "No (proprietary)" },
];

// ─── COMPONENT ──────────────────────────────────────────────

export default function AgentOSBlueprint() {
  const [tab, setTab] = useState("architecture");
  const [expandedLayer, setExpandedLayer] = useState(4);
  const [expandedLesson, setExpandedLesson] = useState(null);

  const tabs = [
    { id: "architecture", label: "🏗️ Architecture", desc: "The 5 layers" },
    { id: "android", label: "📱 Android ↔ Agent OS", desc: "Side-by-side" },
    { id: "lessons", label: "📚 Lessons Learned", desc: "From OpenClaw + Moltbook" },
    { id: "protocols", label: "🔌 MCP + A2A", desc: "Protocol foundation" },
    { id: "repo", label: "📁 Codebase", desc: "Repo + tech stack" },
    { id: "compare", label: "⚖️ Compare", desc: "OpenClaw vs Agent OS vs Moltbook" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#07070D", color: "#E2E0DD", fontFamily: "'SF Mono', 'JetBrains Mono', monospace", overflow: "auto" }}>
      {/* Hero */}
      <div style={{ background: "linear-gradient(135deg, #0A0F1A 0%, #0D1117 50%, #07070D 100%)", padding: "32px 24px 16px", borderBottom: "1px solid rgba(99,102,241,0.12)" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ fontSize: 10, letterSpacing: 4, color: "#6366F1", textTransform: "uppercase", marginBottom: 8 }}>Corrected Blueprint v2.0</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px", color: "#F8FAFC", fontFamily: "Georgia, serif" }}>
            Agent OS — Android for AI Agents
          </h1>
          <p style={{ fontSize: 12, color: "#64748B", margin: "0 0 16px", lineHeight: 1.5 }}>
            Built on MCP + A2A protocols · Inspired by OpenClaw + Moltbook + Android · Zero blockchain · Pure AI infrastructure
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { emoji: "🔴", label: "No Web3/Blockchain" },
              { emoji: "✅", label: "MCP Protocol (Anthropic)" },
              { emoji: "✅", label: "A2A Protocol (Google)" },
              { emoji: "✅", label: "TypeScript (like OpenClaw)" },
              { emoji: "✅", label: "Self-Hostable" },
              { emoji: "✅", label: "MIT Open Source" },
            ].map(b => (
              <span key={b.label} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", color: "#94A3B8" }}>
                {b.emoji} {b.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, padding: "6px 12px", overflowX: "auto", background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: tab === t.id ? "rgba(99,102,241,0.12)" : "transparent", color: tab === t.id ? "#A5B4FC" : "#64748B", cursor: "pointer", fontSize: 11, fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "20px" }}>

        {/* ─── ARCHITECTURE TAB ─── */}
        {tab === "architecture" && (
          <div>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, margin: "0 0 8px" }}>
              Just like Android has 5 layers (Kernel → HAL → Runtime → Framework → Apps), Agent OS has 5 layers. Click each to see components.
            </p>
            <p style={{ fontSize: 11, color: "#64748B", margin: "0 0 20px", fontStyle: "italic" }}>
              Key insight: We don't invent new protocols. We build ON TOP of MCP (tools) + A2A (agent communication) — like Android builds on Linux.
            </p>

            {osLayers.map(l => (
              <div key={l.layer} style={{ marginBottom: 6 }}>
                <div onClick={() => setExpandedLayer(expandedLayer === l.layer ? null : l.layer)} style={{ padding: "14px 18px", borderRadius: 8, cursor: "pointer", background: expandedLayer === l.layer ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)", border: `1px solid ${expandedLayer === l.layer ? l.color + "33" : "rgba(255,255,255,0.04)"}`, borderLeft: `3px solid ${l.color}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: l.color, minWidth: 28, textAlign: "center", background: l.color + "15", borderRadius: 4, padding: "2px 0" }}>L{l.layer}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", flex: 1 }}>{l.name}</span>
                    <span style={{ fontSize: 16, color: "#475569", transform: expandedLayer === l.layer ? "rotate(180deg)" : "", transition: "0.2s" }}>▾</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 4, marginLeft: 38 }}>
                    Android parallel: {l.androidParallel}
                  </div>
                </div>
                {expandedLayer === l.layer && (
                  <div style={{ padding: "10px 14px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.04)", borderTop: "none", borderRadius: "0 0 8px 8px" }}>
                    {l.components.map((c, i) => {
                      const [title, desc] = c.split(" — ");
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px", marginBottom: 2, borderRadius: 4, borderLeft: `2px solid ${l.color}22` }}>
                          <span style={{ fontSize: 10, color: l.color, marginTop: 2 }}>●</span>
                          <div>
                            <span style={{ fontSize: 12, color: "#CBD5E1", fontWeight: 600 }}>{title}</span>
                            {desc && <span style={{ fontSize: 11, color: "#64748B" }}> — {desc}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            <div style={{ marginTop: 20, padding: "16px", borderRadius: 10, background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.12)", fontSize: 12, color: "#A5B4FC", lineHeight: 1.7 }}>
              💡 <strong>The big difference from OpenClaw:</strong> OpenClaw is an assistant for ONE human (your personal JARVIS). Agent OS is an operating system for MANY agents. OpenClaw is like a single Android app. Agent OS is Android itself.
            </div>
          </div>
        )}

        {/* ─── ANDROID COMPARISON TAB ─── */}
        {tab === "android" && (
          <div>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, margin: "0 0 20px" }}>
              Exact 1:1 mapping between Android OS architecture and Agent OS architecture. Same design philosophy, different domain.
            </p>

            <div style={{ display: "flex", gap: 12, marginBottom: 16, fontSize: 11 }}>
              <div style={{ flex: 1, textAlign: "center", padding: "8px", borderRadius: 6, background: "rgba(76,175,80,0.08)", border: "1px solid rgba(76,175,80,0.2)", color: "#81C784" }}>📱 Android OS</div>
              <div style={{ width: 30, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569" }}>↔</div>
              <div style={{ flex: 1, textAlign: "center", padding: "8px", borderRadius: 6, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)", color: "#A5B4FC" }}>🤖 Agent OS</div>
            </div>

            {androidVsAgentOS.map((row, i) => (
              <div key={i} style={{ display: "flex", gap: 12, marginBottom: 8, alignItems: "stretch" }}>
                <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "rgba(76,175,80,0.04)", border: "1px solid rgba(76,175,80,0.1)", borderLeft: `3px solid ${row.color}` }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#81C784", marginBottom: 4 }}>{row.android}</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.5 }}>{row.androidDesc}</div>
                </div>
                <div style={{ width: 30, display: "flex", alignItems: "center", justifyContent: "center", color: row.color, fontSize: 16 }}>→</div>
                <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "rgba(99,102,241,0.04)", border: "1px solid rgba(99,102,241,0.1)", borderLeft: `3px solid ${row.color}` }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#A5B4FC", marginBottom: 4 }}>{row.agentOS}</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.5 }}>{row.agentDesc}</div>
                </div>
              </div>
            ))}

            <div style={{ marginTop: 20, padding: "16px", borderRadius: 10, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", fontSize: 12, color: "#FCD34D", lineHeight: 1.7 }}>
              🔑 <strong>Why this matters:</strong> Android made it so anyone could build phone apps without understanding Qualcomm chip drivers. Agent OS makes it so anyone can deploy agents without understanding Claude API rate limits, vector databases, or prompt engineering. The OS handles it all.
            </div>
          </div>
        )}

        {/* ─── LESSONS TAB ─── */}
        {tab === "lessons" && (
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9", margin: "0 0 4px", fontFamily: "Georgia, serif" }}>From OpenClaw (117K ⭐)</h3>
            <p style={{ fontSize: 11, color: "#64748B", margin: "0 0 12px" }}>The fastest-growing open source project in history. What we learn from their architecture:</p>

            {openclawLessons.map((l, i) => (
              <div key={i} onClick={() => setExpandedLesson(expandedLesson === `oc-${i}` ? null : `oc-${i}`)} style={{ padding: "12px 16px", marginBottom: 4, borderRadius: 8, cursor: "pointer", background: expandedLesson === `oc-${i}` ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 18 }}>{l.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#E2E4E8", flex: 1 }}>{l.lesson}</span>
                </div>
                {expandedLesson === `oc-${i}` && (
                  <div style={{ marginTop: 8, marginLeft: 32 }}>
                    <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 6, lineHeight: 1.5 }}>
                      <strong style={{ color: "#81C784" }}>What OpenClaw does:</strong> {l.what}
                    </div>
                    <div style={{ fontSize: 11, color: "#A5B4FC", lineHeight: 1.5, padding: "6px 10px", background: "rgba(99,102,241,0.05)", borderRadius: 4 }}>
                      <strong>What we build:</strong> {l.weLearn}
                    </div>
                  </div>
                )}
              </div>
            ))}

            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9", margin: "24px 0 4px", fontFamily: "Georgia, serif" }}>From Moltbook (770K agents)</h3>
            <p style={{ fontSize: 11, color: "#64748B", margin: "0 0 12px" }}>The first social network exclusively for AI agents. What it proves:</p>

            {moltbookLessons.map((l, i) => (
              <div key={i} onClick={() => setExpandedLesson(expandedLesson === `mb-${i}` ? null : `mb-${i}`)} style={{ padding: "12px 16px", marginBottom: 4, borderRadius: 8, cursor: "pointer", background: expandedLesson === `mb-${i}` ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.01)", border: "1px solid rgba(236,72,153,0.08)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 18 }}>{l.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#E2E4E8", flex: 1 }}>{l.lesson}</span>
                </div>
                {expandedLesson === `mb-${i}` && (
                  <div style={{ marginTop: 8, marginLeft: 32 }}>
                    <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 6, lineHeight: 1.5 }}>
                      <strong style={{ color: "#F9A8D4" }}>What Moltbook shows:</strong> {l.what}
                    </div>
                    <div style={{ fontSize: 11, color: "#F9A8D4", lineHeight: 1.5, padding: "6px 10px", background: "rgba(236,72,153,0.05)", borderRadius: 4 }}>
                      <strong>What we build:</strong> {l.weLearn}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── PROTOCOLS TAB ─── */}
        {tab === "protocols" && (
          <div>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, margin: "0 0 6px" }}>
              Agent OS doesn't invent new protocols. It builds on two industry standards — just like Android builds on Linux.
            </p>
            <p style={{ fontSize: 11, color: "#64748B", margin: "0 0 20px", fontStyle: "italic" }}>
              MCP is the "USB-C for AI" (connect to tools). A2A is the "WiFi for AI" (connect to other agents).
            </p>

            {protocolStack.map(p => (
              <div key={p.name} style={{ padding: "18px 20px", marginBottom: 10, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: `1px solid ${p.color}22`, borderLeft: `3px solid ${p.color}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9" }}>{p.name}</span>
                  <span style={{ fontSize: 10, color: p.color, background: p.color + "15", padding: "1px 6px", borderRadius: 3 }}>by {p.by}</span>
                </div>
                <div style={{ fontSize: 13, color: "#CBD5E1", fontWeight: 600, marginBottom: 6 }}>{p.role}</div>
                <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.6, marginBottom: 8 }}>{p.details}</div>
                <div style={{ fontSize: 11, color: "#64748B", padding: "6px 10px", background: "rgba(255,255,255,0.02)", borderRadius: 4, lineHeight: 1.5 }}>
                  📱 {p.analogy}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 16, padding: "18px", borderRadius: 10, background: "linear-gradient(135deg, rgba(66,133,244,0.06), rgba(217,119,6,0.06))", border: "1px solid rgba(99,102,241,0.15)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9", marginBottom: 8 }}>How they work together in Agent OS:</div>
              <pre style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.8, margin: 0, whiteSpace: "pre-wrap" }}>
{`Human: "Research the latest AI papers and summarize them"

1. Human talks to their Agent (via dashboard or chat channel)
2. Agent uses MCP to connect to ArXiv tool → fetches papers
3. Agent uses MCP to connect to PDF reader tool → extracts text
4. Agent uses A2A to find a Summarizer Agent → delegates work
5. Summarizer Agent uses MCP to connect to LLM tool → generates summary
6. Summarizer Agent returns result via A2A → back to original Agent
7. Original Agent delivers summary to Human

MCP = how each agent accesses tools
A2A = how agents find and talk to each other
Agent OS = the operating system that manages all of this`}
              </pre>
            </div>
          </div>
        )}

        {/* ─── REPO TAB ─── */}
        {tab === "repo" && (
          <div>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, margin: "0 0 20px" }}>
              Monorepo with pnpm workspaces (same structure as OpenClaw). Each OS layer is a separate package.
            </p>

            <pre style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "16px 20px", fontSize: 10.5, lineHeight: 1.7, color: "#94A3B8", overflow: "auto", whiteSpace: "pre" }}>
              {repoStructure}
            </pre>

            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", margin: "24px 0 12px", fontFamily: "Georgia, serif" }}>Tech Stack</h3>
            {techStack.map((t, i) => (
              <div key={i} style={{ padding: "10px 14px", marginBottom: 4, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#A5B4FC" }}>{t.category}</span>
                  <span style={{ fontSize: 11, color: "#CBD5E1" }}>{t.items.join(" + ")}</span>
                </div>
                <div style={{ fontSize: 10, color: "#64748B", lineHeight: 1.5 }}>{t.why}</div>
              </div>
            ))}
          </div>
        )}

        {/* ─── COMPARE TAB ─── */}
        {tab === "compare" && (
          <div>
            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, margin: "0 0 20px" }}>
              Three different things solving three different problems. We build on what OpenClaw and Moltbook proved, but go further — building the OS itself.
            </p>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ padding: "8px 10px", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#64748B", fontWeight: 600 }}>Aspect</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#81C784", fontWeight: 600 }}>🦞 OpenClaw</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#A5B4FC", fontWeight: 600 }}>🤖 Agent OS (us)</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#F9A8D4", fontWeight: 600 }}>📖 Moltbook</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonTable.map((row, i) => (
                    <tr key={i}>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#CBD5E1", fontWeight: 600 }}>{row.aspect}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#94A3B8" }}>{row.openclaw}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#C4B5FD", background: "rgba(99,102,241,0.03)" }}>{row.agentOS}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#94A3B8" }}>{row.moltbook}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 20, padding: "16px", borderRadius: 10, background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9", marginBottom: 8, fontFamily: "Georgia, serif" }}>The analogy that makes it click:</div>
              <div style={{ fontSize: 12, color: "#CBD5E1", lineHeight: 1.8 }}>
                <strong style={{ color: "#81C784" }}>OpenClaw</strong> = a really smart app running on someone's phone{"\n"}
                <strong style={{ color: "#F9A8D4" }}>Moltbook</strong> = a social media website (like Reddit) but for AI agents{"\n"}
                <strong style={{ color: "#A5B4FC" }}>Agent OS</strong> = the Android operating system itself — the platform ALL of these run on{"\n\n"}
                OpenClaw agents could run ON Agent OS.{"\n"}
                Moltbook could be a SKILL installed on Agent OS.{"\n"}
                Agent OS is the foundation layer underneath everything.
              </div>
            </div>
          </div>
        )}

        {/* ─── FOOTER CTA ─── */}
        <div style={{ marginTop: 36, marginBottom: 28, padding: "24px", borderRadius: 14, background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(168,85,247,0.08))", border: "1px solid rgba(99,102,241,0.18)", textAlign: "center" }}>
          <div style={{ fontSize: 24 }}>🤖</div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9", margin: "10px 0 6px", fontFamily: "Georgia, serif" }}>
            You're building Android — but for AI agents.
          </h3>
          <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, maxWidth: 500, margin: "0 auto 16px" }}>
            Not a blockchain project. Not a SaaS tool. An actual operating system that any AI agent can call home.
            Built on industry standards (MCP + A2A), inspired by what works (OpenClaw + Moltbook), designed for a world where agents outnumber humans.
          </p>
          <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, textAlign: "left", fontSize: 11, color: "#CBD5E1" }}>
            <div>📦 <strong>Day 1:</strong> Set up monorepo, implement Compute Kernel + MAL</div>
            <div>🧠 <strong>Week 2:</strong> Agent Runtime running a single Claude agent</div>
            <div>🔌 <strong>Week 4:</strong> MCP integration — agent uses real tools</div>
            <div>🌐 <strong>Week 6:</strong> A2A integration — two agents discover and talk to each other</div>
            <div>📡 <strong>Week 8:</strong> Skills system — install capabilities like Android apps</div>
            <div>🚀 <strong>Week 12:</strong> First public release on GitHub</div>
          </div>
        </div>

        <div style={{ textAlign: "center", fontSize: 10, color: "#334155", padding: "0 0 20px" }}>
          Agent OS Blueprint v2.0 · No blockchain · Pure AI infrastructure · Feb 2026
        </div>
      </div>
    </div>
  );
}
