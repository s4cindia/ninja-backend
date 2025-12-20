import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';

export interface JSAuditorIssue {
  id: string;
  code: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  location?: string;
  suggestion?: string;
  wcagCriteria?: string[];
}

export interface JSAuditResult {
  issues: JSAuditorIssue[];
  metadata: {
    hasLanguage: boolean;
    hasAccessibilityMeta: boolean;
    hasAccessibilitySummary: boolean;
    hasWcagConformance: boolean;
  };
}

class EpubJSAuditor {
  private issueCounter = 0;

  async audit(buffer: Buffer): Promise<JSAuditResult> {
    this.issueCounter = 0;
    const issues: JSAuditorIssue[] = [];

    try {
      const zip = await JSZip.loadAsync(buffer);
      const opfContent = await this.getOPFContent(zip);
      
      const metadata = {
        hasLanguage: false,
        hasAccessibilityMeta: false,
        hasAccessibilitySummary: false,
        hasWcagConformance: false,
      };

      if (opfContent) {
        this.auditMetadata(opfContent.content, opfContent.path, issues, metadata);
      }

      await this.auditHtmlContent(zip, issues);

      return { issues, metadata };
    } catch (error) {
      logger.error('JS audit failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private async getOPFContent(zip: JSZip): Promise<{ content: string; path: string } | null> {
    const containerPath = 'META-INF/container.xml';
    const containerFile = zip.file(containerPath);
    
    if (!containerFile) {
      return null;
    }

    const containerContent = await containerFile.async('text');
    const $ = cheerio.load(containerContent, { xmlMode: true });
    const opfPath = $('rootfile').attr('full-path');

    if (!opfPath) {
      return null;
    }

    const opfFile = zip.file(opfPath);
    if (!opfFile) {
      return null;
    }

    return {
      content: await opfFile.async('text'),
      path: opfPath,
    };
  }

  private auditMetadata(
    opfContent: string,
    opfPath: string,
    issues: JSAuditorIssue[],
    metadata: JSAuditResult['metadata']
  ): void {
    metadata.hasLanguage = /<dc:language[^>]*>/i.test(opfContent);
    if (!metadata.hasLanguage) {
      issues.push(this.createIssue({
        code: 'EPUB-META-001',
        severity: 'serious',
        message: 'Missing dc:language element in package metadata',
        location: opfPath,
        suggestion: 'Add <dc:language>en</dc:language> to the metadata section',
        wcagCriteria: ['3.1.1'],
      }));
    }

    const hasAccessMode = /schema:accessMode/i.test(opfContent);
    const hasAccessibilityFeature = /schema:accessibilityFeature/i.test(opfContent);
    const hasAccessibilityHazard = /schema:accessibilityHazard/i.test(opfContent);
    
    metadata.hasAccessibilityMeta = hasAccessMode && hasAccessibilityFeature && hasAccessibilityHazard;
    if (!metadata.hasAccessibilityMeta) {
      const missing: string[] = [];
      if (!hasAccessMode) missing.push('accessMode');
      if (!hasAccessibilityFeature) missing.push('accessibilityFeature');
      if (!hasAccessibilityHazard) missing.push('accessibilityHazard');
      
      issues.push(this.createIssue({
        code: 'EPUB-META-002',
        severity: 'moderate',
        message: `Missing accessibility metadata: ${missing.join(', ')}`,
        location: opfPath,
        suggestion: 'Add schema.org accessibility metadata properties',
      }));
    }

    metadata.hasAccessibilitySummary = /schema:accessibilitySummary/i.test(opfContent);
    if (!metadata.hasAccessibilitySummary) {
      issues.push(this.createIssue({
        code: 'EPUB-META-003',
        severity: 'minor',
        message: 'Missing accessibility summary',
        location: opfPath,
        suggestion: 'Add a schema:accessibilitySummary describing the publication\'s accessibility features',
      }));
    }

    metadata.hasWcagConformance = /dcterms:conformsTo.*WCAG/i.test(opfContent) || 
                                   /a11y:conformsTo.*WCAG/i.test(opfContent);
    if (!metadata.hasWcagConformance) {
      issues.push(this.createIssue({
        code: 'EPUB-META-004',
        severity: 'moderate',
        message: 'Missing WCAG conformance declaration',
        location: opfPath,
        suggestion: 'Add dcterms:conformsTo or a11y:conformsTo with WCAG level',
      }));
    }
  }

  private async auditHtmlContent(zip: JSZip, issues: JSAuditorIssue[]): Promise<void> {
    const htmlFiles = Object.keys(zip.files).filter(
      path => /\.(html|xhtml|htm)$/i.test(path) && !zip.files[path].dir
    );

    for (const filePath of htmlFiles) {
      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });

      this.auditLangAttribute($, filePath, issues);
      this.auditImages($, filePath, issues);
      this.auditTables($, filePath, issues);
    }
  }

  private auditLangAttribute($: cheerio.CheerioAPI, filePath: string, issues: JSAuditorIssue[]): void {
    const html = $('html');
    const hasLang = html.attr('lang') || html.attr('xml:lang');
    
    if (!hasLang) {
      issues.push(this.createIssue({
        code: 'EPUB-LANG-001',
        severity: 'serious',
        message: 'HTML document missing lang attribute',
        location: filePath,
        suggestion: 'Add lang="en" attribute to the html element',
        wcagCriteria: ['3.1.1'],
      }));
    }
  }

  private auditImages($: cheerio.CheerioAPI, filePath: string, issues: JSAuditorIssue[]): void {
    $('img').each((_, el) => {
      const $el = $(el);
      const alt = $el.attr('alt');
      const role = $el.attr('role');
      
      if (alt === undefined && role !== 'presentation') {
        const src = $el.attr('src') || 'unknown';
        issues.push(this.createIssue({
          code: 'EPUB-IMG-001',
          severity: 'critical',
          message: `Image missing alt attribute: ${src}`,
          location: filePath,
          suggestion: 'Add alt="" for decorative images or descriptive alt text for meaningful images',
          wcagCriteria: ['1.1.1'],
        }));
      }
    });
  }

  private auditTables($: cheerio.CheerioAPI, filePath: string, issues: JSAuditorIssue[]): void {
    $('table').each((idx, el) => {
      const $table = $(el);
      const hasHeaders = $table.find('th').length > 0;
      const hasScope = $table.find('th[scope]').length > 0;
      const hasCaption = $table.find('caption').length > 0;

      if (!hasHeaders) {
        issues.push(this.createIssue({
          code: 'EPUB-STRUCT-002',
          severity: 'serious',
          message: `Table ${idx + 1} missing header cells (th elements)`,
          location: filePath,
          suggestion: 'Add th elements to identify column and/or row headers',
          wcagCriteria: ['1.3.1'],
        }));
      } else if (!hasScope && $table.find('tr').length > 1) {
        issues.push(this.createIssue({
          code: 'EPUB-STRUCT-003',
          severity: 'moderate',
          message: `Table ${idx + 1} headers missing scope attribute`,
          location: filePath,
          suggestion: 'Add scope="col" or scope="row" to th elements',
          wcagCriteria: ['1.3.1'],
        }));
      }

      if (!hasCaption && $table.find('tr').length > 2) {
        issues.push(this.createIssue({
          code: 'EPUB-STRUCT-001',
          severity: 'minor',
          message: `Table ${idx + 1} missing caption element`,
          location: filePath,
          suggestion: 'Add a caption element to describe the table purpose',
          wcagCriteria: ['1.3.1'],
        }));
      }
    });
  }

  private createIssue(data: Omit<JSAuditorIssue, 'id'>): JSAuditorIssue {
    return {
      id: `js-issue-${++this.issueCounter}`,
      ...data,
    };
  }
}

export const epubJSAuditor = new EpubJSAuditor();
