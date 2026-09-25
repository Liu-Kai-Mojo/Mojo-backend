CREATE TABLE "TrailerCache" (
  "id" VARCHAR(5) NOT NULL,
  "videoId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "channelTitle" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "thumbnailUrl" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "categoryId" TEXT NOT NULL,
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "likeCount" INTEGER NOT NULL DEFAULT 0,
  "commentCount" INTEGER NOT NULL DEFAULT 0,
  "embeddable" BOOLEAN NOT NULL DEFAULT false,
  "privacyStatus" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lastValidatedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrailerCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrailerCache_videoId_key" ON "TrailerCache"("videoId");
CREATE INDEX "TrailerCache_embeddable_privacyStatus_publishedAt_idx" ON "TrailerCache"("embeddable","privacyStatus","publishedAt");
CREATE INDEX "TrailerCache_score_idx" ON "TrailerCache"("score");
