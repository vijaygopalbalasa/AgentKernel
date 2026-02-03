-- Moderation Appeals / Dispute Resolution

CREATE TABLE IF NOT EXISTS moderation_appeals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id UUID REFERENCES moderation_cases(id) ON DELETE SET NULL,
    appellant_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'open',
    reason TEXT,
    evidence JSONB NOT NULL DEFAULT '{}',
    resolution TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_appeals_status ON moderation_appeals(status);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_case ON moderation_appeals(case_id);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_appellant ON moderation_appeals(appellant_agent_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_moderation_appeals_updated_at') THEN
        CREATE TRIGGER update_moderation_appeals_updated_at
            BEFORE UPDATE ON moderation_appeals
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
