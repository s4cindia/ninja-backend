import { randomUUID } from 'crypto';
import { AccessibilityIssue, ValidatorContext, TableValidationResult, TableStatus } from '../types';
import { TableInfo } from '../../pdf/structure-analyzer.service';

export type TableIssueType = 
  | 'missing_headers'
  | 'missing_scope'
  | 'missing_id_headers'
  | 'layout_table_marked_data'
  | 'complex_table_needs_summary'
  | 'no_caption';

function detectLayoutTable(table: TableInfo): boolean {
  if (table.rowCount <= 1 || table.columnCount <= 1) {
    return true;
  }
  
  if (!table.hasHeaderRow && !table.hasHeaderColumn) {
    if (table.rowCount <= 2 && table.columnCount >= 4) {
      return true;
    }
  }
  
  return false;
}

function isComplexTable(table: TableInfo): boolean {
  if (table.rowCount > 5 || table.columnCount > 5) {
    return true;
  }
  
  const hasMergedCells = table.cells.some(
    cell => cell.rowSpan > 1 || cell.colSpan > 1
  );
  
  return hasMergedCells;
}

export function validateTables(
  tables: TableInfo[],
  _context: ValidatorContext
): TableValidationResult {
  const tableStatuses: TableStatus[] = [];
  const issues: AccessibilityIssue[] = [];

  let compliantTables = 0;

  for (const table of tables) {
    const tableIssues: AccessibilityIssue[] = [];
    const isLayout = detectLayoutTable(table);
    const isComplex = isComplexTable(table);

    if (!isLayout) {
      if (!table.hasHeaderRow && !table.hasHeaderColumn) {
        const issue: AccessibilityIssue = {
          id: randomUUID(),
          wcagCriterion: '1.3.1',
          wcagLevel: 'A',
          severity: 'serious',
          title: 'Table missing header cells',
          description: `Table "${table.id}" on page ${table.pageNumber} does not have header cells (TH elements). Data tables must have row or column headers to be accessible.`,
          location: {
            page: table.pageNumber,
            element: table.id,
          },
          remediation: 'Add header cells (<th>) to identify row and/or column headers. Use the scope attribute to associate headers with data cells.',
        };
        tableIssues.push(issue);
        issues.push(issue);
      }

      if (isComplex && !table.hasSummary && !table.caption) {
        const issue: AccessibilityIssue = {
          id: randomUUID(),
          wcagCriterion: '1.3.1',
          wcagLevel: 'A',
          severity: 'moderate',
          title: 'Complex table needs summary',
          description: `Table "${table.id}" on page ${table.pageNumber} is complex (${table.rowCount} rows x ${table.columnCount} columns) but lacks a summary or caption describing its structure.`,
          location: {
            page: table.pageNumber,
            element: table.id,
          },
          remediation: 'Add a summary attribute or caption element to describe the table structure and help users understand how to navigate it.',
        };
        tableIssues.push(issue);
        issues.push(issue);
      }

      const mergedDataCells = table.cells.filter(
        cell => !cell.isHeader && (cell.rowSpan > 1 || cell.colSpan > 1)
      );
      
      const hasHeaderCells = table.cells.some(cell => cell.isHeader);
      
      if (mergedDataCells.length > 0) {
        if (!hasHeaderCells) {
          const issue: AccessibilityIssue = {
            id: randomUUID(),
            wcagCriterion: '1.3.1',
            wcagLevel: 'A',
            severity: 'serious',
            title: 'Merged cells without any headers',
            description: `Table "${table.id}" on page ${table.pageNumber} has ${mergedDataCells.length} merged data cell(s) but no header cells to associate with. Tables with merged cells require explicit id/headers attributes.`,
            location: {
              page: table.pageNumber,
              element: table.id,
            },
            remediation: 'Add header cells with id attributes and use the headers attribute on merged data cells to create explicit associations.',
          };
          tableIssues.push(issue);
          issues.push(issue);
        } else {
          const issue: AccessibilityIssue = {
            id: randomUUID(),
            wcagCriterion: '1.3.1',
            wcagLevel: 'A',
            severity: 'minor',
            title: 'Merged cells may need id/headers review',
            description: `Table "${table.id}" on page ${table.pageNumber} has ${mergedDataCells.length} merged data cell(s). Manual review recommended to verify proper id/headers associations exist for accessibility.`,
            location: {
              page: table.pageNumber,
              element: table.id,
            },
            remediation: 'Verify that header cells have id attributes and merged data cells have headers attributes that reference the appropriate header ids.',
          };
          tableIssues.push(issue);
          issues.push(issue);
        }
      }

      if (table.issues && table.issues.length > 0) {
        for (const issueText of table.issues) {
          if (issueText.toLowerCase().includes('no header')) {
            continue;
          }
          
          const issue: AccessibilityIssue = {
            id: randomUUID(),
            wcagCriterion: '1.3.1',
            wcagLevel: 'A',
            severity: 'minor',
            title: 'Table accessibility issue',
            description: `Table "${table.id}" on page ${table.pageNumber}: ${issueText}`,
            location: {
              page: table.pageNumber,
              element: table.id,
            },
            remediation: 'Review and fix the table structure to ensure proper accessibility.',
          };
          tableIssues.push(issue);
          issues.push(issue);
        }
      }
    } else {
      if (table.hasHeaderRow || table.hasHeaderColumn) {
        const issue: AccessibilityIssue = {
          id: randomUUID(),
          wcagCriterion: '1.3.1',
          wcagLevel: 'A',
          severity: 'moderate',
          title: 'Layout table marked as data table',
          description: `Table "${table.id}" on page ${table.pageNumber} appears to be a layout table but has semantic header markup (TH elements). Layout tables should not use semantic table structure.`,
          location: {
            page: table.pageNumber,
            element: table.id,
          },
          remediation: 'Remove header cell markup from layout tables. Use role="presentation" or role="none" on the table element, or convert to CSS-based layout.',
        };
        tableIssues.push(issue);
        issues.push(issue);
      }
    }

    const hasCriticalOrSerious = tableIssues.some(
      i => i.severity === 'critical' || i.severity === 'serious'
    );
    const isTableAccessible = !hasCriticalOrSerious;

    if (isTableAccessible) {
      compliantTables++;
    }

    tableStatuses.push({
      tableId: table.id,
      page: table.pageNumber,
      position: table.position,
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      hasHeaderRow: table.hasHeaderRow,
      hasHeaderColumn: table.hasHeaderColumn,
      hasSummary: table.hasSummary,
      hasCaption: !!table.caption,
      isLayoutTable: isLayout,
      isComplexTable: isComplex,
      isAccessible: isTableAccessible,
      issues: tableIssues,
    });
  }

  const totalTables = tables.length;
  const compliancePercentage = totalTables > 0
    ? Math.round((compliantTables / totalTables) * 1000) / 10
    : 100;

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const seriousCount = issues.filter(i => i.severity === 'serious').length;
  const moderateCount = issues.filter(i => i.severity === 'moderate').length;
  const minorCount = issues.filter(i => i.severity === 'minor').length;

  const failed = criticalCount + seriousCount;
  const warnings = moderateCount + minorCount;

  return {
    totalTables,
    compliantTables,
    compliancePercentage,
    tables: tableStatuses,
    issues: issues.sort((a, b) => {
      const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    summary: {
      totalChecks: totalTables,
      passed: compliantTables,
      failed,
      warnings,
    },
  };
}
