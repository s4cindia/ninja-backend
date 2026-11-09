/**
 * MCID Page-Mismatch Detection
 *
 * Real incident (Karsaklian_189165_9781606497623.pdf, 2026-11-09): PAC
 * flagged "Entry for given MCID missing" on page 54. Struct element ref
 * 531 (/TX, a running text/link flow spanning pages 54-55) has /Pg = page
 * 54, and its /K mixes bare MCID numbers (1838, 1839, 1841, 1886) with
 * MCR dicts explicitly declaring /Pg = page 55 for MCID 1843/1844/1846.
 * A bare number has no /Pg of its own and always inherits the OWNING
 * element's /Pg (PDF32000-1:2008 §14.7.4.4) -- so MCID 1886 implicitly
 * claimed page 54, where it doesn't exist at all (page 54's real content
 * stream only goes up to MCID 1856). It IS page 55's own real MCID 1886
 * (confirmed: the lone "." closing a hyperlink run), sitting in /K right
 * between two of the correctly-wrapped page-55 MCR entries (1844, 1846).
 * Page 55's own /ParentTree slot for MCID 1886 already correctly points
 * back at struct element 531 -- the defect is purely in the DOWNWARD
 * direction (this one /K entry's own implicit-page shape), not a deeper
 * ownership conflict. This entry should have been wrapped in an MCR dict
 * for page 55 like its neighbors, not left as a bare number.
 *
 * findMcidPageMismatches is the single source of truth for this check --
 * shared by pdf-mcid-page-mismatch.validator.ts (maps each result to an
 * AuditIssue) and PdfStructureWriterService.fixMcidPageMismatch (re-runs
 * this same function fresh at apply time rather than trusting a stale
 * analysis-time result). The two must never independently re-derive this
 * and risk disagreeing about what counts as a mismatch.
 *
 * Deliberately conservative: only ever considers pages this SAME /K
 * array's own sibling MCR entries already declare -- never guesses a
 * page from outside the element's own stated set. Declines (silently
 * skips) a bare MCID whose value exists on more than one sibling page
 * (genuinely ambiguous) or none at all (a different, unrelated problem --
 * a truly dangling reference, not a misplaced one).
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { pageContentMcids } from './pdf-content-stream-io';

export interface McidPageMismatch {
  elementRef: PDFRef;
  kArray: PDFArray;
  entryIndex: number;
  mcid: number;
  wrongPage: number;
  correctPage: number;
}

function getStructTreeRoot(doc: PDFDocument): PDFDict | undefined {
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function findMcidPageMismatches(doc: PDFDocument): McidPageMismatch[] {
  const structRoot = getStructTreeRoot(doc);
  if (!structRoot) return [];

  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  // Lazily computed, cached per page -- avoids re-decoding/re-scanning the
  // same page's content stream for every struct element that references it.
  const mcidsByPage = new Map<number, Set<number> | null>();
  const getPageMcids = (pageNumber: number): Set<number> | null => {
    if (!mcidsByPage.has(pageNumber)) {
      mcidsByPage.set(pageNumber, pageContentMcids(doc, pageNumber));
    }
    return mcidsByPage.get(pageNumber)!;
  };

  const results: McidPageMismatch[] = [];
  const seen = new Set<string>();

  const visit = (nodeRef: unknown, inheritedPage: number | null): void => {
    if (nodeRef instanceof PDFRef) {
      const key = nodeRef.toString();
      if (seen.has(key)) return;
      seen.add(key);
    }
    const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
    if (node instanceof PDFArray) {
      for (const item of node.asArray()) visit(item, inheritedPage);
      return;
    }
    if (!(node instanceof PDFDict)) return;

    const ownPgRaw = node.get(PDFName.of('Pg'));
    const ownPgRef = ownPgRaw instanceof PDFRef ? ownPgRaw : null;
    const ownPage = ownPgRef ? pageByRef.get(ownPgRef.toString()) ?? null : null;
    const effectivePage = ownPage ?? inheritedPage;

    const kRaw = node.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;

    if (
      nodeRef instanceof PDFRef &&
      node.get(PDFName.of('S')) !== undefined &&
      effectivePage !== null &&
      kResolved instanceof PDFArray
    ) {
      const entries = kResolved.asArray();
      // Sibling pages: every DIFFERENT /Pg an MCR dict in THIS SAME /K
      // array explicitly declares -- confirms the element genuinely spans
      // more than one page, from its own stated shape alone.
      const siblingPages = new Set<number>();
      for (const entry of entries) {
        const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
        if (resolved instanceof PDFDict) {
          const mcrPg = resolved.get(PDFName.of('Pg'));
          const mcrPgRef = mcrPg instanceof PDFRef ? mcrPg : null;
          const mcrPage = mcrPgRef ? pageByRef.get(mcrPgRef.toString()) ?? null : null;
          if (mcrPage !== null && mcrPage !== effectivePage) siblingPages.add(mcrPage);
        }
      }
      if (siblingPages.size > 0) {
        const ownMcids = getPageMcids(effectivePage);
        entries.forEach((entry, entryIndex) => {
          const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
          if (!(resolved instanceof PDFNumber)) return; // only bare MCIDs are candidates
          const mcid = resolved.asNumber();
          if (ownMcids?.has(mcid)) return; // correctly placed on its own page
          const matching = [...siblingPages].filter(p => getPageMcids(p)?.has(mcid));
          if (matching.length === 1) {
            results.push({
              elementRef: nodeRef,
              kArray: kResolved,
              entryIndex,
              mcid,
              wrongPage: effectivePage,
              correctPage: matching[0],
            });
          }
          // 0 or 2+ matches: genuinely ambiguous or truly dangling -- decline, never guess.
        });
      }
    }

    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) {
        if (item instanceof PDFRef) visit(item, effectivePage);
      }
    } else if (kResolved instanceof PDFDict && kResolved.get(PDFName.of('S')) !== undefined) {
      visit(kRaw, effectivePage);
    }
  };
  visit(structRoot.get(PDFName.of('K')), null);

  return results;
}
