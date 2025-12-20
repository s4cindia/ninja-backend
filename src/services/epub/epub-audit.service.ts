import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { epubJSAuditor } from './epub-js-auditor.service';

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

interface EpubAuditResult {
  jobId: string;
  fileName: string;
  epubVersion: string;
  isValid: boolean;
  isAccessible: boolean;
  score: number;
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
  accessibilityMetadata: AceResult['metadata'] | null;
  auditedAt: Date;
}

class EpubAuditService {
  private epubCheckPath: string;
  private issueCounter = 0;

  constructor() {
    this.epubCheckPath = process.env.EPUBCHECK_PATH || '/usr/local/lib/epubcheck/epubcheck.jar';
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
    
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epub-audit-'));
    const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.epub';
    const epubPath = path.join(tempDir, safeFileName);
    
    try {
      await fs.promises.writeFile(epubPath, buffer);

      const epubCheckResult = await this.runEpubCheck(epubPath);

      let aceResult: AceResult | null = null;
      if (epubCheckResult.fatalErrors.length === 0) {
        try {
          aceResult = await this.runAce(epubPath, tempDir);
        } catch (_aceError) {
          logger.warn('Ace audit failed, continuing with EPUBCheck results only');
        }
      }

      const combinedIssues = this.combineResults(epubCheckResult, aceResult);

      logger.info('Running JS accessibility audit for auto-fixable issues');
      try {
        const jsResult = await epubJSAuditor.audit(buffer);
        
        const existingCodes = new Set(combinedIssues.map(i => i.code));
        
        for (const issue of jsResult.issues) {
          if (!existingCodes.has(issue.code)) {
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
          }
        }
        
        logger.info(`JS audit found ${jsResult.issues.length} additional accessibility issues`);
      } catch (jsError) {
        logger.warn(`JS audit failed: ${jsError instanceof Error ? jsError.message : 'Unknown error'}`);
      }

      const score = this.calculateScore(combinedIssues, aceResult);

      const result: EpubAuditResult = {
        jobId,
        fileName,
        epubVersion: epubCheckResult.epubVersion,
        isValid: epubCheckResult.isValid,
        isAccessible: score >= 70 && combinedIssues.filter(i => i.severity === 'critical').length === 0,
        score,
        epubCheckResult,
        aceResult,
        combinedIssues,
        summary: {
          critical: combinedIssues.filter(i => i.severity === 'critical').length,
          serious: combinedIssues.filter(i => i.severity === 'serious').length,
          moderate: combinedIssues.filter(i => i.severity === 'moderate').length,
          minor: combinedIssues.filter(i => i.severity === 'minor').length,
          total: combinedIssues.length,
        },
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

    try {
      await execFileAsync('java', ['-version']);
    } catch {
      logger.warn('Java not available, skipping EPUBCheck');
      return {
        isValid: true,
        epubVersion: 'unknown',
        errors: [],
        warnings: [],
        fatalErrors: [{ severity: 'error', message: 'Java runtime not available for EPUBCheck' }],
      };
    }

    try {
      await execFileAsync(
        'java',
        ['-jar', this.epubCheckPath, epubPath, '--json', outputPath],
        { timeout: 60000 }
      );

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
        { timeout: 120000 }
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
    ace: AceResult | null
  ): AccessibilityIssue[] {
    const issues: AccessibilityIssue[] = [];

    for (const error of [...epubCheck.fatalErrors, ...epubCheck.errors]) {
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

    if (ace) {
      for (const violation of ace.violations) {
        issues.push(this.createIssue({
          source: 'ace',
          severity: violation.impact,
          code: violation.rule,
          message: violation.description,
          wcagCriteria: violation.wcag,
          location: violation.location,
        }));
      }
    }

    return issues;
  }

  private createIssue(data: Omit<AccessibilityIssue, 'id'>): AccessibilityIssue {
    return {
      id: `issue-${++this.issueCounter}`,
      ...data,
    };
  }

  private calculateScore(issues: AccessibilityIssue[], ace: AceResult | null): number {
    if (ace) {
      return ace.score;
    }

    let score = 100;
    for (const issue of issues) {
      switch (issue.severity) {
        case 'critical': score -= 15; break;
        case 'serious': score -= 8; break;
        case 'moderate': score -= 4; break;
        case 'minor': score -= 1; break;
      }
    }
    return Math.max(0, score);
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
