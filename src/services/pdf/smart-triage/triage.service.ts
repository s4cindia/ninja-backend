/**
 * Smart Triage Service
 *
 * Post-processing layer that runs after all validators complete.
 * Reduces false positives by:
 *   1. Detecting TOC pages tagged as <Table> → replaces N issues with 1 TOC-TAGGING issue
 *   2. Marking reading-order issues in header/footer regions as artifacts
 *   3. Classifying decorative list issues as auto-resolved
 *   4. Recording contrast suppression in the triage summary
 *
 * Alt text AI suggestions are added by PdfAltTextValidator directly (image base64
 * is only available inside that validator, not at triage time).
 */

import { nanoid } from 'nanoid';
import { logger } from '../../../lib/logger';
import { AuditIssue, IssueTriage, TriageSummary } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';
import { tocDetector } from './toc.detector';
import { artifactMarker, ArtifactRegion } from './artifact-marker';
import { listClassifier } from './list-classifier';

// Table-related issue codes (from both structure and table validators)
const TABLE_ISSUE_CODES = new Set([
  'MATTERHORN-15-001',
  'MATTERHORN-15-002',
  'MATTERHORN-15-003',
  'MATTERHORN-15-004',
  'MATTERHORN-15-005',
  'TABLE-ACCESSIBILITY',
  'TABLE-HEADERS-INCOMPLETE',
  'TABLE-MISSING-SUMMARY',
  'TABLE-INACCESSIBLE',
  'PDF-TABLE-INACCESSIBLE',
]);

// Reading-order issue codes
const READING_ORDER_CODES = new Set([
  'MATTERHORN-12-001',
  'MATTERHORN-09-004',
  'READING-ORDER',
  'READING-ORDER-COLUMNS',
  'READING-ORDER-VISUAL',
  'READING-ORDER-TABLE',
]);

// Regex to extract y-coordinate from issue context strings like "y:123" or "position: (x, y)"
const Y_COORD_RE = /[,\s(]y[:\s]+(\d+(?:\.\d+)?)/i;

export interface TriageResult {
  issues: AuditIssue[];
  summary: TriageSummary;
}

class SmartTriageService {
  async process(
    parsed: PdfParseResult,
    rawIssues: AuditIssue[],
    suppressedCategories: string[] = []
  ): Promise<TriageResult> {
    logger.info(`[SmartTriage] Processing ${rawIssues.length} issues...`);

    // Detect TOC pages and artifact regions in parallel
    const [tocPageNums, artifactRegions] = await Promise.all([
      tocDetector.detectTocPages(parsed),
      Promise.resolve(artifactMarker.detectArtifactRegions(parsed)),
    ]);

    logger.info(`[SmartTriage] Detected ${tocPageNums.size} TOC page(s): [${[...tocPageNums].join(', ')}]`);

    // Classify every issue
    const classified: AuditIssue[] = [];
    for (const issue of rawIssues) {
      classified.push(this.classifyIssue(issue, parsed, tocPageNums, artifactRegions));
    }

    // Collapse: remove all suppressed table issues on TOC pages and inject
    // one TOC-TAGGING issue per TOC page
    const collapsed = this.collapseTocIssues(classified, parsed, tocPageNums);

    // Build triage summary
    const summary = this.buildSummary(rawIssues.length, collapsed, suppressedCategories);

    logger.info(
      `[SmartTriage] Complete — raw: ${rawIssues.length}, after triage: ${collapsed.length} ` +
      `(auto-resolved: ${summary.autoResolved}, ai-drafted: ${summary.aiDrafted}, ` +
      `smart-guided: ${summary.smartGuided}, manual: ${summary.manual})`
    );

    return { issues: collapsed, summary };
  }

  private classifyIssue(
    issue: AuditIssue,
    parsed: PdfParseResult,
    tocPageNums: Set<number>,
    artifactRegions: Map<number, ArtifactRegion[]>
  ): AuditIssue {
    // Already triaged (e.g. by alt-text validator)
    if (issue.triage) return issue;

    // Table issue on a TOC page → will be collapsed later; mark as auto-resolved
    if (TABLE_ISSUE_CODES.has(issue.code) && issue.pageNumber !== undefined && tocPageNums.has(issue.pageNumber)) {
      const triage: IssueTriage = {
        disposition: 'auto-resolved',
        method: 'heuristic',
        confidence: 0.9,
        reclassifiedAs: 'TOC-TAGGING',
      };
      return { ...issue, triage };
    }

    // Reading-order issue in artifact region → reclassify as artifact issue
    if (READING_ORDER_CODES.has(issue.code) && issue.pageNumber !== undefined) {
      const y = this.extractY(issue);
      if (y !== null) {
        const region = artifactMarker.isInArtifactRegion(y, issue.pageNumber, artifactRegions);
        if (region) {
          const triage: IssueTriage = {
            disposition: 'smart-guided',
            method: 'heuristic',
            confidence: 0.8,
            reclassifiedAs: 'ARTIFACT-NOT-MARKED',
            autoFix: {
              description: `Element is in the page ${region.type} region — mark as PDF artifact in the authoring tool`,
              requiresApproval: false,
            },
          };
          return { ...issue, triage };
        }
      }
    }

    // List issues → classify as decorative or genuine
    const listedIssue = listClassifier.classifyListIssue(issue, parsed);
    if (listedIssue.triage) return listedIssue;

    // Default → manual
    const triage: IssueTriage = {
      disposition: 'manual',
      method: 'heuristic',
      confidence: 1.0,
    };
    return { ...issue, triage };
  }

  /**
   * Remove auto-resolved table issues on TOC pages and inject one
   * TOC-TAGGING issue per TOC page (with suppressedCount set).
   */
  private collapseTocIssues(
    issues: AuditIssue[],
    parsed: PdfParseResult,
    tocPageNums: Set<number>
  ): AuditIssue[] {
    if (tocPageNums.size === 0) return issues;

    const suppressedByPage = new Map<number, number>();
    const kept: AuditIssue[] = [];

    for (const issue of issues) {
      const isTocTableIssue =
        issue.triage?.reclassifiedAs === 'TOC-TAGGING' &&
        issue.pageNumber !== undefined;

      if (isTocTableIssue) {
        const count = suppressedByPage.get(issue.pageNumber!) ?? 0;
        suppressedByPage.set(issue.pageNumber!, count + 1);
      } else {
        kept.push(issue);
      }
    }

    // Insert one TOC-TAGGING issue per affected page
    for (const [pageNumber, suppressedCount] of suppressedByPage) {
      const pageLabel = parsed.metadata.pageLabels?.[pageNumber - 1];
      const pageRef = pageLabel ? `Page ${pageNumber} (${pageLabel})` : `Page ${pageNumber}`;

      const tocIssue: AuditIssue = {
        id: `toc-tagging-${nanoid(6)}`,
        source: 'smart-triage',
        severity: 'moderate',
        code: 'TOC-TAGGING',
        message: `${pageRef}: Table of Contents is incorrectly tagged as <Table> instead of <TOC>/<TOCI>`,
        wcagCriteria: ['1.3.1'],
        location: `Page ${pageNumber}`,
        suggestion:
          'Re-export the document from the authoring tool (e.g. InDesign, Word) with proper TOC export settings. ' +
          'The TOC should use PDF <TOC> and <TOCI> structure tags, not data table tags.',
        category: 'table',
        pageNumber,
        triage: {
          disposition: 'smart-guided',
          method: 'heuristic',
          confidence: 0.9,
          suppressedCount,
          reclassifiedAs: 'TOC-TAGGING',
          autoFix: {
            description: `${suppressedCount} table accessibility issue(s) suppressed — root cause is incorrect TOC tagging`,
            requiresApproval: false,
          },
        },
      };
      kept.push(tocIssue);
    }

    return kept;
  }

  private buildSummary(
    totalRaw: number,
    issues: AuditIssue[],
    suppressedCategories: string[]
  ): TriageSummary {
    let autoResolved = 0;
    let aiDrafted = 0;
    let smartGuided = 0;
    let manual = 0;

    for (const issue of issues) {
      switch (issue.triage?.disposition) {
        case 'auto-resolved': autoResolved++; break;
        case 'ai-drafted':    aiDrafted++;    break;
        case 'smart-guided':  smartGuided++;  break;
        default:              manual++;       break;
      }
    }

    return {
      version: '1.0',
      totalRaw,
      autoResolved,
      aiDrafted,
      smartGuided,
      manual,
      suppressedCategories,
    };
  }

  private extractY(issue: AuditIssue): number | null {
    const ctx = issue.context ?? issue.location ?? '';
    const match = Y_COORD_RE.exec(ctx);
    return match ? parseFloat(match[1]) : null;
  }
}

export const smartTriageService = new SmartTriageService();
