CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETED');

CREATE TABLE "Task" (
  "id" VARCHAR(5) NOT NULL,
  "clientId" VARCHAR(5) NOT NULL,
  "assignedById" VARCHAR(5),
  "sequence" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "commissionCents" INTEGER NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
  "isLucky" BOOLEAN NOT NULL DEFAULT false,
  "revealedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Task_clientId_sequence_key" ON "Task"("clientId", "sequence");
CREATE INDEX "Task_clientId_status_sequence_idx" ON "Task"("clientId", "status", "sequence");
ALTER TABLE "Task" ADD CONSTRAINT "Task_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
