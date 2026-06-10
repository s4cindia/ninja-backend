const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const rows = await p.$queryRawUnsafe(
    `SELECT cd.id,
            cd.filename,
            cd.publisher,
            cd."pageCount" AS pages,
            cd."contentType" AS content_type,
            COUNT(z.id) FILTER (
              WHERE z."operatorVerified" = true AND z."isArtefact" = false
                AND z."isGhost" = false AND (z.decision IS NULL OR z.decision <> 'REJECTED')
            )::int AS verified_zones
     FROM "CorpusDocument" cd
     LEFT JOIN "CalibrationRun" cr ON cr."documentId" = cd.id
     LEFT JOIN "Zone" z ON z."calibrationRunId" = cr.id
     GROUP BY cd.id, cd.filename, cd.publisher, cd."pageCount", cd."contentType"
     ORDER BY (cd.publisher IS NULL OR cd.publisher = '') DESC, cd.filename`,
  );

  const missing = rows.filter((r) => r.publisher === null || r.publisher === '');
  const named = rows.filter((r) => r.publisher !== null && r.publisher !== '');

  console.log('===PUB_JSON_START===');
  console.log(JSON.stringify({
    totalDocs: rows.length,
    missingPublisher: missing.length,
    namedPublisher: named.length,
    missing: missing.map((r) => ({ id: r.id, filename: r.filename, pages: r.pages, contentType: r.content_type, verifiedZones: r.verified_zones })),
    named: named.map((r) => ({ filename: r.filename, publisher: r.publisher })),
  }, null, 1));
  console.log('===PUB_JSON_END===');
  await p.$disconnect();
})().catch((e) => { console.error('PUB_ERR', e.message); process.exit(1); });
