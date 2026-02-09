import { randomUUID } from 'crypto';
import {
  AccessibilityIssue,
  ReadingOrderValidationResult,
  ValidatorContext,
} from '../types';
import type { ReadingOrderInfo } from '../../pdf/structure-analyzer.service';

export function validateReadingOrder(
  readingOrderInfo: ReadingOrderInfo,
  context: ValidatorContext
): ReadingOrderValidationResult {
  const issues: AccessibilityIssue[] = [];
  const orderDiscrepancies: ReadingOrderValidationResult['orderDiscrepancies'] = [];

  if (!context.isTaggedPdf) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.2',
      wcagLevel: 'A',
      severity: 'critical',
      title: 'Untagged PDF - Reading order cannot be verified',
      description: 'This PDF does not have a tag structure. Without tags, assistive technologies cannot determine the correct reading order of content.',
      location: { page: 1 },
      remediation: 'Add proper PDF tags to the document. Use a PDF editor or accessibility tool to tag the document structure.',
    });
    return { issues, hasProperOrder: false, orderDiscrepancies };
  }

  if (!readingOrderInfo.hasStructureTree) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.2',
      wcagLevel: 'A',
      severity: 'serious',
      title: 'Missing structure tree',
      description: 'The PDF is tagged but does not have a proper structure tree. Reading order may not be correctly defined.',
      location: { page: 1 },
      remediation: 'Ensure the PDF has a complete structure tree that defines the reading order of all content.',
    });
  }

  for (const orderIssue of readingOrderInfo.issues) {
    let severity: 'critical' | 'serious' | 'moderate' | 'minor' = 'serious';
    
    if (orderIssue.type === 'column-confusion') {
      severity = 'serious';
      issues.push({
        id: randomUUID(),
        wcagCriterion: '1.3.2',
        wcagLevel: 'A',
        severity,
        title: 'Multi-column reading order issue',
        description: orderIssue.description,
        location: { page: orderIssue.pageNumber || 1 },
        remediation: 'Ensure the PDF tag structure correctly defines the reading order for multi-column layouts. Content should be tagged to read each column in sequence.',
      });

      if (orderIssue.pageNumber) {
        orderDiscrepancies.push({
          page: orderIssue.pageNumber,
          expected: 'Left-to-right, top-to-bottom within columns',
          actual: 'Columns may be read in incorrect order',
          description: orderIssue.description,
        });
      }
    } else if (orderIssue.type === 'visual-order') {
      issues.push({
        id: randomUUID(),
        wcagCriterion: '1.3.2',
        wcagLevel: 'A',
        severity: 'serious',
        title: 'Reading order discrepancy',
        description: orderIssue.description,
        location: { page: orderIssue.pageNumber || 1 },
        remediation: 'Reorder the PDF tags to match the intended reading sequence.',
      });
    } else if (orderIssue.type === 'float-interruption' || orderIssue.type === 'table-reading') {
      issues.push({
        id: randomUUID(),
        wcagCriterion: '1.3.2',
        wcagLevel: 'A',
        severity: 'moderate',
        title: 'Reading order concern',
        description: orderIssue.description,
        location: { page: orderIssue.pageNumber || 1 },
        remediation: 'Review and verify the reading order matches the intended content sequence.',
      });
    }
  }

  if (readingOrderInfo.confidence < 0.5) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.2',
      wcagLevel: 'A',
      severity: 'moderate',
      title: 'Low confidence in reading order',
      description: `The reading order analysis has low confidence (${Math.round(readingOrderInfo.confidence * 100)}%). Manual review is recommended.`,
      location: { page: 1 },
      remediation: 'Manually verify the reading order by testing with a screen reader or PDF accessibility checker.',
    });
  }

  const hasProperOrder = readingOrderInfo.isLogical && 
    issues.filter(i => i.severity === 'critical' || i.severity === 'serious').length === 0;

  return { issues, hasProperOrder, orderDiscrepancies };
}
