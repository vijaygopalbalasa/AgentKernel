-- Audit actor_id compatibility update
-- Allows non-UUID actor IDs (for external or non-database-backed agents)

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'audit_log'
          AND column_name = 'actor_id'
          AND data_type = 'uuid'
    ) THEN
        ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_id_fkey;
        ALTER TABLE audit_log ALTER COLUMN actor_id TYPE TEXT USING actor_id::text;
    END IF;
END $$;
