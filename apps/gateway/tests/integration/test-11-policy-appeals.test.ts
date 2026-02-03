// Integration Test 11: Policy Engine + Appeals
// Validates automatic policy enforcement and appeals workflow

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import {
  defaultTestConfig,
  checkTestInfrastructure,
  waitForHealth,
  createTestConnection,
  createTestAgent,
  clearTestDatabase,
  sleep,
  type TestConnection,
  type TestAgent,
} from "../helpers/test-utils.js";
import { socialAgentManifest, adminAgentManifest } from "../fixtures/agent-manifests.js";

describe("Integration Test 11: Policy Engine + Appeals", () => {
  let gatewayProcess: ChildProcess | null = null;
  let connection: TestConnection | null = null;
  let spawnedAgents: TestAgent[] = [];

  beforeAll(async () => {
    const infra = await checkTestInfrastructure();
    expect(infra.postgres).toBe(true);
    expect(infra.qdrant).toBe(true);
    expect(infra.redis).toBe(true);

    gatewayProcess = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        GATEWAY_PORT: String(defaultTestConfig.gatewayPort),
        HEALTH_PORT: String(defaultTestConfig.healthPort),
        DATABASE_URL: defaultTestConfig.postgresUrl,
        QDRANT_URL: defaultTestConfig.qdrantUrl,
        REDIS_URL: defaultTestConfig.redisUrl,
        LOG_LEVEL: "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForHealth(
      `http://127.0.0.1:${defaultTestConfig.healthPort}/health`,
      30000
    );
  }, 60000);

  beforeEach(async () => {
    await clearTestDatabase(defaultTestConfig.postgresUrl);
    spawnedAgents = [];

    if (connection) {
      connection.close();
    }

    const connResult = await createTestConnection(
      `ws://127.0.0.1:${defaultTestConfig.gatewayPort}`
    );
    expect(connResult.ok).toBe(true);
    if (connResult.ok) {
      connection = connResult.value;
    }
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
    }
    if (gatewayProcess) {
      gatewayProcess.kill("SIGTERM");
      await sleep(2000);
      gatewayProcess.kill("SIGKILL");
    }
  });

  afterEach(async () => {
    for (const agent of spawnedAgents) {
      try {
        await agent.terminate();
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("should auto-enforce policies and allow appeals", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const adminResult = await createTestAgent(connection, adminAgentManifest);
    expect(adminResult.ok).toBe(true);
    if (!adminResult.ok) return;
    const adminAgent = adminResult.value;
    spawnedAgents.push(adminAgent);

    const socialResult = await createTestAgent(connection, socialAgentManifest);
    expect(socialResult.ok).toBe(true);
    if (!socialResult.ok) return;
    const socialAgent = socialResult.value;
    spawnedAgents.push(socialAgent);

    const policyCreate = await adminAgent.sendTask({
      type: "policy_create",
      name: "Forum post rate limit",
      description: "Only allow one post per minute",
      rules: {
        rules: [
          {
            type: "rate_limit",
            action: "forum.post",
            windowSeconds: 60,
            maxCount: 1,
            reason: "Too many posts in a short window",
            sanction: { type: "warn" },
          },
        ],
      },
    });

    const policy = (policyCreate as { payload?: { policy?: { id?: string } } }).payload?.policy;
    expect(policy?.id).toBeDefined();

    const forumCreate = await socialAgent.sendTask({
      type: "forum_create",
      name: "PolicyForum",
      description: "Testing policy enforcement",
    });

    const forumId = (forumCreate as { payload?: { forum?: { id?: string } } }).payload?.forum?.id;
    expect(forumId).toBeDefined();

    await socialAgent.sendTask({
      type: "forum_post",
      forumId,
      content: "First post",
    });

    await socialAgent.sendTask({
      type: "forum_post",
      forumId,
      content: "Second post",
    });

    const caseList = await adminAgent.sendTask({
      type: "moderation_case_list",
      subjectAgentId: socialAgent.id,
      status: "open",
      limit: 10,
    });

    const cases = (caseList as { payload?: { cases?: Array<{ id: string }> } }).payload?.cases;
    expect(Array.isArray(cases)).toBe(true);
    expect(cases?.length).toBeGreaterThan(0);

    const caseId = cases?.[0]?.id;
    expect(caseId).toBeDefined();

    const sanctionList = await adminAgent.sendTask({
      type: "sanction_list",
      subjectAgentId: socialAgent.id,
      status: "active",
      limit: 10,
    });

    const sanctions = (sanctionList as { payload?: { sanctions?: Array<{ id: string }> } })
      .payload?.sanctions;
    expect(Array.isArray(sanctions)).toBe(true);
    expect(sanctions?.length).toBeGreaterThan(0);

    const appealOpen = await socialAgent.sendTask({
      type: "appeal_open",
      caseId,
      reason: "Please reconsider",
    });

    const appealId = (appealOpen as { payload?: { appeal?: { id?: string } } }).payload?.appeal?.id;
    expect(appealId).toBeDefined();

    const appealList = await adminAgent.sendTask({
      type: "appeal_list",
      caseId,
      limit: 10,
    });

    const appeals = (appealList as { payload?: { appeals?: Array<{ id: string }> } })
      .payload?.appeals;
    expect(Array.isArray(appeals)).toBe(true);
    expect(appeals?.length).toBeGreaterThan(0);

    const appealResolve = await adminAgent.sendTask({
      type: "appeal_resolve",
      appealId,
      status: "resolved",
      resolution: "Reviewed",
    });

    const resolvedAppeal = (appealResolve as { payload?: { appeal?: { id?: string; status?: string } } })
      .payload?.appeal;
    expect(resolvedAppeal?.id).toBeDefined();
    expect(resolvedAppeal?.status).toBe("resolved");
  }, 60000);
});
