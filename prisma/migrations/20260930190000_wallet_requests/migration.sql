CREATE TYPE "WalletRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "WalletRequest" (
  "id" VARCHAR(5) NOT NULL,
  "userId" VARCHAR(5) NOT NULL,
  "type" VARCHAR(16) NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" "WalletRequestStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WalletRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WalletRequest_idempotencyKey_key" ON "WalletRequest"("idempotencyKey");
CREATE INDEX "WalletRequest_userId_status_createdAt_idx" ON "WalletRequest"("userId", "status", "createdAt");
CREATE INDEX "WalletRequest_type_status_createdAt_idx" ON "WalletRequest"("type", "status", "createdAt");
