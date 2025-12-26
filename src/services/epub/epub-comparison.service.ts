import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { diffLines } from 'diff';
import { logger } from '../../lib/logger';

interface FileComparison {
  filePath: string;
  fileType: 'opf' | 'html' | 'css' | 'other';
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  changeCount: number;
  diff?: DiffResult[];
  beforeSnippet?: string;
  afterSnippet?: string;
}

interface DiffResult {
  type: 'added' | 'removed' | 'unchanged';
  value: string;
  lineNumber?: number;
}

interface ComparisonSummary {
  totalFiles: number;
  modifiedFiles: number;
  addedFiles: number;
  removedFiles: number;
  unchangedFiles: number;
  totalChanges: number;
  changesByType: {
    metadata: number;
    content: number;
    structure: number;
    accessibility: number;
  };
}

interface EPUBComparisonResult {
  jobId: string;
  originalFileName: string;
  remediatedFileName: string;
  summary: ComparisonSummary;
  files: FileComparison[];
  modifications: ModificationDetail[];
  issueResolutions: IssueResolution[];
  beforeAudit: AuditSummary;
  afterAudit: AuditSummary;
  generatedAt: Date;
}

interface ModificationDetail {
  type: string;
  category: 'metadata' | 'content' | 'structure' | 'accessibility';
  description: string;
  filePath: string;
  before?: string;
  after?: string;
  wcagCriteria?: string;
}

interface IssueResolution {
  code: string;
  severity: string;
  message: string;
  location: string;
  originalStatus: 'pending' | 'failed';
  finalStatus: 'fixed' | 'pending' | 'failed';
  resolutionType: 'auto-fixed' | 'manual' | 'failed' | 'skipped';
}

interface AuditSummary {
  totalIssues: number;
  bySeverity: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  byType: {
    auto: number;
    manual: number;
  };
}

interface AuditIssue {
  code: string;
  severity: string;
  message: string;
  location?: string;
}

class EPUBComparisonService {
  async compareEPUBs(
    originalBuffer: Buffer,
    remediatedBuffer: Buffer,
    jobId: string,
    originalFileName: string,
    beforeIssues?: AuditIssue[],
    afterIssues?: AuditIssue[]
  ): Promise<EPUBComparisonResult> {
    const originalZip = await JSZip.loadAsync(originalBuffer);
    const remediatedZip = await JSZip.loadAsync(remediatedBuffer);

    const files: FileComparison[] = [];
    const modifications: ModificationDetail[] = [];

    const originalFiles = new Set(Object.keys(originalZip.files).filter(f => !originalZip.files[f].dir));
    const remediatedFiles = new Set(Object.keys(remediatedZip.files).filter(f => !remediatedZip.files[f].dir));

    const allFiles = new Set([...originalFiles, ...remediatedFiles]);

    for (const filePath of allFiles) {
      const inOriginal = originalFiles.has(filePath);
      const inRemediated = remediatedFiles.has(filePath);

      if (!inOriginal && inRemediated) {
        files.push({
          filePath,
          fileType: this.getFileType(filePath),
          status: 'added',
          changeCount: 1,
        });
      } else if (inOriginal && !inRemediated) {
        files.push({
          filePath,
          fileType: this.getFileType(filePath),
          status: 'removed',
          changeCount: 1,
        });
      } else {
        const originalContent = await originalZip.file(filePath)?.async('text') || '';
        const remediatedContent = await remediatedZip.file(filePath)?.async('text') || '';

        if (originalContent === remediatedContent) {
          files.push({
            filePath,
            fileType: this.getFileType(filePath),
            status: 'unchanged',
            changeCount: 0,
          });
        } else {
          const comparison = this.compareFileContents(
            originalContent,
            remediatedContent,
            filePath
          );
          files.push(comparison.fileComparison);
          modifications.push(...comparison.modifications);
        }
      }
    }

    const summary = this.buildSummary(files, modifications);
    
    const issueResolutions = this.buildIssueResolutions(
      beforeIssues || [],
      afterIssues || [],
      modifications
    );
    
    const beforeAudit = this.buildAuditSummary(beforeIssues || []);
    const afterAudit = this.buildAuditSummary(afterIssues || []);

    logger.info(`EPUB comparison complete for ${jobId}: ${summary.modifiedFiles} modified, ${modifications.length} changes`);

    return {
      jobId,
      originalFileName,
      remediatedFileName: originalFileName.replace(/\.epub$/i, '_remediated.epub'),
      summary,
      files,
      modifications,
      issueResolutions,
      beforeAudit,
      afterAudit,
      generatedAt: new Date(),
    };
  }

  private buildIssueResolutions(
    beforeIssues: AuditIssue[],
    afterIssues: AuditIssue[],
    modifications: ModificationDetail[]
  ): IssueResolution[] {
    const afterIssueKeys = new Set(
      afterIssues.map(i => `${i.code}:${i.location || ''}`)
    );

    const modificationCodes = new Set(
      modifications.map(m => m.type.toUpperCase())
    );

    const autoFixableCodes = new Set([
      'EPUB-META-001', 'EPUB-META-002', 'EPUB-META-003', 'EPUB-META-004',
      'EPUB-SEM-001', 'EPUB-SEM-002', 'EPUB-IMG-001', 'EPUB-STRUCT-002',
      'EPUB-STRUCT-003', 'EPUB-STRUCT-004', 'EPUB-NAV-001', 'EPUB-FIG-001',
    ]);

    return beforeIssues.map(issue => {
      const issueKey = `${issue.code}:${issue.location || ''}`;
      const stillExists = afterIssueKeys.has(issueKey);
      const wasModified = modificationCodes.has(issue.code);
      const isAutoFixable = autoFixableCodes.has(issue.code);

      let finalStatus: 'fixed' | 'pending' | 'failed';
      let resolutionType: 'auto-fixed' | 'manual' | 'failed' | 'skipped';

      if (!stillExists) {
        finalStatus = 'fixed';
        resolutionType = isAutoFixable ? 'auto-fixed' : 'manual';
      } else if (wasModified) {
        finalStatus = 'failed';
        resolutionType = 'failed';
      } else {
        finalStatus = 'pending';
        resolutionType = 'skipped';
      }

      return {
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        location: issue.location || '',
        originalStatus: 'pending' as const,
        finalStatus,
        resolutionType,
      };
    });
  }

  private buildAuditSummary(issues: AuditIssue[]): AuditSummary {
    const bySeverity = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };

    const autoFixableCodes = new Set([
      'EPUB-META-001', 'EPUB-META-002', 'EPUB-META-003', 'EPUB-META-004',
      'EPUB-SEM-001', 'EPUB-SEM-002', 'EPUB-IMG-001', 'EPUB-STRUCT-002',
      'EPUB-STRUCT-003', 'EPUB-STRUCT-004', 'EPUB-NAV-001', 'EPUB-FIG-001',
    ]);

    let autoCount = 0;
    let manualCount = 0;

    for (const issue of issues) {
      const severity = issue.severity.toLowerCase() as keyof typeof bySeverity;
      if (severity in bySeverity) {
        bySeverity[severity]++;
      }

      if (autoFixableCodes.has(issue.code)) {
        autoCount++;
      } else {
        manualCount++;
      }
    }

    return {
      totalIssues: issues.length,
      bySeverity,
      byType: {
        auto: autoCount,
        manual: manualCount,
      },
    };
  }

  private compareFileContents(
    original: string,
    remediated: string,
    filePath: string
  ): { fileComparison: FileComparison; modifications: ModificationDetail[] } {
    const modifications: ModificationDetail[] = [];
    const fileType = this.getFileType(filePath);

    const diff = diffLines(original, remediated);
    const diffResults: DiffResult[] = [];
    let changeCount = 0;

    for (const part of diff) {
      if (part.added) {
        diffResults.push({ type: 'added', value: part.value });
        changeCount++;
      } else if (part.removed) {
        diffResults.push({ type: 'removed', value: part.value });
        changeCount++;
      } else {
        if (part.value.length > 100) {
          diffResults.push({ 
            type: 'unchanged', 
            value: part.value.substring(0, 50) + '\n...[unchanged]...\n' + part.value.substring(part.value.length - 50)
          });
        } else {
          diffResults.push({ type: 'unchanged', value: part.value });
        }
      }
    }

    if (fileType === 'opf') {
      modifications.push(...this.identifyOPFChanges(original, remediated, filePath));
    } else if (fileType === 'html') {
      modifications.push(...this.identifyHTMLChanges(original, remediated, filePath));
    }

    return {
      fileComparison: {
        filePath,
        fileType,
        status: 'modified',
        changeCount,
        diff: diffResults,
        beforeSnippet: original.substring(0, 200),
        afterSnippet: remediated.substring(0, 200),
      },
      modifications,
    };
  }

  private identifyOPFChanges(original: string, remediated: string, filePath: string): ModificationDetail[] {
    const modifications: ModificationDetail[] = [];

    if (!/<dc:language/i.test(original) && /<dc:language/i.test(remediated)) {
      const match = remediated.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/i);
      modifications.push({
        type: 'add_language',
        category: 'metadata',
        description: 'Added document language declaration',
        filePath,
        after: match ? match[0] : '<dc:language>en</dc:language>',
        wcagCriteria: '3.1.1',
      });
    }

    if (!/schema:accessibilityFeature/i.test(original) && /schema:accessibilityFeature/i.test(remediated)) {
      modifications.push({
        type: 'add_accessibility_metadata',
        category: 'accessibility',
        description: 'Added accessibility feature metadata',
        filePath,
        wcagCriteria: 'EPUB Accessibility 1.0',
      });
    }

    if (!/schema:accessibilitySummary/i.test(original) && /schema:accessibilitySummary/i.test(remediated)) {
      const match = remediated.match(/<meta[^>]+schema:accessibilitySummary[^>]*>([^<]+)</i);
      modifications.push({
        type: 'add_accessibility_summary',
        category: 'accessibility',
        description: 'Added accessibility summary',
        filePath,
        after: match ? match[1] : 'Accessibility summary added',
      });
    }

    if (!/schema:accessMode/i.test(original) && /schema:accessMode/i.test(remediated)) {
      modifications.push({
        type: 'add_access_modes',
        category: 'accessibility',
        description: 'Added access mode metadata',
        filePath,
      });
    }

    return modifications;
  }

  private identifyHTMLChanges(original: string, remediated: string, filePath: string): ModificationDetail[] {
    const modifications: ModificationDetail[] = [];
    const $original = cheerio.load(original, { xmlMode: true });
    const $remediated = cheerio.load(remediated, { xmlMode: true });

    const originalLang = $original('html').attr('lang');
    const remediatedLang = $remediated('html').attr('lang');
    if (!originalLang && remediatedLang) {
      modifications.push({
        type: 'add_html_lang',
        category: 'accessibility',
        description: `Added lang="${remediatedLang}" to HTML element`,
        filePath,
        before: '<html>',
        after: `<html lang="${remediatedLang}">`,
        wcagCriteria: '3.1.1',
      });
    }

    const originalImgsWithoutAlt = $original('img:not([alt])').length;
    const remediatedImgsWithoutAlt = $remediated('img:not([alt])').length;
    if (originalImgsWithoutAlt > remediatedImgsWithoutAlt) {
      const fixed = originalImgsWithoutAlt - remediatedImgsWithoutAlt;
      modifications.push({
        type: 'add_alt_text',
        category: 'accessibility',
        description: `Added alt attributes to ${fixed} image(s)`,
        filePath,
        wcagCriteria: '1.1.1',
      });
    }

    const originalLandmarks = $original('[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"]').length;
    const remediatedLandmarks = $remediated('[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"]').length;
    if (remediatedLandmarks > originalLandmarks) {
      const added = remediatedLandmarks - originalLandmarks;
      modifications.push({
        type: 'add_aria_landmarks',
        category: 'structure',
        description: `Added ${added} ARIA landmark(s)`,
        filePath,
        wcagCriteria: '1.3.1',
      });
    }

    if (!$original('.skip-link, a[href="#main"], a[href="#content"]').length &&
        $remediated('.skip-link, a[href="#main"], a[href="#content"]').length) {
      modifications.push({
        type: 'add_skip_navigation',
        category: 'accessibility',
        description: 'Added skip navigation link',
        filePath,
        wcagCriteria: '2.4.1',
      });
    }

    const originalTablesWithoutHeaders = $original('table').filter((_, t) => 
      $original(t).find('th').length === 0
    ).length;
    const remediatedTablesWithoutHeaders = $remediated('table').filter((_, t) => 
      $remediated(t).find('th').length === 0
    ).length;
    if (originalTablesWithoutHeaders > remediatedTablesWithoutHeaders) {
      const fixed = originalTablesWithoutHeaders - remediatedTablesWithoutHeaders;
      modifications.push({
        type: 'add_table_headers',
        category: 'structure',
        description: `Added headers to ${fixed} table(s)`,
        filePath,
        wcagCriteria: '1.3.1',
      });
    }

    const originalFigures = $original('figure').length;
    const remediatedFigures = $remediated('figure').length;
    if (remediatedFigures > originalFigures) {
      const added = remediatedFigures - originalFigures;
      modifications.push({
        type: 'add_figure_structure',
        category: 'structure',
        description: `Wrapped ${added} image(s) with figure/figcaption`,
        filePath,
        wcagCriteria: '1.3.1',
      });
    }

    const originalEmptyLinks = $original('a').filter((_, a) => {
      const $a = $original(a);
      return !$a.text().trim() && !$a.find('img[alt]').length && !$a.attr('aria-label');
    }).length;
    const remediatedEmptyLinks = $remediated('a').filter((_, a) => {
      const $a = $remediated(a);
      return !$a.text().trim() && !$a.find('img[alt]').length && !$a.attr('aria-label');
    }).length;
    if (originalEmptyLinks > remediatedEmptyLinks) {
      const fixed = originalEmptyLinks - remediatedEmptyLinks;
      modifications.push({
        type: 'fix_empty_links',
        category: 'accessibility',
        description: `Fixed ${fixed} empty link(s) with aria-label`,
        filePath,
        wcagCriteria: '2.4.4',
      });
    }

    return modifications;
  }

  private getFileType(filePath: string): 'opf' | 'html' | 'css' | 'other' {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (ext === 'opf') return 'opf';
    if (['html', 'xhtml', 'htm'].includes(ext)) return 'html';
    if (ext === 'css') return 'css';
    return 'other';
  }

  private buildSummary(files: FileComparison[], modifications: ModificationDetail[]): ComparisonSummary {
    const changesByType = {
      metadata: 0,
      content: 0,
      structure: 0,
      accessibility: 0,
    };

    for (const mod of modifications) {
      changesByType[mod.category]++;
    }

    return {
      totalFiles: files.length,
      modifiedFiles: files.filter(f => f.status === 'modified').length,
      addedFiles: files.filter(f => f.status === 'added').length,
      removedFiles: files.filter(f => f.status === 'removed').length,
      unchangedFiles: files.filter(f => f.status === 'unchanged').length,
      totalChanges: modifications.length,
      changesByType,
    };
  }

  async getModificationsByCategory(
    originalBuffer: Buffer,
    remediatedBuffer: Buffer,
    jobId: string,
    originalFileName: string,
    category?: 'metadata' | 'content' | 'structure' | 'accessibility'
  ): Promise<ModificationDetail[]> {
    const result = await this.compareEPUBs(originalBuffer, remediatedBuffer, jobId, originalFileName);
    
    if (category) {
      return result.modifications.filter(m => m.category === category);
    }
    
    return result.modifications;
  }

  generateComparisonMarkdown(comparison: EPUBComparisonResult): string {
    const { summary, beforeAudit, afterAudit, issueResolutions, modifications } = comparison;

    let md = `# EPUB Comparison Report\n\n`;
    md += `**Original:** ${comparison.originalFileName}\n`;
    md += `**Remediated:** ${comparison.remediatedFileName}\n`;
    md += `**Generated:** ${comparison.generatedAt.toISOString()}\n\n`;

    md += `## File Changes Summary\n\n`;
    md += `| Metric | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Files | ${summary.totalFiles} |\n`;
    md += `| Modified Files | ${summary.modifiedFiles} |\n`;
    md += `| Added Files | ${summary.addedFiles} |\n`;
    md += `| Removed Files | ${summary.removedFiles} |\n`;
    md += `| Total Changes | ${summary.totalChanges} |\n\n`;

    md += `### Changes by Category\n\n`;
    md += `| Category | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| Metadata | ${summary.changesByType.metadata} |\n`;
    md += `| Content | ${summary.changesByType.content} |\n`;
    md += `| Structure | ${summary.changesByType.structure} |\n`;
    md += `| Accessibility | ${summary.changesByType.accessibility} |\n\n`;

    md += `## Audit Comparison\n\n`;
    md += `### Before Remediation\n\n`;
    md += `| Metric | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Issues | ${beforeAudit.totalIssues} |\n`;
    md += `| Critical | ${beforeAudit.bySeverity.critical} |\n`;
    md += `| Serious | ${beforeAudit.bySeverity.serious} |\n`;
    md += `| Moderate | ${beforeAudit.bySeverity.moderate} |\n`;
    md += `| Minor | ${beforeAudit.bySeverity.minor} |\n`;
    md += `| Auto-fixable | ${beforeAudit.byType.auto} |\n`;
    md += `| Manual | ${beforeAudit.byType.manual} |\n\n`;

    md += `### After Remediation\n\n`;
    md += `| Metric | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Issues | ${afterAudit.totalIssues} |\n`;
    md += `| Critical | ${afterAudit.bySeverity.critical} |\n`;
    md += `| Serious | ${afterAudit.bySeverity.serious} |\n`;
    md += `| Moderate | ${afterAudit.bySeverity.moderate} |\n`;
    md += `| Minor | ${afterAudit.bySeverity.minor} |\n`;
    md += `| Auto-fixable | ${afterAudit.byType.auto} |\n`;
    md += `| Manual | ${afterAudit.byType.manual} |\n\n`;

    const fixedCount = issueResolutions.filter(r => r.finalStatus === 'fixed').length;
    const pendingCount = issueResolutions.filter(r => r.finalStatus === 'pending').length;
    const failedCount = issueResolutions.filter(r => r.finalStatus === 'failed').length;

    md += `### Resolution Summary\n\n`;
    md += `| Status | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Fixed | ${fixedCount} |\n`;
    md += `| Pending | ${pendingCount} |\n`;
    md += `| Failed | ${failedCount} |\n\n`;

    if (issueResolutions.length > 0) {
      md += `## Issue Resolutions\n\n`;
      md += `| Code | Severity | Original | Final | Type | Message |\n`;
      md += `|------|----------|----------|-------|------|--------|\n`;
      for (const res of issueResolutions) {
        const statusIcon = res.finalStatus === 'fixed' ? '✅' : res.finalStatus === 'failed' ? '❌' : '⏳';
        md += `| ${res.code} | ${res.severity} | ${res.originalStatus} | ${statusIcon} ${res.finalStatus} | ${res.resolutionType} | ${res.message.substring(0, 50)}${res.message.length > 50 ? '...' : ''} |\n`;
      }
      md += '\n';
    }

    if (modifications.length > 0) {
      md += `## Modifications Applied\n\n`;
      for (const mod of modifications) {
        md += `### ${mod.type}\n`;
        md += `- **Category:** ${mod.category}\n`;
        md += `- **Description:** ${mod.description}\n`;
        if (mod.wcagCriteria) {
          md += `- **WCAG Criterion:** ${mod.wcagCriteria}\n`;
        }
        md += `- **File:** ${mod.filePath}\n`;
        if (mod.before) {
          md += `- **Before:** \`${mod.before}\`\n`;
        }
        if (mod.after) {
          md += `- **After:** \`${mod.after}\`\n`;
        }
        md += '\n';
      }
    }

    return md;
  }
}

export const epubComparisonService = new EPUBComparisonService();
