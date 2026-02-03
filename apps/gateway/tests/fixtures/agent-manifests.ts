// Test fixtures for agent manifests

export const sampleAgentManifest = {
  id: "test-agent-1",
  name: "Test Agent",
  version: "0.1.0",
  description: "A test agent for integration tests",
  model: "claude-3-haiku-20240307",
  systemPrompt: "You are a test agent. Respond concisely.",
  capabilities: ["chat", "memory"],
  permissions: ["memory.read", "memory.write", "agents.read", "agents.execute", "llm.execute"],
};

export const minimalAgentManifest = {
  id: "minimal-agent",
  name: "Minimal Agent",
};

export const assistantAgentManifest = {
  id: "assistant-test",
  name: "Assistant Test Agent",
  version: "0.1.0",
  description: "Assistant agent for integration testing",
  model: "claude-3-haiku-20240307",
  systemPrompt: "You are a helpful assistant running in test mode.",
  capabilities: ["chat", "memory", "tools"],
  permissions: [
    "memory.read",
    "memory.write",
    "tools.execute",
    "filesystem.read:/tmp/test",
  ],
};

export const coderAgentManifest = {
  id: "coder-test",
  name: "Coder Test Agent",
  version: "0.1.0",
  description: "Coder agent for integration testing",
  model: "claude-3-5-sonnet-20241022",
  systemPrompt: "You are a coding assistant. Write clean, tested code.",
  capabilities: ["chat", "memory", "tools", "code"],
  permissions: [
    "memory.read",
    "memory.write",
    "tools.execute",
    "filesystem.read:/workspace",
    "filesystem.write:/workspace",
    "shell.execute",
  ],
};

export const systemAgentManifest = {
  id: "system-test",
  name: "System Test Agent",
  version: "0.1.0",
  description: "System monitoring agent for tests",
  model: "claude-3-haiku-20240307",
  capabilities: ["monitoring", "health"],
  permissions: ["system.read", "agents.read"],
  checkInterval: 5000,
  maxAgents: 10,
};

export const socialAgentManifest = {
  id: "social-test",
  name: "Social Test Agent",
  version: "0.1.0",
  description: "Agent with social permissions for integration tests",
  model: "claude-3-haiku-20240307",
  capabilities: ["social"],
  permissions: ["social.read", "social.write"],
};

export const adminAgentManifest = {
  id: "admin-test",
  name: "Admin Test Agent",
  version: "0.1.0",
  description: "Agent with admin permissions for integration tests",
  model: "claude-3-haiku-20240307",
  capabilities: ["admin"],
  permissions: [
    "admin.read",
    "admin.admin",
    "social.read",
    "social.write",
    "social.admin",
    "agents.read",
  ],
};

export const invalidManifests = {
  missingId: { name: "No ID Agent" },
  missingName: { id: "no-name" },
  emptyId: { id: "", name: "Empty ID" },
  invalidPermission: {
    id: "bad-perms",
    name: "Bad Perms",
    permissions: ["not.a.real.permission"],
  },
};

export const agentManifestWithTools = {
  id: "tool-agent",
  name: "Tool Agent",
  version: "0.1.0",
  model: "claude-3-haiku-20240307",
  capabilities: ["tools"],
  permissions: [
    "tools.execute",
    "filesystem.read:/allowed/path",
    "filesystem.write:/allowed/path",
  ],
  tools: [
    {
      id: "builtin:calculate",
      enabled: true,
    },
    {
      id: "builtin:datetime",
      enabled: true,
    },
  ],
};

export const multiAgentManifests = Array.from({ length: 10 }, (_, i) => ({
  id: `concurrent-agent-${i}`,
  name: `Concurrent Agent ${i}`,
  version: "0.1.0",
  model: "claude-3-haiku-20240307",
  capabilities: ["chat"],
  permissions: ["memory.read"],
}));
