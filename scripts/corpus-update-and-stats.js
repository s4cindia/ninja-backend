const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

// Publisher backfill provided by the annotation team (14 docs).
const UPDATES = [
  ['cmnxvsoi20004ooict589iasb', 'Exeter'],
  ['cmnjrf4gv0002nocf1m0lbb1z', 'Kendall Hunt'],
  ['cmnx97z5b00086xwozxbjw7ll', 'Pelagic'],
  ['cmnkvinq6000sbjoshtd3rly4', 'Kendall Hunt'],
  ['cmnxavx9k0006h5ythszl2ecg', 'Wolters Kluwer'],
  ['cmnmrg82t000ewrmup9qyroeq', 'Jones & Bartlett'],
  ['cmnpbz9vk002r13ym8b5cok46', 'Pelagic'],
  ['cmnmkye86000c31ncfn67ici5', 'Wolters Kluwer'],
  ['cmnzrwtr6000ofaxt0iqq7snz', 'Kendall Hunt'],
  ['cmnmw4e2b001hpmvr8d1guc4u', 'Kendall Hunt'],
  ['cmnpfx3mc003513ymxx1k5lsf', 'Kendall Hunt'],
  ['cmpvtf9w40003149enxjde6de', 'Human Kinetics'],
  ['cmnpdqzl8002y13ymhcbge10o', 'Kendall Hunt'],
  ['cmnqvxqs1000013oj1nkmcich', 'Springer Publishing'],
];

const BASE = `FROM "Zone" z
  JOIN "CalibrationRun" cr ON z."calibrationRunId" = cr.id
  JOIN "CorpusDocument" cd ON cr."documentId" = cd.id
  WHERE z."operatorVerified" = true AND z."operatorLabel" IS NOT NULL
    AND z."isArtefact" = false AND z."isGhost" = false
    AND (z.decision IS NULL OR z.decision <> 'REJECTED')`;

(async () => {
  // ── 1. Apply publisher backfill ──
  const updResults = [];
  for (const [id, publisher] of UPDATES) {
    try {
      const r = await p.corpusDocument.update({
        where: { id }, data: { publisher }, select: { filename: true, publisher: true },
      });
      updResults.push({ filename: r.filename, publisher: r.publisher, ok: true });
    } catch (e) {
      updResults.push({ id, publisher, ok: false, error: e.message });
    }
  }
  const remainingNull = await p.corpusDocument.count({
    where: { OR: [{ publisher: null }, { publisher: '' }] },
  });

  // ── 2. Re-run statistics ──
  const corpus = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total_docs,
            COUNT(DISTINCT publisher)::int AS distinct_publishers,
            COUNT(DISTINCT "contentType")::int AS content_types
     FROM "CorpusDocument"`);

  const publisherDist = await p.$queryRawUnsafe(
    `SELECT COALESCE(publisher,'(null)') AS publisher, COUNT(*)::int AS docs
     FROM "CorpusDocument" GROUP BY 1 ORDER BY 2 DESC, 1`);

  const annot = await p.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT cr."documentId")::int AS annotated_docs,
            COUNT(DISTINCT cr.id)::int AS annotated_runs,
            COUNT(*)::int AS total_zones ${BASE}`);

  const byLabel = await p.$queryRawUnsafe(
    `SELECT z."operatorLabel" AS label, COUNT(*)::int AS instances,
            COUNT(DISTINCT cr."documentId")::int AS docs,
            COUNT(DISTINCT cd.publisher)::int AS publishers
     ${BASE} GROUP BY 1 ORDER BY 2 DESC`);

  const formulaDocs = await p.$queryRawUnsafe(
    `SELECT cd.filename, cd.publisher, COUNT(*)::int AS instances
     ${BASE} AND lower(z."operatorLabel") IN ('formula','equation','eqn','formulae')
     GROUP BY 1,2 ORDER BY 3 DESC`);

  const tableDocs = await p.$queryRawUnsafe(
    `SELECT cd.filename, cd.publisher, COUNT(*)::int AS instances
     ${BASE} AND lower(z."operatorLabel") = 'table'
     GROUP BY 1,2 ORDER BY 3 DESC`);

  console.log('===STATS_JSON_START===');
  console.log(JSON.stringify({
    update: { applied: updResults.filter((r) => r.ok).length, failed: updResults.filter((r) => !r.ok), remainingNull },
    corpus: corpus[0], annot: annot[0], publisherDist, byLabel, formulaDocs, tableDocs,
  }, null, 1));
  console.log('===STATS_JSON_END===');
  await p.$disconnect();
})().catch((e) => { console.error('STATS_ERR', e.message); process.exit(1); });
