import JSZip from 'jszip';
import { fileStorageService } from '../storage/file-storage.service';
import { epubComparisonService } from './epub-comparison.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';

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

interface AccessibilityReport {
  jobId: string;
  fileName: string;
  generatedAt: Date;
  originalIssues: number;
  fixedIssues: number;
  remainingIssues: number;
  fixRate: number;
  modifications: {
    type: string;
    category: string;
    description: string;
    wcagCriteria?: string;
  }[];
  wcagCompliance: {
    criterion: string;
    status: 'pass' | 'partial' | 'fail';
    notes?: string;
  }[];
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
    const modifications = (autoRemediation.modifications as Array<Record<string, unknown>> || [])
      .filter((m: Record<string, unknown>) => m.success)
      .map((m: Record<string, unknown>) => ({
        type: String(m.issueCode || ''),
        category: this.getCategory(String(m.issueCode || '')),
        description: String(m.description || ''),
        wcagCriteria: this.getWcagCriteria(String(m.issueCode || '')),
      }));

    const originalIssues = auditResult.length;
    const fixedIssues = modifications.length;
    const remainingIssues = originalIssues - fixedIssues;

    return {
      jobId,
      fileName,
      generatedAt: new Date(),
      originalIssues,
      fixedIssues,
      remainingIssues: Math.max(0, remainingIssues),
      fixRate: originalIssues > 0 ? Math.round((fixedIssues / originalIssues) * 100) : 100,
      modifications,
      wcagCompliance: this.assessWcagCompliance(auditResult, modifications),
    };
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
    issues: Array<Record<string, unknown>>,
    modifications: Array<{ wcagCriteria?: string }>
  ): AccessibilityReport['wcagCompliance'] {
    const criteria = [
      { criterion: '1.1.1', name: 'Non-text Content' },
      { criterion: '1.3.1', name: 'Info and Relationships' },
      { criterion: '2.4.1', name: 'Bypass Blocks' },
      { criterion: '2.4.4', name: 'Link Purpose' },
      { criterion: '3.1.1', name: 'Language of Page' },
    ];

    const fixedCriteria = new Set(
      modifications.filter(m => m.wcagCriteria).map(m => m.wcagCriteria)
    );

    const issueCriteria = new Set(
      issues.filter(i => i.wcagCriteria).map(i => String(i.wcagCriteria))
    );

    return criteria.map(c => {
      const hadIssue = issueCriteria.has(c.criterion);
      const wasFixed = fixedCriteria.has(c.criterion);

      let status: 'pass' | 'partial' | 'fail';
      if (!hadIssue) {
        status = 'pass';
      } else if (wasFixed) {
        status = 'pass';
      } else {
        status = 'fail';
      }

      return {
        criterion: c.criterion,
        status,
        notes: `${c.name}${hadIssue ? (wasFixed ? ' - Fixed' : ' - Issues remain') : ' - No issues found'}`,
      };
    });
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
    md += `| Criterion | Status | Notes |\n`;
    md += `|-----------|--------|-------|\n`;
    for (const c of report.wcagCompliance) {
      const statusIcon = c.status === 'pass' ? '✅' : c.status === 'partial' ? '⚠️' : '❌';
      md += `| ${c.criterion} | ${statusIcon} ${c.status} | ${c.notes || ''} |\n`;
    }
    md += '\n';

    if (report.modifications.length > 0) {
      md += `## Applied Fixes\n\n`;
      for (const mod of report.modifications) {
        md += `- **${mod.type}** (${mod.category}): ${mod.description}`;
        if (mod.wcagCriteria) {
          md += ` [WCAG ${mod.wcagCriteria}]`;
        }
        md += '\n';
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
