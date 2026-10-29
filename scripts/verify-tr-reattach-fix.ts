// Real-document verification of the new TR-reattachment fix: runs the
// updated pdfTableCellTreeValidator against the actual Farrar remediated
// PDF, confirms it reports 5 TABLE-ROW-DISCONNECTED issues, applies
// pdfStructureWriterService.reattachTableRow to all of them, and reports
// before/after results -- expecting 4 successes (the clean first-row
// cases) and 1 honest decline (the page-15 case with no reachable Table
// candidate at all).
//
// Usage: npx tsx scripts/verify-tr-reattach-fix.ts "<path-to-pdf>"

import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { pdfParserService } from '../src/services/pdf/pdf-parser.service';
import { pdfTableCellTreeValidator } from '../src/services/pdf/validators/pdf-table-cell-tree.validator';
import { pdfStructureWriterService } from '../src/services/pdf/pdf-structure-writer.service';

async function main() {
  const pdfPath = process.argv[2];
  const parsedPdf = await pdfParserService.parse(pdfPath);
  try {
    const result = await pdfTableCellTreeValidator.validate(parsedPdf);
    console.log('Metadata:', result.metadata);
    const rowIssues = result.issues.filter(i => i.code === 'TABLE-ROW-DISCONNECTED');
    const cellIssues = result.issues.filter(i => i.code === 'TABLE-CELL-DISCONNECTED');
    console.log(`\nTABLE-ROW-DISCONNECTED issues: ${rowIssues.length}`);
    for (const i of rowIssues) console.log(`  ${i.element} (page ${i.pageNumber})`);
    console.log(`\nTABLE-CELL-DISCONNECTED issues (for reference, should be unaffected): ${cellIssues.length}`);

    // Apply the fix against a FRESH load of the same bytes (mirrors how
    // the real pipeline re-loads the doc for the apply step).
    const bytes = fs.readFileSync(pdfPath);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const fixResults = pdfStructureWriterService.reattachTableRow(doc, rowIssues);
    console.log('\n=== Fix results ===');
    let successCount = 0;
    for (const r of fixResults) {
      console.log(`  ${r.issueId}: success=${r.success} after="${r.after}" error="${r.error ?? ''}"`);
      if (r.success) successCount++;
    }
    console.log(`\n${successCount}/${fixResults.length} succeeded`);

    // Re-validate against the MUTATED in-memory doc's own struct tree by
    // re-running the SAME reachability check the validator uses, to
    // confirm the fixed rows are now genuinely reachable (not just
    // reported success) and that nothing else broke.
    console.log('\n=== Re-check: are the 4 successfully-fixed TRs now actually reachable? ===');
    const { PDFName, PDFDict, PDFArray, PDFRef } = await import('pdf-lib');
    const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
    const reachable = new Set<string>();
    if (structRoot instanceof PDFDict) {
      const seen = new Set<string>();
      const walk = (nodeRef: unknown): void => {
        if (nodeRef instanceof PDFRef) {
          const key = nodeRef.toString();
          if (seen.has(key)) return;
          seen.add(key);
          reachable.add(key);
        }
        const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
        if (node instanceof PDFArray) { for (const item of node.asArray()) walk(item); return; }
        if (!(node instanceof PDFDict)) return;
        const k = node.get(PDFName.of('K'));
        if (k !== undefined) walk(k);
      };
      walk(structRoot.get(PDFName.of('K')));
    }
    const origOrphanRefs = ['5069 0 R', '5470 0 R', '5592 0 R', '5938 0 R', '5988 0 R'];
    for (const refStr of origOrphanRefs) {
      console.log(`  ${refStr}: reachable=${reachable.has(refStr)}`);
    }
  } finally {
    await pdfParserService.close(parsedPdf);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
