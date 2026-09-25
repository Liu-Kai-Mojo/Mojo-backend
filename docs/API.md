# MOJO Backend API Contract

This document describes the production API contract used by the Owner, Admin and Client frontends.

## Base URL

Production frontends use the Railway API base:

`https://boxoffice-platform-production.up.railway.app/api`

Local development:

`http://localhost:8787/api`

Protected endpoints use:

`Authorization: Bearer <JWT>`

## Authentication

### POST /auth/login
Public. Accepts:
```json
{"identifier":"email-or-phone","password":"password"}
```

Returns a short-lived access token and sanitized user object.

### POST /auth/register
Public Client registration. Requires an active Admin invite code.

### GET /me
Authenticated. Returns the current user only. Password hashes and secrets are never returned.

Roles are enforced from the database on every authenticated request; the JWT role claim is not trusted for authorization.

## System status

### GET /system/status
Owner/Admin authenticated. Returns:
```json
{"enabled":true,"source":"backend"}
```

### PATCH /system/status
Owner only.

```json
{"enabled":false}
```

This is a logical application state. It does not terminate the Node process. While disabled, Client business routes return `503 PLATFORM_OFF`; Owner/Admin control access remains available.

## Owner

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | /owner/admins | OWNER | List Admins |
| POST | /owner/admins | OWNER | Create Admin |
| PATCH | /owner/admins/:id | OWNER | Update Admin |
| DELETE | /owner/admins/:id | OWNER | Remove Admin |
| POST | /owner/clients | OWNER | Create Client and assign Admin |
| DELETE | /owner/clients/:id | OWNER | Remove Client |
| GET | /owner/users/:id | OWNER | User detail, related records and audit data |
| GET | /owner/audit | OWNER | Audit log |
| GET | /owner/settings | OWNER | Persistent settings |
| PATCH | /owner/settings/:key | OWNER | Update persistent setting |

## Staff / Admin

These routes enforce the authenticated Admin's client scope. Owner access is broader where the existing business rules allow it.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | /admin/dashboard | OWNER/ADMIN | Operational dashboard |
| GET | /admin/clients | OWNER/ADMIN | Scoped Client list |
| PATCH | /admin/clients/:id | OWNER/ADMIN | Update authorized Client |
| POST | /admin/clients | ADMIN | Create Client under current Admin |
| GET | /admin/clients/:id/tasks | OWNER/ADMIN | Scoped task list |
| POST | /admin/clients/:id/tasks | OWNER/ADMIN | Create/update task |
| POST | /admin/clients/:id/tasks/reset | OWNER/ADMIN | Server-side task reset |
| GET | /admin/messages | OWNER/ADMIN | Authorized conversations |
| POST | /admin/clients/:id/messages | ADMIN | Message assigned Client |
| PATCH | /admin/messages/:id | OWNER/ADMIN | Message status/reply |
| GET | /admin/balances | ADMIN | Assigned Client balances |
| PATCH | /admin/balances/:id | ADMIN | Frozen amount / credit controls |
| POST | /admin/balances/:id/adjust | ADMIN | Server-side balance adjustment |

## Client

| Method | Path | Purpose |
|---|---|---|
| GET | /client/support | Assigned Admin and Telegram service |
| GET | /client/movies | Backend-proxied movie feed |
| GET | /client/movies/:id/videos | Backend-proxied movie videos |
| GET | /client/home | Client dashboard data |
| GET | /client/wallet | Wallet and transaction history |
| GET | /client/tasks | Tasks |
| POST | /client/tasks/:id/reveal | Reveal current task |
| POST | /client/tasks/:id/complete | Complete current task and apply commission |
| GET | /client/messages | Client conversations |
| POST | /client/messages | Send permitted message |
| GET | /client/account | Account settings |
| PATCH | /client/account/password | Change login password |
| PATCH | /client/account/withdrawal-password | Change withdrawal password |
| PATCH | /client/account/wallet | Persist wallet address |

## Security rules

- Client records are scoped by `adminId` for Admin requests.
- Client balance and frozen amount are never accepted from Client requests.
- Frozen amount cannot exceed current balance.
- Wallet mutations are server-side and audited.
- Task completion is transactional and re-checks the current database state.
- Sensitive mutations are rate-limited.
- Production error responses do not expose stack traces or internal exception messages.
- Production CORS uses explicit configured frontend origins.
- Authentication uses bcrypt password hashing and signed JWTs.
- Password hashes, JWT secrets, environment variables and private security data are excluded from DTOs.
- All monetary values are stored as integer cents in PostgreSQL/Prisma.
- Five-digit public identifiers remain compatible with the existing production data model.

## Health / readiness

- GET /health — liveness
- GET /api/health — liveness
- GET /ready — database readiness
- GET /api/ready — database readiness

## Error contract

Validation and application errors use a stable `error` string and, where applicable, a machine-readable `code`.

Examples:

```json
{"error":"Authentication is required.","code":"..."}
```

```json
{"error":"Too many requests. Please try again later.","code":"RATE_LIMITED"}
```

```json
{"error":"The platform is temporarily unavailable. Please try again later.","code":"PLATFORM_OFF"}
```

HTTP status meanings include 400/422 for invalid input, 401 for unauthenticated requests, 403 for forbidden access, 404 for missing resources, 409 for business conflicts, 429 for rate limiting, 500 for unexpected production errors, and 503 for unavailable/startup/platform-off states.

## Data protection

The database remains the source of truth. Frontend navigation visibility is never treated as authorization. Production migrations use Prisma's committed migration history and do not drop production tables as part of normal startup.
