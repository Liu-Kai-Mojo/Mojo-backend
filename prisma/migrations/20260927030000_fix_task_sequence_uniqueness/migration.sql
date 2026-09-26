-- Remove the legacy clientId+sequence uniqueness that conflicts with
-- Dynamic TaskSession sequence numbering. Keep uniqueness scoped to a session.
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_clientId_sequence_key";
DROP INDEX IF EXISTS "Task_clientId_sequence_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Task_clientId_sessionId_sequence_key"
  ON "Task"("clientId","sessionId","sequence");
