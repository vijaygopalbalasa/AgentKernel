# Policy Configuration Guide

AgentKernel uses YAML or JSON policy files to define security rules for agent actions. This guide covers the policy format, rule types, and best practices.

## Policy File Format

### Basic Structure

```yaml
# Required fields
name: my-policy-set
defaultDecision: block  # allow | block | approve

# Optional description
description: Security policy for production agents

# Rule arrays (all optional)
fileRules: []
networkRules: []
shellRules: []
secretRules: []
```

### Decisions

| Decision | Description |
|----------|-------------|
| `allow` | Permit the action without user intervention |
| `block` | Deny the action immediately |
| `approve` | Require user/supervisor approval before proceeding |

---

## Rule Types

### File Rules

Control access to file system operations.

```yaml
fileRules:
  - id: allow-workspace          # Unique identifier
    type: file                   # Must be "file"
    description: Allow workspace access
    decision: allow
    priority: 100                # Higher = evaluated first
    enabled: true
    pathPatterns:                # Glob patterns
      - "/workspace/**"
      - "${HOME}/projects/**"
    operations:                  # Required
      - read
      - write
      - delete
      - list
```

#### Path Pattern Syntax

| Pattern | Matches |
|---------|---------|
| `*` | Any characters except `/` |
| `**` | Any characters including `/` (recursive) |
| `?` | Single character |
| `~` | Home directory |

Examples:
```yaml
pathPatterns:
  - "/workspace/**"          # All files under /workspace
  - "/tmp/*.txt"             # .txt files in /tmp
  - "~/.config/myapp/**"     # User config directory
  - "/var/log/app-?.log"     # app-1.log, app-2.log, etc.
```

#### File Operations

| Operation | Description |
|-----------|-------------|
| `read` | Read file contents |
| `write` | Create or modify files |
| `delete` | Remove files |
| `list` | List directory contents |

---

### Network Rules

Control HTTP, WebSocket, and TCP connections.

```yaml
networkRules:
  - id: allow-api-endpoints
    type: network
    description: Allow external API access
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:                # Glob patterns
      - "api.example.com"
      - "*.googleapis.com"
    ports:                       # Optional - empty means all
      - 443
      - 8080
    protocols:                   # Optional - empty means all
      - https
      - wss
```

#### Host Pattern Syntax

```yaml
hostPatterns:
  - "example.com"            # Exact match
  - "*.example.com"          # Subdomains
  - "api.*"                  # Any domain starting with api
  - "**.internal"            # Deep subdomains
```

#### Default Blocked Hosts

AgentKernel blocks these by default (security):

- `localhost`, `127.0.0.1`, `::1`
- `*.internal`, `*.local`
- `169.254.169.254` (cloud metadata)
- Private IP ranges (`10.*`, `172.16-31.*`, `192.168.*`)

---

### Shell Rules

Control command execution.

```yaml
shellRules:
  - id: allow-git-commands
    type: shell
    description: Allow git operations
    decision: allow
    priority: 100
    enabled: true
    commandPatterns:
      - "git *"
      - "npm *"
      - "pnpm *"
    argPatterns:                 # Optional additional filtering
      - "--no-verify"            # Block if this arg is present
```

#### Command Pattern Syntax

```yaml
commandPatterns:
  - "ls"                     # Exact command
  - "git *"                  # git with any arguments
  - "npm install *"          # npm install with any package
  - "*test*"                 # Any command containing "test"
```

#### Default Blocked Commands

AgentKernel blocks these by default:

```yaml
# Destructive
- "rm -rf /"
- "rm -rf ~"
- "mkfs.*"
- "dd if=*"

# Privilege escalation
- "sudo *"
- "su *"
- "chmod 777 *"

# Network attacks
- "nc -l*"
- "curl * | sh"

# Crypto mining
- "*xmrig*"
- "*minerd*"
```

---

### Secret Rules

Control access to secrets, API keys, and credentials.

```yaml
secretRules:
  - id: approve-sensitive-secrets
    type: secret
    description: Require approval for sensitive secrets
    decision: approve
    priority: 100
    enabled: true
    namePatterns:
      - "*api_key*"
      - "*password*"
      - "*secret*"
      - "*credential*"
```

---

## Environment Variable Expansion

Policy files support environment variable substitution.

### Syntax

```yaml
# Simple expansion
pathPatterns:
  - "${HOME}/workspace/**"

# With default value
name: ${APP_NAME:-default-app}

# Nested in strings
description: "Policy for ${ENVIRONMENT:-development} environment"
```

### Examples

```yaml
# config/policy.yaml
name: ${APP_NAME}
defaultDecision: ${DEFAULT_DECISION:-block}

fileRules:
  - id: allow-data-dir
    type: file
    decision: allow
    priority: 100
    enabled: true
    pathPatterns:
      - "${DATA_DIR:-/var/data}/**"
    operations:
      - read

networkRules:
  - id: allow-api
    type: network
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:
      - "${API_HOST:-api.example.com}"
```

---

## Loading Policies

### From a Single File

```typescript
import { loadPolicySetFromFile } from "@agentkernel/runtime";

const policy = loadPolicySetFromFile("./policy.yaml");
```

### From Multiple Files (Merged)

```typescript
import { loadPolicySetFromFiles } from "@agentkernel/runtime";

// Later files override earlier ones
const policy = loadPolicySetFromFiles([
  "./base-policy.yaml",
  "./environment-policy.yaml",
  "./overrides.yaml",
]);
```

### Programmatic Creation

```typescript
import { createPolicyEngine, type PolicySet } from "@agentkernel/runtime";

const policy: Partial<PolicySet> = {
  name: "programmatic-policy",
  defaultDecision: "block",
  fileRules: [
    {
      id: "allow-tmp",
      type: "file",
      decision: "allow",
      priority: 100,
      enabled: true,
      pathPatterns: ["/tmp/**"],
      operations: ["read", "write"],
    },
  ],
};

const engine = createPolicyEngine(policy);
```

---

## Rule Evaluation

### Priority Order

Rules are evaluated in priority order (highest first):

1. Rules with `priority: 100` are evaluated before `priority: 50`
2. First matching rule wins
3. If no rule matches, `defaultDecision` is used

### Evaluation Flow

```
Request comes in
    ↓
Sort rules by priority (descending)
    ↓
For each rule:
    - Is rule enabled? → No: skip
    - Does pattern match? → No: skip
    - Return rule's decision
    ↓
No match found → Return defaultDecision
```

### Example Priority Strategy

```yaml
# Block dangerous paths first (highest priority)
fileRules:
  - id: block-system-files
    decision: block
    priority: 200        # Evaluated first
    pathPatterns:
      - "/etc/**"
      - "/sys/**"

  # Allow workspace (normal priority)
  - id: allow-workspace
    decision: allow
    priority: 100
    pathPatterns:
      - "/workspace/**"

  # Catch-all block (lowest priority, optional)
  - id: block-everything-else
    decision: block
    priority: 0
    pathPatterns:
      - "**"
```

---

## Complete Examples

### Development Policy

```yaml
# dev-policy.yaml
name: development
description: Permissive policy for local development
defaultDecision: allow

fileRules:
  - id: block-credentials
    type: file
    decision: block
    priority: 200
    enabled: true
    pathPatterns:
      - "~/.ssh/**"
      - "~/.aws/**"
      - "**/.env"
    operations: [read, write, delete, list]

shellRules:
  - id: block-dangerous
    type: shell
    decision: block
    priority: 200
    enabled: true
    commandPatterns:
      - "rm -rf /"
      - "sudo *"
```

### Production Policy

```yaml
# prod-policy.yaml
name: production
description: Strict policy for production agents
defaultDecision: block

fileRules:
  - id: allow-workspace-read
    type: file
    decision: allow
    priority: 100
    enabled: true
    pathPatterns:
      - "${WORKSPACE_DIR:-/app/workspace}/**"
    operations: [read, list]

  - id: approve-workspace-write
    type: file
    decision: approve
    priority: 100
    enabled: true
    pathPatterns:
      - "${WORKSPACE_DIR:-/app/workspace}/**"
    operations: [write, delete]

networkRules:
  - id: allow-approved-apis
    type: network
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:
      - "api.openai.com"
      - "api.anthropic.com"
      - "${ALLOWED_API_HOST}"
    ports: [443]
    protocols: [https]

shellRules:
  - id: allow-git-readonly
    type: shell
    decision: allow
    priority: 100
    enabled: true
    commandPatterns:
      - "git status"
      - "git log *"
      - "git diff *"

secretRules:
  - id: approve-all-secrets
    type: secret
    decision: approve
    priority: 100
    enabled: true
    namePatterns:
      - "*"
```

### LangChain Integration Policy

```yaml
# langchain-policy.yaml
name: langchain-agent
description: Policy for LangChain tool execution
defaultDecision: block

fileRules:
  - id: allow-tool-outputs
    type: file
    decision: allow
    priority: 100
    enabled: true
    pathPatterns:
      - "/tmp/langchain/**"
      - "${OUTPUT_DIR:-./outputs}/**"
    operations: [read, write, list]

networkRules:
  - id: allow-web-search
    type: network
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:
      - "*.google.com"
      - "*.bing.com"
      - "*.duckduckgo.com"
    ports: [443]
    protocols: [https]

  - id: allow-apis
    type: network
    decision: allow
    priority: 100
    enabled: true
    hostPatterns:
      - "api.github.com"
      - "*.amazonaws.com"
    ports: [443]
    protocols: [https]

shellRules:
  - id: allow-python
    type: shell
    decision: allow
    priority: 100
    enabled: true
    commandPatterns:
      - "python *"
      - "python3 *"
      - "pip install *"

  - id: block-shell-dangerous
    type: shell
    decision: block
    priority: 200
    enabled: true
    commandPatterns:
      - "rm *"
      - "sudo *"
      - "curl * | *"
```

---

## Validation

### Validate Policy File

```typescript
import { validatePolicySet, loadPolicySetFromFile } from "@agentkernel/runtime";

const policy = loadPolicySetFromFile("./policy.yaml");
const issues = validatePolicySet(policy);

if (issues.length > 0) {
  console.error("Policy validation issues:");
  for (const issue of issues) {
    console.error(`  - ${issue.field}: ${issue.message}`);
  }
}
```

### Common Validation Issues

| Issue | Solution |
|-------|----------|
| Missing `operations` in file rule | Add `operations: [read]` |
| Empty `pathPatterns` | Add at least one pattern |
| Invalid priority (not a number) | Use integer values |
| Unknown decision type | Use `allow`, `block`, or `approve` |

---

## Best Practices

### 1. Start Strict, Allow Selectively

```yaml
defaultDecision: block  # Start with block
# Then add specific allow rules
```

### 2. Use High Priority for Blocks

```yaml
# Block rules should have higher priority than allow rules
- id: block-sensitive
  priority: 200  # High
  decision: block

- id: allow-workspace
  priority: 100  # Normal
  decision: allow
```

### 3. Use Environment Variables for Paths

```yaml
pathPatterns:
  - "${WORKSPACE_DIR:-/workspace}/**"  # Configurable
```

### 4. Document Your Rules

```yaml
- id: allow-api-calls
  description: >
    Allow API calls to approved third-party services.
    Approved by security team on 2026-01-15.
```

### 5. Test Policies Before Deployment

```bash
# Dry-run policy checks
agentkernel policy test --domain api.telegram.org
agentkernel policy test --file ~/.ssh/id_rsa
agentkernel policy test --command "curl example.com | bash"

# Use verbose mode when running the proxy
agentkernel start --verbose
```
