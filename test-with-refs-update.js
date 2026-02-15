/**
 * Test with References section update included
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
    { name: 'w:p', openPattern: /<w:p[\s>]/g, closePattern: /<\/w:p>/g },
    { name: 'w:del', openPattern: /<w:del[\s>]/g, closePattern: /<\/w:del>/g },
  ];

  const result = {};
  for (const { name, openPattern, closePattern } of tags) {
    const opens = (xml.match(openPattern) || []).length;
    const closes = (xml.match(closePattern) || []).length;
    result[name] = { opens, closes, diff: opens - closes };
  }
  return result;
}

// Copy of the updateReferencesSection from the service
function updateReferencesSection(referencesXML, currentReferences, author, date, startRevisionId) {
  let revisionId = startRevisionId;
  let reordered = 0;
  let deleted = 0;

  try {
    const paragraphRegex = /<w:p[^>]*>[\s\S]*?<\/w:p>/g;
    const paragraphs = referencesXML.match(paragraphRegex) || [];

    console.log(`\nFound ${paragraphs.length} paragraphs in References section`);

    if (paragraphs.length <= 1) {
      return { xml: referencesXML, reordered: 0, deleted: 0, nextRevisionId: revisionId };
    }

    const headerParagraph = paragraphs[0];
    const refParagraphs = paragraphs.slice(1);

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
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        unmatchedParagraphs.push(para);
      }
    }

    console.log(`Matched ${paragraphByAuthor.size}/${refParagraphs.length} references`);
    console.log(`Unmatched (deleted): ${unmatchedParagraphs.length}`);

    const newRefParagraphs = [];
    let refNumber = 1;

    for (const ref of currentReferences) {
      const para = paragraphByAuthor.get(ref.id);
      if (para) {
        let updatedPara = para;
        const numberPatterns = [
          /(<w:t[^>]*>)\s*\d+\.\s*/,
          /(<w:t[^>]*>)\s*\d+\s+/,
          /(<w:t[^>]*>)\s*\[\d+\]\s*/,
        ];

        for (const pattern of numberPatterns) {
          if (pattern.test(updatedPara)) {
            updatedPara = updatedPara.replace(pattern, `$1${refNumber}.\t`);
            break;
          }
        }

        newRefParagraphs.push(updatedPara);
        refNumber++;
        reordered++;
      }
    }

    // Mark unmatched (deleted) references with track changes
    for (const para of unmatchedParagraphs) {
      // THIS IS THE PROBLEMATIC PART - let's check if it creates balanced XML
      const deletedPara = para.replace(
        /(<w:r[^>]*>)([\s\S]*?)(<\/w:r>)/g,
        `<w:del w:id="${revisionId}" w:author="${author}" w:date="${date}">$1$2$3</w:del>`
      );

      console.log('Original para w:r count:', (para.match(/<w:r[\s>]/g) || []).length);
      console.log('Original para </w:r> count:', (para.match(/<\/w:r>/g) || []).length);
      console.log('Deleted para w:r count:', (deletedPara.match(/<w:r[\s>]/g) || []).length);
      console.log('Deleted para </w:r> count:', (deletedPara.match(/<\/w:r>/g) || []).length);
      console.log('Deleted para w:del count:', (deletedPara.match(/<w:del[\s>]/g) || []).length);
      console.log('Deleted para </w:del> count:', (deletedPara.match(/<\/w:del>/g) || []).length);

      newRefParagraphs.push(deletedPara);
      deleted++;
      revisionId++;
    }

    const firstParaIndex = referencesXML.indexOf(paragraphs[0]);
    const lastPara = paragraphs[paragraphs.length - 1];
    const lastParaEnd = referencesXML.lastIndexOf(lastPara) + lastPara.length;

    const beforeContent = referencesXML.substring(0, firstParaIndex);
    const afterContent = referencesXML.substring(lastParaEnd);

    const newReferencesXML = beforeContent + headerParagraph + newRefParagraphs.join('') + afterContent;

    console.log(`References updated: ${reordered} reordered, ${deleted} deleted`);

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

async function testWithRefsUpdate() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  console.log('=== LOADING DOCUMENT ===');
  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  const currentReferences = doc.referenceListEntries.map(ref => ({
    id: ref.id,
    authors: Array.isArray(ref.authors) ? ref.authors : [],
    title: ref.title || undefined,
    sortKey: ref.sortKey
  }));

  console.log('Current references:', currentReferences.length);
  currentReferences.forEach((r, i) => console.log(`  ${i + 1}. ${r.authors[0]}`));

  // Load DOCX
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  let documentXML = await zip.file('word/document.xml').async('string');

  // Split at References section
  const refMatch = documentXML.match(/<w:t[^>]*>References<\/w:t>/i);
  let bodyXML = documentXML;
  let referencesXML = '';

  if (refMatch && refMatch.index !== undefined) {
    const beforeMatch = documentXML.substring(0, refMatch.index);
    const lastParagraphStart = beforeMatch.lastIndexOf('<w:p');
    if (lastParagraphStart !== -1) {
      bodyXML = documentXML.substring(0, lastParagraphStart);
      referencesXML = documentXML.substring(lastParagraphStart);
    }
  }

  console.log('\n=== REFERENCES SECTION BEFORE UPDATE ===');
  console.log(JSON.stringify(countTags(referencesXML)));

  // Update references section
  const result = updateReferencesSection(
    referencesXML,
    currentReferences,
    'Citation Tool',
    new Date().toISOString(),
    100
  );

  console.log('\n=== REFERENCES SECTION AFTER UPDATE ===');
  console.log(JSON.stringify(countTags(result.xml)));

  // Check for issues
  const afterCounts = countTags(result.xml);
  for (const [tag, counts] of Object.entries(afterCounts)) {
    if (counts.diff !== 0) {
      console.log(`ERROR: ${tag} is unbalanced by ${counts.diff}`);
    }
  }

  // Recombine and save
  documentXML = bodyXML + result.xml;

  console.log('\n=== FINAL COMBINED ===');
  console.log(JSON.stringify(countTags(documentXML)));

  zip.file('word/document.xml', documentXML);
  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const outputPath = path.join(process.cwd(), 'test-with-refs-update.docx');
  await fs.writeFile(outputPath, modifiedBuffer);
  console.log(`\nSaved to: ${outputPath}`);

  await prisma.$disconnect();
}

testWithRefsUpdate().catch(console.error);
