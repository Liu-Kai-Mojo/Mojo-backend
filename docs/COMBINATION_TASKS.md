# Combination Tasks: Data Flow and Update Semantics

## Source of truth

The backend is authoritative. Per-client configuration is stored under the existing `client_task_config_<clientId>` setting key and normalized by `getTaskManagementConfig()`. Generated work is persisted in `TaskSession` and `Task` rows. The client ID used by client task endpoints comes from the authenticated token; it is not accepted from a client query/body as an ownership override. Admin endpoints check `canManageClient()` before reading or writing another client's configuration.

## Existing API contract

All endpoints below use the existing `/api` base URL and bearer-token authentication.

- Admin reads task-management rows: `GET /admin/task-management`
- Admin reads one client's configuration/session: `GET /admin/clients/:id/task-management`
- Admin updates VIP/combination assignment/bonus configuration: `PATCH /admin/clients/:id/task-management`
- Admin reads persisted tasks: `GET /admin/clients/:id/tasks`
- Admin creates/updates a standalone client task: `POST /admin/clients/:id/tasks`
- Admin resets a client's task cycle: `POST /admin/clients/:id/tasks/reset`
- Client reads its active session and server-derived task state: `GET /client/tasks`
- Client starts/resumes work: `POST /client/tasks` (the client sends an idempotency key)
- Client reveals a task: `POST /client/tasks/:id/reveal`
- Client records watch progress: `POST /client/tasks/:id/watch`
- Client completes a task: `POST /client/tasks/:id/complete`
- Client reads completed history: `GET /client/history`

Combination assignment payloads use `combinationTaskAssignments: [{ round, sequence, amountCents }]`. Amounts are integer cents; a combination amount must be at least 5000 cents ($50.00). A round must be 1–3 and a sequence must fit the selected VIP task count. Duplicate round/sequence pairs and out-of-range assignments are rejected instead of silently clamped to a different task.

## Update and deletion semantics

Combination schedule changes are saved for the **next Starting session**. The active TaskSession is a persisted snapshot: changing or deleting a schedule entry does not rewrite an in-progress session, task history, a reservation, or a watch/completion transaction. This preserves the amount reserved and reward rules for work already started. The Admin interface labels these as future configuration. An Admin must finish/reset the active cycle before expecting a changed schedule to govern a new session.

When an assignment is deleted from configuration, it is removed from the next-session schedule; already generated task rows remain as history. Deleting a persisted standalone task is a different operation and must follow the backend task-state/settlement rules rather than merely hiding a client-side card.

## Client synchronization

The current architecture does not provide a client-side WebSocket/SSE subscription for task assignments. The client therefore uses a polling fallback while the Tasks screen is active (5 seconds), refreshes on window focus, and refreshes the home/task configuration through the existing home endpoint. The `/client/home`, `/client/tasks`, and `/client/history` GETs bypass the app-level 8-second GET cache and use `cache: no-store`, so polling is not satisfied with an old in-memory response. When a refresh fails, the active task list/current pointer is cleared and a notification is shown for non-silent refreshes rather than presenting stale tasks as current.

## Safety invariants

- Backend calculates task amount, reservation, watch eligibility, completion, and commission.
- Task reads are scoped to the authenticated client ID.
- Admin configuration reads/writes are scoped by the existing staff/client permission check.
- Start requests use the idempotency key and active-session checks.
- Task completion checks persisted task/watch state and uses a database transaction for reservation release, commission credit, task status, and session totals.
- Frontend cache/state is presentation only and does not grant task ownership, progress, or reward entitlement.
