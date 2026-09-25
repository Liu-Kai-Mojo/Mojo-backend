ALTER TABLE "Task"
  ADD COLUMN "videoProvider" TEXT,
  ADD COLUMN "videoId" TEXT,
  ADD COLUMN "videoTitle" TEXT,
  ADD COLUMN "videoChannelTitle" TEXT,
  ADD COLUMN "videoThumbnailUrl" TEXT,
  ADD COLUMN "videoDurationSeconds" INTEGER,
  ADD COLUMN "videoPublishedAt" TIMESTAMP(3),
  ADD COLUMN "videoCategoryId" TEXT,
  ADD COLUMN "requiredWatchSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rating" INTEGER;