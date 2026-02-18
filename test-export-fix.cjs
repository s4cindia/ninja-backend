const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const docId = 'be25f336-b761-404a-937a-b8222ffcc157';

  console.log('=== Testing Export Fix Logic (Final Version) ===\n');

  // Fetch the same data the export function fetches
  const document = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  if (!document) {
    console.log('Document not found');
    return;
  }

  console.log('Document:', document.originalName);
  console.log('Citations:', document.citations.length);
  console.log('References:', document.referenceListEntries.length);

  // Get stored changes
  const storedResequenceChanges = await prisma.citationChange.findMany({
    where: { documentId: docId, changeType: 'RESEQUENCE', isReverted: false }
  });
  const storedRenumberChanges = await prisma.citationChange.findMany({
    where: { documentId: docId, changeType: 'RENUMBER', isReverted: false }
  });
  const storedReferenceDeleteChanges = await prisma.citationChange.findMany({
    where: { documentId: docId, changeType: 'REFERENCE_DELETE', isReverted: false }
  });

  console.log('\n=== Stored Changes ===');
  console.log('RESEQUENCE:', storedResequenceChanges.length);
  storedResequenceChanges.forEach(c => console.log('  ' + c.beforeText + ' -> ' + c.afterText));
  console.log('RENUMBER:', storedRenumberChanges.length);
  storedRenumberChanges.forEach(c => console.log('  ' + c.beforeText + ' -> ' + c.afterText));
  console.log('REFERENCE_DELETE:', storedReferenceDeleteChanges.length);
  storedReferenceDeleteChanges.forEach(c => console.log('  ' + c.beforeText + ' -> (deleted)'));

  // Simulate the export logic
  let changedCitationsWithType = [];
  const orphanedCitations = [];

  // Step 1: Use RESEQUENCE changes (if changedCitationsWithType is empty)
  if (storedResequenceChanges.length > 0) {
    changedCitationsWithType = storedResequenceChanges.map(change => ({
      oldText: change.beforeText,
      newText: change.afterText,
      changeType: 'renumber'
    }));
    console.log('\n=== Step 1: After RESEQUENCE changes ===');
    changedCitationsWithType.forEach(c => console.log('  ' + c.oldText + ' -> ' + c.newText));
  }

  // Step 2: Process RENUMBER changes (FIX PART 1)
  console.log('\n=== Step 2: Processing RENUMBER changes ===');
  if (storedRenumberChanges.length > 0) {
    for (const change of storedRenumberChanges) {
      if (change.afterText.toLowerCase().includes('orphaned')) {
        // FIX PART 1: Remove from changedCitationsWithType and add to orphanedCitations
        const existingIndex = changedCitationsWithType.findIndex(c => c.oldText === change.beforeText);
        if (existingIndex >= 0) {
          console.log('  FIX: Removing obsolete change: "' + change.beforeText + '"');
          changedCitationsWithType.splice(existingIndex, 1);
        }
        if (!orphanedCitations.includes(change.beforeText)) {
          orphanedCitations.push(change.beforeText);
          console.log('  FIX: Adding to orphanedCitations: "' + change.beforeText + '"');
        }
      } else {
        const existingIndex = changedCitationsWithType.findIndex(c => c.oldText === change.beforeText);
        if (existingIndex < 0) {
          changedCitationsWithType.push({
            oldText: change.beforeText,
            newText: change.afterText,
            changeType: 'renumber'
          });
        }
      }
    }
  }

  // Step 3: Add REFERENCE_DELETE changes to orphanedCitations
  console.log('\n=== Step 3: Processing REFERENCE_DELETE changes ===');
  if (storedReferenceDeleteChanges.length > 0) {
    for (const deleteChange of storedReferenceDeleteChanges) {
      if (!orphanedCitations.includes(deleteChange.beforeText)) {
        orphanedCitations.push(deleteChange.beforeText);
        console.log('  Adding from REFERENCE_DELETE: "' + deleteChange.beforeText + '"');
      } else {
        console.log('  Already in orphanedCitations: "' + deleteChange.beforeText + '"');
      }
    }
  }

  // Step 4: FIX PART 2 - Chain orphaned citations through renumber changes
  // IMPORTANT: Use a SNAPSHOT of orphanedCitations to avoid cascading chains
  console.log('\n=== Step 4: Chaining orphaned citations (FIX PART 2 - Fixed) ===');
  console.log('  Original orphanedCitations snapshot:', orphanedCitations.join(', '));
  const originalOrphanedSet = new Set(orphanedCitations);
  for (let i = changedCitationsWithType.length - 1; i >= 0; i--) {
    const change = changedCitationsWithType[i];
    // Only check against the ORIGINAL orphaned set, not the growing list
    if (originalOrphanedSet.has(change.newText)) {
      console.log('  Chaining: "' + change.oldText + '" -> "' + change.newText + '" (orphaned)');
      console.log('    -> Treating "' + change.oldText + '" as orphaned');
      changedCitationsWithType.splice(i, 1);
      if (!orphanedCitations.includes(change.oldText)) {
        orphanedCitations.push(change.oldText);
      }
    }
  }

  console.log('\n========================================');
  console.log('=== FINAL RESULT ===');
  console.log('========================================');
  console.log('\nchangedCitationsWithType (' + changedCitationsWithType.length + '):');
  if (changedCitationsWithType.length === 0) {
    console.log('  (none)');
  } else {
    changedCitationsWithType.forEach(c => console.log('  "' + c.oldText + '" -> "' + c.newText + '"'));
  }
  console.log('\norphanedCitations (' + orphanedCitations.length + '):');
  orphanedCitations.forEach(c => console.log('  "' + c + '"'));

  console.log('\n=== EXPECTED BEHAVIOR IN EXPORTED DOCX ===');
  console.log('\nCitations that will be CHANGED (strikethrough old + insert new):');
  if (changedCitationsWithType.length === 0) {
    console.log('  (none)');
  } else {
    changedCitationsWithType.forEach(c => {
      console.log('  Original: "' + c.oldText + '" -> New: "' + c.newText + '"');
    });
  }
  console.log('\nCitations that will be DELETED (strikethrough only):');
  orphanedCitations.forEach(c => {
    console.log('  "' + c + '" will be struck through');
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
