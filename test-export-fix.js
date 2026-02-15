const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function testExportFix() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

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

  console.log('=== DOCUMENT STATE ===');
  console.log(`References: ${doc.referenceListEntries.length}`);
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`  [${idx+1}] ${ref.authors?.[0] || 'Unknown'} - citationIds: ${ref.citationIds?.length || 0}`);
  });

  // Build citation-to-reference mapping (same as controller does)
  const citationToRefMap = new Map();
  doc.referenceListEntries.forEach((ref, index) => {
    const refNumber = index + 1;
    if (ref.citationIds && ref.citationIds.length > 0) {
      ref.citationIds.forEach(citationId => {
        citationToRefMap.set(citationId, refNumber);
      });
    }
  });

  // Generate replacements
  const replacements = [];
  doc.citations.forEach(citation => {
    const newRefNumber = citationToRefMap.get(citation.id);
    if (citation.rawText) {
      const oldMatch = citation.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          const newText = citation.rawText.replace(String(oldNumber), String(newRefNumber));
          replacements.push({
            citationId: citation.id,
            oldText: citation.rawText,
            newText: newText
          });
        }
      }
    }
  });

  console.log('\n=== REPLACEMENTS TO MAKE ===');
  replacements.forEach(r => {
    console.log(`  "${r.oldText}" -> "${r.newText}"`);
  });

  // Load original DOCX
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  console.log('\n=== BEFORE REPLACEMENT ===');
  const citations = ['(1)', '(2)', '(3)', '(4)', '(5)'];
  citations.forEach(c => {
    const count = (documentXML.match(new RegExp(c.replace(/[()]/g, '\\$&'), 'g')) || []).length;
    console.log(`  ${c}: ${count} occurrences`);
  });

  // Apply placeholder strategy (simulating what the service does)
  console.log('\n=== APPLYING PLACEHOLDER STRATEGY ===');

  // Group replacements by oldText
  const replacementsByOldText = new Map();
  for (const r of replacements) {
    const existing = replacementsByOldText.get(r.oldText) || [];
    existing.push(r);
    replacementsByOldText.set(r.oldText, existing);
  }

  // Create placeholders
  const placeholderMap = new Map();
  const finalMap = new Map();
  let placeholderIndex = 0;

  for (const [oldText, reps] of replacementsByOldText) {
    const newText = reps[0].newText;
    const placeholder = `__CITE_PLACEHOLDER_${placeholderIndex}__`;
    placeholderMap.set(oldText, placeholder);
    finalMap.set(placeholder, newText);
    placeholderIndex++;
    console.log(`  Placeholder: "${oldText}" -> "${placeholder}" -> "${newText}"`);
  }

  // Phase 1: Replace with placeholders
  console.log('\n=== PHASE 1: REPLACING WITH PLACEHOLDERS ===');
  for (const [oldText, placeholder] of placeholderMap) {
    const occurrencesNeeded = replacementsByOldText.get(oldText)?.length || 0;
    let occurrencesReplaced = 0;

    while (occurrencesReplaced < occurrencesNeeded && documentXML.includes(oldText)) {
      documentXML = documentXML.replace(oldText, placeholder);
      occurrencesReplaced++;
    }
    console.log(`  "${oldText}" -> "${placeholder}": ${occurrencesReplaced} replacements`);
  }

  // Phase 2: Replace placeholders with final values
  console.log('\n=== PHASE 2: REPLACING PLACEHOLDERS WITH FINAL VALUES ===');
  for (const [placeholder, newText] of finalMap) {
    const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const beforeCount = (documentXML.match(regex) || []).length;
    documentXML = documentXML.replace(regex, newText);
    console.log(`  "${placeholder}" -> "${newText}": ${beforeCount} replacements`);
  }

  console.log('\n=== AFTER REPLACEMENT ===');
  citations.forEach(c => {
    const count = (documentXML.match(new RegExp(c.replace(/[()]/g, '\\$&'), 'g')) || []).length;
    console.log(`  ${c}: ${count} occurrences`);
  });

  // Save the modified DOCX to verify
  zip.file('word/document.xml', documentXML);
  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(process.cwd(), 'test-output-modified.docx');
  await fs.writeFile(outputPath, modifiedBuffer);
  console.log(`\n=== SAVED TO: ${outputPath} ===`);

  await prisma.$disconnect();
}

testExportFix().catch(console.error);
