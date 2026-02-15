/**
 * Test Track Changes Export
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function testTrackChanges() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  console.log('=== LOADING DOCUMENT ===');
  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  if (!doc) {
    console.log('Document not found!');
    await prisma.$disconnect();
    return;
  }

  console.log(`References: ${doc.referenceListEntries.length}`);
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`  [${idx+1}] ${ref.authors?.[0]}`);
  });

  // Build mapping
  const citationToRefMap = new Map();
  doc.referenceListEntries.forEach((ref, index) => {
    const refNumber = index + 1;
    if (ref.citationIds && ref.citationIds.length > 0) {
      ref.citationIds.forEach(citationId => {
        citationToRefMap.set(citationId, refNumber);
      });
    }
  });

  // Identify changed and orphaned
  const changedCitations = [];
  const orphanedCitations = [];
  const orphanedSet = new Set();

  doc.citations.forEach(citation => {
    const newRefNumber = citationToRefMap.get(citation.id);
    if (citation.rawText) {
      const oldMatch = citation.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          changedCitations.push({
            oldText: citation.rawText,
            newText: citation.rawText.replace(String(oldNumber), String(newRefNumber))
          });
        } else if (!newRefNumber && !orphanedSet.has(citation.rawText)) {
          orphanedCitations.push(citation.rawText);
          orphanedSet.add(citation.rawText);
        }
      }
    }
  });

  console.log('\n=== CHANGES TO MAKE ===');
  console.log('Changed:');
  changedCitations.forEach(c => console.log(`  ${c.oldText} → ${c.newText}`));
  console.log('Orphaned:');
  orphanedCitations.forEach(o => console.log(`  ${o} (deleted reference)`));

  // Load DOCX
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);

  // Apply Track Changes
  console.log('\n=== APPLYING TRACK CHANGES ===');

  const zip = await JSZip.loadAsync(originalBuffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  const revisionDate = new Date().toISOString();
  const author = 'Citation Tool';
  let revisionId = 1;

  // Create placeholders
  const placeholders = new Map();
  let placeholderIndex = 0;

  // Group changes by oldText
  const changeMap = new Map();
  for (const { oldText, newText } of changedCitations) {
    if (!changeMap.has(oldText)) {
      changeMap.set(oldText, newText);
    }
  }

  // Placeholder for changed citations
  for (const [oldText, newText] of changeMap) {
    const placeholder = `__TRACK_CHANGE_${placeholderIndex}__`;
    placeholders.set(placeholder, { type: 'change', oldText, newText });
    placeholderIndex++;

    const regex = new RegExp(oldText.replace(/[()]/g, '\\$&'), 'g');
    documentXML = documentXML.replace(regex, placeholder);
    console.log(`  Placeholder: ${oldText} → ${placeholder}`);
  }

  // Placeholder for orphaned citations
  for (const orphanText of orphanedCitations) {
    if (!changeMap.has(orphanText)) {
      const placeholder = `__TRACK_ORPHAN_${placeholderIndex}__`;
      placeholders.set(placeholder, { type: 'orphan', oldText: orphanText });
      placeholderIndex++;

      const regex = new RegExp(orphanText.replace(/[()]/g, '\\$&'), 'g');
      documentXML = documentXML.replace(regex, placeholder);
      console.log(`  Placeholder: ${orphanText} → ${placeholder} (orphan)`);
    }
  }

  // Apply Track Changes markup
  console.log('\n=== APPLYING TRACK CHANGES MARKUP ===');

  for (const [placeholder, info] of placeholders) {
    let replacement;

    if (info.type === 'change') {
      // Delete old, insert new
      const escOld = info.oldText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escNew = info.newText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      replacement = `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}"><w:r><w:delText>${escOld}</w:delText></w:r></w:del><w:ins w:id="${revisionId + 1000}" w:author="${author}" w:date="${revisionDate}"><w:r><w:t>${escNew}</w:t></w:r></w:ins>`;
      console.log(`  Track Change: ${info.oldText} → ${info.newText}`);
    } else {
      // Just delete (orphaned)
      const escOld = info.oldText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      replacement = `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}"><w:r><w:delText>${escOld}</w:delText></w:r></w:del>`;
      console.log(`  Track Delete (orphan): ${info.oldText}`);
    }
    revisionId++;

    const placeholderRegex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    documentXML = documentXML.replace(placeholderRegex, replacement);
  }

  // Update settings for track changes
  let settingsXML = await zip.file('word/settings.xml')?.async('string');
  if (settingsXML && !settingsXML.includes('<w:trackRevisions')) {
    settingsXML = settingsXML.replace(
      '</w:settings>',
      '<w:trackRevisions/><w:revisionView w:markup="true"/></w:settings>'
    );
    zip.file('word/settings.xml', settingsXML);
  }

  // Save
  zip.file('word/document.xml', documentXML);
  const modifiedBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  const outputPath = path.join(process.cwd(), 'test-track-changes.docx');
  await fs.writeFile(outputPath, modifiedBuffer);

  console.log(`\n=== SAVED TO: ${outputPath} ===`);
  console.log('\nOpen in Microsoft Word to see Track Changes!');
  console.log('- Changed citations: shown with strikethrough (deleted) + underline (inserted)');
  console.log('- Orphaned citations: shown with strikethrough only');

  await prisma.$disconnect();
}

testTrackChanges().catch(console.error);
