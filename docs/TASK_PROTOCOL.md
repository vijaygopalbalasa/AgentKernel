# AgentKernel Gateway Task Protocol

This document describes the low-level WebSocket task protocol used between agents and the AgentKernel gateway. Most developers should use the `AgentClient` API from `@agentkernel/sdk` instead of this protocol directly.

## Connection

The gateway runs a WebSocket server (default: `ws://127.0.0.1:18800`).

### Authentication

After connecting, the gateway sends `auth_required`. Respond with:

```json
{
  "type": "auth",
  "id": "auth-1",
  "payload": { "token": "<GATEWAY_AUTH_TOKEN>" }
}
```

On success: `{ "type": "auth_success", "id": "auth-1" }`
On failure: `{ "type": "auth_failed" }`

## Task Format

All tasks follow this envelope:

```json
{
  "type": "<task_type>",
  "id": "<unique_request_id>",
  "payload": { ... }
}
```

Responses match the request `id` so you can correlate them.

---

## Task Types

### `chat` — LLM Chat

Send messages to an LLM.

**Request:**
```json
{
  "type": "chat",
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello" }
  ],
  "model": "gpt-4o-mini",
  "maxTokens": 1024,
  "temperature": 0.7,
  "systemPrompt": "Optional system prompt"
}
```

**Response:**
```json
{
  "content": "Hi there!",
  "model": "gpt-4o-mini",
  "finishReason": "stop",
  "usage": { "inputTokens": 12, "outputTokens": 5, "totalTokens": 17 }
}
```

**AgentClient equivalent:** `client.chat(messages, options)`

---

### `store_fact` — Store Semantic Memory

**Request:**
```json
{
  "type": "store_fact",
  "category": "user-preferences",
  "fact": "User prefers dark mode",
  "tags": ["preferences", "ui"],
  "importance": 0.7
}
```

**AgentClient equivalent:** `client.storeFact({ category, fact, tags, importance })`

---

### `search_memory` — Search Memory

**Request:**
```json
{
  "type": "search_memory",
  "query": "user preferences",
  "types": ["semantic", "episodic"],
  "limit": 5
}
```

**Response:**
```json
{
  "memories": [
    { "type": "semantic", "content": "User prefers dark mode", "score": 0.92, "metadata": {} }
  ],
  "total": 1
}
```

**AgentClient equivalent:** `client.searchMemory(query, options)`

---

### `record_episode` — Record Episodic Memory

**Request:**
```json
{
  "type": "record_episode",
  "event": "task.completed",
  "context": "{\"taskId\": \"123\"}",
  "tags": ["task"],
  "success": true
}
```

**AgentClient equivalent:** `client.recordEpisode({ event, context, tags, success })`

---

### `invoke_tool` — Invoke a Tool

**Request:**
```json
{
  "type": "invoke_tool",
  "toolId": "builtin:http_fetch",
  "arguments": {
    "url": "https://example.com",
    "timeoutMs": 10000
  }
}
```

**Response:**
```json
{
  "success": true,
  "content": { "body": "...", "status": 200 },
  "error": null
}
```

**AgentClient equivalent:** `client.invokeTool(toolId, args)`

---

### `list_tools` — List Available Tools

**Request:**
```json
{ "type": "list_tools" }
```

**Response:**
```json
{
  "tools": [
    { "id": "builtin:http_fetch", "name": "HTTP Fetch", "description": "...", "inputSchema": {} }
  ]
}
```

**AgentClient equivalent:** `client.listTools()`

---

### `a2a_delegate` — Call Another Agent

**Request:**
```json
{
  "type": "a2a_delegate",
  "targetAgentId": "researcher",
  "task": {
    "type": "research_query",
    "question": "What is MCP?"
  }
}
```

**Response:**
```json
{
  "result": { "answer": "MCP is..." },
  "status": "ok"
}
```

**AgentClient equivalent:** `client.callAgent(agentId, task)`

---

### `agent_directory` — Discover Agents

**Request:**
```json
{
  "type": "agent_directory",
  "query": "researcher"
}
```

**Response:**
```json
{
  "agents": [
    { "id": "researcher", "name": "Researcher Agent", "state": "ready", "skills": [] }
  ]
}
```

**AgentClient equivalent:** `client.discoverAgents(query)`

---

### `emit_event` — Emit Event

**Request:**
```json
{
  "type": "emit_event",
  "channel": "agent.lifecycle",
  "eventType": "task.completed",
  "data": { "taskId": "abc" }
}
```

**AgentClient equivalent:** `client.emit(channel, type, data)`

---

### `agent_spawn` — Deploy an Agent

Used by the CLI, not typically by agents:

```json
{
  "type": "agent_spawn",
  "id": "deploy-1",
  "payload": { "manifest": { ... } }
}
```

---

### `agent_terminate` — Stop an Agent

```json
{
  "type": "agent_terminate",
  "id": "term-1",
  "payload": { "agentId": "my-agent", "force": false }
}
```

---

## Error Handling

Gateway errors are returned as:

```json
{
  "type": "error",
  "payload": { "message": "Description of what went wrong" }
}
```

The `AgentClient` converts these into thrown `Error` objects automatically.

## Streaming

For streaming chat responses, set `stream: true` in the chat request. The gateway sends:

1. `chat_stream` messages with `{ delta: "..." }` payloads
2. A final `chat_stream_end` message

Streaming is handled automatically by the gateway CLI's `chat` command and the OS shell.
