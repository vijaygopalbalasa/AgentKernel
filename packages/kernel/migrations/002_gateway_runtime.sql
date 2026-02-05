-- Gateway Runtime Additions
-- Adds audit logging, provider usage tracking, and soft-delete columns

-- Add runtime columns to agents
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS pid INTEGER,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Audit log table for security-sensitive operations
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(255) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    actor_id TEXT,
    details JSONB NOT NULL DEFAULT '{}',
    outcome VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- Provider usage log for LLM requests
CREATE TABLE IF NOT EXISTS provider_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    provider VARCHAR(100) NOT NULL DEFAULT 'unknown',
    model VARCHAR(255) NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_agent_id ON provider_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage(provider);
CREATE INDEX IF NOT EXISTS idx_provider_usage_created_at ON provider_usage(created_at);
