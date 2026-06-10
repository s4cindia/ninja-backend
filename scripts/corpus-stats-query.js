const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

// Operator-verified ground-truth zones (the rows the training export consumes):
// verified, labelled, not artefact, not ghost, not rejected.
const BASE = `FROM "Zone" z
  JOIN "CalibrationRun" cr ON z."calibrationRunId" = cr.id
  JOIN "CorpusDocument" cd ON cr."documentId" = cd.id
  WHERE z."operatorVerified" = true
    AND z."operatorLabel" IS NOT NULL
    AND z."isArtefact" = false
    AND z."isGhost" = false
    AND (z.decision IS NULL OR z.decision <> 'REJECTED')`;

(async () => {
  const corpus = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total_docs,
            COUNT(DISTINCT publisher)::int AS publishers,
            COUNT(DISTINCT "contentType")::int AS content_types,
            COUNT(*) FILTER (WHERE "taggedPdfPath" IS NOT NULL)::int AS with_tagged
     FROM "CorpusDocument"`,
  );

  const annot = await p.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT cr."documentId")::int AS annotated_docs,
            COUNT(DISTINCT cr.id)::int AS annotated_runs,
            COUNT(*)::int AS total_zones,
            COUNT(DISTINCT cd.publisher)::int AS annotated_publishers
     ${BASE}`,
  );

  const byLabel = await p.$queryRawUnsafe(
    `SELECT z."operatorLabel" AS label,
            COUNT(*)::int AS instances,
            COUNT(DISTINCT cr."documentId")::int AS docs,
            COUNT(DISTINCT cd.publisher)::int AS publishers
     ${BASE}
     GROUP BY 1 ORDER BY 2 DESC`,
  );

  const formulaDocs = await p.$queryRawUnsafe(
    `SELECT cd.filename, cd.publisher, COUNT(*)::int AS instances
     ${BASE} AND lower(z."operatorLabel") IN ('formula','equation','eqn','formulae')
     GROUP BY 1,2 ORDER BY 3 DESC`,
  );

  const tableDocs = await p.$queryRawUnsafe(
    `SELECT cd.filename, cd.publisher, COUNT(*)::int AS instances
     ${BASE} AND lower(z."operatorLabel") = 'table'
     GROUP BY 1,2 ORDER BY 3 DESC`,
  );

  const docList = await p.$queryRawUnsafe(
    `SELECT cd.filename, cd.publisher, cd."contentType" AS content_type,
            cd."pageCount" AS pages, cd."trainingSplit" AS split,
            COUNT(*)::int AS zones
     ${BASE}
     GROUP BY 1,2,3,4,5 ORDER BY 6 DESC`,
  );

  console.log('===STATS_JSON_START===');
  console.log(JSON.stringify(
    { corpus: corpus[0], annot: annot[0], byLabel, formulaDocs, tableDocs, docList },
    null, 1,
  ));
  console.log('===STATS_JSON_END===');
  await p.$disconnect();
})().catch((e) => {
  console.error('STATS_ERR', e.message);
  process.exit(1);
});
