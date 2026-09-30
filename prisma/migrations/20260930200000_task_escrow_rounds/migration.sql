ALTER TABLE "TaskSession"
  ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "dayKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reservedAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settledAmountCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Task"
  ADD COLUMN "ticketCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reservedAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settledAt" TIMESTAMP(3);

CREATE INDEX "TaskSession_clientId_dayKey_round_idx"
  ON "TaskSession"("clientId","dayKey","round");

CREATE INDEX "Task_clientId_status_sequence_idx"
  ON "Task"("clientId","status","sequence");