-- Enforce at most one reserved, Processing-equivalent task per Client.
-- Do not delete or rewrite legacy tasks automatically: stop safely if the data
-- already violates the invariant so operators can review and reconcile it.
DO $$
BEGIN
  IF EXISTS (
    SELECT "clientId"
    FROM "Task"
    WHERE "status" = 'PENDING' AND "reservedAmountCents" > 0
    GROUP BY "clientId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one processing task per client: duplicate reserved pending tasks exist. Reconcile those records before applying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Task_one_processing_per_client_idx"
  ON "Task" ("clientId")
  WHERE "status" = 'PENDING' AND "reservedAmountCents" > 0;
