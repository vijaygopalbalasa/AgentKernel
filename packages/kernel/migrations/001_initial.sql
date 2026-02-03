-- Agent OS Initial Schema
-- This migration creates all core tables for the Agent OS system

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pg_trgm for text search
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================
-- AGENTS
-- ============================================

-- Agent registry table
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL DEFAULT '0.1.0',
    description TEXT,
    author VARCHAR(255),
    state VARCHAR(50) NOT NULL DEFAULT 'created',
    parent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

    -- Resource limits
    max_tokens_per_request INTEGER DEFAULT 4096,
    tokens_per_minute INTEGER DEFAULT 100000,
    max_memory_mb INTEGER DEFAULT 512,
    max_concurrent_requests INTEGER DEFAULT 10,
    cost_budget_usd DECIMAL(10, 4) DEFAULT 0,

    -- Resource usage
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    total_requests BIGINT DEFAULT 0,
    estimated_cost_usd DECIMAL(10, 4) DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ,

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_agents_name ON agents(name);
CREATE INDEX idx_agents_state ON agents(state);
CREATE INDEX idx_agents_parent_id ON agents(parent_id);
CREATE INDEX idx_agents_tags ON agents USING GIN(tags);
CREATE INDEX idx_agents_created_at ON agents(created_at);

-- Agent state history for audit trail
CREATE TABLE agent_state_history (
    id BIGSERIAL PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    from_state VARCHAR(50),
    to_state VARCHAR(50) NOT NULL,
    event VARCHAR(50) NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_state_history_agent_id ON agent_state_history(agent_id);
CREATE INDEX idx_agent_state_history_created_at ON agent_state_history(created_at);

-- ============================================
-- MEMORY (Episodic, Semantic, Procedural)
-- ============================================

-- Episodic memories (events/interactions)
CREATE TABLE episodic_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Content
    event TEXT NOT NULL,
    context TEXT NOT NULL,
    outcome TEXT,
    success BOOLEAN,
    valence DECIMAL(3, 2), -- -1.00 to 1.00

    -- Memory metrics
    importance DECIMAL(3, 2) NOT NULL DEFAULT 0.5,
    strength DECIMAL(3, 2) NOT NULL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,

    -- Relations
    session_id VARCHAR(255),
    related_episodes UUID[] DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_episodic_agent_id ON episodic_memories(agent_id);
CREATE INDEX idx_episodic_session_id ON episodic_memories(session_id);
CREATE INDEX idx_episodic_importance ON episodic_memories(importance);
CREATE INDEX idx_episodic_strength ON episodic_memories(strength);
CREATE INDEX idx_episodic_created_at ON episodic_memories(created_at);
CREATE INDEX idx_episodic_tags ON episodic_memories USING GIN(tags);

-- Semantic memories (facts/knowledge)
CREATE TABLE semantic_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Knowledge triple
    subject VARCHAR(512) NOT NULL,
    predicate VARCHAR(255) NOT NULL,
    object TEXT NOT NULL,
    confidence DECIMAL(3, 2) NOT NULL DEFAULT 0.8,

    -- Memory metrics
    importance DECIMAL(3, 2) NOT NULL DEFAULT 0.5,
    strength DECIMAL(3, 2) NOT NULL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,

    -- Source
    source VARCHAR(255),
    verified_at TIMESTAMPTZ,

    -- Relations
    related_concepts TEXT[] DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',

    -- Unique constraint on knowledge triple per agent
    UNIQUE(agent_id, subject, predicate, object)
);

CREATE INDEX idx_semantic_agent_id ON semantic_memories(agent_id);
CREATE INDEX idx_semantic_subject ON semantic_memories(subject);
CREATE INDEX idx_semantic_predicate ON semantic_memories(predicate);
CREATE INDEX idx_semantic_confidence ON semantic_memories(confidence);
CREATE INDEX idx_semantic_strength ON semantic_memories(strength);
CREATE INDEX idx_semantic_tags ON semantic_memories USING GIN(tags);
-- Full-text search index
CREATE INDEX idx_semantic_subject_trgm ON semantic_memories USING GIN(subject gin_trgm_ops);

-- Procedural memories (skills/workflows)
CREATE TABLE procedural_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Procedure definition
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    trigger TEXT NOT NULL,
    steps JSONB NOT NULL DEFAULT '[]',

    -- Parameters
    inputs JSONB DEFAULT '[]',
    outputs JSONB DEFAULT '[]',

    -- Memory metrics
    importance DECIMAL(3, 2) NOT NULL DEFAULT 0.5,
    strength DECIMAL(3, 2) NOT NULL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,

    -- Performance
    success_rate DECIMAL(3, 2) NOT NULL DEFAULT 1.0,
    execution_count INTEGER DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',

    -- Unique name per agent
    UNIQUE(agent_id, name)
);

CREATE INDEX idx_procedural_agent_id ON procedural_memories(agent_id);
CREATE INDEX idx_procedural_name ON procedural_memories(name);
CREATE INDEX idx_procedural_active ON procedural_memories(active);
CREATE INDEX idx_procedural_success_rate ON procedural_memories(success_rate);
CREATE INDEX idx_procedural_tags ON procedural_memories USING GIN(tags);

-- ============================================
-- PERMISSIONS & CAPABILITIES
-- ============================================

-- Permission definitions
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    category VARCHAR(100),
    risk_level VARCHAR(50) DEFAULT 'low', -- low, medium, high, critical
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent permission grants
CREATE TABLE agent_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,

    -- Grant details
    granted_by VARCHAR(255), -- 'system', 'user', or agent_id
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,

    -- Constraints
    constraints JSONB DEFAULT '{}',

    -- Audit
    last_used_at TIMESTAMPTZ,
    use_count INTEGER DEFAULT 0,

    UNIQUE(agent_id, permission_id)
);

CREATE INDEX idx_agent_permissions_agent_id ON agent_permissions(agent_id);
CREATE INDEX idx_agent_permissions_expires_at ON agent_permissions(expires_at);

-- Capability tokens (unforgeable)
CREATE TABLE capability_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,

    -- Token details
    token_hash VARCHAR(128) NOT NULL UNIQUE,

    -- Validity
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    -- Usage tracking
    max_uses INTEGER,
    current_uses INTEGER DEFAULT 0,

    -- Metadata
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_capability_tokens_agent_id ON capability_tokens(agent_id);
CREATE INDEX idx_capability_tokens_token_hash ON capability_tokens(token_hash);

-- ============================================
-- SKILLS
-- ============================================

-- Installed skills
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Skill info
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    description TEXT,
    author VARCHAR(255),

    -- State
    status VARCHAR(50) NOT NULL DEFAULT 'installed', -- installed, active, disabled, error

    -- Configuration
    config JSONB DEFAULT '{}',

    -- Timestamps
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',

    UNIQUE(agent_id, name)
);

CREATE INDEX idx_skills_agent_id ON skills(agent_id);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_status ON skills(status);

-- ============================================
-- TASKS & A2A COMMUNICATION
-- ============================================

-- Tasks (A2A protocol)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Task ownership
    owner_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

    -- Task details
    name VARCHAR(255) NOT NULL,
    description TEXT,
    input JSONB NOT NULL DEFAULT '{}',
    output JSONB,

    -- State
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed, cancelled
    error TEXT,

    -- Progress
    progress DECIMAL(5, 2) DEFAULT 0, -- 0.00 to 100.00

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Metadata
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_tasks_owner_agent_id ON tasks(owner_agent_id);
CREATE INDEX idx_tasks_assigned_agent_id ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

-- Task messages (A2A communication)
CREATE TABLE task_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

    -- Message details
    role VARCHAR(50) NOT NULL, -- 'user', 'agent', 'system'
    content TEXT NOT NULL,

    -- Sender info
    sender_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_messages_task_id ON task_messages(task_id);
CREATE INDEX idx_task_messages_created_at ON task_messages(created_at);

-- ============================================
-- EVENTS & AUDIT
-- ============================================

-- Event log for audit and replay
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Event details
    type VARCHAR(255) NOT NULL,
    source VARCHAR(255) NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',

    -- Relations
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    correlation_id UUID,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_source ON events(source);
CREATE INDEX idx_events_agent_id ON events(agent_id);
CREATE INDEX idx_events_correlation_id ON events(correlation_id);
CREATE INDEX idx_events_created_at ON events(created_at);

-- Partition events by month for better performance
-- (PostgreSQL 11+ native partitioning would be used in production)

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to agents table
CREATE TRIGGER update_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to record agent state changes
CREATE OR REPLACE FUNCTION record_agent_state_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state IS DISTINCT FROM NEW.state THEN
        INSERT INTO agent_state_history (agent_id, from_state, to_state, event, reason)
        VALUES (NEW.id, OLD.state, NEW.state, 'STATE_CHANGE', NULL);
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply state change trigger to agents table
CREATE TRIGGER record_agents_state_change
    AFTER UPDATE OF state ON agents
    FOR EACH ROW
    EXECUTE FUNCTION record_agent_state_change();

-- ============================================
-- INITIAL DATA
-- ============================================

-- Insert default permissions
INSERT INTO permissions (name, description, category, risk_level) VALUES
    ('system.read', 'Read system information', 'system', 'low'),
    ('system.write', 'Modify system settings', 'system', 'high'),
    ('agent.spawn', 'Spawn new agents', 'agent', 'medium'),
    ('agent.terminate', 'Terminate agents', 'agent', 'high'),
    ('agent.communicate', 'Communicate with other agents', 'agent', 'low'),
    ('memory.read', 'Read memories', 'memory', 'low'),
    ('memory.write', 'Write memories', 'memory', 'low'),
    ('memory.delete', 'Delete memories', 'memory', 'medium'),
    ('skill.install', 'Install skills', 'skill', 'medium'),
    ('skill.execute', 'Execute skills', 'skill', 'medium'),
    ('file.read', 'Read files', 'file', 'medium'),
    ('file.write', 'Write files', 'file', 'high'),
    ('network.fetch', 'Make HTTP requests', 'network', 'medium'),
    ('shell.execute', 'Execute shell commands', 'shell', 'critical')
ON CONFLICT (name) DO NOTHING;
