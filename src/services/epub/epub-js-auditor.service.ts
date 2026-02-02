import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { logger } from '../../lib/logger';

type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

interface AccessibilityIssue {
  id: string;
  code: string;
  severity: Severity;
  message: string;
  wcagCriteria?: string;
  location?: string;
  suggestion?: string;
  category: string;
  element?: string;
  context?: string;
  // Track which file(s) are affected (useful for structural issues)
  affectedFiles?: string[];
}

interface JSAuditResult {
  issues: AccessibilityIssue[];
  metadata: {
    title?: string;
    language?: string;
    hasAccessibilityMetadata: boolean;
    accessibilityFeatures: string[];
  };
  stats: {
    totalDocuments: number;
    totalImages: number;
    imagesWithoutAlt: number;
    emptyLinks: number;
    tablesWithoutHeaders: number;
  };
}

class EPUBJSAuditorService {
  async audit(buffer: Buffer): Promise<JSAuditResult> {
    const issues: AccessibilityIssue[] = [];
    const stats = {
      totalDocuments: 0,
      totalImages: 0,
      imagesWithoutAlt: 0,
      emptyLinks: 0,
      tablesWithoutHeaders: 0,
    };

    const createIssue = (data: Omit<AccessibilityIssue, 'id'>): AccessibilityIssue => {
      return {
        id: `issue-${crypto.randomBytes(8).toString('hex')}`,
        ...data,
      };
    };

    try {
      const zip = await JSZip.loadAsync(buffer);

      const opf = await this.getOPF(zip);
      const metadata = await this.parseMetadata(opf?.content || '');

      if (opf) {
        issues.push(...this.auditMetadata(opf.content, metadata, createIssue));
      }

      const files = Object.keys(zip.files);
      const htmlFiles: { filePath: string; content: string }[] = [];
      
      for (const filePath of files) {
        if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;
        
        const content = await zip.file(filePath)?.async('text');
        if (!content) continue;
        
        htmlFiles.push({ filePath, content });
      }

      // Track which files are missing main landmark
      const filesWithoutMainLandmark: string[] = [];

      for (const { filePath, content } of htmlFiles) {
        // Skip navigation documents (nav, toc, etc.)
        if (this.isNavigationDocument(filePath)) {
          continue;
        }

        stats.totalDocuments++;
        const docIssues = this.auditContentDocument(content, filePath, stats, createIssue, true);
        issues.push(...docIssues);

        // Check if this file has a main landmark
        const hasMainLandmark = this.hasMainRole(content);
        if (!hasMainLandmark) {
          filesWithoutMainLandmark.push(filePath);
        }
      }

      // If any content files lack main landmark, create issue
      if (filesWithoutMainLandmark.length > 0) {
        // Use the first affected file as the primary location
        const primaryFile = filesWithoutMainLandmark[0];

        issues.push(createIssue({
          code: 'EPUB-STRUCT-004',
          severity: 'minor',
          message: 'Missing main landmark in EPUB',
          wcagCriteria: '1.3.1',
          // Use specific file path instead of generic 'EPUB'
          location: primaryFile,
          suggestion: `Add role="main" or <main> element to identify main content in ${primaryFile}`,
          category: 'structure',
          // Track all affected files for comprehensive remediation
          affectedFiles: filesWithoutMainLandmark,
        }));
      }

      return {
        issues,
        metadata: {
          title: metadata.title,
          language: metadata.language,
          hasAccessibilityMetadata: metadata.hasAccessibilityMetadata,
          accessibilityFeatures: metadata.accessibilityFeatures,
        },
        stats,
      };
    } catch (error) {
      logger.error('JS EPUB audit failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private async getOPF(zip: JSZip): Promise<{ path: string; content: string } | null> {
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) return null;

    const match = containerXml.match(/rootfile[^>]+full-path="([^"]+)"/);
    if (!match) return null;

    const opfPath = match[1];
    const opfContent = await zip.file(opfPath)?.async('text');
    if (!opfContent) return null;

    return { path: opfPath, content: opfContent };
  }

  private async parseMetadata(opfContent: string): Promise<{
    title?: string;
    language?: string;
    hasAccessibilityMetadata: boolean;
    accessibilityFeatures: string[];
  }> {
    const getMetaContent = (name: string): string | undefined => {
      const regex = new RegExp(`<dc:${name}[^>]*>([^<]+)</dc:${name}>`, 'i');
      const match = opfContent.match(regex);
      return match ? match[1].trim() : undefined;
    };

    const accessibilityFeatures: string[] = [];
    const featureMatches = opfContent.matchAll(/schema:accessibilityFeature[^>]*>([^<]+)</gi);
    for (const m of featureMatches) {
      accessibilityFeatures.push(m[1].trim());
    }

    return {
      title: getMetaContent('title'),
      language: getMetaContent('language'),
      hasAccessibilityMetadata: accessibilityFeatures.length > 0 || 
        /schema:accessMode/i.test(opfContent) ||
        /schema:accessibilitySummary/i.test(opfContent),
      accessibilityFeatures,
    };
  }

  private auditMetadata(
    opfContent: string,
    metadata: Awaited<ReturnType<typeof this.parseMetadata>>,
    createIssue: (data: Omit<AccessibilityIssue, 'id'>) => AccessibilityIssue
  ): AccessibilityIssue[] {
    const issues: AccessibilityIssue[] = [];

    if (!metadata.language) {
      issues.push(createIssue({
        code: 'EPUB-META-001',
        severity: 'serious',
        message: 'Missing dc:language declaration',
        wcagCriteria: '3.1.1',
        suggestion: 'Add <dc:language> element to specify publication language',
        category: 'metadata',
      }));
    }

    if (metadata.accessibilityFeatures.length === 0) {
      issues.push(createIssue({
        code: 'EPUB-META-002',
        severity: 'moderate',
        message: 'Missing accessibility feature metadata',
        suggestion: 'Add schema:accessibilityFeature metadata',
        category: 'metadata',
      }));
    }

    if (!/schema:accessibilitySummary/i.test(opfContent)) {
      issues.push(createIssue({
        code: 'EPUB-META-003',
        severity: 'minor',
        message: 'Missing accessibility summary',
        suggestion: 'Add schema:accessibilitySummary metadata',
        category: 'metadata',
      }));
    }

    if (!/schema:accessMode/i.test(opfContent)) {
      issues.push(createIssue({
        code: 'EPUB-META-004',
        severity: 'moderate',
        message: 'Missing access mode metadata',
        suggestion: 'Add schema:accessMode metadata',
        category: 'metadata',
      }));
    }

    return issues;
  }

  private auditContentDocument(
    content: string,
    filePath: string,
    stats: JSAuditResult['stats'],
    createIssue: (data: Omit<AccessibilityIssue, 'id'>) => AccessibilityIssue,
    _skipMainLandmarkCheck: boolean = false
  ): AccessibilityIssue[] {
    const issues: AccessibilityIssue[] = [];
    const $ = cheerio.load(content, { xmlMode: true });

    if (!$('html').attr('lang') && !$('html').attr('xml:lang')) {
      issues.push(createIssue({
        code: 'EPUB-SEM-001',
        severity: 'serious',
        message: 'Missing lang attribute on html element',
        wcagCriteria: '3.1.1',
        location: filePath,
        suggestion: 'Add lang attribute to <html> element',
        category: 'semantics',
      }));
    }

    const imagesWithoutAlt: Array<{ src: string; html: string }> = [];
    $('img').each((_, el) => {
      stats.totalImages++;
      const $el = $(el);
      const altAttr = $el.attr('alt');
      if (altAttr === undefined) {
        stats.imagesWithoutAlt++;
        const src = $el.attr('src') || '';
        const html = $.html(el);
        imagesWithoutAlt.push({ src, html });
      }
    });

    if (imagesWithoutAlt.length > 0) {
      const fileDir = filePath.replace(/[^/]+$/, '');
      issues.push(createIssue({
        code: 'EPUB-IMG-001',
        severity: 'critical',
        message: `${imagesWithoutAlt.length} image(s) missing alt attribute`,
        wcagCriteria: '1.1.1',
        location: filePath,
        suggestion: 'Add alt attribute to all images',
        category: 'images',
        context: JSON.stringify({
          images: imagesWithoutAlt.map(img => ({
            src: img.src,
            fullPath: img.src.startsWith('/') ? img.src.slice(1) : (fileDir + img.src),
            html: img.html,
          })),
        }),
        element: imagesWithoutAlt[0]?.html,
      }));
    }

    let localEmptyLinks = 0;
    $('a').each((_, el) => {
      const $el = $(el);
      
      // Skip named anchors (no href) - they're navigation targets, not links
      // WCAG 2.4.4 only applies to navigational links with href
      if (!$el.attr('href')) return;
      
      const text = $el.text().trim();
      const hasImgWithAlt = $el.find('img[alt]:not([alt=""])').length > 0;
      const hasAriaLabel = $el.attr('aria-label');
      
      // Link is empty if: no text, no image with meaningful alt, no aria-label
      if (!text && !hasImgWithAlt && !hasAriaLabel) {
        localEmptyLinks++;
        stats.emptyLinks++;
      }
    });

    if (localEmptyLinks > 0) {
      issues.push(createIssue({
        code: 'EPUB-SEM-002',
        severity: 'serious',
        message: `${localEmptyLinks} empty link(s) found`,
        wcagCriteria: '2.4.4',
        location: filePath,
        suggestion: 'Add descriptive text or aria-label to links',
        category: 'semantics',
      }));
    }

    let localTablesWithoutHeaders = 0;
    $('table').each((_, el) => {
      const $table = $(el);
      if ($table.find('th').length === 0) {
        localTablesWithoutHeaders++;
        stats.tablesWithoutHeaders++;
      }
    });

    if (localTablesWithoutHeaders > 0) {
      issues.push(createIssue({
        code: 'EPUB-STRUCT-002',
        severity: 'serious',
        message: `${localTablesWithoutHeaders} table(s) missing header cells`,
        wcagCriteria: '1.3.1',
        location: filePath,
        suggestion: 'Add <th> elements to identify table headers',
        category: 'structure',
      }));
    }

    const headings: number[] = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const tagName = (el as { tagName?: string }).tagName || '';
      const level = parseInt(tagName.charAt(1));
      if (!isNaN(level)) headings.push(level);
    });

    if (headings.length > 0 && headings[0] !== 1) {
      issues.push(createIssue({
        code: 'EPUB-STRUCT-003',
        severity: 'moderate',
        message: `Document starts with h${headings[0]} instead of h1`,
        wcagCriteria: '1.3.1',
        location: filePath,
        suggestion: 'Start document with an h1 heading',
        category: 'structure',
      }));
    }

    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        issues.push(createIssue({
          code: 'EPUB-STRUCT-003',
          severity: 'moderate',
          message: `Heading hierarchy skips levels (h${headings[i - 1]} to h${headings[i]})`,
          wcagCriteria: '1.3.1',
          location: filePath,
          suggestion: 'Ensure headings follow a logical hierarchy without skipping levels',
          category: 'structure',
        }));
        break;
      }
    }

    return issues;
  }

  /**
   * Check if a document has role="main" or <main> element
   */
  private hasMainRole(content: string): boolean {
    // Check for role="main" attribute
    if (/role\s*=\s*["']main["']/i.test(content)) {
      return true;
    }

    // Check for <main> element
    if (/<main[\s>]/i.test(content)) {
      return true;
    }

    // Check for epub:type="bodymatter" which often implies main content
    if (/epub:type\s*=\s*["'][^"']*bodymatter[^"']*["']/i.test(content)) {
      return true;
    }

    return false;
  }

  /**
   * Check if document is a navigation file (should be skipped)
   */
  private isNavigationDocument(filePath: string): boolean {
    const navPatterns = [
      /nav\.x?html$/i,
      /toc\.x?html$/i,
      /navigation/i,
      /contents\.x?html$/i,
    ];

    return navPatterns.some(pattern => pattern.test(filePath));
  }
}

export const epubJSAuditor = new EPUBJSAuditorService();
