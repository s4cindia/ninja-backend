import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ModificationResult {
  success: boolean;
  filePath: string;
  modificationType: string;
  description: string;
  before?: string;
  after?: string;
}

class EPUBModifierService {
  async loadEPUB(buffer: Buffer): Promise<JSZip> {
    return JSZip.loadAsync(buffer);
  }

  async saveEPUB(zip: JSZip): Promise<Buffer> {
    return zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  }

  async getOPF(zip: JSZip): Promise<{ path: string; content: string } | null> {
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) return null;

    const match = containerXml.match(/rootfile[^>]+full-path="([^"]+)"/);
    if (!match) return null;

    const opfPath = match[1];
    const opfContent = await zip.file(opfPath)?.async('text');
    if (!opfContent) return null;

    return { path: opfPath, content: opfContent };
  }

  async updateOPF(zip: JSZip, opfPath: string, content: string): Promise<void> {
    zip.file(opfPath, content);
  }

  async addLanguage(
    zip: JSZip,
    language: string = 'en'
  ): Promise<ModificationResult> {
    const opf = await this.getOPF(zip);
    if (!opf) {
      return {
        success: false,
        filePath: 'content.opf',
        modificationType: 'add_language',
        description: 'Failed to locate OPF file',
      };
    }

    if (/<dc:language[^>]*>/i.test(opf.content)) {
      return {
        success: true,
        filePath: opf.path,
        modificationType: 'add_language',
        description: 'Language declaration already exists',
      };
    }

    let modified = opf.content;
    const dcPattern = /(<dc:\w+[^>]*>[^<]*<\/dc:\w+>)/i;
    const match = modified.match(dcPattern);

    if (match) {
      const insertAfter = match[0];
      const newElement = `\n    <dc:language>${language}</dc:language>`;
      modified = modified.replace(insertAfter, insertAfter + newElement);
    } else {
      modified = modified.replace(
        /(<metadata[^>]*>)/i,
        `$1\n    <dc:language>${language}</dc:language>`
      );
    }

    await this.updateOPF(zip, opf.path, modified);

    return {
      success: true,
      filePath: opf.path,
      modificationType: 'add_language',
      description: `Added dc:language element with value "${language}"`,
      before: 'No dc:language element',
      after: `<dc:language>${language}</dc:language>`,
    };
  }

  async addAccessibilityMetadata(
    zip: JSZip,
    features: string[] = ['structuralNavigation', 'tableOfContents', 'readingOrder']
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const opf = await this.getOPF(zip);
    
    if (!opf) {
      return [{
        success: false,
        filePath: 'content.opf',
        modificationType: 'add_accessibility_metadata',
        description: 'Failed to locate OPF file',
      }];
    }

    let modified = opf.content;
    const metadataToAdd: string[] = [];

    for (const feature of features) {
      const escapedFeature = escapeRegExp(feature);
      const featurePattern = new RegExp(`schema:accessibilityFeature[^>]*>${escapedFeature}<`, 'i');
      if (!featurePattern.test(modified)) {
        metadataToAdd.push(
          `<meta property="schema:accessibilityFeature">${feature}</meta>`
        );
      }
    }

    if (!/schema:accessMode/i.test(modified)) {
      metadataToAdd.push('<meta property="schema:accessMode">textual</meta>');
    }

    if (!/schema:accessModeSufficient/i.test(modified)) {
      metadataToAdd.push('<meta property="schema:accessModeSufficient">textual</meta>');
    }

    if (!/schema:accessibilityHazard/i.test(modified)) {
      metadataToAdd.push('<meta property="schema:accessibilityHazard">none</meta>');
    }

    if (metadataToAdd.length === 0) {
      return [{
        success: true,
        filePath: opf.path,
        modificationType: 'add_accessibility_metadata',
        description: 'Accessibility metadata already present',
      }];
    }

    const insertContent = '\n    ' + metadataToAdd.join('\n    ');
    modified = modified.replace('</metadata>', insertContent + '\n  </metadata>');

    await this.updateOPF(zip, opf.path, modified);

    results.push({
      success: true,
      filePath: opf.path,
      modificationType: 'add_accessibility_metadata',
      description: `Added ${metadataToAdd.length} accessibility metadata elements`,
      after: metadataToAdd.join('\n'),
    });

    return results;
  }

  async addAccessibilitySummary(
    zip: JSZip,
    summary?: string
  ): Promise<ModificationResult> {
    const opf = await this.getOPF(zip);
    if (!opf) {
      return {
        success: false,
        filePath: 'content.opf',
        modificationType: 'add_accessibility_summary',
        description: 'Failed to locate OPF file',
      };
    }

    if (/schema:accessibilitySummary/i.test(opf.content)) {
      return {
        success: true,
        filePath: opf.path,
        modificationType: 'add_accessibility_summary',
        description: 'Accessibility summary already exists',
      };
    }

    const defaultSummary = summary || 
      'This publication includes structural navigation, a table of contents, and follows a logical reading order.';

    const newElement = `<meta property="schema:accessibilitySummary">${defaultSummary}</meta>`;
    const modified = opf.content.replace(
      '</metadata>',
      `    ${newElement}\n  </metadata>`
    );

    await this.updateOPF(zip, opf.path, modified);

    return {
      success: true,
      filePath: opf.path,
      modificationType: 'add_accessibility_summary',
      description: 'Added accessibility summary',
      after: newElement,
    };
  }

  async addHtmlLangAttributes(
    zip: JSZip,
    language: string = 'en'
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      if (/<html[^>]+lang=/i.test(content)) continue;

      const modified = content.replace(
        /<html([^>]*)>/i,
        `<html$1 lang="${language}" xml:lang="${language}">`
      );

      if (modified !== content) {
        zip.file(filePath, modified);
        results.push({
          success: true,
          filePath,
          modificationType: 'add_html_lang',
          description: `Added lang="${language}" attribute`,
          before: '<html ...>',
          after: `<html ... lang="${language}" xml:lang="${language}">`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_html_lang',
        description: 'All HTML files already have lang attributes',
      });
    }

    return results;
  }

  async addDecorativeAltAttributes(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      let count = 0;
      const markedImages: string[] = [];

      $('img').each((_, el) => {
        const $el = $(el);
        const altAttr = $el.attr('alt');
        if (altAttr === undefined) {
          const src = $el.attr('src') || 'unknown';
          markedImages.push(src);
          $el.attr('alt', '');
          $el.attr('role', 'presentation');
          modified = true;
          count++;
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'add_decorative_alt',
          description: `Marked ${count} image(s) as decorative with alt="" - REVIEW RECOMMENDED`,
          after: `Images marked: ${markedImages.slice(0, 5).join(', ')}${markedImages.length > 5 ? '...' : ''}`,
        });

        logger.warn(`Marked ${count} images as decorative in ${filePath}. Manual review recommended to ensure these are not informative images.`);
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_decorative_alt',
        description: 'All images already have alt attributes',
      });
    }

    return results;
  }

  async addTableHeaders(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      let count = 0;

      $('table').each((_, table) => {
        const $table = $(table);
        
        if ($table.find('th').length > 0) return;

        const $firstRow = $table.find('tr').first();
        const $cells = $firstRow.find('td');
        
        if ($cells.length > 0) {
          $cells.each((_, cell) => {
            const $cell = $(cell);
            const cellContent = $cell.html();
            $cell.replaceWith(`<th scope="col">${cellContent}</th>`);
          });
          modified = true;
          count++;
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'add_table_headers',
          description: `Added headers to ${count} table(s)`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_table_headers',
        description: 'All tables already have headers',
      });
    }

    return results;
  }

  async addAltText(
    zip: JSZip,
    imageAlts: { imageSrc: string; altText: string }[]
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);
    const altMap = new Map(imageAlts.map(ia => [ia.imageSrc, ia.altText]));

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      const changes: string[] = [];

      $('img').each((_, el) => {
        const $el = $(el);
        const src = $el.attr('src') || '';
        
        const fileName = src.split('/').pop() || src;
        const altText = altMap.get(src) || altMap.get(fileName);
        
        if (altText && $el.attr('alt') !== altText) {
          const oldAlt = $el.attr('alt') || '(none)';
          $el.attr('alt', altText);
          $el.removeAttr('role');
          modified = true;
          changes.push(`${fileName}: "${oldAlt}" → "${altText}"`);
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'add_alt_text',
          description: `Updated alt text for ${changes.length} image(s)`,
          after: changes.join('\n'),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_alt_text',
        description: 'No images matched for alt text update',
      });
    }

    return results;
  }

  async fixHeadingHierarchy(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      const changes: string[] = [];

      const headings: { el: Parameters<typeof $>[0]; level: number }[] = [];
      $('h1, h2, h3, h4, h5, h6').each((_, el) => {
        const tagName = ((el as { tagName?: string }).tagName || '').toLowerCase();
        const level = parseInt(tagName.charAt(1));
        if (!isNaN(level)) headings.push({ el: el as Parameters<typeof $>[0], level });
      });

      let expectedMaxLevel = 1;
      for (const heading of headings) {
        if (heading.level > expectedMaxLevel + 1) {
          const newLevel = expectedMaxLevel + 1;
          const $el = $(heading.el);
          const headingContent = $el.html();
          const attrs: Record<string, string> = {};
          
          const elAttrs = ((heading.el as { attribs?: Record<string, string> }).attribs) || {};
          Object.keys(elAttrs).forEach(key => {
            attrs[key] = elAttrs[key];
          });
          
          const attrString = Object.entries(attrs)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ');
          
          const newTag = `<h${newLevel}${attrString ? ' ' + attrString : ''}>${headingContent}</h${newLevel}>`;
          $el.replaceWith(newTag);
          
          changes.push(`h${heading.level} → h${newLevel}`);
          modified = true;
          heading.level = newLevel;
        }
        expectedMaxLevel = Math.max(expectedMaxLevel, heading.level);
      }

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'fix_heading_hierarchy',
          description: `Fixed ${changes.length} heading level(s)`,
          after: changes.join(', '),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'fix_heading_hierarchy',
        description: 'Heading hierarchy is correct',
      });
    }

    return results;
  }

  async addAriaLandmarks(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      const changes: string[] = [];

      const $body = $('body');
      if ($body.length && !$body.find('[role="main"]').length) {
        const $main = $('main');
        if ($main.length) {
          if (!$main.attr('role')) {
            $main.attr('role', 'main');
            changes.push('Added role="main" to <main>');
            modified = true;
          }
        } else {
          const $firstSection = $body.children('div, section, article').first();
          if ($firstSection.length && !$firstSection.attr('role')) {
            $firstSection.attr('role', 'main');
            changes.push('Added role="main" to first content section');
            modified = true;
          }
        }
      }

      $('nav').each((_, el) => {
        const $el = $(el);
        if (!$el.attr('role')) {
          $el.attr('role', 'navigation');
          changes.push('Added role="navigation" to <nav>');
          modified = true;
        }
      });

      $('footer').each((_, el) => {
        const $el = $(el);
        if (!$el.attr('role')) {
          $el.attr('role', 'contentinfo');
          changes.push('Added role="contentinfo" to <footer>');
          modified = true;
        }
      });

      $('header').first().each((_, el) => {
        const $el = $(el);
        if (!$el.attr('role')) {
          $el.attr('role', 'banner');
          changes.push('Added role="banner" to <header>');
          modified = true;
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'add_aria_landmarks',
          description: `Added ${changes.length} ARIA landmark(s)`,
          after: changes.join('\n'),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_aria_landmarks',
        description: 'ARIA landmarks already present or not applicable',
      });
    }

    return results;
  }

  async addSkipNavigation(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      
      if ($('a[href="#main"], a[href="#content"], .skip-link, .skip-nav').length) {
        continue;
      }

      const $body = $('body');
      if (!$body.length) continue;

      let mainId = 'main-content';
      const $main = $('[role="main"], main, #main, #content').first();
      if ($main.length) {
        if (!$main.attr('id')) {
          $main.attr('id', mainId);
        } else {
          mainId = $main.attr('id')!;
        }
      } else {
        const $firstContent = $body.children('div, section, article').first();
        if ($firstContent.length) {
          $firstContent.attr('id', mainId);
        }
      }

      const skipLink = `<a href="#${mainId}" class="skip-link" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;">Skip to main content</a>\n`;
      $body.prepend(skipLink);

      zip.file(filePath, $.html());
      results.push({
        success: true,
        filePath,
        modificationType: 'add_skip_navigation',
        description: 'Added skip navigation link',
        after: `<a href="#${mainId}" class="skip-link">Skip to main content</a>`,
      });
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_skip_navigation',
        description: 'Skip navigation already present or not applicable',
      });
    }

    return results;
  }

  async fixEmptyLinks(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      const changes: string[] = [];

      $('a').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const hasImage = $el.find('img[alt]').length > 0;
        const hasAriaLabel = $el.attr('aria-label');
        
        if (!text && !hasImage && !hasAriaLabel) {
          const href = $el.attr('href') || '';
          
          if (href) {
            let label = '';
            if (href.startsWith('#')) {
              label = `Jump to ${href.substring(1).replace(/[-_]/g, ' ')}`;
            } else if (href.match(/\.(html|xhtml|htm)$/i)) {
              label = href.split('/').pop()?.replace(/\.(html|xhtml|htm)$/i, '').replace(/[-_]/g, ' ') || 'Link';
            } else {
              label = 'Link';
            }
            
            $el.attr('aria-label', label);
            changes.push(`Added aria-label="${label}" to empty link`);
            modified = true;
          }
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'fix_empty_links',
          description: `Fixed ${changes.length} empty link(s)`,
          after: changes.join('\n'),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'fix_empty_links',
        description: 'No empty links found',
      });
    }

    return results;
  }

  async addFigureStructure(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (!filePath.match(/\.(html|xhtml|htm)$/i)) continue;

      const content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      let count = 0;

      $('img').each((_, el) => {
        const $img = $(el);
        const $parent = $img.parent();
        
        if ($parent.is('figure')) return;
        
        const $next = $img.next();
        const $nextText = $next.text().trim();
        
        if ($next.length && $nextText.length > 0 && $nextText.length < 200) {
          if ($next.is('p, span, div') && 
              ($next.hasClass('caption') || 
               $next.hasClass('figure-caption') ||
               $nextText.toLowerCase().startsWith('figure') ||
               $nextText.toLowerCase().startsWith('fig.'))) {
            
            const imgHtml = $.html($img);
            const captionText = $nextText;
            
            $img.replaceWith(`<figure>${imgHtml}<figcaption>${captionText}</figcaption></figure>`);
            $next.remove();
            modified = true;
            count++;
          }
        }
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'add_figure_structure',
          description: `Wrapped ${count} image(s) with figure/figcaption`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_figure_structure',
        description: 'No images with captions found to wrap',
      });
    }

    return results;
  }
}

export const epubModifier = new EPUBModifierService();
