// Deep investigation of the ONE orphaned /TR (5069 0 R, page 15) that
// PR #740's reattachTableRow correctly declined to fix: no reachable
// /Table was found with any content on page 15, even broadened to pages
// 14-16. This script builds a complete picture of page 15's real
// structure (everything connected AND disconnected, any /S type) plus
// the raw content-stream neighborhood around the orphan's own MCID, to
// find out WHY no Table claims it -- never a wrapper that's merely
// orphaned itself (the full raw StructElem scan already ruled that out:
// zero orphans of any type except these exact 5 TD/TR pairs).
//
// Usage: npx tsx scripts/investigate-page15-table.ts "<path-to-pdf>"

import fs from 'fs';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { decodePageContent } from '../src/services/pdf/pdf-content-stream-io';
import { tokenize } from '../src/services/zone-extractor/seam-c/content-stream';

async function main() {
  const pdfPath = process.argv[2];
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));
  const PAGE = 15;
  const pageRef = doc.getPages()[PAGE - 1].ref;

  console.log(`=== 1. Every StructElem (any /S, connected or orphaned) whose own /Pg is page ${PAGE} ===`);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.toString() !== '/StructElem') continue;
    const pgRaw = obj.get(PDFName.of('Pg'));
    if (!(pgRaw instanceof PDFRef) || pgRaw.toString() !== pageRef.toString()) continue;
    const s = obj.get(PDFName.of('S'))?.toString();
    const p = obj.get(PDFName.of('P'));
    const k = obj.get(PDFName.of('K'));
    const kDesc = k instanceof PDFNumber ? `MCID ${k.asNumber()}` : k instanceof PDFArray ? `Array(${k.asArray().length})` : k instanceof PDFRef ? k.toString() : String(k);
    console.log(`  [${ref.toString()}] S=${s} P=${p instanceof PDFRef ? p.toString() : p} K=${kDesc}`);
  }

  console.log(`\n=== 2. ParentTree page array for page ${PAGE} (every MCID -> struct element) ===`);
  const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
  if (structRoot instanceof PDFDict) {
    const page = doc.getPages()[PAGE - 1];
    const structParentsRaw = page.node.get(PDFName.of('StructParents'));
    const structParents = structParentsRaw instanceof PDFRef ? doc.context.lookup(structParentsRaw) : structParentsRaw;
    const pageKey = structParents instanceof PDFNumber ? structParents.asNumber() : null;
    console.log(`  page's own StructParents key: ${pageKey}`);
    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    const findInNode = (node: PDFDict): PDFArray | null => {
      const numsRaw = node.get(PDFName.of('Nums'));
      if (numsRaw) {
        const numsArr = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
        if (!(numsArr instanceof PDFArray)) return null;
        const raw = numsArr.asArray();
        for (let i = 0; i < raw.length; i += 2) {
          const key = raw[i] instanceof PDFNumber ? (raw[i] as PDFNumber).asNumber() : null;
          if (key !== pageKey) continue;
          const val = raw[i + 1] instanceof PDFRef ? doc.context.lookup(raw[i + 1]) : raw[i + 1];
          return val instanceof PDFArray ? val : null;
        }
        return null;
      }
      const kidsRaw = node.get(PDFName.of('Kids'));
      if (!kidsRaw) return null;
      const kids = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
      if (!(kids instanceof PDFArray)) return null;
      for (const kidRef of kids.asArray()) {
        const kid = kidRef instanceof PDFRef ? doc.context.lookup(kidRef) : kidRef;
        if (kid instanceof PDFDict) {
          const found = findInNode(kid);
          if (found) return found;
        }
      }
      return null;
    };
    const pageArr = pageKey !== null && parentTreeDict instanceof PDFDict ? findInNode(parentTreeDict) : null;
    if (pageArr) {
      const raw = pageArr.asArray();
      for (let mcid = 0; mcid < raw.length; mcid++) {
        const entry = raw[mcid];
        if (entry instanceof PDFRef) {
          const resolved = doc.context.lookup(entry);
          const s = resolved instanceof PDFDict ? resolved.get(PDFName.of('S'))?.toString() : undefined;
          console.log(`  MCID ${mcid} -> ${entry.toString()} (S=${s})`);
        } else if (entry !== undefined && entry !== null) {
          console.log(`  MCID ${mcid} -> ${entry.toString()}`);
        }
      }
    } else {
      console.log('  No ParentTree page array found for this page.');
    }
  }

  console.log(`\n=== 3. Raw content-stream tokens around MCID 1 on page ${PAGE} (BDC/EMC structure) ===`);
  const content = decodePageContent(doc, PAGE);
  if (content) {
    const tokens = tokenize(content);
    // Print every BDC/BMC/EMC with its tag name and any MCID, in order,
    // to see the real nesting/ordering of marked content on this page.
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.t === 'op' && (tok.v === 'BDC' || tok.v === 'BMC' || tok.v === 'EMC')) {
        let label = tok.v;
        if (tok.v !== 'EMC') {
          // find tag name: walk back past the properties dict/name to the tag
          let j = i - 1;
          if (tokens[j]?.t === '>>') {
            let depth = 1; j--;
            while (j >= 0 && depth > 0) {
              if (tokens[j].t === '>>') depth++;
              else if (tokens[j].t === '<<') depth--;
              j--;
            }
          } else if (tokens[j]?.t === 'name') {
            j--;
          }
          const tagTok = tokens[j];
          label += ` /${tagTok?.v ?? '?'}`;
          // if inline dict has MCID, print it
          if (tokens[i - 1]?.t === '>>') {
            const dictStr = content.slice(tokens[j + 1]?.start ?? 0, tokens[i - 1].end);
            const mcidMatch = /\/MCID\s+(\d+)/.exec(dictStr);
            if (mcidMatch) label += ` MCID=${mcidMatch[1]}`;
          }
        }
        console.log(`  [offset ${tok.start}] ${label}`);
      }
    }
  } else {
    console.log('  Could not decode page content.');
  }

  console.log(`\n=== 4. Object-number neighbors of orphaned TR 5069 0 R and TD 5070 0 R (what else was created alongside them) ===`);
  for (const num of [5067, 5068, 5069, 5070, 5071, 5072]) {
    const ref = PDFRef.of(num, 0);
    const obj = doc.context.lookup(ref);
    if (obj instanceof PDFDict) {
      const type = obj.get(PDFName.of('Type'))?.toString();
      const s = obj.get(PDFName.of('S'))?.toString();
      console.log(`  ${num} 0 R: Type=${type} S=${s}`);
    } else {
      console.log(`  ${num} 0 R: (not a dict / not found)`);
    }
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
