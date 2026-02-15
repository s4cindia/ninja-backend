/**
 * Debug Export - Check for XML corruption
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

async function testExport() {
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
  const changeMap = new Map();
  const orphanedSet = new Set();

  doc.citations.forEach(citation => {
    const newRefNumber = citationToRefMap.get(citation.id);
    if (citation.rawText) {
      const oldMatch = citation.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          changeMap.set(citation.rawText, citation.rawText.replace(String(oldNumber), String(newRefNumber)));
        } else if (!newRefNumber) {
          orphanedSet.add(citation.rawText);
        }
      }
    }
  });

  for (const oldText of changeMap.keys()) {
    orphanedSet.delete(oldText);
  }

  console.log('Changed:', [...changeMap.entries()].map(([o, n]) => `${o}→${n}`).join(', ') || 'none');
  console.log('Orphaned:', [...orphanedSet].join(', ') || 'none');

  // Load DOCX
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  // SPLIT at References section
  console.log('\n=== FINDING REFERENCES SECTION ===');
  const refPatterns = [
    /<w:t[^>]*>References<\/w:t>/i,
    /<w:t[^>]*>Bibliography<\/w:t>/i,
  ];

  let bodyXML = documentXML;
  let referencesXML = '';

  for (const pattern of refPatterns) {
    const match = documentXML.match(pattern);
    if (match && match.index !== undefined) {
      const beforeMatch = documentXML.substring(0, match.index);
      const lastParagraphStart = beforeMatch.lastIndexOf('<w:p');
      if (lastParagraphStart !== -1) {
        bodyXML = documentXML.substring(0, lastParagraphStart);
        referencesXML = documentXML.substring(lastParagraphStart);
        console.log(`Found References at index ${lastParagraphStart}`);
        break;
      }
    }
  }

  const revisionDate = new Date().toISOString();
  const author = 'Citation Tool';
  let revisionId = 1;

  // PHASE 1: Placeholders (body only)
  console.log('\n=== APPLYING CHANGES TO BODY ONLY ===');
  const placeholders = new Map();
  let phIndex = 0;

  for (const [oldText, newText] of changeMap) {
    const placeholder = `__PH_CHANGE_${phIndex}__`;
    placeholders.set(placeholder, { type: 'change', oldText, newText });
    phIndex++;

    const escapedOld = escapeXml(oldText);
    const pattern = new RegExp(`<w:t([^>]*)>([^<]*)` + escapeRegex(escapedOld) + `([^<]*)</w:t>`, 'g');
    const matches = bodyXML.match(pattern) || [];
    bodyXML = bodyXML.replace(pattern, `<w:t$1>$2${placeholder}$3</w:t>`);
    console.log(`  Changed: ${oldText} → ${newText} (${matches.length}x in body)`);
  }

  for (const orphanText of orphanedSet) {
    const placeholder = `__PH_ORPHAN_${phIndex}__`;
    placeholders.set(placeholder, { type: 'orphan', oldText: orphanText });
    phIndex++;

    const escapedOrphan = escapeXml(orphanText);
    const pattern = new RegExp(`<w:t([^>]*)>([^<]*)` + escapeRegex(escapedOrphan) + `([^<]*)</w:t>`, 'g');
    const matches = bodyXML.match(pattern) || [];
    bodyXML = bodyXML.replace(pattern, `<w:t$1>$2${placeholder}$3</w:t>`);
    console.log(`  Orphaned: ${orphanText} (${matches.length}x in body)`);
  }

  // PHASE 2: Track Changes markup
  for (const [placeholder, info] of placeholders) {
    const pattern = new RegExp(`<w:t([^>]*)>([^<]*)` + escapeRegex(placeholder) + `([^<]*)</w:t>`, 'g');

    let replacement;
    if (info.type === 'change') {
      const escapedOld = escapeXml(info.oldText);
      const escapedNew = escapeXml(info.newText);
      replacement = `<w:t$1>$2</w:t></w:r>` +
                    `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                    `<w:r><w:delText>${escapedOld}</w:delText></w:r></w:del>` +
                    `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${revisionDate}">` +
                    `<w:r><w:t>${escapedNew}</w:t></w:r></w:ins>` +
                    `<w:r><w:t>$3</w:t>`;
      revisionId += 2;
    } else {
      const escapedOrphan = escapeXml(info.oldText);
      replacement = `<w:t$1>$2</w:t></w:r>` +
                    `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                    `<w:r><w:delText>${escapedOrphan}</w:delText></w:r></w:del>` +
                    `<w:r><w:t>$3</w:t>`;
      revisionId++;
    }
    bodyXML = bodyXML.replace(pattern, replacement);
  }

  // Clean up
  bodyXML = bodyXML.replace(/<w:r><w:t><\/w:t><\/w:r>/g, '');
  bodyXML = bodyXML.replace(/<w:t><\/w:t>/g, '');

  // *** SKIP References section update for now - just use original ***
  console.log('\n=== SKIPPING References section update (using original) ===');

  // Recombine
  documentXML = bodyXML + referencesXML;

  // Validate XML structure
  console.log('\n=== VALIDATING XML ===');

  // Check for unclosed tags
  const openTags = (documentXML.match(/<w:r[^>]*>/g) || []).length;
  const closeTags = (documentXML.match(/<\/w:r>/g) || []).length;
  console.log(`<w:r> tags: ${openTags} open, ${closeTags} close`);

  const openT = (documentXML.match(/<w:t[^>]*>/g) || []).length;
  const closeT = (documentXML.match(/<\/w:t>/g) || []).length;
  console.log(`<w:t> tags: ${openT} open, ${closeT} close`);

  const openP = (documentXML.match(/<w:p[^>]*>/g) || []).length;
  const closeP = (documentXML.match(/<\/w:p>/g) || []).length;
  console.log(`<w:p> tags: ${openP} open, ${closeP} close`);

  // Enable track changes
  let settingsXML = await zip.file('word/settings.xml')?.async('string');
  if (settingsXML && !settingsXML.includes('<w:trackRevisions')) {
    settingsXML = settingsXML.replace('</w:settings>', '<w:trackRevisions/></w:settings>');
    zip.file('word/settings.xml', settingsXML);
  }

  zip.file('word/document.xml', documentXML);
  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const outputPath = path.join(process.cwd(), 'test-export-debug.docx');
  await fs.writeFile(outputPath, modifiedBuffer);

  console.log(`\n=== SAVED TO: ${outputPath} ===`);
  console.log('Try opening this file in Word');

  await prisma.$disconnect();
}

testExport().catch(console.error);
