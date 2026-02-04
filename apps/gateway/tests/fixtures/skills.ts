// Test fixtures for skills

export const sampleSkillManifest = {
  id: "test-skill",
  name: "Test Skill",
  version: "0.1.0",
  description: "A sample skill for testing",
  author: "AgentRun Team",
  permissions: ["tools.execute"],
  tools: [
    {
      id: "test-tool",
      name: "Test Tool",
      description: "A tool for testing",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
    },
  ],
};

export const filesystemSkillManifest = {
  id: "filesystem-skill",
  name: "Filesystem Skill",
  version: "0.1.0",
  description: "Filesystem operations skill",
  permissions: ["filesystem.read", "filesystem.write"],
  tools: [
    {
      id: "file-read",
      name: "Read File",
      description: "Read a file from the filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      id: "file-write",
      name: "Write File",
      description: "Write content to a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  ],
};

export const mcpServerConfig = {
  filesystem: {
    command: "npx",
    args: ["-y", "@anthropic/mcp-filesystem"],
    env: {
      ALLOWED_PATHS: "/tmp/test,/workspace",
    },
  },
  memory: {
    command: "npx",
    args: ["-y", "@agentrun/mcp-memory"],
  },
};
