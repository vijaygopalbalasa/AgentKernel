const gatewayHost = import.meta.env.VITE_GATEWAY_HOST || window.location.hostname;
const gatewayPort = Number(import.meta.env.VITE_GATEWAY_PORT || 18800);
const wsUrl = `ws://${gatewayHost}:${gatewayPort}`;
const healthUrl = `http://${gatewayHost}:${gatewayPort + 1}/health`;
const metricsUrl = `http://${gatewayHost}:${gatewayPort + 1}/metrics`;

const connectionStatusEl = document.getElementById("connection-status");
const gatewayStatusEl = document.getElementById("gateway-status");
const providerCountEl = document.getElementById("provider-count");
const agentCountEl = document.getElementById("agent-count");
const agentListEl = document.getElementById("agent-list");
const eventStreamEl = document.getElementById("event-stream");
const refreshBtn = document.getElementById("refresh-btn");
const refreshMetricsBtn = document.getElementById("refresh-metrics-btn");
const metricInputBar = document.getElementById("metric-input-bar");
const metricOutputBar = document.getElementById("metric-output-bar");
const metricCostBar = document.getElementById("metric-cost-bar");
const metricInputValue = document.getElementById("metric-input-value");
const metricOutputValue = document.getElementById("metric-output-value");
const metricCostValue = document.getElementById("metric-cost-value");
const authTokenInput = document.getElementById("auth-token-input");
const saveTokenBtn = document.getElementById("save-token-btn");
const operatorAgentSelect = document.getElementById("operator-agent-select");
const operatorAgentInput = document.getElementById("operator-agent-input");
const setOperatorBtn = document.getElementById("set-operator-btn");
const forumCountEl = document.getElementById("forum-count");
const jobCountEl = document.getElementById("job-count");
const reputationScoreEl = document.getElementById("reputation-score");
const directoryQueryInput = document.getElementById("directory-query-input");
const directoryStatusInput = document.getElementById("directory-status-input");
const directoryLimitInput = document.getElementById("directory-limit-input");
const directoryOffsetInput = document.getElementById("directory-offset-input");
const socialListEl = document.getElementById("social-list");
const governanceListEl = document.getElementById("governance-list");
const refreshSocialBtn = document.getElementById("refresh-social-btn");
const refreshGovernanceBtn = document.getElementById("refresh-governance-btn");
const caseSubjectInput = document.getElementById("case-subject-input");
const casePolicyInput = document.getElementById("case-policy-input");
const caseReasonInput = document.getElementById("case-reason-input");
const openCaseBtn = document.getElementById("open-case-btn");
const sanctionSubjectInput = document.getElementById("sanction-subject-input");
const sanctionTypeSelect = document.getElementById("sanction-type-select");
const applySanctionBtn = document.getElementById("apply-sanction-btn");
const resolveCaseInput = document.getElementById("resolve-case-input");
const resolveCaseStatusInput = document.getElementById("resolve-case-status-input");
const resolveCaseNotesInput = document.getElementById("resolve-case-notes-input");
const resolveCaseBtn = document.getElementById("resolve-case-btn");
const liftSanctionInput = document.getElementById("lift-sanction-input");
const liftSanctionBtn = document.getElementById("lift-sanction-btn");
const appealCaseInput = document.getElementById("appeal-case-input");
const appealReasonInput = document.getElementById("appeal-reason-input");
const openAppealBtn = document.getElementById("open-appeal-btn");
const resolveAppealInput = document.getElementById("resolve-appeal-input");
const resolveAppealStatusInput = document.getElementById("resolve-appeal-status-input");
const resolveAppealNotesInput = document.getElementById("resolve-appeal-notes-input");
const resolveAppealBtn = document.getElementById("resolve-appeal-btn");
const permissionListEl = document.getElementById("permission-list");
const capabilityAgentInput = document.getElementById("capability-agent-input");
const capabilityListBtn = document.getElementById("capability-list-btn");
const capabilityGrantPermissionsInput = document.getElementById("capability-grant-permissions");
const capabilityGrantPurposeInput = document.getElementById("capability-grant-purpose");
const capabilityGrantDurationInput = document.getElementById("capability-grant-duration");
const capabilityGrantBtn = document.getElementById("capability-grant-btn");
const capabilityRevokeInput = document.getElementById("capability-revoke-input");
const capabilityRevokeBtn = document.getElementById("capability-revoke-btn");
const capabilityRevokeAllBtn = document.getElementById("capability-revoke-all-btn");
const capabilityListEl = document.getElementById("capability-list");
const auditActionInput = document.getElementById("audit-action-input");
const auditActorInput = document.getElementById("audit-actor-input");
const auditLimitInput = document.getElementById("audit-limit-input");
const refreshAuditBtn = document.getElementById("refresh-audit-btn");
const auditListEl = document.getElementById("audit-list");
const lockdownPolicyInput = document.getElementById("lockdown-policy-input");
const enableLockdownBtn = document.getElementById("enable-lockdown-btn");
const disableLockdownBtn = document.getElementById("disable-lockdown-btn");
const incidentStatusEl = document.getElementById("incident-status");

const state = {
  agents: [],
  events: [],
  authToken: window.localStorage.getItem("gatewayAuthToken") || "",
  operatorAgentId: window.localStorage.getItem("operatorAgentId") || "",
};

authTokenInput.value = state.authToken;
operatorAgentInput.value = state.operatorAgentId;

let ws = null;
let wsReady = false;
const pendingRequests = new Map();

const setConnectionStatus = (status, tone = "info") => {
  connectionStatusEl.textContent = status;
  connectionStatusEl.style.color = tone === "ok" ? "var(--success)" : "var(--accent)";
  connectionStatusEl.style.background =
    tone === "ok"
      ? "rgba(66, 211, 146, 0.18)"
      : "rgba(124, 156, 255, 0.2)";
};

const renderAgents = () => {
  if (!state.agents.length) {
    agentListEl.innerHTML = `<p class="subhead">No agents running yet.</p>`;
    operatorAgentSelect.innerHTML = "<option value=\"\">No agents available</option>";
    return;
  }

  agentListEl.innerHTML = "";
  state.agents.forEach((agent) => {
    const card = document.createElement("div");
    card.className = "agent-card";

    const header = document.createElement("header");
    const name = document.createElement("div");
    name.className = "agent-name";
    name.textContent = agent.name || agent.id;

    const stateTag = document.createElement("span");
    stateTag.className = `tag ${agent.state === "error" ? "danger" : agent.state === "running" ? "warning" : ""}`;
    stateTag.textContent = agent.state;

    header.appendChild(name);
    header.appendChild(stateTag);

    const meta = document.createElement("div");
    meta.className = "agent-meta";
    meta.innerHTML = `
      <span>ID: ${agent.externalId || agent.id}</span>
      <span>Trust: ${agent.trustLevel || "monitored-autonomous"}</span>
      <span>Uptime: ${agent.uptime}s</span>
    `;

    const limits = agent.limits || {};
    const limitText = Object.keys(limits).length
      ? `Limits: ${Object.entries(limits)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`
      : "Limits: default";

    const limitRow = document.createElement("div");
    limitRow.className = "agent-meta";
    limitRow.innerHTML = `<span>${limitText}</span>`;

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(limitRow);
    agentListEl.appendChild(card);
  });

  operatorAgentSelect.innerHTML = "<option value=\"\">Select agent</option>";
  state.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.name || agent.id} (${agent.externalId || agent.id})`;
    if (agent.id === state.operatorAgentId || agent.externalId === state.operatorAgentId) {
      option.selected = true;
    }
    operatorAgentSelect.appendChild(option);
  });
};

const renderPermissions = () => {
  if (!state.agents.length) {
    permissionListEl.innerHTML = `<p class="subhead">No agents available.</p>`;
    return;
  }

  permissionListEl.innerHTML = "";
  state.agents.forEach((agent) => {
    const permissions = Array.isArray(agent.permissions) ? agent.permissions : [];
    const grants = Array.isArray(agent.permissionGrants) ? agent.permissionGrants : [];
    const summary = permissions.length ? permissions.join(", ") : "No explicit permissions";
    const grantCount = grants.length ? `${grants.length} grants` : "No grants";

    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <strong>${agent.name || agent.id}</strong>
      <small>Trust: ${agent.trustLevel || "monitored-autonomous"} · ${grantCount}</small>
      <small>Permissions: ${summary}</small>
      <button class="ghost-btn" data-agent-id="${agent.id}">Quarantine</button>
    `;
    permissionListEl.appendChild(item);
  });
};

const renderCapabilities = (tokens = []) => {
  if (!tokens.length) {
    capabilityListEl.innerHTML = `<p class="subhead">No capability tokens.</p>`;
    return;
  }

  capabilityListEl.innerHTML = "";
  tokens.forEach((token) => {
    const el = document.createElement("div");
    el.className = "list-item";
    const perms = Array.isArray(token.permissions)
      ? token.permissions
          .map((perm) => `${perm.category}.${perm.actions?.join("|")}${perm.resource ? `:${perm.resource}` : ""}`)
          .join(", ")
      : "—";
    el.innerHTML = `
      <strong>${token.id}</strong>
      <small>Agent: ${token.agentId} · Expires: ${token.expiresAt ? new Date(token.expiresAt).toLocaleString() : "—"}</small>
      <small>Permissions: ${perms}</small>
      <button class="ghost-btn" data-token-id="${token.id}">Revoke</button>
    `;
    capabilityListEl.appendChild(el);
  });
};

const renderAudit = (entries) => {
  if (!entries.length) {
    auditListEl.innerHTML = `<p class="subhead">No audit entries.</p>`;
    return;
  }

  auditListEl.innerHTML = "";
  entries.forEach((entry) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `
      <strong>${entry.action}</strong>
      <small>Actor: ${entry.actor_id || "—"} · Resource: ${entry.resource_type || "—"} · Outcome: ${entry.outcome}</small>
      <small>${new Date(entry.created_at).toLocaleString()}</small>
    `;
    auditListEl.appendChild(el);
  });
};

const renderEvents = () => {
  if (!state.events.length) {
    eventStreamEl.innerHTML = `<p class="subhead">Waiting for events…</p>`;
    return;
  }

  eventStreamEl.innerHTML = "";
  state.events.forEach((event) => {
    const item = document.createElement("div");
    item.className = "event-item";
    item.innerHTML = `
      <strong>${event.type}</strong>
      <div>${event.summary}</div>
      <small>${event.timestamp}</small>
    `;
    eventStreamEl.appendChild(item);
  });
};

const pushEvent = (event) => {
  state.events.unshift(event);
  state.events = state.events.slice(0, 50);
  renderEvents();
};

const fetchHealth = async () => {
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      gatewayStatusEl.textContent = "offline";
      return;
    }
    const data = await response.json();
    gatewayStatusEl.textContent = data.status;
    providerCountEl.textContent = data.providers?.length ?? "—";
    agentCountEl.textContent = data.agents ?? "—";
  } catch {
    gatewayStatusEl.textContent = "offline";
  }
};

const parseMetric = (text, name) => {
  const match = text.match(new RegExp(`${name} ([0-9.]+)`));
  return match ? Number(match[1]) : 0;
};

const scaleBar = (value) => {
  if (value <= 0) return 0;
  const scaled = Math.log10(value + 1) / 6;
  return Math.min(100, Math.max(2, scaled * 100));
};

const fetchMetrics = async () => {
  try {
    const response = await fetch(metricsUrl);
    if (!response.ok) {
      metricInputValue.textContent = "—";
      metricOutputValue.textContent = "—";
      metricCostValue.textContent = "—";
      return;
    }
    const text = await response.text();
    const input = parseMetric(text, "agent_os_tokens_input_total");
    const output = parseMetric(text, "agent_os_tokens_output_total");
    const cost = parseMetric(text, "agent_os_cost_usd_total");

    metricInputValue.textContent = input.toLocaleString();
    metricOutputValue.textContent = output.toLocaleString();
    metricCostValue.textContent = `$${cost.toFixed(4)}`;

    metricInputBar.style.width = `${scaleBar(input)}%`;
    metricOutputBar.style.width = `${scaleBar(output)}%`;
    metricCostBar.style.width = `${scaleBar(cost)}%`;
  } catch {
    metricInputValue.textContent = "—";
    metricOutputValue.textContent = "—";
    metricCostValue.textContent = "—";
  }
};

const sendRequest = (message) => {
  if (!ws) {
    return Promise.reject(new Error("No active connection"));
  }
  return new Promise((resolve, reject) => {
    const messageId = message.id;
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(messageId);
      reject(new Error("Request timeout"));
    }, 10000);

    pendingRequests.set(messageId, { resolve, reject, timeoutId });
    ws.send(JSON.stringify(message));
  });
};

const connect = () => {
  if (ws) {
    ws.close();
  }
  wsReady = false;
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.addEventListener("open", () => {
    if (state.authToken) {
      socket.send(
        JSON.stringify({
          type: "auth",
          id: `auth-${Date.now()}`,
          payload: { token: state.authToken },
        })
      );
    } else {
      wsReady = true;
      setConnectionStatus("connected", "ok");
      socket.send(JSON.stringify({ type: "agent_status", id: `agents-${Date.now()}` }));
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: `sub-${Date.now()}`,
          payload: { channels: ["agent.lifecycle", "system", "audit", "*"] },
        })
      );
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("disconnected");
    wsReady = false;
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.id && pendingRequests.has(message.id)) {
        const pending = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        clearTimeout(pending.timeoutId);
        pending.resolve(message);
        return;
      }

      if (message.type === "auth_success") {
        wsReady = true;
        setConnectionStatus("connected", "ok");
        socket.send(JSON.stringify({ type: "agent_status", id: `agents-${Date.now()}` }));
        socket.send(
          JSON.stringify({
            type: "subscribe",
            id: `sub-${Date.now()}`,
            payload: { channels: ["agent.lifecycle", "system", "audit", "*"] },
          })
        );
        return;
      }

      if (message.type === "auth_required") {
        wsReady = false;
        setConnectionStatus("auth required");
        if (state.authToken) {
          socket.send(
            JSON.stringify({
              type: "auth",
              id: `auth-${Date.now()}`,
              payload: { token: state.authToken },
            })
          );
        }
        return;
      }

      if (message.type === "auth_failed") {
        wsReady = false;
        setConnectionStatus("auth failed");
        pushEvent({
          type: "auth",
          summary: message.payload?.message || "Auth failed",
          timestamp: new Date().toLocaleTimeString(),
        });
        return;
      }

      if (message.type === "agent_list" && message.payload) {
        state.agents = message.payload.agents || [];
        agentCountEl.textContent = message.payload.count ?? state.agents.length;
        renderAgents();
        renderPermissions();
        return;
      }

      if (message.type === "event" && message.payload) {
        const payload = message.payload;
        pushEvent({
          type: payload.type || "event",
          summary: payload.channel ? `${payload.channel} • ${payload.data ? JSON.stringify(payload.data) : ""}` : "",
          timestamp: new Date(payload.timestamp || Date.now()).toLocaleTimeString(),
        });
        return;
      }

      if (message.type === "error") {
        pushEvent({
          type: "error",
          summary: message.payload?.message || "Gateway error",
          timestamp: new Date().toLocaleTimeString(),
        });
      }
    } catch {
      // Ignore malformed messages
    }
  });

  return socket;
};

const sendAgentTask = async (task) => {
  if (!wsReady) {
    throw new Error("Not connected or authenticated");
  }
  if (!state.operatorAgentId) {
    throw new Error("Operator agent not set");
  }
  const response = await sendRequest({
    type: "agent_task",
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    payload: { agentId: state.operatorAgentId, task },
  });

  if (response.type === "agent_task_result") {
    if (response.payload?.status === "ok") {
      return response.payload.result;
    }
    throw new Error(response.payload?.error || "Task failed");
  }

  if (response.type === "error") {
    throw new Error(response.payload?.message || "Gateway error");
  }

  throw new Error("Unexpected response");
};

const renderSocial = (forums, jobs, reputation, reputations, directory) => {
  forumCountEl.textContent = forums.length.toString();
  jobCountEl.textContent = jobs.length.toString();
  reputationScoreEl.textContent = reputation?.score ?? 0;

  socialListEl.innerHTML = "";
  const items = [];

  directory.slice(0, 3).forEach((entry) => {
    items.push({
      title: `Agent: ${entry.name || entry.id}`,
      subtitle: `Reputation: ${entry.score ?? 0}`,
    });
  });

  forums.slice(0, 3).forEach((forum) => {
    items.push({
      title: `Forum: ${forum.name}`,
      subtitle: forum.description || "No description",
    });
  });

  jobs.slice(0, 3).forEach((job) => {
    items.push({
      title: `Job: ${job.title}`,
      subtitle: job.status ? `Status: ${job.status}` : "Open",
    });
  });

  reputations.slice(0, 3).forEach((entry) => {
    items.push({
      title: `Reputation: ${entry.agent_id}`,
      subtitle: `Score: ${entry.score}`,
    });
  });

  if (!items.length) {
    socialListEl.innerHTML = `<p class="subhead">No social data yet.</p>`;
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<strong>${item.title}</strong><small>${item.subtitle}</small>`;
    socialListEl.appendChild(el);
  });
};

const renderGovernance = (policies, cases, sanctions, appeals, audits) => {
  governanceListEl.innerHTML = "";
  const items = [];
  const formatEvidence = (value) => {
    if (!value || typeof value !== "object") return "No evidence";
    const keys = Object.keys(value);
    if (!keys.length) return "No evidence";
    return `Evidence: ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "…" : ""}`;
  };

  policies.slice(0, 3).forEach((policy) => {
    items.push({
      title: `Policy: ${policy.name}`,
      subtitle: `Status: ${policy.status || "active"}`,
    });
  });

  cases.slice(0, 3).forEach((moderationCase) => {
    const reason = moderationCase.reason ? `Reason: ${moderationCase.reason}` : "No reason";
    items.push({
      title: `Case: ${moderationCase.id}`,
      subtitle: `${moderationCase.status || "open"} · ${reason} · ${formatEvidence(moderationCase.evidence)}`,
    });
  });

  sanctions.slice(0, 3).forEach((sanction) => {
    items.push({
      title: `Sanction: ${sanction.type}`,
      subtitle: sanction.subject_agent_id ? `Subject: ${sanction.subject_agent_id}` : "—",
    });
  });

  appeals.slice(0, 3).forEach((appeal) => {
    const resolution = appeal.resolution ? `Resolution: ${appeal.resolution}` : "No resolution";
    items.push({
      title: `Appeal: ${appeal.id}`,
      subtitle: `${appeal.status || "open"} · ${resolution} · ${formatEvidence(appeal.evidence)}`,
    });
  });

  audits.slice(0, 3).forEach((entry) => {
    items.push({
      title: `Audit: ${entry.action || "event"}`,
      subtitle: entry.actor_id ? `Actor: ${entry.actor_id}` : "—",
    });
  });

  if (!items.length) {
    governanceListEl.innerHTML = `<p class="subhead">No governance data yet.</p>`;
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<strong>${item.title}</strong><small>${item.subtitle}</small>`;
    governanceListEl.appendChild(el);
  });
};

const fetchSocial = async () => {
  try {
    const query = directoryQueryInput.value.trim();
    const status = directoryStatusInput.value.trim();
    const limitValue = Number(directoryLimitInput.value);
    const offsetValue = Number(directoryOffsetInput.value);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 10;
    const offset = Number.isFinite(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
    const [forums, jobs, reputation, reputations, directory] = await Promise.all([
      sendAgentTask({ type: "forum_list", limit: 50 }),
      sendAgentTask({ type: "job_list", limit: 50 }),
      sendAgentTask({ type: "reputation_get" }),
      sendAgentTask({ type: "reputation_list", limit: 10 }),
      sendAgentTask({
        type: "agent_directory",
        limit,
        offset,
        query: query || undefined,
        status: status || undefined,
      }),
    ]);

    renderSocial(
      forums?.forums ?? [],
      jobs?.jobs ?? [],
      reputation?.reputation ?? {},
      reputations?.reputations ?? [],
      directory?.agents ?? []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    socialListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
};

const fetchGovernance = async () => {
  try {
    const [policies, cases, sanctions, appeals, audits] = await Promise.all([
      sendAgentTask({ type: "policy_list", limit: 50 }),
      sendAgentTask({ type: "moderation_case_list", limit: 50 }),
      sendAgentTask({ type: "sanction_list", limit: 50 }),
      sendAgentTask({ type: "appeal_list", limit: 50 }),
      sendAgentTask({ type: "audit_query", limit: 20 }),
    ]);

    renderGovernance(
      policies?.policies ?? [],
      cases?.cases ?? [],
      sanctions?.sanctions ?? [],
      appeals?.appeals ?? [],
      audits?.entries ?? []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
};

const fetchAudit = async () => {
  try {
    const action = auditActionInput.value.trim();
    const actorId = auditActorInput.value.trim();
    const limitValue = Number(auditLimitInput.value);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 50;
    const result = await sendAgentTask({
      type: "audit_query",
      action: action || undefined,
      actorId: actorId || undefined,
      limit,
    });
    renderAudit(result?.entries ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
};

const parseCapabilityPermissions = () => {
  const raw = capabilityGrantPermissionsInput.value || "";
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const fetchCapabilities = async () => {
  try {
    const agentId = capabilityAgentInput.value.trim() || state.operatorAgentId;
    if (!agentId) {
      capabilityListEl.innerHTML = `<p class="subhead">Provide an agent id.</p>`;
      return;
    }
    const result = await sendAgentTask({ type: "capability_list", agentId });
    renderCapabilities(result?.tokens ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capabilityListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
};

const getLockdownPolicy = async (name) => {
  const policies = await sendAgentTask({ type: "policy_list", limit: 100 });
  const list = policies?.policies ?? [];
  return list.find((policy) => policy.name === name);
};

const ensureLockdownPolicy = async (name) => {
  const existing = await getLockdownPolicy(name);
  if (existing) return existing;
  const policy = await sendAgentTask({
    type: "policy_create",
    name,
    description: "Global incident lockdown policy",
    rules: {
      rules: [
        {
          type: "deny",
          action: "tool.invoked",
          resourceType: "tool",
          reason: "Incident lockdown active",
          sanction: { type: "quarantine" },
        },
      ],
    },
  });
  return policy?.policy;
};

refreshBtn.addEventListener("click", () => {
  fetchHealth();
});

refreshMetricsBtn.addEventListener("click", () => {
  fetchMetrics();
});

saveTokenBtn.addEventListener("click", () => {
  state.authToken = authTokenInput.value.trim();
  window.localStorage.setItem("gatewayAuthToken", state.authToken);
  connect();
});

operatorAgentSelect.addEventListener("change", (event) => {
  operatorAgentInput.value = event.target.value;
});

setOperatorBtn.addEventListener("click", () => {
  state.operatorAgentId = operatorAgentInput.value.trim();
  window.localStorage.setItem("operatorAgentId", state.operatorAgentId);
  if (state.operatorAgentId) {
    fetchSocial();
    fetchGovernance();
    fetchAudit();
  }
});

refreshSocialBtn.addEventListener("click", () => {
  fetchSocial();
});

refreshGovernanceBtn.addEventListener("click", () => {
  fetchGovernance();
});

refreshAuditBtn.addEventListener("click", () => {
  fetchAudit();
});

capabilityListBtn.addEventListener("click", () => {
  fetchCapabilities();
});

capabilityGrantBtn.addEventListener("click", async () => {
  const agentId = capabilityAgentInput.value.trim() || state.operatorAgentId;
  if (!agentId) {
    capabilityListEl.innerHTML = `<p class="subhead">Provide an agent id.</p>`;
    return;
  }
  const permissions = parseCapabilityPermissions();
  if (!permissions.length) {
    capabilityListEl.innerHTML = `<p class="subhead">Provide at least one permission.</p>`;
    return;
  }
  const purpose = capabilityGrantPurposeInput.value.trim();
  const durationValue = Number(capabilityGrantDurationInput.value);
  const durationMs = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : undefined;
  try {
    await sendAgentTask({
      type: "capability_grant",
      agentId,
      permissions,
      purpose: purpose || undefined,
      durationMs,
    });
    capabilityGrantPermissionsInput.value = "";
    capabilityGrantPurposeInput.value = "";
    capabilityGrantDurationInput.value = "";
    fetchCapabilities();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capabilityListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

capabilityRevokeBtn.addEventListener("click", async () => {
  const tokenId = capabilityRevokeInput.value.trim();
  if (!tokenId) {
    capabilityListEl.innerHTML = `<p class="subhead">Provide a token id.</p>`;
    return;
  }
  try {
    await sendAgentTask({ type: "capability_revoke", tokenId });
    capabilityRevokeInput.value = "";
    fetchCapabilities();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capabilityListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

capabilityRevokeAllBtn.addEventListener("click", async () => {
  const agentId = capabilityAgentInput.value.trim() || state.operatorAgentId;
  if (!agentId) {
    capabilityListEl.innerHTML = `<p class="subhead">Provide an agent id.</p>`;
    return;
  }
  try {
    await sendAgentTask({ type: "capability_revoke_all", agentId });
    fetchCapabilities();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capabilityListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

capabilityListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!target || !target.dataset) return;
  const tokenId = target.dataset.tokenId;
  if (!tokenId) return;
  try {
    await sendAgentTask({ type: "capability_revoke", tokenId });
    fetchCapabilities();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capabilityListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

permissionListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!target || !target.dataset) return;
  const agentId = target.dataset.agentId;
  if (!agentId) return;
  try {
    await sendAgentTask({
      type: "sanction_apply",
      subjectAgentId: agentId,
      sanctionType: "quarantine",
    });
    permissionListEl.insertAdjacentHTML(
      "afterbegin",
      `<p class="subhead">Quarantined ${agentId}</p>`
    );
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    permissionListEl.insertAdjacentHTML(
      "afterbegin",
      `<p class="subhead">${message}</p>`
    );
  }
});

enableLockdownBtn.addEventListener("click", async () => {
  const name = lockdownPolicyInput.value.trim() || "Global Lockdown";
  incidentStatusEl.innerHTML = "";
  try {
    const policy = await ensureLockdownPolicy(name);
    if (policy?.id) {
      await sendAgentTask({
        type: "policy_set_status",
        policyId: policy.id,
        status: "active",
      });
      incidentStatusEl.innerHTML = `<p class="subhead">Lockdown enabled (${policy.id}).</p>`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    incidentStatusEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

disableLockdownBtn.addEventListener("click", async () => {
  const name = lockdownPolicyInput.value.trim() || "Global Lockdown";
  incidentStatusEl.innerHTML = "";
  try {
    const policy = await getLockdownPolicy(name);
    if (!policy?.id) {
      incidentStatusEl.innerHTML = `<p class="subhead">No policy found for ${name}</p>`;
      return;
    }
    await sendAgentTask({
      type: "policy_set_status",
      policyId: policy.id,
      status: "inactive",
    });
    incidentStatusEl.innerHTML = `<p class="subhead">Lockdown disabled (${policy.id}).</p>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    incidentStatusEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

openCaseBtn.addEventListener("click", async () => {
  const subjectAgentId = caseSubjectInput.value.trim();
  if (!subjectAgentId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide a subject agent id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "moderation_case_open",
      subjectAgentId,
      policyId: casePolicyInput.value.trim() || undefined,
      reason: caseReasonInput.value.trim() || undefined,
    });
    caseSubjectInput.value = "";
    casePolicyInput.value = "";
    caseReasonInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

applySanctionBtn.addEventListener("click", async () => {
  const subjectAgentId = sanctionSubjectInput.value.trim();
  if (!subjectAgentId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide a subject agent id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "sanction_apply",
      subjectAgentId,
      sanctionType: sanctionTypeSelect.value,
    });
    sanctionSubjectInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

resolveCaseBtn.addEventListener("click", async () => {
  const caseId = resolveCaseInput.value.trim();
  if (!caseId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide a case id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "moderation_case_resolve",
      caseId,
      status: resolveCaseStatusInput.value.trim() || undefined,
      resolution: resolveCaseNotesInput.value.trim() || undefined,
    });
    resolveCaseInput.value = "";
    resolveCaseStatusInput.value = "";
    resolveCaseNotesInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

liftSanctionBtn.addEventListener("click", async () => {
  const sanctionId = liftSanctionInput.value.trim();
  if (!sanctionId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide a sanction id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "sanction_lift",
      sanctionId,
    });
    liftSanctionInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

openAppealBtn.addEventListener("click", async () => {
  const caseId = appealCaseInput.value.trim();
  if (!caseId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide a case id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "appeal_open",
      caseId,
      reason: appealReasonInput.value.trim() || undefined,
    });
    appealCaseInput.value = "";
    appealReasonInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

resolveAppealBtn.addEventListener("click", async () => {
  const appealId = resolveAppealInput.value.trim();
  if (!appealId) {
    governanceListEl.innerHTML = `<p class="subhead">Provide an appeal id.</p>`;
    return;
  }
  try {
    await sendAgentTask({
      type: "appeal_resolve",
      appealId,
      status: resolveAppealStatusInput.value.trim() || undefined,
      resolution: resolveAppealNotesInput.value.trim() || undefined,
    });
    resolveAppealInput.value = "";
    resolveAppealStatusInput.value = "";
    resolveAppealNotesInput.value = "";
    fetchGovernance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    governanceListEl.innerHTML = `<p class="subhead">${message}</p>`;
  }
});

fetchHealth();
connect();
fetchMetrics();
