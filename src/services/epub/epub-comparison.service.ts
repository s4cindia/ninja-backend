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

class EPUBComparisonService {
  async compareEPUBs(
    originalBuffer: Buffer,
    remediatedBuffer: Buffer,
    jobId: string,
    originalFileName: string
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

    logger.info(`EPUB comparison complete for ${jobId}: ${summary.modifiedFiles} modified, ${modifications.length} changes`);

    return {
      jobId,
      originalFileName,
      remediatedFileName: originalFileName.replace(/\.epub$/i, '_remediated.epub'),
      summary,
      files,
      modifications,
      generatedAt: new Date(),
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
}

export const epubComparisonService = new EPUBComparisonService();
