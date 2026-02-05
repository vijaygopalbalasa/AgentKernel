# Launch Posts — Copy-Paste Ready

## 1. Twitter/X Thread (PRIMARY — Post First)

**Tweet 1 (Hook — post this first):**
```
Your AI agent has the same permissions as you.

It can read your SSH keys. Exfiltrate to Telegram. Run reverse shells.

341 malicious OpenClaw skills were doing exactly this. Stealing AWS creds, crypto wallets, browser passwords.

I built an open-source firewall to stop it.

github.com/vijaygopalbalasa/AgentKernel
```

**Tweet 2 (The problem — reply to Tweet 1):**
```
The ClawHavoc malware hit 341 skills in January.

CVE-2026-25253 gave one-click RCE to 50K+ users.

AMOS Stealer was hiding in AI tools — grabbing:
  - ~/.ssh keys
  - ~/.aws credentials
  - Chrome/Firefox passwords
  - Crypto wallets (Metamask, Phantom, Ledger)

No one noticed until it was too late.
```

**Tweet 3 (The solution):**
```
AgentKernel sits between your agent and the system.

Every file read, network call, and shell command goes through a policy engine first.

Dangerous? Blocked.
Safe? Allowed.
Everything? Logged.

3 commands to protect your machine:

npm install -g @agentkernel/agent-kernel
agentkernel init
agentkernel start
```

**Tweet 4 (Demo — the wow moment):**
```
Watch what happens when an agent tries to steal your SSH keys:

$ curl -X POST http://localhost:18788/evaluate \
  -d '{"tool":"bash","args":{"command":"cat ~/.ssh/id_rsa"}}'

→ BLOCKED: Shell command "cat" accesses blocked file ~/.ssh/id_rsa

Even though "cat" is an allowed command, the FILE argument triggers the block.

Cross-domain security. No bypass.
```

**Tweet 5 (CLI simplicity):**
```
The CLI makes security dead simple:

agentkernel init              # interactive wizard
agentkernel start             # firewall running
agentkernel block "telegram"  # block exfil channel
agentkernel allow "github"    # allow what you trust
agentkernel policy show       # see everything in English
agentkernel audit             # full audit trail

No YAML. No config files. Just commands.
```

**Tweet 6 (Tech cred):**
```
Under the hood:

- Policy engine with YAML rules (file/network/shell)
- HMAC-signed capability tokens (unforgeable, auto-expire)
- V8 process sandboxing (memory + time limits)
- Cross-domain shell→file checking
- Full audit trail to PostgreSQL
- LangChain adapter included

1,140+ tests. TypeScript strict mode. MIT licensed.
```

**Tweet 7 (Call to action):**
```
Works with:
- LangChain (@LangChainAI)
- OpenClaw / MCP / any agent framework
- Standalone HTTP API (no framework needed)

If you're building with AI agents, you need a firewall.

Star it: github.com/vijaygopalbalasa/AgentKernel
Install it: npm install -g @agentkernel/agent-kernel

Open source. Self-hosted. No cloud dependency.
```

**Accounts to tag (reply to thread, not in main tweet):**
```
cc @LangChainAI @AnthropicAI @OpenAI @Harrison_Chase @hwchase17
@siloapp_ @llaboratory @jerryjliu0 @swaborkers
@aiaboratory @LlamaIndex @CrewAIInc
```

---

## 2. Hacker News (Show HN)

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

AgentKernel sits between your agent and the system. It intercepts every file read, network request, and shell command, checks it against a policy engine, and blocks anything dangerous. Everything gets logged for audit.

What it does:
- Blocks 341+ known malicious patterns (AMOS Stealer, reverse shells, SSRF, crypto theft)
- Cross-domain security: `cat ~/.ssh/id_rsa` blocked even though `cat` is allowed (file arg triggers it)
- Policy engine with allow/block/approve rules for files, network, shell
- HMAC-signed capability tokens with auto-expiry
- V8 process sandboxing with memory/time limits
- Full audit trail (HIPAA/SOC2 ready)
- Works with any framework — LangChain adapter included, HTTP API built-in

It's a single npm install:

  npm install -g @agentkernel/agent-kernel
  agentkernel init
  agentkernel start

The CLI has an interactive wizard so you don't need to write YAML. You can do `agentkernel block "telegram"` or `agentkernel allow "github"` and it handles the policy config.

1,140+ tests. TypeScript. Self-hosted. MIT licensed.

I'd love feedback on the policy model and what threats you'd want covered. Happy to answer questions.
```

---

## 3. Reddit — r/programming

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

**Cross-domain security** — even `cat ~/.ssh/id_rsa` gets blocked. The file argument triggers the file policy even though `cat` is an allowed command.

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

Works with LangChain, OpenClaw, or any WebSocket-based agent. 1,140+ tests. TypeScript. MIT licensed.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
npm: https://www.npmjs.com/package/@agentkernel/agent-kernel
```

---

## 4. Reddit — r/MachineLearning

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
- **Cross-Domain Security** — Shell commands cross-checked against file policies
- **Capability Tokens** — HMAC-signed, time-bounded permissions
- **Process Sandbox** — V8 isolates with memory limits
- **Audit Trail** — Full logging to PostgreSQL
- **LangChain Adapter** — `wrapToolWithPolicy(tool, engine)` wraps any tool

For researchers building agent systems: this gives you a way to safely run untrusted tools without exposing your machine.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
```

---

## 5. Reddit — r/artificial

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
- Cross-domain security (shell commands checked against file policies)
- Full audit trail for compliance

GitHub: https://github.com/vijaygopalbalasa/AgentKernel

MIT licensed, self-hosted, no cloud dependency.
```

---

## 6. LangChain Discord / Community

```
Hey everyone! I just released AgentKernel — an open-source security layer for AI agents.

If you're using LangChain tools from untrusted sources, AgentKernel wraps them with policy enforcement:

import { wrapToolWithPolicy } from '@agentkernel/langchain-adapter';
const safeTool = wrapToolWithPolicy(myTool, policyEngine, { agentId: 'my-agent' });

It blocks credential theft, data exfiltration, reverse shells, and 341+ other attack patterns. Full audit trail to PostgreSQL.

Built this after the ClawHavoc malware incident showed how easy it is for a malicious tool to steal SSH keys and AWS credentials.

GitHub: https://github.com/vijaygopalbalasa/AgentKernel
npm: npm install @agentkernel/langchain-adapter
```

---

## Posting Strategy

**Day 1 (Tuesday-Thursday, 8-9 AM ET):**
1. Post Twitter/X thread FIRST — it's the hook
2. Post to Hacker News (Show HN) — post first comment immediately
3. Reply to your own X thread tagging relevant accounts

**Day 1-2:**
4. Post to r/programming
5. Post to r/MachineLearning
6. Post to r/artificial

**Day 2-3:**
7. Post to LangChain Discord
8. Post to AI/ML focused Discord servers
9. Post to r/opensource, r/node, r/typescript

**Engagement Tips:**
- Respond to every HN comment within the first 2 hours
- On Reddit, reply to questions with code examples
- On Twitter, quote-retweet with additional context
- If HN hits front page, post a "lessons learned" follow-up the next week
- Retweet/engage with anyone who shares it
- Pin the thread on your X profile
