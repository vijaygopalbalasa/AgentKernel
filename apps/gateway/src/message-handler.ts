// Message Handler — WebSocket message dispatch for incoming client messages

import { randomUUID } from "crypto";
import { z } from "zod";
import type { ValidateFunction } from "ajv";
import { createLogger, type Database } from "@agentrun/kernel";
import { type ModelRouter } from "@agentrun/mal";
import { ok, err, type Result } from "@agentrun/shared";
import { createEventBus, type EventBus } from "@agentrun/events";
import { MemoryManager } from "@agentrun/memory";
import { createCapabilityManager } from "@agentrun/permissions";
import { createToolRegistry } from "@agentrun/tools";
import type { JobRunner } from "@agentrun/runtime";
import {
  type AgentEntry,
  type A2ATaskEntry,
  type AgentManifest,
  type TrustLevel,
  isUuid,
} from "./gateway-types.js";
import {
  type WsMessage,
  type ClientConnection,
  ChatPayloadSchema,
  AgentSpawnPayloadSchema,
  AgentTerminatePayloadSchema,
  SubscribePayloadSchema,
  AgentTaskPayloadSchema,
  GatewayError,
} from "./types.js";
import { parseBoolean, verifyManifestSignature } from "./security-utils.js";
import {
  findAgentById,
  createEventId,
  collectPermissions,
  normalizeMcpAllowlist,
  resolvePermissionDurationMs,
  resolveInternalTaskToken,
  resolveMaxAgentErrors,
  resolveMaxAgentTaskTimeoutMs,
  ajv,
} from "./gateway-utils.js";
import {
  resolveAgentNode,
  resolveClusterNodeUrl,
  forwardClusterMessage,
  listAgentsFromDatabase,
  normalizeRecord,
  toNumber,
} from "./cluster.js";
import {
  sendClientMessage,
  streamChatToClient,
  startAgentWorker,
  sendTaskToWorker,
  unscheduleMonitorAgent,
  scheduleMonitorAgent,
} from "./worker-manager.js";
import {
  upsertAgentRecord,
  updateAgentState,
  recordAuditLog,
  recordEvent,
} from "./db-operations.js";
import { handleAgentTask } from "./task-handler.js";

export async function handleClientMessage(
  client: ClientConnection,
  message: WsMessage,
  ctx: {
    router: ModelRouter;
    eventBus: EventBus;
    agents: Map<string, AgentEntry>;
    jobRunner: JobRunner;
    monitorIntervalMs: number;
    log: ReturnType<typeof createLogger>;
    memory: MemoryManager;
    db?: Database;
    toolRegistry: ReturnType<typeof createToolRegistry>;
    permissionManager: ReturnType<typeof createCapabilityManager>;
    a2aTasks: Map<string, A2ATaskEntry>;
    allowedPaths: string[];
    allowedDomains: string[];
    allowedCommands: string[];
    allowAllPaths: boolean;
    allowAllDomains: boolean;
    allowAllCommands: boolean;
    memoryLimitMb: number;
    clusterNodeId: string | null;
  }
): Promise<Result<WsMessage | null, GatewayError>> {
  const {
    router,
    eventBus,
    agents,
    jobRunner,
    monitorIntervalMs,
    log,
    memory,
    db,
    toolRegistry,
    permissionManager,
    a2aTasks,
    allowedPaths,
    allowedDomains,
    allowedCommands,
    allowAllPaths,
    allowAllDomains,
    allowAllCommands,
    memoryLimitMb,
    clusterNodeId,
  } = ctx;
  const taskContext = {
    router,
    memory,
    log,
    db,
    eventBus,
    agents,
    toolRegistry,
    permissionManager,
    a2aTasks,
    allowedPaths,
    allowedDomains,
    allowedCommands,
    allowAllPaths,
    allowAllDomains,
    allowAllCommands,
    memoryLimitMb,
    clusterNodeId,
    handleTask: handleAgentTask,
    updateState: updateAgentState,
  };

  switch (message.type) {
    case "chat": {
      const payloadResult = ChatPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid chat payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const payload = payloadResult.data;
      log.info("Chat request", { clientId: client.id, model: payload.model });

      if (payload.stream) {
        const streamResult = await streamChatToClient(
          client,
          message.id,
          payload,
          router,
          log
        );
        if (!streamResult.ok) {
          return err(streamResult.error);
        }
        return ok(null);
      }

      const result = await router.route({
        model: payload.model ?? "claude-3-haiku-20240307",
        messages: payload.messages,
        maxTokens: payload.maxTokens ?? 1024,
        temperature: payload.temperature,
      });

      if (result.ok) {
        return ok({
          type: "chat_response",
          id: message.id,
          payload: {
            content: result.value.content,
            model: result.value.model,
            usage: result.value.usage,
          },
        });
      }

      return err(new GatewayError(
        result.error.message,
        "PROVIDER_ERROR",
        client.id
      ));
    }

    case "agent_spawn": {
      const payloadResult = AgentSpawnPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid spawn payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const payload = payloadResult.data;
      const manifest = payload.manifest;

      if (!manifest) {
        return err(new GatewayError(
          "Agent manifest required",
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const signingSecret = process.env.MANIFEST_SIGNING_SECRET;
      const requireSignature = parseBoolean(
        process.env.REQUIRE_MANIFEST_SIGNATURE,
        process.env.NODE_ENV === "production"
      );
      if (signingSecret && signingSecret.trim().length > 0) {
        const verification = verifyManifestSignature(manifest, signingSecret);
        if (!verification.ok) {
          return err(new GatewayError(
            verification.message ?? "Manifest signature verification failed",
            "AUTH_ERROR",
            client.id
          ));
        }
      } else if (requireSignature) {
        return err(new GatewayError(
          "Manifest signing secret not configured",
          "AUTH_ERROR",
          client.id
        ));
      }

      const agentId = isUuid(manifest.id) ? manifest.id : randomUUID();
      const existingAgent = findAgentById(agents, manifest.id);
      if (existingAgent) {
        return err(new GatewayError(
          `Agent already exists: ${existingAgent.id}`,
          "AGENT_ERROR",
          client.id,
          existingAgent.id
        ));
      }
      const permissionResult = collectPermissions(manifest);
      if (!permissionResult.ok) {
        return err(new GatewayError(
          `Invalid permissions: ${permissionResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }
      const permissionGrants = permissionResult.value;
      const trustLevel: TrustLevel = manifest.trustLevel ?? "monitored-autonomous";
      let permissionTokenId: string | undefined;
      const mcpAllowlist = normalizeMcpAllowlist(manifest.mcpServers);

      const a2aSkills = manifest.a2aSkills ?? [];
      const a2aValidators = new Map<string, ValidateFunction>();
      for (const skill of a2aSkills) {
        if (!skill.inputSchema) continue;
        try {
          const validator = ajv.compile(skill.inputSchema);
          a2aValidators.set(skill.id, validator);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return err(new GatewayError(
            `Invalid A2A input schema for skill ${skill.id}: ${message}`,
            "VALIDATION_ERROR",
            client.id
          ));
        }
      }

      if (permissionGrants.length > 0) {
        const grantResult = permissionManager.grant(
          {
            agentId,
            permissions: permissionGrants,
            purpose: "manifest",
            durationMs: resolvePermissionDurationMs(),
            delegatable: false,
          },
          "system"
        );

        if (!grantResult.ok) {
          return err(new GatewayError(
            `Failed to grant permissions: ${grantResult.error.message}`,
            "AGENT_ERROR",
            client.id,
            agentId
          ));
        }

        permissionTokenId = grantResult.value.id;
      }

      const entry: AgentEntry = {
        id: agentId,
        externalId: manifest.id,
        name: manifest.name,
        nodeId: clusterNodeId ?? undefined,
        state: "ready",
        startedAt: Date.now(),
        model: manifest.preferredModel ?? manifest.model,
        entryPoint: manifest.entryPoint,
        capabilities: manifest.capabilities ?? [],
        permissions: manifest.permissions ?? [],
        mcpServers: mcpAllowlist.length > 0 ? mcpAllowlist : undefined,
        permissionGrants,
        trustLevel,
        permissionTokenId,
        limits: manifest.limits ?? {},
        usageWindow: {
          windowStart: Date.now(),
          requestsThisMinute: 0,
          toolCallsThisMinute: 0,
          tokensThisMinute: 0,
        },
        costUsageUSD: 0,
        a2aSkills,
        a2aValidators,
        errorCount: 0,
        workerReady: false,
        workerTasks: new Map(),
        restartAttempts: 0,
        restartBackoffMs: 0,
        shutdownRequested: false,
        tools: manifest.tools ?? [],
        tokenUsage: { input: 0, output: 0 },
      };

      agents.set(agentId, entry);
      log.info("Agent spawned", { agentId, name: manifest.name });

      if (manifest.entryPoint) {
        startAgentWorker(entry, manifest.entryPoint, log, memoryLimitMb);
      }
      if (manifest.id === "monitor" && manifest.entryPoint) {
        scheduleMonitorAgent(entry, monitorIntervalMs, jobRunner, taskContext);
      }

      if (db) {
        await upsertAgentRecord(db, agentId, manifest, entry.state, log, clusterNodeId);
        await recordAuditLog(
          db,
          {
            action: "agent.spawn",
            resourceType: "agent",
            resourceId: agentId,
            actorId: client.id,
            details: {
              name: manifest.name,
              model: manifest.preferredModel ?? manifest.model,
              trustLevel,
              permissions: manifest.permissions ?? [],
              hasEntryPoint: !!manifest.entryPoint,
            },
            outcome: "success",
          },
          log
        );
      }

      // Publish event
      await eventBus.publish({
        id: createEventId(),
        channel: "agent.lifecycle",
        type: "agent.created",
        timestamp: new Date(),
        agentId,
        data: {
          state: "ready",
          manifest: { name: manifest.name, model: manifest.preferredModel ?? manifest.model },
        },
      });

      return ok({
        type: "agent_spawn_result",
        id: message.id,
        payload: { agentId, externalId: manifest.id, status: "ready" },
      });
    }

    case "agent_terminate": {
      const payloadResult = AgentTerminatePayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid terminate payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const { agentId } = payloadResult.data;
      const agent = findAgentById(agents, agentId);

      if (!agent) {
        if (clusterNodeId && db) {
          const { nodeId } = await resolveAgentNode(db, agentId);
          if (nodeId && nodeId !== clusterNodeId) {
            const wsUrl = await resolveClusterNodeUrl(db, nodeId);
            if (wsUrl) {
              try {
                const forwarded = await forwardClusterMessage(wsUrl, message, log);
                return ok(forwarded);
              } catch (error) {
                return err(new GatewayError(
                  `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                  "CLUSTER_FORWARD_FAILED",
                  client.id,
                  agentId
                ));
              }
            }
          }
        }
        return err(new GatewayError(
          `Agent not found: ${agentId}`,
          "NOT_FOUND",
          client.id,
          agentId
        ));
      }

      if (agent.state === "terminated") {
        return err(new GatewayError(
          `Agent terminated: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }
      if (agent.state === "error") {
        return err(new GatewayError(
          `Agent in error state: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }
      if (agent.state === "paused") {
        return err(new GatewayError(
          `Agent is paused: ${agentId}`,
          "AGENT_ERROR",
          client.id,
          agentId
        ));
      }

      const previousState = agent.state;
      agent.state = "terminated";
      agent.shutdownRequested = true;
      if (agent.externalId === "monitor") {
        unscheduleMonitorAgent(agent.id, jobRunner);
      }
      if (agent.worker) {
        try {
          agent.worker.send({ type: "shutdown" });
          setTimeout(() => {
            if (agent.worker) {
              agent.worker.kill("SIGKILL");
            }
          }, 5000);
        } catch (error) {
          log.warn("Failed to shutdown agent worker", { agentId, error: String(error) });
        }
      }
      agents.delete(agent.id);
      permissionManager.revokeAll(agent.id);
      log.info("Agent terminated", { agentId });

      if (db) {
        await updateAgentState(db, agent.id, "terminated", log, { fromState: previousState });
        await recordAuditLog(
          db,
          {
            action: "agent.terminate",
            resourceType: "agent",
            resourceId: agent.id,
            actorId: client.id,
            details: {
              name: agent.name,
              previousState,
              trustLevel: agent.trustLevel,
              uptimeMs: Date.now() - agent.startedAt,
            },
            outcome: "success",
          },
          log
        );
      }

      // Publish event
      await eventBus.publish({
        id: createEventId(),
        channel: "agent.lifecycle",
        type: "agent.terminated",
        timestamp: new Date(),
        agentId,
        data: { state: "terminated", previousState },
      });

      return ok({
        type: "agent_terminate_result",
        id: message.id,
        payload: { agentId, success: true },
      });
    }

    case "agent_status": {
      const agentId = (message.payload as { agentId?: string } | undefined)?.agentId;
      if (agentId) {
        const agent = findAgentById(agents, agentId);
        if (!agent) {
          if (clusterNodeId && db) {
            const { nodeId } = await resolveAgentNode(db, agentId);
            if (nodeId && nodeId !== clusterNodeId) {
              const wsUrl = await resolveClusterNodeUrl(db, nodeId);
              if (wsUrl) {
                try {
                  const forwarded = await forwardClusterMessage(wsUrl, message, log);
                  return ok(forwarded);
                } catch (error) {
                  return err(new GatewayError(
                    `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                    "CLUSTER_FORWARD_FAILED",
                    client.id,
                    agentId
                  ));
                }
              }
            }

            const rows = await db.query<{
              id: string;
              name: string;
              state: string;
              created_at: Date;
              node_id?: string;
              metadata?: Record<string, unknown>;
              total_input_tokens?: number | string;
              total_output_tokens?: number | string;
            }>((sql) => sql`
              SELECT id, name, state, created_at, node_id, metadata,
                     total_input_tokens, total_output_tokens
              FROM agents
              WHERE id = ${agentId}
                 OR metadata->>'manifestId' = ${agentId}
              ORDER BY created_at DESC
              LIMIT 1
            `);
            const row = rows[0];
            if (row) {
              const metadata = normalizeRecord(row.metadata);
              const limits = normalizeRecord(metadata.limits);
              return ok({
                type: "agent_status",
                id: message.id,
                payload: {
                  agentId: row.id,
                  externalId: metadata.manifestId ?? row.id,
                  name: row.name,
                  state: row.state,
                  uptime: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
                  model: metadata.model,
                  capabilities: Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
                  permissions: Array.isArray(metadata.permissions) ? metadata.permissions : [],
                  permissionGrants: Array.isArray(metadata.permissionGrants)
                    ? metadata.permissionGrants
                    : [],
                  trustLevel: metadata.trustLevel ?? "monitored-autonomous",
                  limits,
                  tokenUsage: {
                    input: toNumber(row.total_input_tokens, 0),
                    output: toNumber(row.total_output_tokens, 0),
                  },
                  nodeId: row.node_id,
                },
              });
            }
          }

          return err(new GatewayError(
            `Agent not found: ${agentId}`,
            "NOT_FOUND",
            client.id,
            agentId
          ));
        }

        return ok({
          type: "agent_status",
          id: message.id,
          payload: {
            agentId: agent.id,
            externalId: agent.externalId,
            name: agent.name,
            state: agent.state,
            uptime: Math.floor((Date.now() - agent.startedAt) / 1000),
            model: agent.model,
            capabilities: agent.capabilities,
            permissions: agent.permissions,
            trustLevel: agent.trustLevel,
            limits: agent.limits,
            tokenUsage: agent.tokenUsage,
          },
        });
      }

      if (clusterNodeId && db) {
        const agentsList = await listAgentsFromDatabase(db);
        return ok({
          type: "agent_list",
          id: message.id,
          payload: {
            agents: agentsList,
            count: agentsList.length,
          },
        });
      }

      return ok({
        type: "agent_list",
        id: message.id,
        payload: {
          agents: Array.from(agents.values()).map((a) => ({
            id: a.id,
            externalId: a.externalId,
            name: a.name,
            state: a.state,
            uptime: Math.floor((Date.now() - a.startedAt) / 1000),
            model: a.model,
            capabilities: a.capabilities,
            permissions: a.permissions,
            trustLevel: a.trustLevel,
            limits: a.limits,
            tokenUsage: a.tokenUsage,
          })),
          count: agents.size,
        },
      });
    }

    case "agent_task": {
      const payloadResult = AgentTaskPayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid task payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const {
        agentId,
        task,
        internal,
        internalToken,
      } = payloadResult.data;
      const isInternal = Boolean(internal);
      const agent = findAgentById(agents, agentId);

      if (!agent) {
        if (clusterNodeId && db) {
          const { nodeId } = await resolveAgentNode(db, agentId);
          if (nodeId && nodeId !== clusterNodeId) {
            const wsUrl = await resolveClusterNodeUrl(db, nodeId);
            if (wsUrl) {
              try {
                const forwarded = await forwardClusterMessage(wsUrl, message, log);
                return ok(forwarded);
              } catch (error) {
                return err(new GatewayError(
                  `Cluster forward failed: ${error instanceof Error ? error.message : String(error)}`,
                  "CLUSTER_FORWARD_FAILED",
                  client.id,
                  agentId
                ));
              }
            }
          }
        }

        return err(new GatewayError(
          `Agent not found: ${agentId}`,
          "NOT_FOUND",
          client.id,
          agentId
        ));
      }

      if (isInternal) {
        const expectedToken = resolveInternalTaskToken();
        if (expectedToken && internalToken !== expectedToken) {
          return err(new GatewayError(
            "Invalid internal task token",
            "AUTH_ERROR",
            client.id,
            agentId
          ));
        }
      }

      const previousState = agent.state;
      agent.state = "running";
      if (db) {
        await updateAgentState(db, agent.id, "running", log, { fromState: previousState });
      }

      try {
        const maxTimeoutMs = resolveMaxAgentTaskTimeoutMs();
        const requestedTimeoutMs = typeof (task as { timeoutMs?: unknown }).timeoutMs === "number"
          ? Number((task as { timeoutMs?: unknown }).timeoutMs)
          : maxTimeoutMs;
        const timeoutMs = Math.min(requestedTimeoutMs, maxTimeoutMs);

        if (agent.entryPoint && !agent.worker) {
          log.warn("Agent entryPoint configured but worker not running; falling back to gateway task handler", {
            agentId: agent.id,
            entryPoint: agent.entryPoint,
          });
        }

        // Gateway-level infrastructure tasks are always handled by the gateway,
        // even when the agent has a running worker process. These tasks need
        // direct access to the memory store, database, and other gateway services.
        const GATEWAY_HANDLED_TASKS = new Set([
          "store_fact", "record_episode", "search_memory",
          "list_tools", "invoke_tool", "emit_event",
          "agent_directory", "a2a_delegate",
        ]);
        const taskType = typeof (task as { type?: unknown }).type === "string"
          ? (task as { type: string }).type
          : "";
        const isGatewayTask = GATEWAY_HANDLED_TASKS.has(taskType);
        const shouldUseWorker = agent.entryPoint && agent.worker && !isInternal && !isGatewayTask;
        const result = shouldUseWorker
          ? await sendTaskToWorker(agent, task, timeoutMs, log)
          : await handleAgentTask(task, agent, {
              router,
              memory,
              log,
              db,
              eventBus,
              agents,
              toolRegistry,
              permissionManager,
              a2aTasks,
              allowedPaths,
              allowedDomains,
              allowedCommands,
              allowAllPaths,
              allowAllDomains,
              allowAllCommands,
              memoryLimitMb,
            });
        agent.state = "ready";
        agent.errorCount = 0;
        if (db) {
          await updateAgentState(db, agent.id, "ready", log, { fromState: "running" });
        }

        return ok({
          type: "agent_task_result",
          id: message.id,
          payload: {
            agentId,
            status: "ok",
            result,
          },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error("Agent task failed", { agentId, error: errorMsg });
        agent.errorCount += 1;
        const maxErrors = resolveMaxAgentErrors();
        if (agent.errorCount >= maxErrors) {
          agent.state = "error";
          log.warn("Agent error threshold exceeded", {
            agentId,
            errorCount: agent.errorCount,
            maxErrors,
          });

          if (db) {
            await recordEvent(
              db,
              "agent.error.threshold",
              "gateway",
              { agentId, errorCount: agent.errorCount, maxErrors },
              log,
              { agentId }
            );
          }
          await eventBus.publish({
            id: createEventId(),
            channel: "alerts",
            type: "agent.error.threshold",
            timestamp: new Date(),
            agentId: agent.id,
            data: { errorCount: agent.errorCount, maxErrors },
          });
        } else {
          agent.state = previousState === "running" ? "ready" : previousState;
        }
        if (db) {
          await updateAgentState(db, agent.id, agent.state, log, { fromState: "running", reason: errorMsg });
        }

        return ok({
          type: "agent_task_result",
          id: message.id,
          payload: {
            agentId,
            status: "error",
            error: errorMsg,
          },
        });
      }
    }

    case "subscribe": {
      const payloadResult = SubscribePayloadSchema.safeParse(message.payload);
      if (!payloadResult.success) {
        return err(new GatewayError(
          `Invalid subscribe payload: ${payloadResult.error.message}`,
          "VALIDATION_ERROR",
          client.id
        ));
      }

      const { channels } = payloadResult.data;
      client.subscriptions = client.subscriptions ?? [];
      client.subscriptions.push(...channels);

      log.debug("Client subscribed", { clientId: client.id, channels });

      return ok({
        type: "subscribe",
        id: message.id,
        payload: { channels, success: true },
      });
    }

    default:
      return err(new GatewayError(
        `Unhandled message type: ${message.type}`,
        "VALIDATION_ERROR",
        client.id
      ));
  }
}
