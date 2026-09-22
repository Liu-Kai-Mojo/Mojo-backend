# Box Office Mojo — Backend

Production-ready API repository for the Owner, Admin and Client frontends.

## Stack
- Node.js 22 + Express 5
- TypeScript
- PostgreSQL
- Prisma
- JWT authentication
- bcrypt password hashing
- Zod validation

## Local setup

```powershell
npm install
Copy-Item .env.example .env
docker compose up -d
npx prisma generate
npx prisma migrate dev
npm run seed
npm run dev
```

The API runs on `http://localhost:8787`. Liveness endpoints are available at `/`, `/health`, and `/api/health`. Database readiness is reported by `/ready` and `/api/ready`. Protected API routes return `503 SERVICE_STARTING` until migrations and the database connection are ready.

## Production / Railway

This backend is an Express/Node service and must run on a container-capable service such as Railway. It is **not** a Cloudflare Pages static site.

The repository includes a `Dockerfile` so Railway can build the service directly without depending on Railpack detection. The image:

1. installs the locked npm dependency tree;
2. generates the Prisma client;
3. compiles TypeScript to `dist/src/server.js`;
4. starts the API process immediately;
5. applies committed Prisma migrations in the running process and exposes protected API routes only after the database is ready.

Required Railway variables:

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — random secret of at least 32 characters
- `NODE_ENV=production`
- `FRONTEND_ORIGINS` — comma-separated exact HTTPS origins for Client/Admin/Owner frontends
- `PORT` — Railway normally supplies this automatically; the app also defaults to `8787`

Example:

```text
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=...
FRONTEND_ORIGINS=https://box-office-mojo.pages.dev,https://mojo-owner.pages.dev,https://YOUR-ADMIN-DOMAIN.pages.dev
```

Do not commit `.env` or production secrets.

## Demo accounts

- Owner: `owner@boxofficemojo.local`
- Admin: `admin@boxofficemojo.local`
- Client: `09990001111`
- Demo password: `ChangeMe123!`

Change demo credentials before production use.

## Public identifier rules

User, movie, history, message and setting IDs are exactly five numeric digits. Client registration accepts either an email address or a phone number. The API stores the detected identifier type as `EMAIL` or `PHONE`.

## API deployment topology

```text
Cloudflare Pages
  ├─ Client frontend
  ├─ Admin frontend
  └─ Owner frontend
          │
          │ HTTPS / JSON / JWT
          ▼
Railway
  └─ Box Office Mojo Express API
          │
          ▼
PostgreSQL
```

The frontends must use the Railway HTTPS API URL as their production API base URL.

## GitHub

```powershell
git init
git add .
git commit -m "Initial backend"
git branch -M main
git remote add origin <YOUR_BACKEND_REPOSITORY_URL>
git push -u origin main
```
