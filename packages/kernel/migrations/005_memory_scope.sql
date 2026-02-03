-- Add visibility scope to memories for privacy controls

ALTER TABLE episodic_memories
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'private';

ALTER TABLE semantic_memories
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'private';

ALTER TABLE procedural_memories
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'private';

CREATE INDEX IF NOT EXISTS idx_episodic_memories_scope ON episodic_memories(scope);
CREATE INDEX IF NOT EXISTS idx_semantic_memories_scope ON semantic_memories(scope);
CREATE INDEX IF NOT EXISTS idx_procedural_memories_scope ON procedural_memories(scope);
