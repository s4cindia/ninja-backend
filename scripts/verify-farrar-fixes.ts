// Real-world verification: applies the new Matterhorn 01-004 (tagged
// content inside Artifact) and TABLE-CELL-DISCONNECTED fixes directly
// against Farrar's actual remediated PDF (the same file
// investigate-farrar-pac-gap.js found the real defects in), confirming
// both classes of violation drop to zero -- the same direct forensic
// method that found the bugs, now closing the loop on the real document
// rather than trusting unit tests alone.
//
// Usage: npx tsx scripts/verify-farrar-fixes.ts "<path-to-pdf>"

import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { findTaggedContentInsideArtifact, splitArtifactAroundTaggedContent } from '../src/services/pdf/pdf-artifact-tagger';
import { pdfTableCellTreeValidator } from '../src/services/pdf/validators/pdf-table-cell-tree.validator';
import { pdfStructureWriterService } from '../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../src/services/pdf/pdf-parser.service';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: npx tsx verify-farrar-fixes.ts <path-to-pdf>');
    process.exit(1);
  }
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  // ---- 1. Matterhorn 01-004: tagged content inside Artifact ----
  const pages = doc.getPages();
  let totalBefore = 0;
  let totalAfter = 0;
  for (let i = 0; i < pages.length; i++) {
    const pageNumber = i + 1;
    let content: string | null;
    try {
      content = decodePageContent(doc, pageNumber);
    } catch {
      continue;
    }
    if (!content) continue;

    const before = findTaggedContentInsideArtifact(content).length;
    if (before === 0) continue;
    totalBefore += before;

    const { content: fixed } = splitArtifactAroundTaggedContent(content);
    writePageContent(doc, pageNumber, fixed);

    const after = findTaggedContentInsideArtifact(fixed).length;
    totalAfter += after;
    console.log(`Page ${pageNumber}: ${before} violation(s) before -> ${after} after`);
  }
  console.log(`\n=== Matterhorn 01-004 ===`);
  console.log(`Total violations before: ${totalBefore}`);
  console.log(`Total violations after:  ${totalAfter}`);
  console.log(totalAfter === 0 ? 'PASS: all nesting violations resolved.' : 'FAIL: violations remain.');

  // ---- 2. TABLE-CELL-DISCONNECTED ----
  const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
  const before = await pdfTableCellTreeValidator.validate(parsedPdf);
  console.log(`\n=== TABLE-CELL-DISCONNECTED ===`);
  console.log(`Disconnected cells before: ${before.issues.length} (of ${before.metadata.totalCells} total cells)`);

  if (before.issues.length > 0) {
    const results = pdfStructureWriterService.reattachTableCell(doc, before.issues);
    for (const r of results) {
      console.log(`  ${r.issueId}: ${r.success ? 'OK' : 'FAILED'} -- ${r.success ? r.after : r.error}`);
    }
  }

  const after = await pdfTableCellTreeValidator.validate(parsedPdf);
  console.log(`Disconnected cells after:  ${after.issues.length} (of ${after.metadata.totalCells} total cells)`);
  console.log(after.issues.length === 0 ? 'PASS: all disconnected cells reattached.' : 'FAIL: cells remain disconnected.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
