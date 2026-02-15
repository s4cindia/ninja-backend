/**
 * Test multi-number citation replacement logic
 */

// Simulate the new logic
function testMultiCitationReplacement() {
  // Sample data simulating the document state
  const citations = [
    { id: 'c1', rawText: '(4, 5)' },
    { id: 'c2', rawText: '(4, 5)' },
    { id: 'c3', rawText: '(7, 8)' },
    { id: 'c4', rawText: '(7, 8)' },
    { id: 'c5', rawText: '(19)' },
    { id: 'c6', rawText: '(4)' },
    { id: 'c7', rawText: '(5)' },
  ];

  // Citation to reference mapping (after reordering/deletion)
  // Old ref 1,2 deleted, so 3→1, 4→2, 5→3, etc.
  const citationToRefMap = new Map([
    ['c1', 2],  // citation (4, 5) linked to new ref 2 (was ref 4)
    ['c2', 3],  // citation (4, 5) linked to new ref 3 (was ref 5)
    ['c3', 5],  // citation (7, 8) linked to new ref 5 (was ref 7)
    ['c4', 6],  // citation (7, 8) linked to new ref 6 (was ref 8)
    ['c5', 17], // citation (19) linked to new ref 17 (was ref 19)
    ['c6', 2],  // citation (4) linked to new ref 2 (was ref 4)
    ['c7', 3],  // citation (5) linked to new ref 3 (was ref 5)
  ]);

  // Build old to new number mapping
  const oldToNewNumberMap = new Map();
  const deletedNumbers = new Set();

  citations.forEach(citation => {
    const newRefNumber = citationToRefMap.get(citation.id);
    if (citation.rawText) {
      const numbers = citation.rawText.match(/\d+/g) || [];
      numbers.forEach(numStr => {
        const oldNum = parseInt(numStr);
        if (newRefNumber) {
          const firstNum = parseInt(numbers[0]);
          if (oldNum === firstNum && !oldToNewNumberMap.has(oldNum)) {
            oldToNewNumberMap.set(oldNum, newRefNumber);
          }
        } else {
          deletedNumbers.add(oldNum);
        }
      });
    }
  });

  console.log('=== NUMBER MAPPING ===');
  console.log('Old → New:', [...oldToNewNumberMap.entries()].map(([o, n]) => `${o}→${n}`).join(', '));
  console.log('Deleted:', [...deletedNumbers].join(', '));

  // Build changed citations
  const changedCitations = [];
  const processedTexts = new Set();

  citations.forEach(citation => {
    if (!citation.rawText || processedTexts.has(citation.rawText)) {
      return;
    }
    processedTexts.add(citation.rawText);

    const rawText = citation.rawText;
    const numbers = rawText.match(/\d+/g) || [];

    let newText = rawText;
    let hasChanges = false;

    // Sort numbers by length/value descending to avoid partial replacements
    const sortedNumbers = [...new Set(numbers)].sort((a, b) => b.length - a.length || parseInt(b) - parseInt(a));

    for (const numStr of sortedNumbers) {
      const oldNum = parseInt(numStr);
      const newNum = oldToNewNumberMap.get(oldNum);

      if (newNum && newNum !== oldNum) {
        const regex = new RegExp(`\\b${oldNum}\\b`, 'g');
        newText = newText.replace(regex, String(newNum));
        hasChanges = true;
      }
    }

    if (hasChanges) {
      changedCitations.push({ oldText: rawText, newText });
    }
  });

  console.log('\n=== CHANGED CITATIONS ===');
  changedCitations.forEach(c => {
    console.log(`"${c.oldText}" → "${c.newText}"`);
  });

  // Expected results:
  // (4, 5) → (2, 3) - both numbers updated
  // (7, 8) → (5, 6) - both numbers updated
  // (19) → (17)
  // (4) → (2)
  // (5) → (3)
}

testMultiCitationReplacement();
