/**
 * Test References Section Update
 * Verifies that reference reordering and deletions are reflected in exported DOCX
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

// Import the DOCX processor service methods inline for testing
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Update the References section to reflect reordering and deletions
 */
function updateReferencesSection(referencesXML, currentReferences, author, date, startRevisionId) {
  let revisionId = startRevisionId;
  let reordered = 0;
  let deleted = 0;

  try {
    // Extract reference paragraphs from the References section
    const paragraphRegex = /<w:p[^>]*>[\s\S]*?<\/w:p>/g;
    const paragraphs = referencesXML.match(paragraphRegex) || [];

    console.log(`\nFound ${paragraphs.length} total paragraphs in References section`);

    if (paragraphs.length <= 1) {
      console.log('No reference paragraphs found to update');
      return { xml: referencesXML, reordered: 0, deleted: 0, nextRevisionId: revisionId };
    }

    // First paragraph is usually the "References" header
    const headerParagraph = paragraphs[0];
    const refParagraphs = paragraphs.slice(1);

    console.log(`Header paragraph found: ${headerParagraph.substring(0, 100)}...`);
    console.log(`Reference paragraphs: ${refParagraphs.length}`);

    // Extract text from each paragraph for debugging
    refParagraphs.forEach((para, idx) => {
      const textMatches = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      const fullText = textMatches
        .map(t => t.replace(/<w:t[^>]*>([^<]*)<\/w:t>/, '$1'))
        .join('');
      console.log(`  Paragraph ${idx + 1}: "${fullText.substring(0, 80)}..."`);
    });

    // Create a map of author -> paragraph for matching
    const paragraphByAuthor = new Map();
    const unmatchedParagraphs = [];

    for (const para of refParagraphs) {
      const textMatches = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      const fullText = textMatches
        .map(t => t.replace(/<w:t[^>]*>([^<]*)<\/w:t>/, '$1'))
        .join('');

      let matched = false;
      for (const ref of currentReferences) {
        if (ref.authors && ref.authors[0]) {
          const authorLastName = ref.authors[0].split(/[,\s]/)[0];
          if (fullText.includes(authorLastName)) {
            paragraphByAuthor.set(ref.id, para);
            console.log(`  Matched reference "${ref.id}" by author "${authorLastName}"`);
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        unmatchedParagraphs.push(para);
        const shortText = fullText.substring(0, 50);
        console.log(`  UNMATCHED (will be deleted): "${shortText}..."`);
      }
    }

    console.log(`\nMatched ${paragraphByAuthor.size}/${refParagraphs.length} references`);
    console.log(`Unmatched (deleted): ${unmatchedParagraphs.length}`);

    // Build new References section in correct order
    const newRefParagraphs = [];
    let refNumber = 1;

    console.log('\nBuilding new reference order:');
    for (const ref of currentReferences) {
      console.log(`  Looking for ref ${ref.id} (authors: ${ref.authors})`);
      const para = paragraphByAuthor.get(ref.id);
      if (para) {
        let updatedPara = para;

        // Try different numbering patterns
        const numberPatterns = [
          /(<w:t[^>]*>)\s*\d+\.\s*/,  // "1. "
          /(<w:t[^>]*>)\s*\d+\s+/,     // "1 "
          /(<w:t[^>]*>)\s*\[\d+\]\s*/, // "[1]"
        ];

        for (const pattern of numberPatterns) {
          if (pattern.test(updatedPara)) {
            updatedPara = updatedPara.replace(pattern, `$1${refNumber}.\t`);
            console.log(`    Updated numbering to ${refNumber}`);
            break;
          }
        }

        newRefParagraphs.push(updatedPara);
        refNumber++;
        reordered++;
      } else {
        console.log(`    NOT FOUND in document!`);
      }
    }

    // Mark unmatched (deleted) references with track changes
    console.log('\nMarking deleted references:');
    for (const para of unmatchedParagraphs) {
      const deletedPara = para.replace(
        /(<w:r[^>]*>)([\s\S]*?)(<\/w:r>)/g,
        `<w:del w:id="${revisionId}" w:author="${author}" w:date="${date}">$1$2$3</w:del>`
      );
      newRefParagraphs.push(deletedPara);
      deleted++;
      revisionId++;
      console.log(`  Marked paragraph ${deleted} as deleted`);
    }

    // Reconstruct References section
    const firstParaIndex = referencesXML.indexOf(paragraphs[0]);
    const lastPara = paragraphs[paragraphs.length - 1];
    const lastParaEnd = referencesXML.lastIndexOf(lastPara) + lastPara.length;

    const beforeContent = referencesXML.substring(0, firstParaIndex);
    const afterContent = referencesXML.substring(lastParaEnd);

    const newReferencesXML = beforeContent + headerParagraph + newRefParagraphs.join('') + afterContent;

    console.log(`\nReferences updated: ${reordered} reordered, ${deleted} deleted`);

    return {
      xml: newReferencesXML,
      reordered,
      deleted,
      nextRevisionId: revisionId
    };
  } catch (error) {
    console.error('Failed to update references section:', error.message);
    return { xml: referencesXML, reordered: 0, deleted: 0, nextRevisionId: revisionId };
  }
}

async function testReferencesUpdate() {
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

  console.log(`\n=== CURRENT REFERENCES (from database) ===`);
  console.log(`Total: ${doc.referenceListEntries.length}`);
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`  [${idx + 1}] sortKey=${ref.sortKey}, authors=${JSON.stringify(ref.authors)}, id=${ref.id}`);
  });

  // Load DOCX
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  console.log(`\n=== LOADING DOCX: ${filePath} ===`);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  // Find References section
  console.log('\n=== FINDING REFERENCES SECTION ===');
  const refPatterns = [
    /<w:t[^>]*>References<\/w:t>/i,
    /<w:t[^>]*>Bibliography<\/w:t>/i,
  ];

  let referencesXML = '';

  for (const pattern of refPatterns) {
    const match = documentXML.match(pattern);
    if (match && match.index !== undefined) {
      const beforeMatch = documentXML.substring(0, match.index);
      const lastParagraphStart = beforeMatch.lastIndexOf('<w:p');
      if (lastParagraphStart !== -1) {
        referencesXML = documentXML.substring(lastParagraphStart);
        console.log(`Found References at index ${lastParagraphStart}`);
        console.log(`References section length: ${referencesXML.length} chars`);
        break;
      }
    }
  }

  if (!referencesXML) {
    console.log('No References section found!');
    await prisma.$disconnect();
    return;
  }

  // Prepare current references
  const currentReferences = doc.referenceListEntries.map(ref => ({
    id: ref.id,
    authors: Array.isArray(ref.authors) ? ref.authors : [],
    title: ref.title || undefined,
    sortKey: ref.sortKey
  }));

  console.log('\n=== UPDATING REFERENCES SECTION ===');
  const revisionDate = new Date().toISOString();
  const author = 'Citation Tool';

  const result = updateReferencesSection(referencesXML, currentReferences, author, revisionDate, 100);

  console.log('\n=== RESULT ===');
  console.log(`Reordered: ${result.reordered}`);
  console.log(`Deleted: ${result.deleted}`);

  // Check for w:del tags
  const delCount = (result.xml.match(/<w:del /g) || []).length;
  console.log(`Track Changes deletions in References: ${delCount}`);

  await prisma.$disconnect();
}

testReferencesUpdate().catch(console.error);
