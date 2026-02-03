// Integration Test 9: Social + Governance Tasks
// Tests forums, jobs, reputation, policies, and sanctions

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

describe("Integration Test 9: Social + Governance", () => {
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

  it("should support forums, jobs, and reputation", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const agentResult = await createTestAgent(connection, socialAgentManifest);
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;
    const agent: TestAgent = agentResult.value;
    spawnedAgents.push(agent);

    const forumCreate = await agent.sendTask({
      type: "forum_create",
      name: "AgentTown",
      description: "Town hall for agents",
    });

    expect(forumCreate).toBeDefined();
    const forum = (forumCreate as { payload?: { forum?: { id?: string; name?: string } } })
      .payload?.forum;
    expect(forum?.id).toBeDefined();
    expect(forum?.name).toBe("AgentTown");

    const forumList = await agent.sendTask({ type: "forum_list" });
    const forums = (forumList as { payload?: { forums?: Array<{ id: string }> } })
      .payload?.forums;
    expect(Array.isArray(forums)).toBe(true);
    expect(forums?.length).toBeGreaterThan(0);

    const forumPost = await agent.sendTask({
      type: "forum_post",
      forumId: forum?.id,
      content: "Hello agents",
    });

    const post = (forumPost as { payload?: { post?: { id?: string } } }).payload?.post;
    expect(post?.id).toBeDefined();

    const forumPosts = await agent.sendTask({
      type: "forum_posts",
      forumId: forum?.id,
    });

    const posts = (forumPosts as { payload?: { posts?: Array<{ id: string }> } })
      .payload?.posts;
    expect(Array.isArray(posts)).toBe(true);
    expect(posts?.length).toBeGreaterThan(0);

    const jobPost = await agent.sendTask({
      type: "job_post",
      title: "Vector DB curator",
      description: "Maintain agent memory indexes",
      budgetUsd: 500,
    });

    const job = (jobPost as { payload?: { job?: { id?: string } } }).payload?.job;
    expect(job?.id).toBeDefined();

    const jobList = await agent.sendTask({ type: "job_list" });
    const jobs = (jobList as { payload?: { jobs?: Array<{ id: string }> } })
      .payload?.jobs;
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs?.length).toBeGreaterThan(0);

    const jobApply = await agent.sendTask({
      type: "job_apply",
      jobId: job?.id,
      proposal: "I can do this.",
    });

    const application = (jobApply as { payload?: { application?: { id?: string } } }).payload
      ?.application;
    expect(application?.id).toBeDefined();
  }, 60000);

  it("should enforce governance policies and sanctions", async () => {
    expect(connection).toBeDefined();
    if (!connection) return;

    const adminResult = await createTestAgent(connection, adminAgentManifest);
    expect(adminResult.ok).toBe(true);
    if (!adminResult.ok) return;
    const adminAgent = adminResult.value;
    spawnedAgents.push(adminAgent);

    const targetResult = await createTestAgent(connection, socialAgentManifest);
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const targetAgent = targetResult.value;
    spawnedAgents.push(targetAgent);

    const policyCreate = await adminAgent.sendTask({
      type: "policy_create",
      name: "No spam",
      description: "Block spam content",
      rules: { spam: true },
    });

    const policy = (policyCreate as { payload?: { policy?: { id?: string } } }).payload?.policy;
    expect(policy?.id).toBeDefined();

    const policyList = await adminAgent.sendTask({ type: "policy_list" });
    const policies = (policyList as { payload?: { policies?: Array<{ id: string }> } })
      .payload?.policies;
    expect(Array.isArray(policies)).toBe(true);
    expect(policies?.length).toBeGreaterThan(0);

    const directory = await adminAgent.sendTask({ type: "agent_directory", limit: 10 });
    const agents = (directory as { payload?: { agents?: Array<{ id: string }> } }).payload?.agents;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents?.length).toBeGreaterThan(0);

    const sanctionApply = await adminAgent.sendTask({
      type: "sanction_apply",
      subjectAgentId: targetAgent.id,
      sanctionType: "throttle",
      details: { reason: "test" },
    });

    const sanction = (sanctionApply as { payload?: { sanction?: { id?: string } } })
      .payload?.sanction;
    expect(sanction?.id).toBeDefined();

    const sanctionList = await adminAgent.sendTask({
      type: "sanction_list",
      subjectAgentId: targetAgent.id,
      limit: 10,
    });

    const sanctions = (sanctionList as { payload?: { sanctions?: Array<{ id: string }> } })
      .payload?.sanctions;
    expect(Array.isArray(sanctions)).toBe(true);
    expect(sanctions?.length).toBeGreaterThan(0);

    const reputationAdjust = await adminAgent.sendTask({
      type: "reputation_adjust",
      agentId: targetAgent.id,
      delta: 5,
      reason: "test bonus",
    });

    const reputation = (reputationAdjust as { payload?: { reputation?: { score?: number } } })
      .payload?.reputation;
    expect(reputation?.score).toBeDefined();

    const reputationList = await adminAgent.sendTask({
      type: "reputation_list",
      limit: 10,
    });

    const reputations = (reputationList as { payload?: { reputations?: Array<{ agent_id: string }> } })
      .payload?.reputations;
    expect(Array.isArray(reputations)).toBe(true);
    expect(reputations?.length).toBeGreaterThan(0);

    const blocked = await targetAgent.sendTask({ type: "forum_list" });
    const blockedPayload = blocked as { payload?: { status?: string; error?: string } };
    expect(blockedPayload.payload?.status).toBe("error");
    expect(blockedPayload.payload?.error).toContain("sanctioned");
  }, 60000);
});
