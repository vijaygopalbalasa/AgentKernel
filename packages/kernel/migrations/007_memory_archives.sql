-- Memory archives for cold storage of old memories

CREATE TABLE IF NOT EXISTS memory_archives (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL,
    type VARCHAR(32) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (memory_id, type)
);

CREATE INDEX IF NOT EXISTS idx_memory_archives_agent_id ON memory_archives(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_archives_type ON memory_archives(type);
CREATE INDEX IF NOT EXISTS idx_memory_archives_archived_at ON memory_archives(archived_at);
