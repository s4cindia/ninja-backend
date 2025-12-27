import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { epubJSAuditor } from './epub-js-auditor.service';
import { callAceMicroservice } from './ace-client.service';
import { captureIssueSnapshot, compareSnapshots, clearSnapshots } from '../../utils/issue-flow-logger';

const execFileAsync = promisify(execFile);

interface EpubMessage {
  severity: string;
  message: string;
  code?: string;
  location?: {
    path?: string;
    line?: number;
    column?: number;
  };
}

interface EpubCheckResult {
  isValid: boolean;
  epubVersion: string;
  errors: EpubMessage[];
  warnings: EpubMessage[];
  fatalErrors: EpubMessage[];
}

interface AceViolation {
  rule: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  wcag?: string[];
  location?: string;
  html?: string;
}

interface AceResult {
  score: number;
  violations: AceViolation[];
  metadata: {
    conformsTo: string[];
    accessMode: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
    accessibilitySummary?: string;
  };
  outlines: {
    toc: unknown[];
    headings: unknown[];
  };
}

interface AccessibilityIssue {
  id: string;
  source: 'epubcheck' | 'ace' | 'js-auditor';
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  code: string;
  message: string;
  wcagCriteria?: string[];
  location?: string;
  suggestion?: string;
  category?: string;
}

interface ScoreBreakdown {
  score: number;
  formula: string;
  weights: { critical: number; serious: number; moderate: number; minor: number };
  deductions: {
    critical: { count: number; points: number };
    serious: { count: number; points: number };
    moderate: { count: number; points: number };
    minor: { count: number; points: number };
  };
  totalDeduction: number;
  maxScore: number;
}

interface EpubAuditResult {
  jobId: string;
  fileName: string;
  epubVersion: string;
  isValid: boolean;
  isAccessible: boolean;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  epubCheckResult: EpubCheckResult;
  aceResult: AceResult | null;
  combinedIssues: AccessibilityIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  summaryBySource: {
    epubcheck: { critical: number; serious: number; moderate: number; minor: number; total: number };
    ace: { critical: number; serious: number; moderate: number; minor: number; total: number };
    'js-auditor': { critical: number; serious: number; moderate: number; minor: number; total: number; autoFixable: number };
  };
  accessibilityMetadata: AceResult['metadata'] | null;
  auditedAt: Date;
}

class EpubAuditService {
  private epubCheckPath: string;
  private issueCounter = 0;

  constructor() {
    // Use project-local EPUBCheck JAR, fallback to env variable
    this.epubCheckPath = process.env.EPUBCHECK_PATH || 
      path.resolve(__dirname, '../../../lib/epubcheck/epubcheck.jar');
  }

  private parseMessages(messages: Array<Record<string, unknown>>): {
    errors: Array<{ severity: string; message: string; code?: string; location?: { path?: string; line?: number; column?: number } }>;
    warnings: Array<{ severity: string; message: string; code?: string; location?: { path?: string; line?: number; column?: number } }>;
    fatalErrors: Array<{ severity: string; message: string; code?: string; location?: { path?: string; line?: number; column?: number } }>;
  } {
    const normalizedMessages = messages
      .filter(m => m && typeof m === 'object')
      .map(m => {
        const rawSeverity = m.severity;
        const severity = typeof rawSeverity === 'string' ? rawSeverity.toLowerCase() : 'unknown';
        const message = typeof m.message === 'string' ? m.message : 'Unknown message';
        const code = typeof m.ID === 'string' ? m.ID : undefined;

        let location: { path?: string; line?: number; column?: number } | undefined;
        if (Array.isArray(m.locations) && m.locations.length > 0) {
          const loc = m.locations[0] as Record<string, unknown> | null;
          if (loc && typeof loc === 'object') {
            location = {
              path: typeof loc.path === 'string' ? loc.path : undefined,
              line: typeof loc.line === 'number' ? loc.line : undefined,
              column: typeof loc.column === 'number' ? loc.column : undefined,
            };
          }
        }

        return { severity, message, code, location };
      });

    return {
      errors: normalizedMessages.filter(m => m.severity === 'error'),
      warnings: normalizedMessages.filter(m => m.severity === 'warning'),
      fatalErrors: normalizedMessages.filter(m => m.severity === 'fatal'),
    };
  }

  async runAudit(buffer: Buffer, jobId: string, fileName: string): Promise<EpubAuditResult> {
    this.issueCounter = 0;
    clearSnapshots();
    
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epub-audit-'));
    const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.epub';
    const epubPath = path.join(tempDir, safeFileName);
    
    try {
      await fs.promises.writeFile(epubPath, buffer);

      const epubCheckResult = await this.runEpubCheck(epubPath);

      // Call ACE microservice if configured
      let aceResult: AceResult | null = null;
      try {
        aceResult = await callAceMicroservice(buffer, fileName);
        if (aceResult) {
          logger.info(`ACE audit complete: score=${aceResult.score}, violations=${aceResult.violations.length}`);
        }
      } catch (aceError) {
        logger.warn(`ACE microservice call failed: ${aceError instanceof Error ? aceError.message : 'Unknown error'}`);
      }

      const combinedIssues = this.combineResults(epubCheckResult, aceResult);

      captureIssueSnapshot('1_AFTER_COMBINE_EPUBCHECK_ACE', combinedIssues, true);

      logger.info('\nJS AUDITOR INTEGRATION:');
      try {
        const jsResult = await epubJSAuditor.audit(buffer);
        
        logger.info(`  JS Auditor found: ${jsResult.issues.length} issues`);
        logger.info(`  Before merge, combined has: ${combinedIssues.length} issues`);
        
        const existingKeys = new Set(combinedIssues.map(i => 
          `${i.code}:${i.location || ''}:${i.source || ''}`
        ));
        
        logger.info(`  Existing keys count: ${existingKeys.size}`);
        
        let jsAddedCount = 0;
        let jsSkippedCount = 0;
        const skippedJsIssues: Array<{code: string; location: string; matchedKey: string}> = [];
        
        for (const issue of jsResult.issues) {
          const key = `${issue.code}:${issue.location || ''}:js-auditor`;
          const keyWithoutSource = `${issue.code}:${issue.location || ''}`;
          
          const matchedKey = [...existingKeys].find(existingKey => 
            existingKey.startsWith(keyWithoutSource)
          );
          
          if (!matchedKey) {
            combinedIssues.push({
              id: `js-${issue.id}`,
              source: 'js-auditor' as const,
              severity: issue.severity,
              code: issue.code,
              message: issue.message,
              wcagCriteria: issue.wcagCriteria ? [issue.wcagCriteria] : undefined,
              location: issue.location,
              suggestion: issue.suggestion,
              category: issue.category,
            });
            existingKeys.add(key);
            jsAddedCount++;
          } else {
            skippedJsIssues.push({
              code: issue.code,
              location: issue.location || '',
              matchedKey,
            });
            jsSkippedCount++;
          }
        }
        
        logger.info(`  JS issues added: ${jsAddedCount}`);
        logger.info(`  JS issues skipped (duplicates): ${jsSkippedCount}`);
        
        if (skippedJsIssues.length > 0) {
          logger.info(`  Skipped JS issues:`);
          skippedJsIssues.forEach(item => {
            logger.info(`    - ${item.code} @ ${item.location || 'N/A'} (matched: ${item.matchedKey})`);
          });
        }
        
        logger.info(`  After merge, combined has: ${combinedIssues.length} issues`);
        captureIssueSnapshot('2_AFTER_JS_AUDITOR', combinedIssues, true);
      } catch (jsError) {
        logger.warn(`JS audit failed: ${jsError instanceof Error ? jsError.message : 'Unknown error'}`);
      }

      captureIssueSnapshot('3_BEFORE_DEDUPLICATION', combinedIssues, true);

      logger.info('\nFINAL DEDUPLICATION:');
      logger.info(`  Input count: ${combinedIssues.length}`);

      const seen = new Set<string>();
      const removedInDedup: Array<{code: string; source: string; location: string; key: string}> = [];
      
      const deduplicatedIssues = combinedIssues.filter(issue => {
        const key = `${issue.source}-${issue.code}-${issue.location || ''}-${issue.message}`;
        if (seen.has(key)) {
          removedInDedup.push({
            code: issue.code,
            source: issue.source,
            location: issue.location || '',
            key,
          });
          return false;
        }
        seen.add(key);
        return true;
      });

      if (removedInDedup.length > 0) {
        logger.info(`  Removed ${removedInDedup.length} duplicates:`);
        removedInDedup.forEach(item => {
          logger.info(`    - [${item.source}] ${item.code} @ ${item.location || 'N/A'}`);
        });
      } else {
        logger.info(`  No duplicates removed`);
      }
      logger.info(`  Output count: ${deduplicatedIssues.length}`);

      captureIssueSnapshot('4_AFTER_DEDUPLICATION', deduplicatedIssues, true);

      compareSnapshots('1_AFTER_COMBINE_EPUBCHECK_ACE', '4_AFTER_DEDUPLICATION');

      logger.info('\n📊 AUDIT ISSUE FLOW SUMMARY:');
      logger.info(`  EPUBCheck+ACE combined: ${combinedIssues.length - (deduplicatedIssues.filter(i => i.source === 'js-auditor').length)}`);
      logger.info(`  JS Auditor added: ${deduplicatedIssues.filter(i => i.source === 'js-auditor').length}`);
      logger.info(`  After deduplication: ${deduplicatedIssues.length}`);
      logger.info(`  By Source: epubcheck=${deduplicatedIssues.filter(i => i.source === 'epubcheck').length}, ace=${deduplicatedIssues.filter(i => i.source === 'ace').length}, js-auditor=${deduplicatedIssues.filter(i => i.source === 'js-auditor').length}`);

      const scoreBreakdown = this.calculateScore(deduplicatedIssues);
      
      logger.info(`[EPUB Audit] Score calculation: ${JSON.stringify(scoreBreakdown)}`);
      logger.info(`[EPUB Audit] Issues by severity - critical: ${deduplicatedIssues.filter(i => i.severity === 'critical').length}, serious: ${deduplicatedIssues.filter(i => i.severity === 'serious').length}, moderate: ${deduplicatedIssues.filter(i => i.severity === 'moderate').length}, minor: ${deduplicatedIssues.filter(i => i.severity === 'minor').length}`);

      const summaryBySource = {
        epubcheck: {
          critical: deduplicatedIssues.filter(i => i.source === 'epubcheck' && i.severity === 'critical').length,
          serious: deduplicatedIssues.filter(i => i.source === 'epubcheck' && i.severity === 'serious').length,
          moderate: deduplicatedIssues.filter(i => i.source === 'epubcheck' && i.severity === 'moderate').length,
          minor: deduplicatedIssues.filter(i => i.source === 'epubcheck' && i.severity === 'minor').length,
          total: deduplicatedIssues.filter(i => i.source === 'epubcheck').length,
        },
        ace: {
          critical: deduplicatedIssues.filter(i => i.source === 'ace' && i.severity === 'critical').length,
          serious: deduplicatedIssues.filter(i => i.source === 'ace' && i.severity === 'serious').length,
          moderate: deduplicatedIssues.filter(i => i.source === 'ace' && i.severity === 'moderate').length,
          minor: deduplicatedIssues.filter(i => i.source === 'ace' && i.severity === 'minor').length,
          total: deduplicatedIssues.filter(i => i.source === 'ace').length,
        },
        'js-auditor': {
          critical: deduplicatedIssues.filter(i => i.source === 'js-auditor' && i.severity === 'critical').length,
          serious: deduplicatedIssues.filter(i => i.source === 'js-auditor' && i.severity === 'serious').length,
          moderate: deduplicatedIssues.filter(i => i.source === 'js-auditor' && i.severity === 'moderate').length,
          minor: deduplicatedIssues.filter(i => i.source === 'js-auditor' && i.severity === 'minor').length,
          total: deduplicatedIssues.filter(i => i.source === 'js-auditor').length,
          // All JS Auditor issues are auto-fixable by design - it specifically detects issues with remediation handlers
          autoFixable: deduplicatedIssues.filter(i => i.source === 'js-auditor').length,
        },
      };

      const result: EpubAuditResult = {
        jobId,
        fileName,
        epubVersion: epubCheckResult.epubVersion,
        isValid: epubCheckResult.isValid,
        isAccessible: scoreBreakdown.score >= 70 && deduplicatedIssues.filter(i => i.severity === 'critical').length === 0,
        score: scoreBreakdown.score,
        scoreBreakdown,
        epubCheckResult,
        aceResult,
        combinedIssues: deduplicatedIssues,
        summary: {
          critical: deduplicatedIssues.filter(i => i.severity === 'critical').length,
          serious: deduplicatedIssues.filter(i => i.severity === 'serious').length,
          moderate: deduplicatedIssues.filter(i => i.severity === 'moderate').length,
          minor: deduplicatedIssues.filter(i => i.severity === 'minor').length,
          total: deduplicatedIssues.length,
        },
        summaryBySource,
        accessibilityMetadata: aceResult?.metadata || null,
        auditedAt: new Date(),
      };

      await this.storeResult(result);

      return result;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runEpubCheck(epubPath: string): Promise<EpubCheckResult> {
    const outputPath = epubPath + '.json';

    logger.info(`Running EPUBCheck on: ${epubPath}`);
    logger.info(`EPUBCheck JAR path: ${this.epubCheckPath}`);

    try {
      await execFileAsync('java', ['-version']);
      logger.info('Java is available');
    } catch (javaError) {
      logger.warn(`Java not available, skipping EPUBCheck: ${javaError instanceof Error ? javaError.message : 'unknown error'}`);
      return {
        isValid: false,
        epubVersion: 'unknown',
        errors: [],
        warnings: [],
        fatalErrors: [{ severity: 'error', message: 'Java runtime not available for EPUBCheck' }],
      };
    }

    try {
      logger.info(`Executing: java -jar ${this.epubCheckPath} ${epubPath} --json ${outputPath}`);
      await execFileAsync(
        'java',
        ['-jar', this.epubCheckPath, epubPath, '--json', outputPath],
        { timeout: 60000 }
      );
      logger.info('EPUBCheck completed successfully');

      const outputContent = await fs.promises.readFile(outputPath, 'utf-8');
      const output = JSON.parse(outputContent);

      const parsed = this.parseMessages(output.messages || []);
      return {
        isValid: parsed.errors.length === 0 && parsed.fatalErrors.length === 0,
        epubVersion: output.publication?.ePubVersion || 'unknown',
        errors: parsed.errors,
        warnings: parsed.warnings,
        fatalErrors: parsed.fatalErrors,
      };
    } catch (error) {
      try {
        const outputContent = await fs.promises.readFile(outputPath, 'utf-8');
        const output = JSON.parse(outputContent);

        const parsed = this.parseMessages(output.messages || []);
        return {
          isValid: parsed.errors.length === 0 && parsed.fatalErrors.length === 0,
          epubVersion: output.publication?.ePubVersion || 'unknown',
          errors: parsed.errors,
          warnings: parsed.warnings,
          fatalErrors: parsed.fatalErrors,
        };
      } catch {
        logger.error('EPUBCheck failed', error instanceof Error ? error : undefined);
        return {
          isValid: false,
          epubVersion: 'unknown',
          errors: [],
          warnings: [],
          fatalErrors: [{ severity: 'error', message: 'EPUBCheck execution failed' }],
        };
      }
    }
  }

  private async runAce(epubPath: string, tempDir: string): Promise<AceResult> {
    const aceOutputDir = path.join(tempDir, 'ace-output');

    try {
      await execFileAsync(
        'npx',
        ['@daisy/ace', epubPath, '--outdir', aceOutputDir, '--force'],
        { 
          timeout: 120000,
          env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }
        }
      );

      const reportPath = path.join(aceOutputDir, 'report.json');
      const reportContent = await fs.promises.readFile(reportPath, 'utf-8');
      const report = JSON.parse(reportContent);

      const violations: AceViolation[] = [];
      for (const assertion of report.assertions || []) {
        for (const violation of assertion.assertions || []) {
          violations.push({
            rule: violation['@type'] || 'unknown',
            impact: this.mapAceImpact(violation.earl?.result?.outcome),
            description: violation.earl?.result?.description || violation.assertion || '',
            wcag: violation['dcterms:references'],
            location: assertion['earl:testSubject']?.url,
            html: violation.earl?.result?.pointer?.css,
          });
        }
      }

      const metadata = {
        conformsTo: report.data?.['dc:conformsTo'] || [],
        accessMode: report.data?.accessMode || [],
        accessibilityFeature: report.data?.accessibilityFeature || [],
        accessibilityHazard: report.data?.accessibilityHazard || [],
        accessibilitySummary: report.data?.accessibilitySummary,
      };

      return {
        score: this.calculateAceScore(violations),
        violations,
        metadata,
        outlines: {
          toc: report.outlines?.toc || [],
          headings: report.outlines?.headings || [],
        },
      };
    } catch (error) {
      logger.error('Ace audit failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private mapAceImpact(outcome: string): AceViolation['impact'] {
    switch (outcome) {
      case 'fail': return 'critical';
      case 'cantTell': return 'serious';
      case 'inapplicable': return 'minor';
      default: return 'moderate';
    }
  }

  private calculateAceScore(violations: AceViolation[]): number {
    let score = 100;
    for (const v of violations) {
      switch (v.impact) {
        case 'critical': score -= 15; break;
        case 'serious': score -= 8; break;
        case 'moderate': score -= 4; break;
        case 'minor': score -= 1; break;
      }
    }
    return Math.max(0, score);
  }

  private combineResults(
    epubCheck: EpubCheckResult,
    ace: AceResult | null = null
  ): AccessibilityIssue[] {
    const issues: AccessibilityIssue[] = [];

    logger.info('\nPARSING EPUBCHECK RESULTS:');
    const epubCheckErrors = [...epubCheck.fatalErrors, ...epubCheck.errors];
    logger.info(`  Fatal errors: ${epubCheck.fatalErrors.length}`);
    logger.info(`  Errors: ${epubCheck.errors.length}`);
    logger.info(`  Warnings: ${epubCheck.warnings.length}`);

    for (const error of epubCheckErrors) {
      issues.push(this.createIssue({
        source: 'epubcheck',
        severity: 'serious',
        code: error.code || 'EPUBCHECK-ERROR',
        message: error.message,
        location: error.location?.path,
      }));
    }

    for (const warning of epubCheck.warnings) {
      issues.push(this.createIssue({
        source: 'epubcheck',
        severity: 'moderate',
        code: warning.code || 'EPUBCHECK-WARN',
        message: warning.message,
        location: warning.location?.path,
      }));
    }

    logger.info(`  EPUBCheck issues added: ${issues.length}`);

    if (ace) {
      logger.info('\nPARSING ACE RESULTS:');
      logger.info(`  Raw violations count: ${ace.violations?.length || 0}`);
      
      const aceCodeCounts: Record<string, number> = {};
      
      for (const violation of ace.violations) {
        const code = violation.rule || 'ACE-UNKNOWN';
        aceCodeCounts[code] = (aceCodeCounts[code] || 0) + 1;
        
        issues.push(this.createIssue({
          source: 'ace',
          severity: violation.impact,
          code: code,
          message: violation.description,
          wcagCriteria: violation.wcag,
          location: violation.location,
        }));
      }
      
      logger.info(`  ACE issues added: ${ace.violations.length}`);
      logger.info(`  ACE issues by code: ${JSON.stringify(aceCodeCounts)}`);
    } else {
      logger.info('\nACE RESULTS: null (microservice not available or failed)');
    }

    logger.info(`\nTOTAL COMBINED ISSUES: ${issues.length}`);
    logger.info(`  EPUBCheck: ${issues.filter(i => i.source === 'epubcheck').length}`);
    logger.info(`  ACE: ${issues.filter(i => i.source === 'ace').length}`);

    return issues;
  }

  private createIssue(data: Omit<AccessibilityIssue, 'id'>): AccessibilityIssue {
    return {
      id: `issue-${++this.issueCounter}`,
      ...data,
    };
  }

  private calculateScore(issues: AccessibilityIssue[]): ScoreBreakdown {
    const weights = {
      critical: 15,
      serious: 8,
      moderate: 4,
      minor: 1,
    };

    const counts = {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
    };

    const deductions = {
      critical: { count: counts.critical, points: counts.critical * weights.critical },
      serious: { count: counts.serious, points: counts.serious * weights.serious },
      moderate: { count: counts.moderate, points: counts.moderate * weights.moderate },
      minor: { count: counts.minor, points: counts.minor * weights.minor },
    };

    const totalDeduction =
      deductions.critical.points +
      deductions.serious.points +
      deductions.moderate.points +
      deductions.minor.points;

    return {
      score: Math.max(0, 100 - totalDeduction),
      formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
      weights,
      deductions,
      totalDeduction,
      maxScore: 100,
    };
  }

  private async storeResult(result: EpubAuditResult): Promise<void> {
    await prisma.job.update({
      where: { id: result.jobId },
      data: {
        output: JSON.parse(JSON.stringify(result)),
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
  }
}

export const epubAuditService = new EpubAuditService();
export type { EpubAuditResult, AccessibilityIssue, AceResult, EpubCheckResult };
