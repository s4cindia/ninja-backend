/**
 * Test placeholder-based replacement
 */

function testReplacement() {
  const oldToNewNumberMap = new Map([
    [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7],
    [9, 8], [10, 9], [11, 10], [12, 11], [13, 12], [14, 13],
    [15, 14], [16, 15], [17, 16], [18, 17], [19, 19], [20, 18]
  ]);

  const testCases = [
    '(4, 5)',
    '(7, 8)',
    '(19)',
    '(20)',
    '(1)',  // deleted - should not change
  ];

  console.log('=== TESTING PLACEHOLDER REPLACEMENT ===\n');

  for (const rawText of testCases) {
    const numbers = rawText.match(/\d+/g) || [];
    let newText = rawText;
    let hasChanges = false;

    const sortedNumbers = [...new Set(numbers)].sort((a, b) => b.length - a.length || parseInt(b) - parseInt(a));

    // Phase 1: Replace with placeholders
    const placeholderMap = new Map();
    for (const numStr of sortedNumbers) {
      const oldNum = parseInt(numStr);
      const newNum = oldToNewNumberMap.get(oldNum);

      if (newNum && newNum !== oldNum) {
        const placeholder = `__NUM_${oldNum}__`;
        placeholderMap.set(placeholder, newNum);
        const regex = new RegExp(`\\b${oldNum}\\b`, 'g');
        newText = newText.replace(regex, placeholder);
        hasChanges = true;
      }
    }

    // Phase 2: Replace placeholders with new numbers
    for (const [placeholder, newNum] of placeholderMap) {
      newText = newText.replace(new RegExp(placeholder, 'g'), String(newNum));
    }

    console.log(`"${rawText}" → "${newText}" ${hasChanges ? '(changed)' : '(unchanged)'}`);
  }
}

testReplacement();
