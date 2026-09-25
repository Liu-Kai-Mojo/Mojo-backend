ALTER TABLE "Task"
  ADD COLUMN "tmdbMovieId" INTEGER,
  ADD COLUMN "movieTitle" TEXT,
  ADD COLUMN "moviePosterUrl" TEXT,
  ADD COLUMN "movieReleaseDate" TIMESTAMP(3);
