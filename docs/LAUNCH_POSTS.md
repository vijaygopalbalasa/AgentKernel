# Launch Posts — Copy-Paste Ready

## 1. Hacker News (Show HN)

**Title:**
```
Show HN: AgentKernel – Open-source firewall for AI agents (blocks credential theft, data exfil)
```

**URL:** `https://github.com/vijaygopalbalasa/AgentKernel`

**First Comment (post immediately after submitting):**
```
Hi HN,

I built AgentKernel after watching the ClawHavoc malware hit 341 OpenClaw skills in January — stealing SSH keys, AWS credentials, and crypto wallets from anyone who installed them. CVE-2026-25253 made it worse with one-click RCE on 50K+ installs.

The core problem: AI agents run with YOUR permissions. A malicious LangChain tool or OpenClaw skill can read ~/.ssh, exfiltrate to Telegram, or run reverse shells — and you'd never know.

AgentKernel sits between your agent and the system. It intercepts every file read, network request, and shell command, checks it against a policy engine, and blocks anything dangerous. Everything gets logged to PostgreSQL for audit.

What it does:
- Blocks 341+ known malicious patterns (AMOS Stealer, reverse shells, SSRF, crypto theft)
- Policy engine with allow/block/approve rules for files, network, shell
- HMAC-signed capability tokens with auto-expiry
- V8 process sandboxing with memory/time limits
- Full audit trail to PostgreSQL (HIPAA/SOC2 ready)
- Works with any framework — LangChain adapter included, OpenClaw proxy built-in

It's a single npm install:

  npm install -g @agentkernel/agent-kernel
  agentkernel init
  agentkernel start

The CLI has an interactive wizard so you don't need to write YAML. You can do `agentkernel block "telegram"` or `agentkernel allow "github"` and it handles the policy config.

1,175+ tests. TypeScript. Self-hosted. MIT licensed.

I'd love feedback on the policy model and what threats you'd want covered. Happy to answer questions.
```

---

## 2. Reddit — r/programming

**Title:**
```
I built an open-source firewall for AI agents after 341 malicious skills were found stealing credentials
```

**Body:**
```
After the ClawHavoc malware incident (341 malicious OpenClaw skills stealing SSH keys, AWS credentials, and crypto wallets) and CVE-2026-25253, I realized there's no open-source solution to make AI agents safe.

**AgentKernel** is a security sandbox that wraps any AI agent framework. It intercepts every operation and enforces policies before execution.

**What it blocks:**
- Credential theft (~/.ssh, ~/.aws, browser passwords)
- Data exfiltration (Telegram, Discord, paste sites)
- Malware execution (reverse shells, curl|bash)
- SSRF attacks (cloud metadata, internal networks)
- Crypto wallet theft

**How it works:**
- Policy engine: YAML rules for files, network, shell commands
- Capability tokens: HMAC-signed, time-bounded, auto-expire
- Process sandbox: V8 isolates with memory/time limits
- Audit trail: Everything logged to PostgreSQL

**Quick start:**
```bash
npm install -g @agentkernel/agent-kernel
agentkernel init    # interactive wizard
agentkernel start   # security proxy running
```

Works with LangChain, OpenClaw, or any WebSocket-based agent. 1,175+ tests. TypeScript. MIT licensed.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
npm: https://www.npmjs.com/package/@agentkernel/agent-kernel
```

---

## 3. Reddit — r/MachineLearning

**Title:**
```
[P] AgentKernel: Open-source security sandbox for AI agents — blocks credential theft, data exfiltration, and malware
```

**Body:**
```
**Problem:** Autonomous AI agents (LangChain, OpenClaw, AutoGPT) run with full user permissions. A compromised tool can steal credentials, exfiltrate data, or execute malware without the user knowing. The ClawHavoc incident (341 malicious skills) and CVE-2026-25253 showed this isn't theoretical.

**Solution:** AgentKernel is a security layer that sits between your agent and system resources. Every file access, network request, and shell command is intercepted, checked against policies, and logged.

Key features:
- **Policy Engine** — Allow/block rules for files, domains, and commands
- **Capability Tokens** — HMAC-signed, time-bounded permissions
- **Process Sandbox** — V8 isolates with memory limits
- **Audit Trail** — Full logging to PostgreSQL
- **LangChain Adapter** — `wrapToolWithPolicy(tool, engine)` wraps any tool

For researchers building agent systems: this gives you a way to safely run untrusted tools without exposing your machine.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
```

---

## 4. Reddit — r/artificial

**Title:**
```
Open-source firewall for AI agents — blocks data theft, credential stealing, and malware execution
```

**Body:**
```
AI agents are becoming more autonomous, but there's almost nothing to stop a malicious tool from reading your SSH keys or exfiltrating data to a Telegram bot.

I built AgentKernel — an open-source security sandbox that intercepts everything an AI agent does and blocks dangerous operations. Think of it as a firewall specifically designed for AI agents.

- Blocks 341+ known attack patterns
- Works with LangChain, OpenClaw, or any agent framework
- Interactive CLI: `agentkernel block "telegram"`, `agentkernel allow "github"`
- Full audit trail for compliance

GitHub: https://github.com/vijaygopalbalasa/AgentKernel

MIT licensed, self-hosted, no cloud dependency.
```

---

## 5. Twitter/X Thread

**Tweet 1 (Main):**
```
I just open-sourced AgentKernel — a firewall for AI agents.

341 malicious skills were found stealing SSH keys, AWS credentials, and crypto wallets from AI agent users.

AgentKernel intercepts every agent action and blocks what's dangerous.

npm install -g @agentkernel/agent-kernel

github.com/vijaygopalbalasa/AgentKernel
```

**Tweet 2 (Reply):**
```
What it blocks:

- Credential theft (~/.ssh, ~/.aws, browser passwords)
- Data exfiltration (Telegram, Discord, paste sites)
- Reverse shells and malware execution
- SSRF attacks on cloud metadata
- Crypto wallet theft

All 341+ ClawHavoc patterns covered.
```

**Tweet 3 (Reply):**
```
How it works:

Your Agent → AgentKernel Proxy → System Resources

Every file read, network request, and shell command is intercepted, checked against policies, and logged.

Policy engine + HMAC capability tokens + V8 sandboxing + PostgreSQL audit trail.
```

**Tweet 4 (Reply):**
```
The CLI is dead simple:

agentkernel init          # interactive wizard
agentkernel start         # proxy running
agentkernel block "telegram"
agentkernel allow "github"
agentkernel policy show

No YAML editing required.
```

**Tweet 5 (Reply):**
```
Works with:
- LangChain (adapter included)
- OpenClaw (built-in proxy)
- Any WebSocket-based agent

1,175+ tests. TypeScript. Self-hosted. MIT licensed.

If you're building with AI agents, you need this.

github.com/vijaygopalbalasa/AgentKernel
```

---

## 6. LangChain Discord / Community

```
Hey everyone! I just released AgentKernel — an open-source security layer for AI agents.

If you're using LangChain tools from untrusted sources, AgentKernel wraps them with policy enforcement:

```typescript
import { wrapToolWithPolicy } from '@agentkernel/langchain-adapter';
const safeTool = wrapToolWithPolicy(myTool, policyEngine, { agentId: 'my-agent' });
```

It blocks credential theft, data exfiltration, reverse shells, and 341+ other attack patterns. Full audit trail to PostgreSQL.

Built this after the ClawHavoc malware incident showed how easy it is for a malicious tool to steal SSH keys and AWS credentials.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
npm: `npm install @agentkernel/langchain-adapter`
```

---

## Posting Strategy

**Day 1:**
1. Post to Hacker News (Show HN) — Best time: Tuesday-Thursday, 8-9 AM ET
2. Post first comment immediately
3. Post to Twitter/X — Full thread

**Day 1-2:**
4. Post to r/programming
5. Post to r/MachineLearning
6. Post to r/artificial

**Day 2-3:**
7. Post to LangChain Discord
8. Post to AI/ML focused Discord servers

**Engagement Tips:**
- Respond to every HN comment within the first 2 hours
- On Reddit, reply to questions with code examples
- On Twitter, quote-retweet with additional context
- If HN hits front page, post a "lessons learned" follow-up the next week
