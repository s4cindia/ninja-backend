/**
 * Citation Management Test Script
 * Tests: upload, edit year, edit author, delete reference, swap references, export
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const API_BASE = 'http://localhost:3001/api/v1';
let authToken = null;

async function register() {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'citationtest@ninja.local',
      password: 'Test123456!',
      firstName: 'Citation',
      lastName: 'Tester'
    })
  });
  return res.json();
}

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'citationtest@ninja.local',
      password: 'Test123456!'
    })
  });
  const data = await res.json();
  if (data.success) {
    authToken = data.data.accessToken;
    console.log('Logged in successfully');
  }
  return data;
}

async function uploadDocument(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', fileBuffer, {
    filename: fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const res = await fetch(`${API_BASE}/citation-management/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      ...formData.getHeaders()
    },
    body: formData
  });
  return res.json();
}

async function getAnalysis(documentId) {
  const res = await fetch(`${API_BASE}/citation-management/document/${documentId}/analysis`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  return res.json();
}

async function editReference(documentId, referenceId, updates) {
  const res = await fetch(`${API_BASE}/citation-management/document/${documentId}/reference/${referenceId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  return res.json();
}

async function deleteReference(documentId, referenceId) {
  const res = await fetch(`${API_BASE}/citation-management/document/${documentId}/reference/${referenceId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  return res.json();
}

async function reorderReference(documentId, referenceId, newPosition) {
  const res = await fetch(`${API_BASE}/citation-management/document/${documentId}/reorder`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ referenceId, newPosition })
  });
  return res.json();
}

async function exportDocument(documentId, outputPath) {
  const res = await fetch(`${API_BASE}/citation-management/document/${documentId}/export`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });

  if (res.ok) {
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(buffer));
    return { success: true, path: outputPath };
  }
  return { success: false, error: await res.text() };
}

async function testDocument(name, filePath) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TESTING: ${name}`);
  console.log('='.repeat(60));

  // 1. Upload
  console.log('\n1. Uploading document...');
  const uploadResult = await uploadDocument(filePath);
  if (!uploadResult.success) {
    console.log('Upload failed:', uploadResult.error);
    return { name, success: false, error: 'Upload failed' };
  }
  const documentId = uploadResult.data.documentId;
  console.log(`   Document ID: ${documentId}`);

  // Wait for analysis to complete
  await new Promise(r => setTimeout(r, 3000));

  // 2. Get analysis
  console.log('\n2. Getting analysis...');
  const analysis = await getAnalysis(documentId);
  if (!analysis.success) {
    console.log('Analysis failed:', analysis.error);
    return { name, success: false, error: 'Analysis failed' };
  }

  const citations = analysis.data.citations || [];
  const references = analysis.data.references || [];
  const style = analysis.data.detectedStyle || 'Unknown';

  console.log(`   Style: ${style}`);
  console.log(`   Citations: ${citations.length}`);
  console.log(`   References: ${references.length}`);

  if (references.length === 0) {
    console.log('   No references found, skipping operations');
    return { name, success: false, error: 'No references found' };
  }

  // Print initial state
  console.log('\n   Initial citations:');
  citations.slice(0, 5).forEach((c, i) => {
    console.log(`     [${i+1}] "${c.rawText}" (type: ${c.citationType})`);
  });

  console.log('\n   Initial references:');
  references.slice(0, 5).forEach((r, i) => {
    console.log(`     [${i+1}] ${r.authors?.[0] || 'Unknown'} (${r.year || 'N/A'})`);
  });

  const results = {
    name,
    style,
    documentId,
    initialCitations: citations.length,
    initialReferences: references.length,
    operations: []
  };

  // 3. Edit year on first reference
  if (references.length > 0) {
    console.log('\n3. Editing year on first reference...');
    const ref = references[0];
    const oldYear = ref.year;
    const newYear = '1999';
    const editYearResult = await editReference(documentId, ref.id, { year: newYear });
    console.log(`   ${ref.authors?.[0] || 'Unknown'}: ${oldYear} -> ${newYear}`);
    console.log(`   Result: ${editYearResult.success ? 'SUCCESS' : 'FAILED'}`);
    results.operations.push({ op: 'edit_year', success: editYearResult.success });
  }

  // 4. Edit author on second reference
  if (references.length > 1) {
    console.log('\n4. Editing author on second reference...');
    const ref = references[1];
    const oldAuthor = ref.authors?.[0] || 'Unknown';
    const newAuthors = ['TestAuthor'];
    const editAuthorResult = await editReference(documentId, ref.id, { authors: newAuthors });
    console.log(`   ${oldAuthor} -> TestAuthor`);
    console.log(`   Result: ${editAuthorResult.success ? 'SUCCESS' : 'FAILED'}`);
    results.operations.push({ op: 'edit_author', success: editAuthorResult.success });
  }

  // 5. Delete third reference (if exists)
  if (references.length > 2) {
    console.log('\n5. Deleting third reference...');
    const ref = references[2];
    const deleteResult = await deleteReference(documentId, ref.id);
    console.log(`   Deleted: ${ref.authors?.[0] || 'Unknown'} (${ref.year || 'N/A'})`);
    console.log(`   Result: ${deleteResult.success ? 'SUCCESS' : 'FAILED'}`);
    results.operations.push({ op: 'delete', success: deleteResult.success });
  }

  // 6. Swap references (move first to position 2)
  if (references.length > 1) {
    console.log('\n6. Swapping references (move ref 1 to position 2)...');
    // Get fresh analysis after deletion
    const freshAnalysis = await getAnalysis(documentId);
    const freshRefs = freshAnalysis.data?.references || [];
    if (freshRefs.length > 1) {
      const reorderResult = await reorderReference(documentId, freshRefs[0].id, 2);
      console.log(`   Result: ${reorderResult.success ? 'SUCCESS' : 'FAILED'}`);
      results.operations.push({ op: 'swap', success: reorderResult.success });
    }
  }

  // 7. Export
  console.log('\n7. Exporting modified document...');
  const outputPath = filePath.replace('.docx', '_TESTED.docx');
  const exportResult = await exportDocument(documentId, outputPath);
  console.log(`   Result: ${exportResult.success ? 'SUCCESS' : 'FAILED'}`);
  if (exportResult.success) {
    console.log(`   Output: ${outputPath}`);
  }
  results.operations.push({ op: 'export', success: exportResult.success });
  results.outputPath = outputPath;

  // 8. Verify output
  if (exportResult.success) {
    console.log('\n8. Verifying output...');
    const { execSync } = require('child_process');
    try {
      const content = execSync(`unzip -p "${outputPath}" word/document.xml 2>/dev/null`).toString();

      // Check for Track Changes markers
      const hasInsertions = content.includes('<w:ins');
      const hasDeletions = content.includes('<w:del');

      console.log(`   Track Changes - Insertions: ${hasInsertions ? 'YES' : 'NO'}`);
      console.log(`   Track Changes - Deletions: ${hasDeletions ? 'YES' : 'NO'}`);

      // Extract visible text for comparison
      const textContent = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // Check if year was changed
      if (textContent.includes('1999')) {
        console.log('   Year change (1999): FOUND');
      }

      // Check if author was changed
      if (textContent.includes('TestAuthor')) {
        console.log('   Author change (TestAuthor): FOUND');
      }

      results.verification = {
        hasInsertions,
        hasDeletions,
        yearChangeVisible: textContent.includes('1999'),
        authorChangeVisible: textContent.includes('TestAuthor')
      };
    } catch (e) {
      console.log('   Verification failed:', e.message);
    }
  }

  return results;
}

async function main() {
  console.log('Citation Management Test Suite');
  console.log('==============================\n');

  // Register and login
  console.log('Setting up authentication...');
  await register();
  const loginResult = await login();
  if (!loginResult.success) {
    console.log('Login failed:', loginResult.error);
    return;
  }

  const testFiles = [
    { name: 'APA.docx', path: 'C:/Users/sakthivelv/Downloads/APA.docx' },
    { name: 'vancouver.docx', path: 'C:/Users/sakthivelv/Downloads/vancouver.docx' },
    { name: 'Chicago.docx', path: 'C:/Users/sakthivelv/Downloads/Chicago.docx' },
    { name: 'Book.docx', path: 'C:/Users/sakthivelv/Downloads/Book.docx' }
  ];

  const results = [];
  for (const file of testFiles) {
    try {
      const result = await testDocument(file.name, file.path);
      results.push(result);
    } catch (e) {
      console.log(`Error testing ${file.name}:`, e.message);
      results.push({ name: file.name, success: false, error: e.message });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  for (const r of results) {
    console.log(`\n${r.name}:`);
    console.log(`  Style: ${r.style || 'Unknown'}`);
    console.log(`  Citations: ${r.initialCitations || 0}, References: ${r.initialReferences || 0}`);
    if (r.operations) {
      for (const op of r.operations) {
        console.log(`  ${op.op}: ${op.success ? 'PASS' : 'FAIL'}`);
      }
    }
    if (r.verification) {
      console.log(`  Track Changes: ${r.verification.hasInsertions || r.verification.hasDeletions ? 'YES' : 'NO'}`);
    }
    if (r.outputPath) {
      console.log(`  Output: ${r.outputPath}`);
    }
  }
}

main().catch(console.error);
