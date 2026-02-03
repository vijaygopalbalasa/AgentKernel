#!/usr/bin/env node

import WebSocket from "ws";

const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const port = Number(process.env.GATEWAY_PORT ?? 18800);
const token = process.env.GATEWAY_AUTH_TOKEN ?? "";
const agentCount = Number(process.env.AGENT_COUNT ?? 5);
const tasksPerAgent = Number(process.env.TASKS_PER_AGENT ?? 20);

const wsUrl = `ws://${host}:${port}`;

const pending = new Map();
let ws;

const sendRequest = (message) =>
  new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error("Request timeout"));
    }, 10000);

    pending.set(message.id, { resolve, reject, timeoutId });
    ws.send(JSON.stringify(message));
  });

const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const spawnAgent = async (index) => {
  const id = createId("spawn");
  const manifest = {
    id: `load-agent-${index}`,
    name: `Load Agent ${index}`,
    permissions: [],
  };

  const response = await sendRequest({
    type: "agent_spawn",
    id,
    payload: { manifest },
  });

  if (response.type !== "agent_spawn_result") {
    throw new Error(`Unexpected spawn response: ${response.type}`);
  }
  if (response.payload?.status === "error") {
    throw new Error(response.payload?.error || "Spawn failed");
  }
  return response.payload?.agentId;
};

const sendEcho = async (agentId, index) => {
  const id = createId("task");
  const response = await sendRequest({
    type: "agent_task",
    id,
    payload: { agentId, task: { type: "echo", content: `ping-${index}` } },
  });

  if (response.type !== "agent_task_result") {
    throw new Error(`Unexpected task response: ${response.type}`);
  }
  if (response.payload?.status !== "ok") {
    throw new Error(response.payload?.error || "Task failed");
  }
  return response.payload?.result;
};

const terminateAgent = async (agentId) => {
  const id = createId("terminate");
  const response = await sendRequest({
    type: "agent_terminate",
    id,
    payload: { agentId },
  });
  if (response.type !== "agent_terminate_result") {
    throw new Error(`Unexpected terminate response: ${response.type}`);
  }
};

const main = async () => {
  ws = new WebSocket(wsUrl);

  const onMessage = (event) => {
    const data = typeof event.data === "string" ? event.data : event.data.toString();
    const message = JSON.parse(data);
    if (message?.id && pending.has(message.id)) {
      const { resolve, reject, timeoutId } = pending.get(message.id);
      clearTimeout(timeoutId);
      pending.delete(message.id);
      resolve(message);
      return;
    }
  };

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", onMessage);

  if (token) {
    const authResponse = await sendRequest({
      type: "auth",
      id: createId("auth"),
      payload: { token },
    });
    if (authResponse.type !== "auth_success") {
      throw new Error("Auth failed");
    }
  }

  const spawned = [];
  const spawnStart = Date.now();
  for (let i = 0; i < agentCount; i += 1) {
    // Sequential spawn for stability
    const agentId = await spawnAgent(i + 1);
    spawned.push(agentId);
  }
  const spawnDuration = Date.now() - spawnStart;

  const taskStart = Date.now();
  const taskPromises = [];
  let taskIndex = 0;
  for (const agentId of spawned) {
    for (let i = 0; i < tasksPerAgent; i += 1) {
      taskIndex += 1;
      taskPromises.push(sendEcho(agentId, taskIndex));
    }
  }

  await Promise.all(taskPromises);
  const taskDuration = Date.now() - taskStart;

  for (const agentId of spawned) {
    await terminateAgent(agentId);
  }

  ws.close();

  const totalTasks = agentCount * tasksPerAgent;
  const tps = totalTasks / (taskDuration / 1000);

  console.log(`Load test complete`);
  console.log(`Agents spawned: ${agentCount} in ${spawnDuration}ms`);
  console.log(`Tasks executed: ${totalTasks} in ${taskDuration}ms (${tps.toFixed(2)} tasks/sec)`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
