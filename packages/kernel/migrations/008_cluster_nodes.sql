-- Cluster node registry for multi-node routing

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS node_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_agents_node_id ON agents(node_id);

CREATE TABLE IF NOT EXISTS gateway_nodes (
    node_id VARCHAR(64) PRIMARY KEY,
    ws_url TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gateway_nodes_last_seen ON gateway_nodes(last_seen_at);
