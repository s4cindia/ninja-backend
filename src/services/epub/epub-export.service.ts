import JSZip from 'jszip';
import { fileStorageService } from '../storage/file-storage.service';
import { epubComparisonService } from './epub-comparison.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { AUTO_FIXABLE_ISSUE_CODES } from '../../constants/auto-fix-codes';

interface ExportOptions {
  includeOriginal?: boolean;
  includeComparison?: boolean;
  includeReport?: boolean;
  format?: 'epub' | 'zip';
}

interface ExportResult {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  size: number;
  contents?: string[];
}

interface IssueDetail {
  code: string;
  severity: string;
  message: string;
  location: string;
  filePath?: string;
  wcagCriteria: string[];
  source: string;
  type: 'auto' | 'manual';
  status: 'pending' | 'fixed' | 'failed';
}

interface IssueResolution {
  code: string;
  location: string;
  originalStatus: 'pending';
  finalStatus: 'fixed' | 'pending' | 'failed';
  resolutionType: 'auto-remediated' | 'manual' | 'not-fixed';
}

interface AccessibilityReport {
  jobId: string;
  fileName: string;
  generatedAt: Date;
  originalIssues: number;
  fixedIssues: number;
  remainingIssues: number;
  fixRate: number;
  issues: IssueDetail[];
  modifications: {
    type: string;
    category: string;
    description: string;
    wcagCriteria?: string;
    filePath?: string;
  }[];
  wcagCompliance: {
    criterion: string;
    name: string;
    status: 'pass' | 'partial' | 'fail';
    issueCount: number;
    fixedCount: number;
    notes?: string;
  }[];
  issueResolutions: IssueResolution[];
}

class EPUBExportService {
  async exportRemediated(
    jobId: string,
    tenantId: string,
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });

    if (!job) {
      throw new Error('Job not found');
    }

    const fileName = (job.input as { fileName?: string })?.fileName || 'document.epub';
    const baseName = fileName.replace(/\.epub$/i, '');
    const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

    const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
    if (!remediatedBuffer) {
      throw new Error('Remediated EPUB not found. Run auto-remediation first.');
    }

    if (!options.includeOriginal && !options.includeComparison && !options.includeReport) {
      return {
        fileName: `${baseName}_remediated.epub`,
        mimeType: 'application/epub+zip',
        buffer: remediatedBuffer,
        size: remediatedBuffer.length,
      };
    }

    const zip = new JSZip();
    const contents: string[] = [];

    zip.file(`${baseName}_remediated.epub`, remediatedBuffer);
    contents.push(`${baseName}_remediated.epub`);

    if (options.includeOriginal) {
      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      if (originalBuffer) {
        zip.file(`${baseName}_original.epub`, originalBuffer);
        contents.push(`${baseName}_original.epub`);
      }
    }

    if (options.includeComparison) {
      const originalBuffer = await fileStorageService.getFile(jobId, fileName);
      if (originalBuffer) {
        try {
          const comparison = await epubComparisonService.compareEPUBs(
            originalBuffer,
            remediatedBuffer,
            jobId,
            fileName
          );
          
          const comparisonJson = JSON.stringify(comparison, null, 2);
          zip.file(`${baseName}_comparison.json`, comparisonJson);
          contents.push(`${baseName}_comparison.json`);

          const comparisonMd = this.generateComparisonMarkdown(comparison as unknown as Record<string, unknown>);
          zip.file(`${baseName}_comparison.md`, comparisonMd);
          contents.push(`${baseName}_comparison.md`);
        } catch (error) {
          logger.warn(`Failed to generate comparison for export: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    if (options.includeReport) {
      try {
        const report = await this.generateAccessibilityReport(jobId, tenantId);
        
        const reportJson = JSON.stringify(report, null, 2);
        zip.file(`${baseName}_accessibility_report.json`, reportJson);
        contents.push(`${baseName}_accessibility_report.json`);

        const reportMd = this.generateReportMarkdown(report);
        zip.file(`${baseName}_accessibility_report.md`, reportMd);
        contents.push(`${baseName}_accessibility_report.md`);
      } catch (error) {
        logger.warn(`Failed to generate report for export: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const readme = this.generateReadme(baseName, contents, options);
    zip.file('README.md', readme);
    contents.push('README.md');

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    return {
      fileName: `${baseName}_remediated_package.zip`,
      mimeType: 'application/zip',
      buffer: zipBuffer,
      size: zipBuffer.length,
      contents,
    };
  }

  async exportBatch(
    jobIds: string[],
    tenantId: string,
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    const zip = new JSZip();
    const contents: string[] = [];
    const errors: string[] = [];

    for (const jobId of jobIds) {
      try {
        const job = await prisma.job.findFirst({
          where: { id: jobId, tenantId },
        });

        if (!job) {
          errors.push(`Job ${jobId}: Not found`);
          continue;
        }

        const fileName = (job.input as { fileName?: string })?.fileName || 'document.epub';
        const baseName = fileName.replace(/\.epub$/i, '');
        const remediatedFileName = fileName.replace(/\.epub$/i, '_remediated.epub');

        const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, remediatedFileName);
        if (!remediatedBuffer) {
          errors.push(`Job ${jobId}: Remediated file not found`);
          continue;
        }

        const folder = zip.folder(baseName);
        if (folder) {
          folder.file(`${baseName}_remediated.epub`, remediatedBuffer);
          contents.push(`${baseName}/${baseName}_remediated.epub`);

          const originalBuffer = options.includeOriginal || options.includeComparison
            ? await fileStorageService.getFile(jobId, fileName)
            : null;

          if (options.includeOriginal && originalBuffer) {
            folder.file(`${baseName}_original.epub`, originalBuffer);
            contents.push(`${baseName}/${baseName}_original.epub`);
          }

          if (options.includeComparison && originalBuffer) {
            try {
              const comparison = await epubComparisonService.compareEPUBs(
                originalBuffer,
                remediatedBuffer,
                jobId,
                fileName
              );
              folder.file(`${baseName}_comparison.json`, JSON.stringify(comparison, null, 2));
              contents.push(`${baseName}/${baseName}_comparison.json`);
              
              const comparisonMd = this.generateComparisonMarkdown(comparison as unknown as Record<string, unknown>);
              folder.file(`${baseName}_comparison.md`, comparisonMd);
              contents.push(`${baseName}/${baseName}_comparison.md`);
            } catch {
              // Skip comparison if generation fails
            }
          }

          if (options.includeReport) {
            try {
              const report = await this.generateAccessibilityReport(jobId, tenantId);
              folder.file(`${baseName}_report.json`, JSON.stringify(report, null, 2));
              contents.push(`${baseName}/${baseName}_report.json`);
              
              const reportMd = this.generateReportMarkdown(report);
              folder.file(`${baseName}_report.md`, reportMd);
              contents.push(`${baseName}/${baseName}_report.md`);
            } catch {
              // Skip report if generation fails
            }
          }

          const folderContents = contents.filter(c => c.startsWith(`${baseName}/`)).map(c => c.replace(`${baseName}/`, ''));
          const folderReadme = this.generateReadme(baseName, folderContents, options);
          folder.file('README.md', folderReadme);
          contents.push(`${baseName}/README.md`);
        }
      } catch (error) {
        errors.push(`Job ${jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const batchReadme = this.generateBatchReadme(jobIds.length, errors.length, contents, options);
    zip.file('README.md', batchReadme);
    contents.push('README.md');

    const manifest = {
      exportedAt: new Date().toISOString(),
      totalJobs: jobIds.length,
      successfulJobs: jobIds.length - errors.length,
      failedJobs: errors.length,
      contents,
      errors: errors.length > 0 ? errors : undefined,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    return {
      fileName: `batch_export_${Date.now()}.zip`,
      mimeType: 'application/zip',
      buffer: zipBuffer,
      size: zipBuffer.length,
      contents,
    };
  }

  async generateAccessibilityReport(
    jobId: string,
    tenantId: string
  ): Promise<AccessibilityReport> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });

    if (!job) {
      throw new Error('Job not found');
    }

    const output = job.output as Record<string, unknown> || {};
    const auditResult = output.combinedIssues as Array<Record<string, unknown>> || [];
    const autoRemediation = output.autoRemediation as Record<string, unknown> || {};

    const fileName = (job.input as { fileName?: string })?.fileName || 'document.epub';
    
    const planJob = await prisma.job.findFirst({
      where: {
        type: 'BATCH_VALIDATION',
        input: {
          path: ['sourceJobId'],
          equals: jobId,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    const planOutput = planJob?.output as Record<string, unknown> | null;
    const remediationTasks = (planOutput?.tasks as Array<Record<string, unknown>>) || [];
    
    const completedTasksByCode = new Map<string, Set<string>>();
    const completedCodes = new Set<string>();
    
    for (const task of remediationTasks) {
      if (task.status === 'completed') {
        const issueCode = String(task.issueCode || '');
        completedCodes.add(issueCode);
        if (!completedTasksByCode.has(issueCode)) {
          completedTasksByCode.set(issueCode, new Set());
        }
        completedTasksByCode.get(issueCode)!.add(String(task.location || ''));
      }
    }

    const modifications = (autoRemediation.modifications as Array<Record<string, unknown>> || [])
      .filter((m: Record<string, unknown>) => m.success)
      .map((m: Record<string, unknown>) => {
        const code = String(m.issueCode || '');
        return {
          type: code,
          category: this.getCategory(code),
          description: String(m.description || ''),
          wcagCriteria: this.getWcagCriteria(code),
          filePath: String(m.location || m.filePath || ''),
        };
      });

    const issues: IssueDetail[] = auditResult.map((issue: Record<string, unknown>) => {
      const code = String(issue.code || '');
      const location = String(issue.location || '');
      const isAutoFixable = this.isAutoFixable(code);
      
      const isFixed = completedTasksByCode.has(code) && 
        completedTasksByCode.get(code)!.has(location);
      
      let wcagCriteria: string[] = [];
      if (Array.isArray(issue.wcagCriteria)) {
        wcagCriteria = issue.wcagCriteria.map(String);
      } else if (typeof issue.wcagCriteria === 'string') {
        wcagCriteria = [issue.wcagCriteria];
      } else {
        const mapped = this.getWcagCriteria(code);
        if (mapped) wcagCriteria = [mapped];
      }

      return {
        code,
        severity: String(issue.severity || 'moderate'),
        message: String(issue.message || 'Accessibility issue detected'),
        location,
        filePath: String(issue.filePath || issue.location || ''),
        wcagCriteria,
        source: String(issue.source || 'unknown'),
        type: isAutoFixable ? 'auto' as const : 'manual' as const,
        status: isFixed ? 'fixed' as const : 'pending' as const,
      };
    });

    const issueResolutions: IssueResolution[] = issues.map(issue => ({
      code: issue.code,
      location: issue.location,
      originalStatus: 'pending' as const,
      finalStatus: issue.status === 'fixed' ? 'fixed' as const : 'pending' as const,
      resolutionType: issue.status === 'fixed' 
        ? 'auto-remediated' as const 
        : 'not-fixed' as const,
    }));

    const originalIssues = auditResult.length;
    const fixedIssues = issues.filter(i => i.status === 'fixed').length;
    const remainingIssues = originalIssues - fixedIssues;

    return {
      jobId,
      fileName,
      generatedAt: new Date(),
      originalIssues,
      fixedIssues,
      remainingIssues: Math.max(0, remainingIssues),
      fixRate: originalIssues > 0 ? Math.round((fixedIssues / originalIssues) * 100) : 100,
      issues,
      modifications,
      wcagCompliance: this.assessWcagCompliance(issues),
      issueResolutions,
    };
  }

  private isAutoFixable(code: string): boolean {
    return AUTO_FIXABLE_ISSUE_CODES.has(code);
  }

  private getCategory(code: string): string {
    if (code.startsWith('EPUB-META')) return 'metadata';
    if (code.startsWith('EPUB-IMG')) return 'images';
    if (code.startsWith('EPUB-STRUCT')) return 'structure';
    if (code.startsWith('EPUB-SEM')) return 'semantics';
    if (code.startsWith('EPUB-NAV')) return 'navigation';
    if (code.startsWith('EPUB-FIG')) return 'figures';
    return 'other';
  }

  private getWcagCriteria(code: string): string | undefined {
    const wcagMap: Record<string, string> = {
      'EPUB-META-001': '3.1.1',
      'EPUB-META-002': 'EPUB Accessibility 1.0',
      'EPUB-META-003': 'EPUB Accessibility 1.0',
      'EPUB-META-004': 'EPUB Accessibility 1.0',
      'EPUB-SEM-001': '3.1.1',
      'EPUB-SEM-002': '2.4.4',
      'EPUB-IMG-001': '1.1.1',
      'EPUB-STRUCT-002': '1.3.1',
      'EPUB-STRUCT-003': '1.3.1',
      'EPUB-STRUCT-004': '1.3.1',
      'EPUB-NAV-001': '2.4.1',
      'EPUB-FIG-001': '1.3.1',
    };
    return wcagMap[code];
  }

  private assessWcagCompliance(
    issues: IssueDetail[]
  ): AccessibilityReport['wcagCompliance'] {
    const wcagNames: Record<string, string> = {
      '1.1.1': 'Non-text Content',
      '1.3.1': 'Info and Relationships',
      '1.3.6': 'Identify Purpose',
      '2.4.1': 'Bypass Blocks',
      '2.4.4': 'Link Purpose (In Context)',
      '2.4.6': 'Headings and Labels',
      '3.1.1': 'Language of Page',
      '3.1.2': 'Language of Parts',
      '4.1.1': 'Parsing',
      '4.1.2': 'Name, Role, Value',
    };

    const criteriaStats = new Map<string, { total: number; fixed: number }>();

    for (const issue of issues) {
      for (const criterion of issue.wcagCriteria) {
        if (!criteriaStats.has(criterion)) {
          criteriaStats.set(criterion, { total: 0, fixed: 0 });
        }
        const stats = criteriaStats.get(criterion)!;
        stats.total++;
        if (issue.status === 'fixed') {
          stats.fixed++;
        }
      }
    }

    const compliance: AccessibilityReport['wcagCompliance'] = [];

    for (const [criterion, stats] of criteriaStats) {
      let status: 'pass' | 'partial' | 'fail';
      if (stats.fixed === stats.total) {
        status = 'pass';
      } else if (stats.fixed > 0) {
        status = 'partial';
      } else {
        status = 'fail';
      }

      compliance.push({
        criterion,
        name: wcagNames[criterion] || `WCAG ${criterion}`,
        status,
        issueCount: stats.total,
        fixedCount: stats.fixed,
        notes: `${stats.fixed}/${stats.total} issues resolved`,
      });
    }

    compliance.sort((a, b) => a.criterion.localeCompare(b.criterion));

    return compliance;
  }

  private generateComparisonMarkdown(comparison: Record<string, unknown>): string {
    const summary = comparison.summary as Record<string, unknown> || {};
    const modifications = comparison.modifications as Array<Record<string, unknown>> || [];

    let md = `# EPUB Comparison Report\n\n`;
    md += `**Original:** ${comparison.originalFileName}\n`;
    md += `**Remediated:** ${comparison.remediatedFileName}\n`;
    md += `**Generated:** ${new Date().toISOString()}\n\n`;

    md += `## Summary\n\n`;
    md += `| Metric | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Files | ${summary.totalFiles || 0} |\n`;
    md += `| Modified Files | ${summary.modifiedFiles || 0} |\n`;
    md += `| Added Files | ${summary.addedFiles || 0} |\n`;
    md += `| Removed Files | ${summary.removedFiles || 0} |\n`;
    md += `| Total Changes | ${summary.totalChanges || 0} |\n\n`;

    if (modifications.length > 0) {
      md += `## Modifications\n\n`;
      for (const mod of modifications) {
        md += `### ${mod.type}\n`;
        md += `- **Category:** ${mod.category}\n`;
        md += `- **Description:** ${mod.description}\n`;
        if (mod.wcagCriteria) {
          md += `- **WCAG Criterion:** ${mod.wcagCriteria}\n`;
        }
        md += `- **File:** ${mod.filePath}\n\n`;
      }
    }

    return md;
  }

  generateReportMarkdown(report: AccessibilityReport): string {
    let md = `# Accessibility Report\n\n`;
    md += `**File:** ${report.fileName}\n`;
    md += `**Job ID:** ${report.jobId}\n`;
    md += `**Generated:** ${report.generatedAt.toISOString()}\n\n`;

    md += `## Summary\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Original Issues | ${report.originalIssues} |\n`;
    md += `| Fixed Issues | ${report.fixedIssues} |\n`;
    md += `| Remaining Issues | ${report.remainingIssues} |\n`;
    md += `| Fix Rate | ${report.fixRate}% |\n\n`;

    md += `## WCAG Compliance\n\n`;
    if (report.wcagCompliance.length > 0) {
      md += `| Criterion | Name | Status | Issues | Fixed |\n`;
      md += `|-----------|------|--------|--------|-------|\n`;
      for (const c of report.wcagCompliance) {
        const statusIcon = c.status === 'pass' ? '✅' : c.status === 'partial' ? '⚠️' : '❌';
        md += `| ${c.criterion} | ${c.name} | ${statusIcon} ${c.status} | ${c.issueCount} | ${c.fixedCount} |\n`;
      }
    } else {
      md += `No WCAG criteria issues found.\n`;
    }
    md += '\n';

    if (report.issues.length > 0) {
      md += `## All Issues (${report.issues.length})\n\n`;
      md += `| Code | Severity | Status | Type | Location | WCAG |\n`;
      md += `|------|----------|--------|------|----------|------|\n`;
      for (const issue of report.issues) {
        const statusIcon = issue.status === 'fixed' ? '✅' : '❌';
        const wcag = issue.wcagCriteria.join(', ') || '-';
        md += `| ${issue.code} | ${issue.severity} | ${statusIcon} ${issue.status} | ${issue.type} | ${issue.location} | ${wcag} |\n`;
      }
      md += '\n';

      md += `### Issue Details\n\n`;
      for (const issue of report.issues) {
        const statusIcon = issue.status === 'fixed' ? '✅' : '❌';
        md += `#### ${statusIcon} ${issue.code}\n`;
        md += `- **Message:** ${issue.message}\n`;
        md += `- **Severity:** ${issue.severity}\n`;
        md += `- **Location:** ${issue.location}\n`;
        md += `- **Source:** ${issue.source}\n`;
        md += `- **Type:** ${issue.type === 'auto' ? 'Auto-fixable' : 'Manual fix required'}\n`;
        md += `- **Status:** ${issue.status}\n`;
        if (issue.wcagCriteria.length > 0) {
          md += `- **WCAG Criteria:** ${issue.wcagCriteria.join(', ')}\n`;
        }
        md += '\n';
      }
    }

    if (report.modifications.length > 0) {
      md += `## Applied Fixes (${report.modifications.length})\n\n`;
      for (const mod of report.modifications) {
        md += `- **${mod.type}** (${mod.category}): ${mod.description}`;
        if (mod.wcagCriteria) {
          md += ` [WCAG ${mod.wcagCriteria}]`;
        }
        if (mod.filePath) {
          md += ` - ${mod.filePath}`;
        }
        md += '\n';
      }
      md += '\n';
    }

    if (report.issueResolutions.length > 0) {
      md += `## Issue Resolutions\n\n`;
      md += `| Code | Location | Original | Final | Resolution Type |\n`;
      md += `|------|----------|----------|-------|----------------|\n`;
      for (const res of report.issueResolutions) {
        md += `| ${res.code} | ${res.location} | ${res.originalStatus} | ${res.finalStatus} | ${res.resolutionType} |\n`;
      }
    }

    return md;
  }

  private generateReadme(baseName: string, contents: string[], options: ExportOptions): string {
    let readme = `# ${baseName} - Remediated EPUB Package\n\n`;
    readme += `This package contains the accessibility-remediated version of your EPUB file.\n\n`;
    readme += `## Contents\n\n`;
    
    for (const file of contents) {
      if (file === 'README.md') continue;
      readme += `- \`${file}\`\n`;
    }
    readme += '\n';

    readme += `## Export Options Used\n\n`;
    readme += `- Include Original: ${options.includeOriginal ? 'Yes' : 'No'}\n`;
    readme += `- Include Comparison: ${options.includeComparison ? 'Yes' : 'No'}\n`;
    readme += `- Include Report: ${options.includeReport ? 'Yes' : 'No'}\n\n`;

    readme += `## Generated\n\n`;
    readme += `${new Date().toISOString()}\n\n`;
    readme += `*Generated by Ninja Accessibility Platform*\n`;

    return readme;
  }

  private generateBatchReadme(totalJobs: number, errorCount: number, contents: string[], options: ExportOptions): string {
    let readme = `# Batch Export - Remediated EPUB Package\n\n`;
    readme += `This package contains accessibility-remediated EPUBs from a batch export.\n\n`;

    readme += `## Summary\n\n`;
    readme += `| Metric | Value |\n`;
    readme += `|--------|-------|\n`;
    readme += `| Total Jobs | ${totalJobs} |\n`;
    readme += `| Successful | ${totalJobs - errorCount} |\n`;
    readme += `| Failed | ${errorCount} |\n\n`;

    readme += `## Export Options Used\n\n`;
    readme += `- Include Original: ${options.includeOriginal ? 'Yes' : 'No'}\n`;
    readme += `- Include Comparison: ${options.includeComparison ? 'Yes' : 'No'}\n`;
    readme += `- Include Report: ${options.includeReport ? 'Yes' : 'No'}\n\n`;

    readme += `## Contents\n\n`;
    const folders = new Set(contents.filter(c => c.includes('/')).map(c => c.split('/')[0]));
    for (const folder of folders) {
      readme += `- \`${folder}/\`\n`;
    }
    readme += '\n';

    readme += `## Generated\n\n`;
    readme += `${new Date().toISOString()}\n\n`;
    readme += `*Generated by Ninja Accessibility Platform*\n`;

    return readme;
  }
}

export const epubExportService = new EPUBExportService();
