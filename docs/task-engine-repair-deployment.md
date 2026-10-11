# MOJO task-engine repair deployment notes

## Processing-task invariant

The application serializes task-start and task-completion operations with a PostgreSQL transaction-scoped advisory lock keyed by Client ID. The migration `20261010120000_one_processing_task_per_client` adds a partial unique index over tasks that are still `PENDING` and have a positive `reservedAmountCents`. In this schema, that is the persisted representation of the single active/Processing task; later tasks remain unreserved until they become current.

The migration intentionally fails rather than deleting or rewriting records if legacy data already contains more than one such task for a Client. Inspect and reconcile those records with an audited, business-approved repair before retrying the migration.

## Deployment order

1. Review and merge the backend migration and server changes.
2. Before releasing frontend changes that rely on the new structured codes, apply the migration with the project's normal production migration process: `npx prisma migrate deploy`.
3. Deploy the backend and verify the health endpoint plus the new task-start responses.
4. Deploy Client, Admin, and Owner frontend updates.
5. Verify the bonus acknowledgment flow, exact combination funding, task-start deduplication, and the one-processing-task invariant using authorized test accounts.

Do not run `prisma migrate dev` against production. The migration is additive and does not drop or reset tables, but it may stop if existing records violate the invariant.
