# Backend deployment
1. Configure `DATABASE_URL`, `JWT_SECRET`, `PORT`, `NODE_ENV` and `FRONTEND_ORIGINS`.
2. Run `npm ci`.
3. Run `npx prisma migrate deploy`.
4. Run `npm run seed` once for the demo workspace, then change all demo credentials.
5. Run `npm run build` and `npm start`.
