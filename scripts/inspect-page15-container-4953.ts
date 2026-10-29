// Confirms the hypothesis from investigate-page15-table.ts: page 15's
// orphaned TR (5069 0 R) sits, in reading order, between an /H6 (5067 0
// R, MCID 0) and a /P (5071 0 R, MCID 2) that are BOTH direct children
// of the SAME container (4953 0 R per their own /P field) -- meaning the
// orphan's rightful parent is that shared container directly, not a
// dedicated /Table wrapper, with an exact one-slot gap where it belongs.
//
// Usage: npx tsx scripts/inspect-page15-container-4953.ts "<path-to-pdf>"

import fs from 'fs';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';

async function main() {
  const pdfPath = process.argv[2];
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  const containerRef = PDFRef.of(4953, 0);
  const container = doc.context.lookup(containerRef, PDFDict);
  console.log('Container 4953 0 R: S=', container.get(PDFName.of('S'))?.toString(), 'P=', container.get(PDFName.of('P'))?.toString());

  const k = container.get(PDFName.of('K'));
  const kResolved = k instanceof PDFRef ? doc.context.lookup(k) : k;
  if (kResolved instanceof PDFArray) {
    console.log(`Container's own /K array (${kResolved.size()} entries):`);
    for (let i = 0; i < kResolved.size(); i++) {
      const entry = kResolved.get(i);
      if (entry instanceof PDFRef) {
        const resolved = doc.context.lookup(entry, PDFDict);
        const s = resolved.get(PDFName.of('S'))?.toString();
        console.log(`  [${i}] ${entry.toString()} S=${s}`);
      } else {
        console.log(`  [${i}] ${entry?.toString()}`);
      }
    }
  } else {
    console.log('Container /K is not an array:', kResolved?.toString());
  }

  // Confirm container is reachable from root.
  const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
  const seen = new Set<string>();
  let reachable = false;
  const walk = (nodeRef: unknown): void => {
    if (reachable) return;
    if (nodeRef instanceof PDFRef) {
      const key = nodeRef.toString();
      if (key === containerRef.toString()) { reachable = true; return; }
      if (seen.has(key)) return;
      seen.add(key);
    }
    const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
    if (node instanceof PDFArray) { for (const item of node.asArray()) walk(item); return; }
    if (!(node instanceof PDFDict)) return;
    const kk = node.get(PDFName.of('K'));
    if (kk !== undefined) walk(kk);
  };
  if (structRoot instanceof PDFDict) walk(structRoot.get(PDFName.of('K')));
  console.log('\nContainer 4953 0 R reachable from StructTreeRoot:', reachable);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
