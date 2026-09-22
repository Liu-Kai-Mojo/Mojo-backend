CREATE TYPE "Role" AS ENUM ('OWNER','ADMIN','CLIENT');
CREATE TYPE "IdentifierType" AS ENUM ('EMAIL','PHONE');
CREATE TYPE "MessageStatus" AS ENUM ('OPEN','REPLIED','CLOSED');
CREATE TABLE "User" (
 "id" VARCHAR(5) PRIMARY KEY,
 "name" TEXT NOT NULL,
 "identifier" TEXT NOT NULL UNIQUE,
 "identifierType" "IdentifierType" NOT NULL,
 "passwordHash" TEXT NOT NULL,
 "role" "Role" NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "Movie" (
 "id" VARCHAR(5) PRIMARY KEY,
 "title" TEXT NOT NULL,
 "genre" TEXT NOT NULL,
 "year" INTEGER NOT NULL,
 "duration" INTEGER NOT NULL,
 "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "description" TEXT NOT NULL,
 "posterUrl" TEXT NOT NULL,
 "backdropUrl" TEXT,
 "published" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "MovieHistory" (
 "id" VARCHAR(5) PRIMARY KEY,
 "userId" VARCHAR(5) NOT NULL,
 "movieId" VARCHAR(5) NOT NULL,
 "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MovieHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "MovieHistory_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "Movie"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Message" (
 "id" VARCHAR(5) PRIMARY KEY,
 "senderId" VARCHAR(5) NOT NULL,
 "recipientId" VARCHAR(5),
 "subject" TEXT NOT NULL,
 "body" TEXT NOT NULL,
 "status" "MessageStatus" NOT NULL DEFAULT 'OPEN',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "Message_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "Setting" (
 "id" VARCHAR(5) PRIMARY KEY,
 "key" TEXT NOT NULL UNIQUE,
 "value" TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "MovieHistory_userId_viewedAt_idx" ON "MovieHistory"("userId","viewedAt");
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message"("senderId","createdAt");
CREATE INDEX "Message_recipientId_createdAt_idx" ON "Message"("recipientId","createdAt");
