-- Create admin invite codes, client ownership and welcome-bonus wallet fields.
ALTER TABLE "User"
  ADD COLUMN "inviteCode" VARCHAR(5),
  ADD COLUMN "adminId" VARCHAR(5),
  ADD COLUMN "balanceCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "welcomeBonusGrantedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_inviteCode_key" ON "User"("inviteCode");
CREATE INDEX "User_adminId_idx" ON "User"("adminId");

DO $$
DECLARE
  row_data RECORD;
  candidate TEXT;
BEGIN
  FOR row_data IN
    SELECT "id" FROM "User"
    WHERE "role" = 'ADMIN' AND "inviteCode" IS NULL
  LOOP
    LOOP
      candidate := lpad((floor(10000 + random() * 90000))::int::text, 5, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "User" u WHERE u."inviteCode" = candidate
      );
    END LOOP;

    UPDATE "User"
    SET "inviteCode" = candidate
    WHERE "id" = row_data."id";
  END LOOP;
END $$;

ALTER TABLE "User"
  ADD CONSTRAINT "User_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WalletTransaction" (
  "id" VARCHAR(5) NOT NULL,
  "userId" VARCHAR(5) NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WalletTransaction_userId_createdAt_idx"
  ON "WalletTransaction"("userId", "createdAt");

ALTER TABLE "WalletTransaction"
  ADD CONSTRAINT "WalletTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
