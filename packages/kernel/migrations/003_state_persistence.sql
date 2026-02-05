-- State Persistence Additions
-- Adds agent state, capability tokens, and rate limit bucket tables

-- Agent state persistence table
CREATE TABLE IF NOT EXISTS agent_state (
    agent_id TEXT PRIMARY KEY,
    state JSONB NOT NULL DEFAULT '{}',
    lifecycle_status TEXT NOT NULL DEFAULT 'created',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_state_lifecycle ON agent_state(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_agent_state_updated ON agent_state(updated_at);

-- Capability tokens table (secure token-based capability grants)
CREATE TABLE IF NOT EXISTS capability_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted_by TEXT NOT NULL DEFAULT 'system',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    constraints JSONB
);

CREATE INDEX IF NOT EXISTS idx_capability_tokens_agent ON capability_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_capability_tokens_token ON capability_tokens(token);
CREATE INDEX IF NOT EXISTS idx_capability_tokens_capability ON capability_tokens(capability);
CREATE INDEX IF NOT EXISTS idx_capability_tokens_active ON capability_tokens(agent_id, capability)
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW());

-- Rate limit buckets table (token bucket state persistence)
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    agent_id TEXT NOT NULL,
    bucket_type TEXT NOT NULL,
    tokens REAL NOT NULL DEFAULT 0,
    capacity REAL NOT NULL DEFAULT 60,
    refill_rate REAL NOT NULL DEFAULT 1,
    last_refill TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, bucket_type)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_agent ON rate_limit_buckets(agent_id);
