// Diagnostic script: investigate why PAC/axesPAC finds hundreds of
// "Path object not tagged"/"Text object not tagged"/"Tagged content
// present inside an artifact" errors on a Ninja-remediated PDF that
// Ninja's own audit reported ZERO of (Farrar 2E_Comp_188910, 2026-10-29).
//
// Two checks, mirroring the two previously-confirmed real root causes for
// this exact PAC symptom in this codebase:
//
//   1. Tree-disconnection (pdf-figure-caption-tree.validator.ts /
//      pdf-inline-figure-tree.validator.ts's own root cause): content that
//      IS tagged (MCID-bearing, resolvable via /ParentTree) but never
//      linked into any parent's /K array, so a top-down reader (PAC, a
//      screen reader) never reaches it -- invisible despite "being tagged."
//      Generalized here to ALL struct-element tag types, not just /fc.
//
//   2. Genuinely untagged content (pdf-artifact-tagger.ts's own root
//      cause, paths only there): path-paint or text-show operators with NO
//      enclosing BDC/BMC span at all. Extended here to also check TEXT
//      show operators (Tj/TJ/'/") and to flag real-tagged content nested
//      inside an outer /Artifact span (the "tagged content present inside
//      an artifact" PAC finding -- the inverse nesting problem).
//
// Usage: node scripts/investigate-farrar-pac-gap.js "<path-to-pdf>"

const fs = require('fs');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, decodePDFRawStream } = require('pdf-lib');

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node investigate-farrar-pac-gap.js <path-to-pdf>');
    process.exit(1);
  }
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });

  const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
  if (!(structRoot instanceof PDFDict)) {
    console.log('No /StructTreeRoot found -- document is not tagged at all.');
    return;
  }

  const pageByRef = new Map();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  // ---- 1. Top-down reachability (same traversal as pdf-figure-caption-tree.validator.ts) ----
  const reachable = new Set();
  const seenTD = new Set();
  function visitTopDown(nodeRef) {
    if (nodeRef instanceof PDFRef) {
      const key = nodeRef.toString();
      if (seenTD.has(key)) return;
      seenTD.add(key);
      reachable.add(key);
    }
    const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
    if (node instanceof PDFArray) {
      for (const item of node.asArray()) visitTopDown(item);
      return;
    }
    if (!(node instanceof PDFDict)) return;
    const k = node.get(PDFName.of('K'));
    if (k !== undefined) visitTopDown(k);
  }
  visitTopDown(structRoot.get(PDFName.of('K')));

  // ---- 2. Bottom-up: every StructElem referenced anywhere in /ParentTree, of ANY tag type ----
  const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
  const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
  const allRefs = new Map(); // key -> {tag, page}
  function walkNumsTree(node) {
    const numsRaw = node.get(PDFName.of('Nums'));
    if (numsRaw) {
      const numsArr = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
      if (!(numsArr instanceof PDFArray)) return;
      const raw = numsArr.asArray();
      for (let i = 1; i < raw.length; i += 2) {
        const valRaw = raw[i];
        const val = valRaw instanceof PDFRef ? doc.context.lookup(valRaw) : valRaw;
        const entries = val instanceof PDFArray ? val.asArray() : [valRaw];
        for (const entry of entries) {
          if (!(entry instanceof PDFRef)) continue;
          const key = entry.toString();
          const resolved = doc.context.lookup(entry);
          if (!(resolved instanceof PDFDict)) continue;
          const tagRaw = resolved.get(PDFName.of('S'));
          const tag = tagRaw ? tagRaw.toString().replace(/^\//, '') : '(untyped)';
          const pgRaw = resolved.get(PDFName.of('Pg'));
          const page = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) : undefined;
          if (!allRefs.has(key)) allRefs.set(key, { tag, page });
        }
      }
      return;
    }
    const kidsRaw = node.get(PDFName.of('Kids'));
    if (!kidsRaw) return;
    const kids = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
    if (!(kids instanceof PDFArray)) return;
    for (const kidRef of kids.asArray()) {
      const kid = kidRef instanceof PDFRef ? doc.context.lookup(kidRef) : kidRef;
      if (kid instanceof PDFDict) walkNumsTree(kid);
    }
  }
  if (parentTreeDict instanceof PDFDict) walkNumsTree(parentTreeDict);

  const disconnected = [];
  for (const [key, info] of allRefs) {
    if (!reachable.has(key)) disconnected.push({ key, ...info });
  }

  console.log('=== Check 1: Tree-disconnection (reverse-resolvable but not forward-reachable) ===');
  console.log(`Total StructElems referenced via ParentTree: ${allRefs.size}`);
  console.log(`Disconnected (orphaned from top-down tree): ${disconnected.length}`);
  const byTag = {};
  for (const d of disconnected) byTag[d.tag] = (byTag[d.tag] || 0) + 1;
  console.log('By tag:', byTag);
  console.log('Sample (first 10):', disconnected.slice(0, 10));
  console.log('');

  // ---- 3. Content-stream scan: untagged path/text runs + artifact-nesting ----
  const pages = doc.getPages();
  let pagesWithUntaggedPath = 0, pagesWithUntaggedText = 0, nestingViolations = 0;
  let totalUntaggedPathOps = 0, totalUntaggedTextOps = 0;
  const sampleUntaggedPath = [], sampleUntaggedText = [], sampleNesting = [];

  function getPageContentString(page) {
    const contentsRaw = page.node.get(PDFName.of('Contents'));
    const contents = contentsRaw instanceof PDFRef ? doc.context.lookup(contentsRaw) : contentsRaw;
    const streamDicts = contents instanceof PDFArray
      ? contents.asArray().map((r) => (r instanceof PDFRef ? doc.context.lookup(r) : r))
      : [contents];
    let combined = Buffer.alloc(0);
    for (const s of streamDicts) {
      if (!s) continue;
      try {
        const decoded = decodePDFRawStream(s).decode();
        combined = Buffer.concat([combined, Buffer.from(decoded), Buffer.from('\n')]);
      } catch (e) {
        // skip a stream that fails to decode -- not the focus of this check
      }
    }
    return combined.toString('latin1');
  }

  const PATH_PAINT_OPS = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
  const TEXT_SHOW_OPS = new Set(["Tj", 'TJ', "'", '"']);
  const tokenRe = /\/[A-Za-z0-9#_.]+|[A-Za-z*'"]+|\(|\)|<<|>>|\[|\]/g;

  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    let content;
    try { content = getPageContentString(pages[i]); } catch (e) { continue; }
    if (!content) continue;

    let depthParen = 0, depthAngle = 0;
    const stack = []; // { tag: string|null }
    let namesSinceLastOp = [];
    let pagePathCount = 0, pageTextCount = 0;
    let m;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(content)) !== null) {
      const tok = m[0];
      if (tok === '(') { depthParen++; continue; }
      if (tok === ')') { depthParen = Math.max(0, depthParen - 1); continue; }
      if (depthParen > 0) continue;
      if (tok === '<<') { depthAngle++; continue; }
      if (tok === '>>') { depthAngle = Math.max(0, depthAngle - 1); continue; }
      if (depthAngle > 0) continue;
      if (tok === '[' || tok === ']') continue;

      if (tok[0] === '/') { namesSinceLastOp.push(tok.slice(1)); continue; }

      if (tok === 'BDC' || tok === 'BMC') {
        const tag = namesSinceLastOp[0] || null; // first name = the actual tag; second (if any) is the MC property-list reference
        const isRealTag = tok === 'BDC' && tag && tag !== 'Artifact';
        if (isRealTag && stack.some((s) => s.tag === 'Artifact')) {
          nestingViolations++;
          sampleNesting.push({ page: pageNum, tag, depth: stack.length });
        }
        stack.push({ tag });
        namesSinceLastOp = [];
        continue;
      }
      if (tok === 'EMC') { stack.pop(); namesSinceLastOp = []; continue; }

      const insideAnyTag = stack.length > 0;
      if (PATH_PAINT_OPS.has(tok) && !insideAnyTag) { pagePathCount++; totalUntaggedPathOps++; }
      else if (TEXT_SHOW_OPS.has(tok) && !insideAnyTag) { pageTextCount++; totalUntaggedTextOps++; }
      namesSinceLastOp = [];
    }

    if (pagePathCount > 0) { pagesWithUntaggedPath++; if (sampleUntaggedPath.length < 10) sampleUntaggedPath.push({ page: pageNum, count: pagePathCount }); }
    if (pageTextCount > 0) { pagesWithUntaggedText++; if (sampleUntaggedText.length < 10) sampleUntaggedText.push({ page: pageNum, count: pageTextCount }); }
  }

  console.log('=== Check 2: Genuinely untagged content (no enclosing BDC/BMC at all) ===');
  console.log(`Pages with >=1 untagged PATH paint op: ${pagesWithUntaggedPath} (total ops: ${totalUntaggedPathOps})`);
  console.log(`Pages with >=1 untagged TEXT show op: ${pagesWithUntaggedText} (total ops: ${totalUntaggedTextOps})`);
  console.log('Sample untagged-path pages:', sampleUntaggedPath);
  console.log('Sample untagged-text pages:', sampleUntaggedText);
  console.log('');

  console.log('=== Check 3: Real tagged content nested inside an Artifact span ===');
  console.log(`Violations found: ${nestingViolations}`);
  const byPage = {};
  for (const n of sampleNesting) { (byPage[n.page] ??= []).push(n.tag); }
  console.log('By page:', JSON.stringify(byPage, null, 1));
  const byTag3 = {};
  for (const n of sampleNesting) byTag3[n.tag] = (byTag3[n.tag] || 0) + 1;
  console.log('By tag:', byTag3);
  const byDepth = {};
  for (const n of sampleNesting) byDepth[n.depth] = (byDepth[n.depth] || 0) + 1;
  console.log('By nesting depth at violation:', byDepth);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
