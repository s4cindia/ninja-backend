/**
 * Trace replacement step by step
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTags(xml) {
  const tags = [
    { name: 'w:r', openPattern: /<w:r[\s>]/g, closePattern: /<\/w:r>/g },
    { name: 'w:t', openPattern: /<w:t[\s>]/g, closePattern: /<\/w:t>/g },
  ];

  const result = {};
  for (const { name, openPattern, closePattern } of tags) {
    const opens = (xml.match(openPattern) || []).length;
    const closes = (xml.match(closePattern) || []).length;
    result[name] = { opens, closes, diff: opens - closes };
  }
  return result;
}

async function traceReplacement() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId }
  });

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  console.log('=== ORIGINAL ===');
  console.log(JSON.stringify(countTags(documentXML)));

  // Split at References
  const refMatch = documentXML.match(/<w:t[^>]*>References<\/w:t>/i);
  let bodyXML = documentXML;
  let referencesXML = '';

  if (refMatch && refMatch.index !== undefined) {
    const beforeMatch = documentXML.substring(0, refMatch.index);
    const lastParagraphStart = beforeMatch.lastIndexOf('<w:p');
    if (lastParagraphStart !== -1) {
      bodyXML = documentXML.substring(0, lastParagraphStart);
      referencesXML = documentXML.substring(lastParagraphStart);
      console.log('Split at References section');
    }
  }

  console.log('\n=== BODY ONLY ===');
  console.log(JSON.stringify(countTags(bodyXML)));

  const revisionDate = new Date().toISOString();
  const author = 'Citation Tool';
  let revisionId = 1;

  // Test replacing (1) - should be orphaned (deleted)
  const oldText = '(1)';
  const placeholder = '__PH_ORPHAN_0__';

  console.log(`\n=== REPLACING ${oldText} WITH PLACEHOLDER ===`);

  const escapedOld = escapeXml(oldText);
  const pattern1 = new RegExp(
    `<w:t([^>]*)>([^<]*)` + escapeRegex(escapedOld) + `([^<]*)</w:t>`,
    'g'
  );

  const matches = bodyXML.match(pattern1) || [];
  console.log(`Found ${matches.length} matches:`);
  matches.forEach((m, i) => console.log(`  ${i + 1}: ${m}`));

  bodyXML = bodyXML.replace(pattern1, `<w:t$1>$2${placeholder}$3</w:t>`);
  console.log('After placeholder:', JSON.stringify(countTags(bodyXML)));

  // Phase 2: Replace placeholder with Track Changes
  console.log('\n=== REPLACING PLACEHOLDER WITH TRACK CHANGES ===');

  const pattern2 = new RegExp(
    `<w:t([^>]*)>([^<]*)` + escapeRegex(placeholder) + `([^<]*)</w:t>`,
    'g'
  );

  const matches2 = bodyXML.match(pattern2) || [];
  console.log(`Found ${matches2.length} placeholder matches:`);
  matches2.forEach((m, i) => console.log(`  ${i + 1}: ${m}`));

  const escapedOrphan = escapeXml(oldText);
  const replacement = `<w:t$1>$2</w:t></w:r>` +
                      `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                      `<w:r><w:delText>${escapedOrphan}</w:delText></w:r></w:del>` +
                      `<w:r><w:t>$3</w:t>`;

  console.log('\nReplacement template:');
  console.log(replacement);

  // Show what the replacement looks like for the first match
  if (matches2.length > 0) {
    const firstMatch = matches2[0];
    const attrs = firstMatch.match(/<w:t([^>]*)>/)[1];
    const before = firstMatch.match(/<w:t[^>]*>([^<]*)/)[1].replace(placeholder, '');
    const after = firstMatch.match(new RegExp(escapeRegex(placeholder) + '([^<]*)</w:t>'))[1];

    console.log('\nFirst match breakdown:');
    console.log(`  attrs: "${attrs}"`);
    console.log(`  before: "${before}"`);
    console.log(`  after: "${after}"`);

    const actualReplacement = replacement
      .replace('$1', attrs)
      .replace('$2', before)
      .replace('$3', after);

    console.log('\nActual replacement:');
    console.log(actualReplacement);
  }

  bodyXML = bodyXML.replace(pattern2, replacement);
  console.log('\nAfter Track Changes:', JSON.stringify(countTags(bodyXML)));

  // Clean up empty elements
  console.log('\n=== CLEANUP ===');
  const beforeCleanup = bodyXML;
  bodyXML = bodyXML.replace(/<w:r><w:t><\/w:t><\/w:r>/g, '');
  console.log(`Removed ${(beforeCleanup.match(/<w:r><w:t><\/w:t><\/w:r>/g) || []).length} empty <w:r><w:t></w:t></w:r>`);

  const beforeCleanup2 = bodyXML;
  bodyXML = bodyXML.replace(/<w:t><\/w:t>/g, '');
  console.log(`Removed ${(beforeCleanup2.match(/<w:t><\/w:t>/g) || []).length} empty <w:t></w:t>`);

  console.log('After cleanup:', JSON.stringify(countTags(bodyXML)));

  // Recombine and save
  documentXML = bodyXML + referencesXML;
  console.log('\n=== FINAL (body + references) ===');
  console.log(JSON.stringify(countTags(documentXML)));

  // Save test file
  zip.file('word/document.xml', documentXML);
  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(process.cwd(), 'test-trace-output.docx');
  await fs.writeFile(outputPath, modifiedBuffer);
  console.log(`\nSaved to: ${outputPath}`);

  await prisma.$disconnect();
}

traceReplacement().catch(console.error);
