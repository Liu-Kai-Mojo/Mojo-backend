CREATE TABLE "TaskSession" (
  "id" VARCHAR(5) NOT NULL,
  "clientId" VARCHAR(5) NOT NULL,
  "vipLevel" TEXT NOT NULL,
  "balanceSnapshotCents" INTEGER NOT NULL,
  "generatedTaskCount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "totalTaskAmountCents" INTEGER NOT NULL DEFAULT 0,
  "totalExpectedCommissionCents" INTEGER NOT NULL DEFAULT 0,
  "completedTaskCount" INTEGER NOT NULL DEFAULT 0,
  "resetNumber" INTEGER NOT NULL DEFAULT 0,
  "taskCountOverride" INTEGER,
  "amountOverrideCents" INTEGER,
  "combinationTaskCount" INTEGER NOT NULL DEFAULT 0,
  "combinationTaskAmountCents" INTEGER NOT NULL DEFAULT 0,
  "combinationCommissionRateBps" INTEGER NOT NULL DEFAULT 1500,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Task" ADD COLUMN "sessionId" VARCHAR(5),
ADD COLUMN "taskType" TEXT NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "commissionRateBps" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_clientId_sequence_key";

CREATE UNIQUE INDEX "Task_clientId_sessionId_sequence_key" ON "Task"("clientId","sessionId","sequence");
CREATE INDEX "Task_clientId_sequence_idx" ON "Task"("clientId","sequence");
CREATE INDEX "Task_sessionId_sequence_idx" ON "Task"("sessionId","sequence");
CREATE INDEX "TaskSession_clientId_createdAt_idx" ON "TaskSession"("clientId","createdAt");
CREATE INDEX "TaskSession_clientId_status_idx" ON "TaskSession"("clientId","status");

ALTER TABLE "TaskSession" ADD CONSTRAINT "TaskSession_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Task" ADD CONSTRAINT "Task_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "TaskSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
