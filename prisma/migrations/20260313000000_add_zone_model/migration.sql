-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "readingOrder" INTEGER,
    "bounds" JSONB,
    "content" TEXT,
    "altText" TEXT,
    "longDesc" TEXT,
    "tableStructure" JSONB,
    "zoneSubtype" TEXT,
    "rowCount" INTEGER,
    "parentZoneId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Zone_fileId_idx" ON "Zone"("fileId");

-- CreateIndex
CREATE INDEX "Zone_tenantId_idx" ON "Zone"("tenantId");

-- CreateIndex
CREATE INDEX "Zone_parentZoneId_idx" ON "Zone"("parentZoneId");

-- CreateUniqueIndex (one THEAD/TBODY per parent table)
CREATE UNIQUE INDEX "Zone_parentZoneId_zoneSubtype_key" ON "Zone"("parentZoneId", "zoneSubtype");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (self-referential)
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_parentZoneId_fkey" FOREIGN KEY ("parentZoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
