/**
 * Mirror the exact service flow to identify the issue
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

async function mirrorService() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
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

  // Controller logic for building changedCitations and orphanedCitations
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
          const newText = citation.rawText.replace(String(oldNumber), String(newRefNumber));
          changedCitations.push({ oldText: citation.rawText, newText });
        } else if (!newRefNumber) {
          if (!orphanedSet.has(citation.rawText)) {
            orphanedCitations.push(citation.rawText);
            orphanedSet.add(citation.rawText);
          }
        }
      }
    }
  });

  console.log('changedCitations:', changedCitations);
  console.log('orphanedCitations:', orphanedCitations);

  // Prepare currentReferences
  const currentReferences = doc.referenceListEntries.map(ref => ({
    id: ref.id,
    authors: Array.isArray(ref.authors) ? ref.authors : [],
    title: ref.title || undefined,
    sortKey: ref.sortKey
  }));

  // Now call the actual service
  const { docxProcessorService } = require('./src/services/citation/docx-processor.service');

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);

  try {
    const { buffer, summary } = await docxProcessorService.replaceCitationsWithTrackChanges(
      originalBuffer,
      changedCitations,
      orphanedCitations,
      currentReferences
    );

    console.log('\n=== EXPORT SUMMARY ===');
    console.log('Total citations:', summary.totalCitations);
    console.log('Changed:', summary.changed);
    console.log('Orphaned:', summary.orphaned);
    console.log('References reordered:', summary.referencesReordered);
    console.log('References deleted:', summary.referencesDeleted);

    // Save the file
    const outputPath = path.join(process.cwd(), 'test-service-mirror.docx');
    await fs.writeFile(outputPath, buffer);
    console.log(`\nSaved to: ${outputPath}`);
    console.log('File size:', buffer.length, 'bytes');

    // Verify the file structure
    const zip = await JSZip.loadAsync(buffer);
    const documentXML = await zip.file('word/document.xml')?.async('string');
    if (documentXML) {
      console.log('\nVerifying XML structure...');
      const tags = ['w:r', 'w:t', 'w:p', 'w:del', 'w:ins'];
      for (const tag of tags) {
        const openPattern = new RegExp(`<${tag}[\\s>]`, 'g');
        const closePattern = new RegExp(`</${tag}>`, 'g');
        const opens = (documentXML.match(openPattern) || []).length;
        const closes = (documentXML.match(closePattern) || []).length;
        const status = opens === closes ? 'OK' : `MISMATCH (${opens - closes})`;
        console.log(`  ${tag}: ${opens}/${closes} - ${status}`);
      }
    }
  } catch (error) {
    console.error('ERROR:', error);
  }

  await prisma.$disconnect();
}

mirrorService().catch(console.error);
