/**
 * Reading-Order Float-Interruption Detection
 *
 * Real incident (Karsaklian_189165_9781606497623.pdf -- S4 Carlisle manual
 * QC, Round 2, item #2): "Highlight tags were not associated with their
 * respective content locations. Instead, many highlight tags were found
 * grouped at the end of the document." Direct inspection of the real
 * struct tree found NO literal /Highlight structure type or annotation
 * anywhere in the file (both exhaustively ruled out). The screenshot in
 * the actual report shows Acrobat's Tags panel on page 15 with <CT> and
 * <TXL> selected around an italicized pull-quote ("Marketers always find
 * a way to spend money."), which S4 informally called a "highlight" --
 * the real defect is structural, not a literal Highlight tag.
 *
 * The quote's own 4 lines (content-stream MCIDs 265-268 on page 15) are
 * split across THREE struct elements: MCID 265 is /CT and MCID 268 is
 * /TXL, both correctly inline inside the book's one big flat /Story flow
 * container (direct children indices 73/74 of 772) -- but MCID 266-267 is
 * a separate /EPI (epigraph) element whose own parent is a SEPARATE,
 * dedicated two-element /Story wrapper that is itself a TOP-LEVEL sibling
 * of the big flow container, positioned to come AFTER the big flow
 * container's own ~770 remaining children in struct-tree (= logical
 * reading) order -- even though the epigraph's own content sits on page
 * 15, right between CT and TXL. Confirmed this is not a one-off: the SAME
 * top-level parent has 27 such "detached" siblings (epigraphs, standalone
 * tables, floated figure+caption groups, cover-page figures), EVERY ONE of
 * whose own page range falls entirely inside the big flow container's own
 * page range (1-185) despite being array-positioned after it, so a reader
 * that walks the struct tree in order reads the ENTIRE 185-page body
 * first, then ALL of these detached pieces afterward, right before the
 * back-matter Index -- i.e. "grouped at the end of the document", exactly
 * as reported. 20 of the 27 have an unambiguous MCID-interpolated splice
 * point back into the flow container (auto-fixable); 8 do not (their MCID
 * range is nested inside a single flow-container SIBLING's own range
 * rather than falling cleanly between two siblings -- e.g. a standalone
 * table whose content was fully carved out of what is, on the page, one
 * continuous /TX text run) and are declined rather than guessed at.
 *
 * This fills a real, previously-unimplemented gap: `ReadingOrderInfo`
 * (structure-analyzer.service.ts) has long declared a 'float-interruption'
 * issue type in its own type union, and this exact shape is Matterhorn
 * Protocol Checkpoint 09, failure condition 09-001 ("Tags are not in
 * logical reading order") -- confirmed via the PDF Association's own
 * Matterhorn 1.1 checklist (reproduced by powermapper.com's PDF/UA-1
 * Matterhorn rule list), which also confirms 09-001 is human-testing-only
 * (no automated rule), consistent with this being caught by S4's manual QC
 * and not by PAC's own automated checker. NOTE: this codebase's existing
 * 'MATTERHORN-09-004' references (ai-analysis.service.ts's
 * READING_ORDER_CODES, pdf-fix-classification.ts, smart-triage.service.ts,
 * validators/README.md) are a pre-existing mislabeling -- checkpoint 09-004
 * is actually about table structure syntax (ISO 32000-1 Table 337), not
 * reading order, and is never actually produced by any validator (dead
 * code). Deliberately NOT touched here (out of this task's scope) -- this
 * module uses its own, correctly-verified 09-001 checkpoint and its own,
 * non-colliding issue codes instead of reusing that mislabeled constant.
 *
 * findFloatInterruptions is the single source of truth for this check --
 * shared by pdf-reading-order-float.validator.ts (maps each result to an
 * AuditIssue) and PdfStructureWriterService.fixReadingOrderFloatInterruption
 * (re-runs this same function fresh at apply time rather than trusting a
 * stale analysis-time result), matching mcid-page-mismatch.ts's own
 * established convention for this codebase.
 *
 * Deliberately conservative, same "bail rather than guess" discipline as
 * mcid-page-mismatch.ts: a sibling is only flagged when its own full
 * subtree page range falls STRICTLY inside another sibling's own page
 * range under the SAME parent (never guessed from outside that parent's
 * own stated set), and an auto-fix anchor is only ever offered when there
 * exists an unambiguous, immediately-consecutive pair of the containing
 * sibling's OWN direct children that brackets the misplaced element's
 * page+MCID range exactly -- anything else (the range doesn't fit cleanly
 * between two consecutive children, e.g. because it is nested inside one
 * of them) is reported detect-only with anchor === null.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';

export interface FloatInterruption {
  /** The misplaced struct element (currently a direct child of parentRef). */
  misplacedRef: PDFRef;
  misplacedS: string;
  /** The parent whose /K array currently holds misplacedRef. */
  parentRef: PDFRef;
  /** The sibling (also a direct child of parentRef) whose own page range contains misplacedRef's. */
  containerRef: PDFRef;
  containerS: string;
  minMcid: number;
  maxMcid: number;
  minPage: number;
  maxPage: number;
  /**
   * An unambiguous position among containerRef's OWN direct children to
   * insert misplacedRef immediately after, or null when none exists
   * (misplacedRef's range doesn't fall cleanly between two consecutive
   * children, or exactly adjacent to the container's own first/last child
   * -- e.g. it's nested inside one of them -- so no safe auto-fix position
   * can be determined). insertIntoKidsAfter only ever needs the one ref to
   * splice after; a `beforeRef` isn't separately required by the fixer, so
   * isn't carried here.
   */
  anchor: { afterRef: PDFRef } | null;
}

interface SubtreeRange {
  minMcid: number;
  maxMcid: number;
  minPage: number;
  maxPage: number;
}

function getStructTreeRoot(doc: PDFDocument): PDFDict | undefined {
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function nameStr(n: ReturnType<PDFDict['get']>): string | undefined {
  return n ? n.toString().replace(/^\//, '') : undefined;
}

export function findFloatInterruptions(doc: PDFDocument): FloatInterruption[] {
  const structRoot = getStructTreeRoot(doc);
  if (!structRoot) return [];

  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  // Bottom-up, memoized (by ref string) subtree range -- computed once per
  // struct element regardless of how many ancestors/pairs end up consulting
  // it, since the same element can be a candidate "container" and a
  // candidate "misplaced child" for different pairs.
  const rangeCache = new Map<string, SubtreeRange | null>();
  const visiting = new Set<string>(); // cycle guard

  function collectDirectMcids(kObj: ReturnType<PDFDict['get']>): number[] {
    const resolved = kObj instanceof PDFRef ? doc.context.lookup(kObj) : kObj;
    const out: number[] = [];
    if (resolved instanceof PDFNumber) {
      out.push(resolved.asNumber());
      return out;
    }
    if (resolved instanceof PDFArray) {
      for (const item of resolved.asArray()) {
        const r = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (r instanceof PDFNumber) {
          out.push(r.asNumber());
        } else if (r instanceof PDFDict && r.get(PDFName.of('S')) === undefined && r.get(PDFName.of('MCID')) !== undefined) {
          const mcidVal = r.get(PDFName.of('MCID'));
          const resolvedMcid = mcidVal instanceof PDFRef ? doc.context.lookup(mcidVal) : mcidVal;
          if (resolvedMcid instanceof PDFNumber) out.push(resolvedMcid.asNumber());
        }
      }
    }
    return out;
  }

  function computeRange(ref: PDFRef, dict: PDFDict, inheritedPage: number | null): SubtreeRange | null {
    const key = ref.toString();
    if (rangeCache.has(key)) return rangeCache.get(key) ?? null;
    if (visiting.has(key)) return null; // cyclic/malformed tree -- bail
    visiting.add(key);

    let minMcid = Infinity, maxMcid = -Infinity, minPage = Infinity, maxPage = -Infinity;

    const pgRaw = dict.get(PDFName.of('Pg'));
    const pgRef = pgRaw instanceof PDFRef ? pgRaw : null;
    const ownPage = pgRef ? pageByRef.get(pgRef.toString()) ?? null : null;
    const effectivePage = ownPage ?? inheritedPage;

    if (typeof effectivePage === 'number') {
      const mcids = collectDirectMcids(dict.get(PDFName.of('K')));
      for (const m of mcids) {
        minMcid = Math.min(minMcid, m);
        maxMcid = Math.max(maxMcid, m);
        minPage = Math.min(minPage, effectivePage);
        maxPage = Math.max(maxPage, effectivePage);
      }
    }

    const kRaw = dict.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    const children: PDFRef[] = [];
    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) if (item instanceof PDFRef) children.push(item);
    } else if (kRaw instanceof PDFRef) {
      // A single-child struct element legitimately has a bare (non-array)
      // /K per spec -- kRaw (the original reference) is the child to
      // recurse into, NOT kResolved (already dereferenced to the child's
      // own dict two lines up, which can never itself be a PDFRef again).
      children.push(kRaw);
    }
    for (const childRef of children) {
      const childDict = doc.context.lookup(childRef);
      if (!(childDict instanceof PDFDict)) continue;
      if (childDict.get(PDFName.of('S')) === undefined) continue; // not a struct element
      const childRange = computeRange(childRef, childDict, effectivePage);
      if (childRange) {
        minMcid = Math.min(minMcid, childRange.minMcid);
        maxMcid = Math.max(maxMcid, childRange.maxMcid);
        minPage = Math.min(minPage, childRange.minPage);
        maxPage = Math.max(maxPage, childRange.maxPage);
      }
    }

    visiting.delete(key);
    const result = minMcid === Infinity ? null : { minMcid, maxMcid, minPage, maxPage };
    rangeCache.set(key, result);
    return result;
  }

  // Resolve a container's own DIRECT struct-element children (refs + dicts,
  // in /K array order), needed both to find containment pairs under a
  // shared parent and to find an anchor within a confirmed container.
  function directStructChildren(dict: PDFDict): Array<{ ref: PDFRef; dict: PDFDict }> {
    const kRaw = dict.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    const out: Array<{ ref: PDFRef; dict: PDFDict }> = [];
    const consider = (item: unknown): void => {
      if (!(item instanceof PDFRef)) return;
      const childDict = doc.context.lookup(item);
      if (childDict instanceof PDFDict && childDict.get(PDFName.of('S')) !== undefined) {
        out.push({ ref: item, dict: childDict });
      }
    };
    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) consider(item);
    } else {
      // Bare (non-array) /K, a legitimate single-child shape -- consider
      // the ORIGINAL reference (kRaw), not kResolved (already dereferenced
      // to the child's own dict above, which can never itself be a
      // PDFRef, so passing it here would always silently find nothing).
      consider(kRaw);
    }
    return out;
  }

  /**
   * Finds an unambiguous position for `target` among `siblings` (a
   * container's own direct children, each with its own cached range) to
   * insert immediately after -- page-primary, MCID only as a same-page
   * tiebreak (MCIDs are only spec-guaranteed comparable within one page;
   * this producer's own globally-increasing MCID convention, confirmed
   * empirically across this document, is used only as a secondary
   * confirmation, never the sole signal). `target` must fall cleanly
   * BETWEEN two consecutive siblings (20 of the 27 real instances on
   * Karsaklian_189165_9781606497623.pdf -- e.g. an epigraph pull-quote
   * sandwiched between two body paragraphs). Returns null for anything
   * else, including nested-inside-a-single-sibling (6 of the 27).
   *
   * Deliberately does NOT also treat "exactly adjacent to the container's
   * own first/last child" as a safe anchor, even though that shape is
   * ALSO real (the document's own 27th instance, a cover-page Figure whose
   * MCID is exactly one past the flow's own final MCID) -- tried and
   * reverted: this producer's own globally-increasing MCID convention
   * makes "my own maxMcid + 1 equals your minMcid" trivially true for
   * almost EVERY genuinely-correct pair of adjacent siblings anywhere in
   * the tree (confirmed real: generalizing this rule turned 26 correct
   * detections into 95, the other 69 being false positives at unrelated
   * nesting levels throughout the document). The strict "between two"
   * requirement is what keeps false positives near zero; this one real
   * boundary case is accepted as an undetected residual rather than
   * loosening the rule.
   */
  function findAnchor(
    siblings: Array<{ ref: PDFRef; range: SubtreeRange | null }>,
    target: SubtreeRange
  ): { afterRef: PDFRef } | null {
    for (let k = 0; k < siblings.length - 1; k++) {
      const before = siblings[k].range;
      const after = siblings[k + 1].range;
      if (!before || !after) continue;

      const beforeEndsBeforeTarget =
        before.maxPage < target.minPage ||
        (before.maxPage === target.minPage && before.maxMcid < target.minMcid);
      const afterStartsAfterTarget =
        after.minPage > target.maxPage ||
        (after.minPage === target.maxPage && after.minMcid > target.maxMcid);

      if (beforeEndsBeforeTarget && afterStartsAfterTarget) {
        return { afterRef: siblings[k].ref };
      }
    }
    return null;
  }

  const results: FloatInterruption[] = [];
  const visitedParents = new Set<string>();

  function visitParent(parentRef: PDFRef | null, parentDict: PDFDict): void {
    const key = parentRef ? parentRef.toString() : '(root)';
    if (visitedParents.has(key)) return;
    visitedParents.add(key);

    const children = directStructChildren(parentDict);
    if (children.length >= 2 && parentRef) {
      // inheritedPage=null here is intentional and safe, not a shortcut:
      // these are container-level ranges requested from the TOP of each
      // child's own subtree, with no page context from further up the
      // tree. A child that carries no /Pg ANYWHERE in its own subtree
      // (relying solely on inheritance from an ancestor above this point)
      // would come back with range===null and simply be skipped -- a
      // missed detection, never a wrong one, consistent with this
      // module's "bail rather than guess" discipline. Every real instance
      // confirmed on Karsaklian_189165_9781606497623.pdf carries its own
      // direct /Pg at this exact level (Figure, and the Story/Sect
      // wrappers whose own child -- EPI, FGC, etc. -- carries /Pg
      // directly), so this doesn't affect any case this module was built
      // from.
      const ranges = children.map(c => ({ ref: c.ref, range: computeRange(c.ref, c.dict, null) }));
      // Tracks target indices already claimed by an earlier (smaller i,
      // so array-earlier/"more likely the real flow") container, so the
      // same misplaced child is never reported twice under two different
      // containers -- NOT a reason to stop scanning the REST of this
      // container's own later siblings for containment (a real bug caught
      // here: an earlier version `break`d out of the j-loop after the
      // FIRST match, silently missing every other misplaced sibling under
      // the same container -- confirmed real via a round-trip check
      // against Karsaklian_189165_9781606497623.pdf, which found only 1 of
      // its own 27 real instances before this fix).
      const claimed = new Set<number>();

      for (let i = 0; i < ranges.length; i++) {
        const container = ranges[i];
        if (!container.range) continue;
        // Only a genuine multi-page flow can legitimately "contain" another
        // top-level sibling in reading order -- a single-page sibling
        // containing another single-page sibling isn't this shape.
        if (container.range.maxPage <= container.range.minPage) continue;

        for (let j = i + 1; j < ranges.length; j++) {
          if (claimed.has(j)) continue;
          const target = ranges[j];
          if (!target.range) continue;
          // Fully nested inside container's own range -- see findAnchor's
          // own doc comment for why a looser "exactly adjacent" shape is
          // deliberately NOT also accepted here (tried and reverted: real
          // false-positive flood at unrelated nesting levels).
          const contained =
            container.range.minPage <= target.range.minPage &&
            target.range.maxPage <= container.range.maxPage &&
            container.range.minMcid <= target.range.minMcid &&
            target.range.maxMcid <= container.range.maxMcid;
          if (!contained) continue;

          const containerChildren = directStructChildren(children[i].dict).map(c => ({
            ref: c.ref,
            range: computeRange(c.ref, c.dict, null),
          }));
          const anchor = findAnchor(containerChildren, target.range);

          results.push({
            misplacedRef: target.ref,
            misplacedS: nameStr(children[j].dict.get(PDFName.of('S'))) ?? 'Unknown',
            parentRef,
            containerRef: container.ref,
            containerS: nameStr(children[i].dict.get(PDFName.of('S'))) ?? 'Unknown',
            minMcid: target.range.minMcid,
            maxMcid: target.range.maxMcid,
            minPage: target.range.minPage,
            maxPage: target.range.maxPage,
            anchor,
          });
          claimed.add(j);
        }
      }
    }

    for (const child of children) {
      visitParent(child.ref, child.dict);
    }
  }

  visitParent(null, structRoot);

  return results;
}
