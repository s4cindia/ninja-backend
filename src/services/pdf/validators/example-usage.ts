/**
 * Example usage of PDF Structure Validator
 *
 * This file demonstrates how to use the PDF structure validator
 * to check PDF documents for accessibility compliance.
 */

/* eslint-disable no-console */

import { pdfStructureValidator } from './pdf-structure.validator';
import { AuditIssue } from '../../audit/base-audit.service';
import { logger } from '../../../lib/logger';

/**
 * Example: Validate a PDF file and display results
 */
async function exampleValidation(filePath: string): Promise<void> {
  try {
    logger.info(`Starting validation for: ${filePath}`);

    // Validate the PDF
    const result = await pdfStructureValidator.validateFromFile(filePath);

    // Display summary
    console.log('\n=== PDF Structure Validation Report ===\n');
    console.log(`Document: ${filePath}`);
    console.log(`Total Issues: ${result.summary.total}`);
    console.log(`  - Critical: ${result.summary.critical}`);
    console.log(`  - Serious: ${result.summary.serious}`);
    console.log(`  - Moderate: ${result.summary.moderate}`);
    console.log(`  - Minor: ${result.summary.minor}`);

    // Display metadata
    console.log('\n=== Document Metadata ===\n');
    console.log(`Tagged PDF: ${result.metadata.isTaggedPDF ? '✓' : '✗'}`);
    console.log(`Document Language: ${result.metadata.hasDocumentLanguage ? '✓' : '✗'}`);
    console.log(`Document Title: ${result.metadata.hasDocumentTitle ? '✓' : '✗'}`);
    console.log(`Total Headings: ${result.metadata.totalHeadings}`);
    console.log(`Total Tables: ${result.metadata.totalTables}`);
    console.log(`Total Lists: ${result.metadata.totalLists}`);

    // Display issues by severity
    if (result.issues.length > 0) {
      console.log('\n=== Issues ===\n');

      // Group issues by severity
      const issuesBySeverity = {
        critical: result.issues.filter(i => i.severity === 'critical'),
        serious: result.issues.filter(i => i.severity === 'serious'),
        moderate: result.issues.filter(i => i.severity === 'moderate'),
        minor: result.issues.filter(i => i.severity === 'minor'),
      };

      // Display critical issues
      if (issuesBySeverity.critical.length > 0) {
        console.log('🔴 CRITICAL ISSUES:');
        for (const issue of issuesBySeverity.critical) {
          displayIssue(issue);
        }
        console.log('');
      }

      // Display serious issues
      if (issuesBySeverity.serious.length > 0) {
        console.log('🟠 SERIOUS ISSUES:');
        for (const issue of issuesBySeverity.serious) {
          displayIssue(issue);
        }
        console.log('');
      }

      // Display moderate issues
      if (issuesBySeverity.moderate.length > 0) {
        console.log('🟡 MODERATE ISSUES:');
        for (const issue of issuesBySeverity.moderate) {
          displayIssue(issue);
        }
        console.log('');
      }

      // Display minor issues
      if (issuesBySeverity.minor.length > 0) {
        console.log('🟢 MINOR ISSUES:');
        for (const issue of issuesBySeverity.minor) {
          displayIssue(issue);
        }
        console.log('');
      }
    } else {
      console.log('\n✓ No accessibility issues found!\n');
    }

    // Display compliance summary
    console.log('=== Compliance Summary ===\n');
    if (result.summary.critical === 0 && result.summary.serious === 0) {
      console.log('✓ Document meets basic accessibility requirements');
    } else {
      console.log('✗ Document has accessibility issues that need to be addressed');
      console.log('  Priority: Fix critical and serious issues first');
    }

  } catch (error) {
    logger.error('Validation failed:', error);
    throw error;
  }
}

/**
 * Display a single issue with formatting
 */
function displayIssue(issue: AuditIssue): void {
  console.log(`  [${issue.code}] ${issue.message}`);
  console.log(`    Location: ${issue.location || 'N/A'}`);
  if (issue.wcagCriteria && issue.wcagCriteria.length > 0) {
    console.log(`    WCAG: ${issue.wcagCriteria.join(', ')}`);
  }
  if (issue.suggestion) {
    console.log(`    💡 Suggestion: ${issue.suggestion}`);
  }
  console.log('');
}

/**
 * Example: Filter issues by category
 */
async function exampleFilterByCategory(filePath: string, category: string): Promise<void> {
  const result = await pdfStructureValidator.validateFromFile(filePath);

  const categoryIssues = result.issues.filter(
    issue => issue.category === category
  );

  console.log(`\n=== ${category.toUpperCase()} Issues ===\n`);
  console.log(`Found ${categoryIssues.length} ${category} issues`);

  for (const issue of categoryIssues) {
    displayIssue(issue);
  }
}

/**
 * Example: Check WCAG compliance level
 */
async function exampleCheckWCAGCompliance(filePath: string, level: 'A' | 'AA' | 'AAA'): Promise<void> {
  const result = await pdfStructureValidator.validateFromFile(filePath);

  // Define WCAG criteria by level
  const wcagLevelA = ['1.3.1', '1.3.2', '2.4.1', '2.4.2', '3.1.1'];
  const wcagLevelAA = [...wcagLevelA, '2.4.6'];
  const wcagLevelAAA = [...wcagLevelAA]; // Add AAA criteria as needed

  let requiredCriteria: string[];
  switch (level) {
    case 'A':
      requiredCriteria = wcagLevelA;
      break;
    case 'AA':
      requiredCriteria = wcagLevelAA;
      break;
    case 'AAA':
      requiredCriteria = wcagLevelAAA;
      break;
  }

  // Find issues that affect required criteria
  const complianceIssues = result.issues.filter(issue =>
    issue.wcagCriteria?.some(criterion => requiredCriteria.includes(criterion))
  );

  console.log(`\n=== WCAG ${level} Compliance Check ===\n`);
  console.log(`Issues affecting WCAG ${level}: ${complianceIssues.length}`);

  if (complianceIssues.length === 0) {
    console.log(`✓ Document meets WCAG ${level} requirements for structure`);
  } else {
    console.log(`✗ Document does not meet WCAG ${level} requirements`);
    console.log('\nIssues to fix:');
    for (const issue of complianceIssues) {
      displayIssue(issue);
    }
  }
}

// Export examples for use in other files
export {
  exampleValidation,
  exampleFilterByCategory,
  exampleCheckWCAGCompliance,
};

// Example CLI usage (if run directly)
const isMainModule = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (isMainModule) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: ts-node example-usage.ts <path-to-pdf>');
    console.log('Example: ts-node example-usage.ts /path/to/document.pdf');
    process.exit(1);
  }

  try {
    await exampleValidation(filePath);
    console.log('\n✓ Validation complete\n');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Validation failed:', (error as Error).message);
    process.exit(1);
  }
}
