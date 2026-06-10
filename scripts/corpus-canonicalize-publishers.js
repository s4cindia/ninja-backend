const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

// Collapse abbreviation/variant spellings onto the canonical full name.
const CANON = [
  ['KH', 'Kendall Hunt'],
  ['WK', 'Wolters Kluwer'],
  ['Exeter Press', 'Exeter'],
];

(async () => {
  const applied = [];
  for (const [from, to] of CANON) {
    const r = await p.corpusDocument.updateMany({
      where: { publisher: from }, data: { publisher: to },
    });
    applied.push({ from, to, updated: r.count });
  }

  const dist = await p.$queryRawUnsafe(
    `SELECT COALESCE(publisher,'(null)') AS publisher, COUNT(*)::int AS docs
     FROM "CorpusDocument" GROUP BY 1 ORDER BY 2 DESC, 1`);
  const distinct = await p.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT publisher)::int AS real_publishers FROM "CorpusDocument"`);

  console.log('===CANON_JSON_START===');
  console.log(JSON.stringify({ applied, realPublishers: distinct[0].real_publishers, dist }, null, 1));
  console.log('===CANON_JSON_END===');
  await p.$disconnect();
})().catch((e) => { console.error('CANON_ERR', e.message); process.exit(1); });
