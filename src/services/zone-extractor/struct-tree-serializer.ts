import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { logger } from '../../lib/logger';

export interface StructTreeNode {
  tag: string;
  page?: number;
  mcids?: number[];
  children?: StructTreeNode[];
  attributes?: Record<string, unknown>;
}

export interface StructTreeResult {
  roleMap: Record<string, string>;
  tree: StructTreeNode[];
  totalElements: number;
  totalPages: number;
}

function resolvePdfObj(obj: unknown, doc: PDFDocument): unknown {
  if (obj instanceof PDFRef) return doc.context.lookup(obj);
  return obj;
}

function getPageNumber(node: PDFDict, doc: PDFDocument): number | null {
  const pgRef = node.get(PDFName.of('Pg'));
  if (!(pgRef instanceof PDFRef)) return null;
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].ref === pgRef) return i + 1;
  }
  return null;
}

function collectDirectMcids(kEntry: unknown, doc: PDFDocument): number[] {
  const mcids: number[] = [];
  collectMcidsHelper(kEntry, doc, mcids, 0);
  return mcids;
}

function collectMcidsHelper(kEntry: unknown, doc: PDFDocument, mcids: number[], depth: number): void {
  if (depth > 50) return;

  if (kEntry instanceof PDFNumber) {
    mcids.push(kEntry.asNumber());
    return;
  }

  if (kEntry instanceof PDFRef) {
    collectMcidsHelper(doc.context.lookup(kEntry), doc, mcids, depth + 1);
    return;
  }

  if (kEntry instanceof PDFArray) {
    for (let i = 0; i < kEntry.size(); i++) {
      collectMcidsHelper(kEntry.get(i), doc, mcids, depth + 1);
    }
    return;
  }

  if (kEntry instanceof PDFDict) {
    const mcidVal = kEntry.get(PDFName.of('MCID'));
    if (mcidVal instanceof PDFNumber) {
      mcids.push(mcidVal.asNumber());
      return;
    }
    if (kEntry.get(PDFName.of('S'))) return; // child struct element
    const subK = kEntry.get(PDFName.of('K'));
    if (subK) collectMcidsHelper(subK, doc, mcids, depth + 1);
  }
}

function serializeNode(
  node: unknown,
  doc: PDFDocument,
  counter: { count: number },
  currentPage: number | null,
  depth: number,
): StructTreeNode | StructTreeNode[] | null {
  if (depth > 100 || !node) return null;

  if (node instanceof PDFRef) {
    return serializeNode(doc.context.lookup(node), doc, counter, currentPage, depth + 1);
  }

  if (node instanceof PDFArray) {
    const results: StructTreeNode[] = [];
    for (let i = 0; i < node.size(); i++) {
      const child = serializeNode(node.get(i), doc, counter, currentPage, depth + 1);
      if (child) {
        if (Array.isArray(child)) results.push(...child);
        else results.push(child);
      }
    }
    return results.length > 0 ? results : null;
  }

  if (!(node instanceof PDFDict)) return null;

  const sName = node.get(PDFName.of('S'));
  if (!sName) return null;

  const tag = sName instanceof PDFName ? sName.decodeText() : String(sName);
  const pageNum = getPageNumber(node, doc) ?? currentPage;
  counter.count++;

  const result: StructTreeNode = { tag };
  if (pageNum) result.page = pageNum;

  // Collect direct MCIDs (not from child struct elements)
  const kEntry = node.get(PDFName.of('K'));
  const mcids = kEntry ? collectDirectMcids(kEntry, doc) : [];
  if (mcids.length > 0) result.mcids = mcids;

  // Recurse into children
  if (kEntry) {
    const children: StructTreeNode[] = [];
    if (kEntry instanceof PDFArray) {
      for (let i = 0; i < kEntry.size(); i++) {
        const item = resolvePdfObj(kEntry.get(i), doc);
        if (item instanceof PDFDict && item.get(PDFName.of('S'))) {
          const child = serializeNode(item, doc, counter, pageNum, depth + 1);
          if (child) {
            if (Array.isArray(child)) children.push(...child);
            else children.push(child);
          }
        }
      }
    } else {
      const item = resolvePdfObj(kEntry, doc);
      if (item instanceof PDFDict && item.get(PDFName.of('S'))) {
        const child = serializeNode(item, doc, counter, pageNum, depth + 1);
        if (child) {
          if (Array.isArray(child)) children.push(...child);
          else children.push(child);
        }
      }
    }
    if (children.length > 0) result.children = children;
  }

  return result;
}

/**
 * Serialize the StructTreeRoot of a PDF into a JSON tree for debugging.
 */
export async function serializeStructTreeAsync(pdfBytes: Buffer): Promise<StructTreeResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const totalPages = doc.getPageCount();

  const structTreeRoot = doc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structTreeRoot) {
    return { roleMap: {}, tree: [], totalElements: 0, totalPages };
  }

  const root = resolvePdfObj(structTreeRoot, doc);
  if (!(root instanceof PDFDict)) {
    return { roleMap: {}, tree: [], totalElements: 0, totalPages };
  }

  // Build RoleMap
  const roleMap: Record<string, string> = {};
  const rmRaw = root.get(PDFName.of('RoleMap'));
  const rm = resolvePdfObj(rmRaw, doc);
  if (rm instanceof PDFDict) {
    for (const [key, value] of rm.entries()) {
      const customTag = key instanceof PDFName ? key.decodeText() : String(key);
      const stdTag = value instanceof PDFName ? value.decodeText() : null;
      if (stdTag) roleMap[customTag] = stdTag;
    }
  }

  // Serialize tree from /K children of StructTreeRoot
  const counter = { count: 0 };
  const kEntry = root.get(PDFName.of('K'));
  const tree: StructTreeNode[] = [];

  if (kEntry) {
    const result = serializeNode(kEntry, doc, counter, null, 0);
    if (result) {
      if (Array.isArray(result)) tree.push(...result);
      else tree.push(result);
    }
  }

  logger.info(
    `[struct-tree-serializer] Serialized ${counter.count} structure elements from ${totalPages} pages`,
  );

  return {
    roleMap,
    tree,
    totalElements: counter.count,
    totalPages,
  };
}
