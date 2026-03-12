/**
 * List Classifier
 *
 * Classifies list-related accessibility issues as decorative (auto-resolved)
 * or genuine (manual). Reduces false positives from visual bullet characters
 * and short label lists that are not semantic lists.
 */

import { AuditIssue, IssueTriage } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';
import { ListInfo } from '../structure-analyzer.service';

// Issue codes produced by the structure validator for lists
const LIST_ISSUE_CODES = new Set([
  'LIST-NOT-TAGGED',
  'LIST-IMPROPER-MARKUP',
  'MATTERHORN-04-001',
  'MATTERHORN-04-002',
]);

// Threshold: average words per item below this → likely decorative labels
const DECORATIVE_AVG_WORDS = 4;

export class ListClassifier {
  /**
   * Classify a single list-related issue.
   * Returns the issue with a `triage` annotation added.
   * Non-list issues are returned unchanged.
   */
  classifyListIssue(issue: AuditIssue, parsed: PdfParseResult): AuditIssue {
    if (!LIST_ISSUE_CODES.has(issue.code)) return issue;

    const page = parsed.pages.find(p => p.pageNumber === issue.pageNumber);
    if (!page || page.lists.length === 0) {
      return this.markManual(issue);
    }

    // Try to match the issue to a specific list using bounding box proximity,
    // so we don't suppress failures for a different list on the same page.
    const implicated = this.findImplicatedList(issue, page.lists);
    if (implicated) {
      const decoration = this.checkDecorativeList(implicated);
      if (decoration) {
        return this.markAutoResolved(issue, decoration);
      }
      return this.markManual(issue);
    }

    // No match by position — fall back to per-page check only if there is exactly
    // one list on the page (unambiguous).
    if (page.lists.length === 1) {
      const decoration = this.checkDecorativeList(page.lists[0]);
      if (decoration) {
        return this.markAutoResolved(issue, decoration);
      }
    }

    return this.markManual(issue);
  }

  /**
   * Find the list on the page that is closest to the issue's reported position.
   * Uses the issue bounding box (when available) or falls back to null.
   */
  private findImplicatedList(issue: AuditIssue, lists: import('../structure-analyzer.service').ListInfo[]): import('../structure-analyzer.service').ListInfo | null {
    if (!issue.boundingBox) return null;

    const issueY = issue.boundingBox.y;
    const issueX = issue.boundingBox.x;

    let best: import('../structure-analyzer.service').ListInfo | null = null;
    let bestDist = Infinity;

    for (const list of lists) {
      const dx = list.position.x - issueX;
      const dy = list.position.y - issueY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = list;
      }
    }

    // Only consider it a match if the list is within 100 PDF points of the issue
    return bestDist <= 100 ? best : null;
  }

  private checkDecorativeList(list: ListInfo): string | null {
    // Single-item "lists" are almost always a decorative bullet character
    if (list.itemCount === 1) {
      return 'Single-item list — likely a decorative bullet character, not a semantic list';
    }

    // Very short unordered items without sentence structure → decorative labels
    if (list.type === 'unordered') {
      const avgWords = this.avgWordCount(list.items.map(i => i.text));
      if (avgWords < DECORATIVE_AVG_WORDS) {
        return `Short unordered items (avg ${avgWords.toFixed(1)} words) — likely decorative labels, not a semantic list`;
      }
    }

    return null;
  }

  private avgWordCount(texts: string[]): number {
    if (texts.length === 0) return 0;
    const total = texts.reduce((sum, t) => sum + t.trim().split(/\s+/).length, 0);
    return total / texts.length;
  }

  private markAutoResolved(issue: AuditIssue, reason: string): AuditIssue {
    const triage: IssueTriage = {
      disposition: 'auto-resolved',
      method: 'heuristic',
      confidence: 0.85,
      autoFix: {
        description: reason,
        requiresApproval: false,
      },
    };
    return { ...issue, triage };
  }

  private markManual(issue: AuditIssue): AuditIssue {
    const triage: IssueTriage = {
      disposition: 'manual',
      method: 'heuristic',
      confidence: 1.0,
    };
    return { ...issue, triage };
  }
}

export const listClassifier = new ListClassifier();
