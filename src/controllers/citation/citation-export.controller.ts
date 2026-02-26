/**
 * Citation Export Controller
 * Handles document export and preview operations
 *
 * Endpoints:
 * - GET /document/:documentId/preview - Preview changes
 * - GET /document/:documentId/export - Export modified DOCX
 * - GET /document/:documentId/export-debug - Debug export (dev only)
 * - POST /document/:documentId/debug-style-conversion - Debug style conversion (dev only)
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { docxProcessorService } from '../../services/citation/docx-processor.service';
import { citationStorageService } from '../../services/citation/citation-storage.service';
import { normalizeStyleCode, getFormattedColumn } from '../../services/citation/reference-list.service';
import { resolveDocumentSimple } from './document-resolver';
import { buildRefIdToNumberMap, formatCitationWithChanges, citationNumbersMatch } from '../../utils/citation.utils';

export class CitationExportController {
  /**
   * GET /api/v1/citation-management/document/:documentId/preview
   * Preview changes that will be applied on export
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async previewChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Previewing changes for document ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const document = await resolveDocumentSimple(documentId, tenantId);

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Use the resolved document ID for subsequent queries
      const resolvedDocId = document.id;

      // Get all changes
      const changes = await prisma.citationChange.findMany({
        where: {
          documentId: resolvedDocId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Get citations with their reference links for frontend display
      const citations = await prisma.citation.findMany({
        where: { documentId: resolvedDocId },
        include: {
          referenceListEntries: {
            include: { referenceListEntry: true }
          }
        },
        orderBy: [{ paragraphIndex: 'asc' }, { startOffset: 'asc' }]
      });

      // Get references for building number map
      const references = await prisma.referenceListEntry.findMany({
        where: { documentId: resolvedDocId },
        orderBy: { sortKey: 'asc' }
      });

      // Build ref ID to number map using shared utility
      const refIdToNumber = buildRefIdToNumberMap(references);

      // Build citation ID to change map
      const citationToChange = new Map<string, typeof changes[0]>();
      for (const change of changes) {
        if (change.citationId) {
          citationToChange.set(change.citationId, change);
          logger.info(`[CitationExport] Preview: Mapped change for citationId=${change.citationId}, before="${change.beforeText?.substring(0, 40)}", after="${change.afterText?.substring(0, 40)}"`);
        }
      }
      logger.info(`[CitationExport] Preview: ${citationToChange.size} citation changes mapped, ${citations.length} total citations`);

      // === Reconcile stacked changes ===
      // When operations stack (e.g., reorder + delete), the Map may hold stale entries
      // from earlier operations. Text-based RENUMBER changes (citationId=null) from later
      // operations need to be chained to compute cumulative original→current transformation.
      const textRenumberChanges = changes.filter(c =>
        c.changeType === 'RENUMBER' && !c.citationId
      );

      if (textRenumberChanges.length > 0) {
        // Build text transform map: beforeText → afterText
        // Include empty afterText (from delete operations where citation text is removed)
        const textTransforms = new Map<string, string>();
        for (const ch of textRenumberChanges) {
          if (ch.beforeText && ch.afterText !== null && ch.afterText !== undefined) {
            textTransforms.set(ch.beforeText, ch.afterText);
          }
        }

        for (const citation of citations) {
          const mapEntry = citationToChange.get(citation.id);

          if (mapEntry && mapEntry.changeType === 'RENUMBER' && !citationNumbersMatch(mapEntry.afterText || '', citation.rawText || '')) {
            // Stale entry — chain through text transforms to find current rawText
            let current = mapEntry.afterText;
            const visited = new Set<string>();
            while (current && textTransforms.has(current) && !visited.has(current)) {
              visited.add(current);
              current = textTransforms.get(current)!;
              // Stop as soon as we reach the citation's current rawText
              // Without this, the chain may pass through the correct value
              // and continue to a further transform (e.g., "(3)"→"(2)"→"(1)" when rawText="(2)")
              if (citationNumbersMatch(current || '', citation.rawText || '')) break;
            }
            if (citationNumbersMatch(current || '', citation.rawText || '')) {
              // Update Map: keep original beforeText, set afterText to current rawText
              citationToChange.set(citation.id, { ...mapEntry, afterText: current });
              logger.info(`[CitationExport] Reconciled stale change for citationId=${citation.id}: "${mapEntry.beforeText}" → "${current}" (was "${mapEntry.afterText}")`);
            }
          } else if (!mapEntry && citation.rawText) {
            // No Map entry — check if a text transform's afterText matches this citation
            for (const [before, after] of textTransforms) {
              if (citationNumbersMatch(after, citation.rawText || '') && before !== after) {
                const sourceChange = textRenumberChanges.find(
                  c => c.beforeText === before && c.afterText === after
                );
                if (sourceChange) {
                  citationToChange.set(citation.id, { ...sourceChange });
                  logger.info(`[CitationExport] Added text-based change for citationId=${citation.id}: "${before}" → "${after}"`);
                }
                break;
              }
            }
          }
        }
      }

      // Format citations for frontend with change info using shared utility
      const formattedCitations = citations.map(c => {
        const change = citationToChange.get(c.id);
        return formatCitationWithChanges(
          c,
          refIdToNumber,
          change ? {
            id: change.id,
            changeType: change.changeType,
            beforeText: change.beforeText,
            afterText: change.afterText
          } : undefined
        );
      });

      // Group changes by type (for backward compatibility)
      const changesByType: Record<string, Array<{
        id: string;
        beforeText: string | null;
        afterText: string | null;
        citationId: string | null;
      }>> = {};

      for (const change of changes) {
        const type = change.changeType;
        if (!changesByType[type]) {
          changesByType[type] = [];
        }
        changesByType[type].push({
          id: change.id,
          beforeText: change.beforeText,
          afterText: change.afterText,
          citationId: change.citationId
        });
      }

      // Collect reference-level DELETE changes (citationId: null, appliedBy: 'user')
      // into a dedicated array for cleaner API separation
      const refDeleteChanges = changes.filter(c =>
        c.changeType === 'DELETE' && c.appliedBy === 'user' && !c.citationId
      );
      const deletedReferences: Array<{
        id: string;
        changeId: string;
        position: number;
        originalText: string;
      }> = [];
      for (const delChange of refDeleteChanges) {
        const position = (delChange.metadata as Record<string, unknown>)?.position as number || 0;
        deletedReferences.push({
          id: `ref-delete-${delChange.id}`,
          changeId: delChange.id,
          position,
          originalText: delChange.beforeText || '',
        });
        // Also add to formattedCitations for backward compatibility with existing frontend
        // Use citationType 'NUMERIC' (valid Prisma enum) with changeType 'deleted' to signal ref deletion
        formattedCitations.push({
          id: `ref-delete-${delChange.id}`,
          changeId: delChange.id,
          rawText: '',
          citationType: 'NUMERIC',
          paragraphIndex: null,
          referenceNumber: position,
          linkedReferenceIds: [],
          linkedReferenceNumbers: [],
          originalText: delChange.beforeText || '',
          newText: '',
          changeType: 'deleted',
          isOrphaned: false,
        });
      }

      // Summary
      const summary = {
        totalChanges: changes.length,
        byType: Object.entries(changesByType).map(([type, items]) => ({
          type,
          count: items.length
        })),
        totalCitations: citations.length,
        citationsWithChanges: formattedCitations.filter(c => c.changeType !== 'unchanged').length,
        orphanedCitations: formattedCitations.filter(c => c.isOrphaned).length
      };

      res.json({
        success: true,
        data: {
          documentId: resolvedDocId,
          documentName: document.originalName,
          currentStyle: document.referenceListStyle,
          summary,
          changes: changesByType,
          // Add citations array for frontend track changes display
          citations: formattedCitations,
          // Dedicated array for deleted references (cleaner than synthetic REFERENCE_DELETE in citations)
          deletedReferences
        }
      });
    } catch (error) {
      logger.error('[CitationExport] Preview failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/export
   * Export modified DOCX with preserved formatting
   *
   * NOTE: The :documentId param can be either a document ID or a job ID.
   */
  async exportDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      logger.info(`[CitationExport] Exporting document ${documentId}`);

      // Resolve document (handles both document ID and job ID)
      const baseDoc = await resolveDocumentSimple(documentId, tenantId);

      if (!baseDoc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Use resolved document ID for subsequent queries
      const resolvedDocId = baseDoc.id;

      // Get document with full relations
      const document = await prisma.editorialDocument.findFirst({
        where: { id: resolvedDocId, tenantId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get all changes to apply
      const changes = await prisma.citationChange.findMany({
        where: {
          documentId: resolvedDocId,
          isReverted: false
        },
        orderBy: { appliedAt: 'asc' }
      });

      // Read original DOCX file using storage service (handles S3/local automatically)
      let originalBuffer: Buffer;
      try {
        originalBuffer = await citationStorageService.getFileBuffer(
          document.storagePath,
          document.storageType as 'S3' | 'LOCAL'
        );
      } catch (readError) {
        logger.error(`[CitationExport] Cannot read original file: ${document.storagePath}`, readError);
        res.status(404).json({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Original document file not found' }
        });
        return;
      }

      // === Build maps for merging stacked in-text changes ===
      // When RENUMBER + INTEXT_STYLE_CONVERSION both exist for the same citation,
      // they must be merged into a single change. Otherwise the docx processor
      // replaces "(2)" with a placeholder (RENUMBER) and then can't find "(1)"
      // for the style conversion — it's already gone.
      //
      // Also handles reverted RENUMBER: if reorder was reverted, the style
      // conversion's beforeText needs to be mapped back to the original DOCX text.

      // Active in-text RENUMBER: citationId → { beforeText, afterText }
      const activeRenumbers = new Map<string, { beforeText: string; afterText: string }>();
      // Active INTEXT_STYLE_CONVERSION: citationId → { beforeText, afterText }
      const activeStyleConversions = new Map<string, { beforeText: string; afterText: string }>();

      for (const c of changes) {
        if (c.changeType === 'RENUMBER' && c.citationId && c.beforeText && c.afterText) {
          activeRenumbers.set(c.citationId, { beforeText: c.beforeText, afterText: c.afterText });
        }
        if (c.changeType === 'INTEXT_STYLE_CONVERSION' && c.citationId && c.beforeText && c.afterText) {
          activeStyleConversions.set(c.citationId, { beforeText: c.beforeText, afterText: c.afterText });
        }
      }

      // Fetch all reverted changes in a single query for both RENUMBER and REFERENCE_STYLE_CONVERSION.
      // RENUMBER: citationId → original beforeText (what's in the DOCX)
      // REFERENCE_STYLE_CONVERSION: When style conversions stack (Vancouver→APA reverted, then APA→Chicago active),
      // the active change's beforeText is APA but the DOCX has Vancouver. We chain back to the original.
      const revertedChanges = await prisma.citationChange.findMany({
        where: {
          documentId: resolvedDocId,
          isReverted: true,
          changeType: { in: ['RENUMBER', 'REFERENCE_STYLE_CONVERSION'] },
          citationId: { not: null }
        },
        orderBy: { appliedAt: 'asc' }
      });
      const revertedBeforeText = new Map<string, string>();
      const revertedRefBeforeText = new Map<string, string>();
      for (const rc of revertedChanges) {
        if (rc.citationId && rc.beforeText) {
          if (rc.changeType === 'RENUMBER' && !revertedBeforeText.has(rc.citationId)) {
            revertedBeforeText.set(rc.citationId, rc.beforeText);
          }
          if (rc.changeType === 'REFERENCE_STYLE_CONVERSION' && !revertedRefBeforeText.has(rc.citationId)) {
            revertedRefBeforeText.set(rc.citationId, rc.beforeText);
          }
        }
      }

      // === Match text-based RENUMBER to INTEXT_STYLE_CONVERSION by text ===
      // When RENUMBER changes have no citationId (text-based from delete), match them to
      // INTEXT_STYLE_CONVERSION changes where RENUMBER.afterText ≈ STYLE.beforeText (by numbers).
      // This enables the merge below to chain: original DOCX text → style-converted text.
      const consumedTextRenumberIds = new Set<string>();
      const allTextBasedRenumbers = changes.filter(c =>
        c.changeType === 'RENUMBER' && !c.citationId && c.beforeText && c.afterText
      );

      if (allTextBasedRenumbers.length > 0 && activeStyleConversions.size > 0) {
        for (const [citId, styleConv] of activeStyleConversions) {
          if (activeRenumbers.has(citId)) continue; // already has citationId-based RENUMBER
          const matchingRenumber = allTextBasedRenumbers.find(r =>
            !consumedTextRenumberIds.has(r.id) &&
            citationNumbersMatch(r.afterText || '', styleConv.beforeText)
          );
          if (matchingRenumber) {
            activeRenumbers.set(citId, {
              beforeText: matchingRenumber.beforeText!,
              afterText: matchingRenumber.afterText!
            });
            consumedTextRenumberIds.add(matchingRenumber.id);
            logger.info(`[CitationExport] Matched text-based RENUMBER "${matchingRenumber.beforeText}" → "${matchingRenumber.afterText}" to INTEXT_STYLE for citation ${citId}`);
          }
        }
      }

      // === Reconcile stacked RENUMBER for export ===
      // When reorder + delete stack, citationId-based RENUMBER (from reorder) have stale
      // afterText. Text-based RENUMBER (from delete) represent the subsequent transformation.
      // Chain them to get cumulative original→current, then skip text-based duplicates.
      // Match text-based RENUMBER for both parenthetical "(N)" and bracket "[N]" formats
      const textBasedInTextRenumber = changes.filter(c =>
        c.changeType === 'RENUMBER' && !c.citationId &&
        c.beforeText && /^[[(][\d\s,\-–—]+[)\]]$/.test(c.beforeText)
      );
      const skipTextBasedRenumber = textBasedInTextRenumber.length > 0 && activeRenumbers.size > 0;

      if (skipTextBasedRenumber) {
        // Build text transform map (including empty afterText from delete)
        const exportTextTransforms = new Map<string, string>();
        for (const ch of textBasedInTextRenumber) {
          if (ch.beforeText && ch.afterText !== null && ch.afterText !== undefined) {
            exportTextTransforms.set(ch.beforeText, ch.afterText);
          }
        }

        // Build citationId → current rawText map for early-break detection
        const citRawTextMap = new Map<string, string>();
        for (const cit of document.citations) {
          citRawTextMap.set(cit.id, cit.rawText || '');
        }

        // Chain each citationId-based RENUMBER through text transforms
        // Must stop as soon as we reach the citation's current rawText
        // (same logic as preview reconciliation)
        for (const [citId, renumber] of activeRenumbers) {
          const citRawText = citRawTextMap.get(citId);
          let current = renumber.afterText;
          const visited = new Set<string>();
          while (current && exportTextTransforms.has(current) && !visited.has(current)) {
            visited.add(current);
            current = exportTextTransforms.get(current)!;
            // Stop as soon as we reach the citation's current rawText
            // Without this, the chain passes through correct value to ""
            // e.g., "(2)"→"(1)"→"" when rawText="(1)" — must stop at "(1)"
            if (current === citRawText) break;
          }
          // Update to cumulative value (original beforeText → final current text)
          if (current !== renumber.afterText) {
            logger.info(`[CitationExport] Export reconciled RENUMBER for ${citId}: "${renumber.beforeText}" → "${current}" (was "${renumber.afterText}")`);
            activeRenumbers.set(citId, { beforeText: renumber.beforeText, afterText: current });
          }
        }
      }

      // Set of citationIds that will be merged (skip individual entries)
      const mergedCitationIds = new Set<string>();

      // Build the changes array for the docx processor
      const changesToApply: Array<{
        type: string;
        beforeText: string;
        afterText: string;
        metadata?: Record<string, unknown> | null;
      }> = [];

      // STEP 1: Create merged RENUMBER + INTEXT_STYLE_CONVERSION changes
      for (const [citId, styleConv] of activeStyleConversions) {
        const renumber = activeRenumbers.get(citId);
        const reverted = revertedBeforeText.get(citId);

        if (renumber) {
          // Both active: merge RENUMBER.beforeText → STYLE_CONVERSION.afterText
          logger.info(`[CitationExport] Merging RENUMBER+STYLE for citation ${citId}: "${renumber.beforeText}" → "${styleConv.afterText}"`);
          changesToApply.push({
            type: 'INTEXT_STYLE_CONVERSION',
            beforeText: renumber.beforeText,
            afterText: styleConv.afterText,
            metadata: null
          });
          mergedCitationIds.add(citId);
        } else if (reverted) {
          // RENUMBER reverted: use original DOCX text as beforeText
          logger.info(`[CitationExport] Using reverted beforeText for citation ${citId}: "${reverted}" → "${styleConv.afterText}"`);
          changesToApply.push({
            type: 'INTEXT_STYLE_CONVERSION',
            beforeText: reverted,
            afterText: styleConv.afterText,
            metadata: null
          });
          mergedCitationIds.add(citId);
        }
        // If neither renumber nor reverted exists, the style conversion's
        // own beforeText is correct — it will be added in the loop below
      }

      // STEP 2: Process remaining changes
      for (const c of changes) {
        // Skip RENUMBER and INTEXT_STYLE_CONVERSION that were merged
        if (c.citationId && mergedCitationIds.has(c.citationId)) {
          if (c.changeType === 'RENUMBER' || c.changeType === 'INTEXT_STYLE_CONVERSION') {
            continue;
          }
        }

        // Skip text-based RENUMBER consumed by INTEXT_STYLE_CONVERSION merge
        if (consumedTextRenumberIds.has(c.id)) {
          continue;
        }

        // Handle REFERENCE_EDIT with metadata (manual edits)
        if (c.changeType === 'REFERENCE_EDIT' && !c.citationId && c.metadata) {
          const metadata = c.metadata as Record<string, unknown>;
          const referenceId = metadata.referenceId as string;
          const oldValues = metadata.oldValues as Record<string, unknown>;

          if (referenceId && oldValues) {
            const currentRef = document.referenceListEntries.find(r => r.id === referenceId);
            if (currentRef) {
              const styleCode = normalizeStyleCode(document.referenceListStyle);
              const formattedColumn = getFormattedColumn(styleCode);
              const oldFormatted = (oldValues as Record<string, unknown>)[formattedColumn] as string | undefined;
              const newFormatted = (currentRef as Record<string, unknown>)[formattedColumn] as string | undefined;

              if (!oldFormatted) {
                logger.warn(`[CitationExport] Skipping REFERENCE_EDIT - old formatted text missing for style "${styleCode}"`);
                continue;
              }
              if (!newFormatted) {
                logger.warn(`[CitationExport] Skipping REFERENCE_EDIT - new formatted text missing for style "${styleCode}"`);
                continue;
              }
              if (oldFormatted !== newFormatted) {
                changesToApply.push({
                  type: 'REFERENCE_SECTION_EDIT',
                  beforeText: oldFormatted,
                  afterText: newFormatted,
                  metadata: { referenceId, isReferenceSection: true }
                });
              }
            }
          }
          continue;
        }

        // Handle REFERENCE_STYLE_CONVERSION — route to reference section
        // Chain through reverted conversions to get original DOCX text as beforeText
        if (c.changeType === 'REFERENCE_STYLE_CONVERSION' && c.beforeText && c.afterText) {
          const originalBeforeText = (c.citationId && revertedRefBeforeText.get(c.citationId)) || c.beforeText;
          logger.info(`[CitationExport] Adding ref style conversion: "${originalBeforeText.substring(0, 50)}..." → "${c.afterText.substring(0, 50)}..."`);
          changesToApply.push({
            type: 'REFERENCE_SECTION_EDIT',
            beforeText: originalBeforeText,
            afterText: c.afterText,
            metadata: c.citationId ? { referenceId: c.citationId, isReferenceSection: true } : null
          });
          continue;
        }

        // Skip [N] format ref-section RENUMBER — handled by REFERENCE_REORDER below
        if (c.changeType === 'RENUMBER' && c.beforeText && /^\[\d+\]/.test(c.beforeText)) {
          continue;
        }

        // Skip text-based (N) in-text RENUMBER when already folded into citationId-based ones
        // This prevents duplicate replacements that cancel each other out
        if (skipTextBasedRenumber && c.changeType === 'RENUMBER' && !c.citationId &&
            c.beforeText && /^[[(][\d\s,\-–—]+[)\]]$/.test(c.beforeText)) {
          continue;
        }

        // For citationId-based RENUMBER, use the reconciled afterText from activeRenumbers
        if (c.changeType === 'RENUMBER' && c.citationId && activeRenumbers.has(c.citationId)) {
          const reconciled = activeRenumbers.get(c.citationId)!;
          logger.info(`[CitationExport] Adding reconciled RENUMBER: before="${reconciled.beforeText}", after="${reconciled.afterText}"`);
          changesToApply.push({
            type: c.changeType,
            beforeText: reconciled.beforeText,
            afterText: reconciled.afterText,
            metadata: c.metadata as Record<string, unknown> | null
          });
          continue;
        }

        // Generic: add remaining changes as-is
        logger.info(`[CitationExport] Adding change: type=${c.changeType}, citationId=${c.citationId}, before="${(c.beforeText || '').substring(0, 50)}", after="${(c.afterText || '').substring(0, 50)}"`);
        changesToApply.push({
          type: c.changeType,
          beforeText: c.beforeText || '',
          afterText: c.afterText || '',
          metadata: c.metadata as Record<string, unknown> | null
        });
      }

      // === Generate reference section reorder changes ===
      // Phase 4 of the DOCX processor reorders reference paragraphs using REFERENCE_REORDER changes.
      // We provide ALL references with their desired order (sortKey) and content for matching.
      // The DOCX processor finds each paragraph by content and rearranges them.
      // Only emit when there are actual RENUMBER or DELETE changes that affect reference order.
      // Only emit REFERENCE_REORDER when there are actual ordering changes (RENUMBER or DELETE).
      // REFERENCE_SECTION_EDIT alone (style-only edits) should not trigger reordering.
      const hasOrderChanges = changesToApply.some(c =>
        c.type === 'RENUMBER' || c.type === 'DELETE'
      );
      if (hasOrderChanges && document.referenceListEntries.length > 1) {
        const styleCode = normalizeStyleCode(document.referenceListStyle);
        const formattedCol = getFormattedColumn(styleCode);

        const referenceOrder: Array<{ position: number; contentStart: string }> = [];
        for (let i = 0; i < document.referenceListEntries.length; i++) {
          const ref = document.referenceListEntries[i];
          // Use the post-conversion formatted text for paragraph matching
          const refContent = (ref as Record<string, unknown>)[formattedCol] as string
            || ref.formattedApa
            || `${(ref.authors as string[] || []).join(', ')} (${ref.year}). ${ref.title}`;

          // Use a normalized prefix for matching (reduces collisions for same-author entries)
          const contentStart = refContent
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 120);

          referenceOrder.push({ position: i + 1, contentStart });
        }

        changesToApply.push({
          type: 'REFERENCE_REORDER',
          beforeText: JSON.stringify(referenceOrder),
          afterText: '',
          metadata: { referenceReorder: true }
        });
        logger.info(`[CitationExport] Added REFERENCE_REORDER with ${referenceOrder.length} references`);
      }

      logger.info(`[CitationExport] Total changes to apply: ${changesToApply.length}`);

      // Apply changes using docx processor
      let modifiedBuffer: Buffer;
      try {
        modifiedBuffer = await docxProcessorService.applyChanges(originalBuffer, changesToApply);
      } catch (applyError) {
        logger.error('[CitationExport] Failed to apply changes:', applyError);
        // Return original document if modification fails
        modifiedBuffer = originalBuffer;
      }

      // Use original filename
      const exportName = document.originalName;

      // Send file
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportName)}"`);
      res.setHeader('Content-Length', modifiedBuffer.length);
      res.send(modifiedBuffer);
    } catch (error) {
      logger.error('[CitationExport] Export failed:', error);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation-management/document/:documentId/export-debug
   * Debug endpoint to check document state before export (DEVELOPMENT ONLY)
   */
  async exportDebug(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      // Get document with all related data
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        include: {
          citations: true,
          referenceListEntries: { orderBy: { sortKey: 'asc' } }
        }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      const changes = await prisma.citationChange.findMany({
        where: { documentId },
        orderBy: { appliedAt: 'asc' }
      });

      res.json({
        success: true,
        data: {
          document: {
            id: document.id,
            originalName: document.originalName,
            storagePath: document.storagePath,
            status: document.status,
            referenceListStyle: document.referenceListStyle
          },
          citations: document.citations.length,
          references: document.referenceListEntries.length,
          changes: changes.map(c => ({
            id: c.id,
            type: c.changeType,
            beforeText: c.beforeText?.substring(0, 50),
            afterText: c.afterText?.substring(0, 50),
            isReverted: c.isReverted
          })),
          totalActiveChanges: changes.filter(c => !c.isReverted).length
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation-management/document/:documentId/debug-style-conversion
   * Debug endpoint to test style conversion (DEVELOPMENT ONLY)
   */
  async debugStyleConversion(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { referenceId, targetStyle } = req.body;
      const { tenantId } = req.user!;

      // Get document with tenant verification
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId }
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' }
        });
        return;
      }

      // Get the specific reference
      const reference = await prisma.referenceListEntry.findUnique({
        where: { id: referenceId }
      });

      if (!reference || reference.documentId !== documentId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          referenceId: reference.id,
          originalText: reference.formattedApa || reference.title,
          targetStyle,
          components: {
            authors: reference.authors,
            year: reference.year,
            title: reference.title,
            journal: reference.journalName,
            volume: reference.volume,
            issue: reference.issue,
            pages: reference.pages,
            doi: reference.doi
          },
          message: 'Debug info - use convert-style endpoint for actual conversion'
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const citationExportController = new CitationExportController();
