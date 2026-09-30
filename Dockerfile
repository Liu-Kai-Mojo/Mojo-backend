FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --include=dev && npm cache clean --force

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./tsconfig.json

RUN npm run build

ENV NODE_ENV=production


EXPOSE 8787

CMD ["node", "dist/src/migrationDiagnostics.js"]
