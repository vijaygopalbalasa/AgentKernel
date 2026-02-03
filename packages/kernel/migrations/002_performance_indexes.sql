-- Performance indexes for high-traffic query patterns
-- These composite indexes optimize the most common gateway queries at scale

-- Agent lookups by state + last activity (used by monitor/scheduler)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_state_last_active
    ON agents(state, last_active_at DESC);

-- Events: agent-scoped time-range queries (audit log, event replay)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_agent_created
    ON events(agent_id, created_at DESC);

-- Events: type-scoped time-range queries (alerting, monitoring)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_type_created
    ON events(type, created_at DESC);

-- Tasks: status-scoped queries with time ordering (task scheduler, dashboard)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_status_created
    ON tasks(status, created_at DESC);

-- Tasks: assigned agent lookups filtered by status (worker polling)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_assigned_status
    ON tasks(assigned_agent_id, status);

-- Task messages: pagination within a task (chat history)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_messages_task_created
    ON task_messages(task_id, created_at DESC);

-- Episodic memories: agent-scoped recency queries (memory retrieval)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_episodic_agent_created
    ON episodic_memories(agent_id, created_at DESC);

-- Episodic memories: importance-weighted retrieval per agent
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_episodic_agent_importance
    ON episodic_memories(agent_id, importance DESC);

-- Capability tokens: validity lookups (permission checks at request time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_capability_tokens_agent_valid
    ON capability_tokens(agent_id, valid_until)
    WHERE revoked_at IS NULL;

-- Agent permissions: active permission lookups (authorization checks)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_permissions_agent_expires
    ON agent_permissions(agent_id, expires_at)
    WHERE expires_at IS NULL OR expires_at > NOW();

-- Skills: active skills per agent (skill loading)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_agent_status
    ON skills(agent_id, status);
