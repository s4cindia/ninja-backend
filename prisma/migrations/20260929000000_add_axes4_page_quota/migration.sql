-- CreateTable
CREATE TABLE IF NOT EXISTS "Axes4PageQuota" (
    "scopeKey" TEXT NOT NULL,
    "pagesUsedThisPeriod" INTEGER NOT NULL DEFAULT 0,
    "pagesLimitThisPeriod" INTEGER NOT NULL,
    "periodResetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Axes4PageQuota_pkey" PRIMARY KEY ("scopeKey")
);
