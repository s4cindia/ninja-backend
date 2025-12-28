import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';

const EPUB_TEXT_FILE_EXTENSIONS = ['.opf', '.xhtml', '.html', '.htm', '.xml', '.ncx', '.css', '.smil', '.svg'];

function isTextFile(filePath: string): boolean {
  return EPUB_TEXT_FILE_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext));
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface FlexibleMatchResult {
  matched: boolean;
  matchedContent?: string;
  newContent?: string;
}

function tryFlexibleMatch(content: string, oldContent: string, newContent: string): FlexibleMatchResult {
  const flexiblePattern = escapeRegExp(oldContent)
    .replace(/\\s+/g, '\\s*')
    .replace(/"/g, '["\']')
    .replace(/'/g, '["\']');

  try {
    const regex = new RegExp(flexiblePattern, 'g');
    const match = content.match(regex);

    if (match && match.length > 0) {
      logger.info(`Flexible match found: "${match[0].substring(0, 80)}..."`);
      return {
        matched: true,
        matchedContent: match[0],
        newContent: content.replace(match[0], newContent),
      };
    }
  } catch (e) {
    logger.warn(`Flexible pattern failed: ${e}`);
  }

  return { matched: false };
}

function tryEpubTypePatternMatch(content: string, oldContent: string, newContent: string): FlexibleMatchResult {
  const epubTypeMatch = oldContent.match(/epub:type\s*=\s*["']([^"']+)["']/);
  if (epubTypeMatch) {
    const epubTypeValue = epubTypeMatch[1];
    const regex = new RegExp(`epub:type\\s*=\\s*["']${escapeRegExp(epubTypeValue)}["']`, 'g');
    const match = content.match(regex);

    if (match && match.length > 0) {
      logger.info(`epub:type pattern matched: "${match[0]}"`);
      const quoteChar = match[0].includes('"') ? '"' : "'";
      const replacement = newContent.replace(/["']/g, quoteChar);

      return {
        matched: true,
        matchedContent: match[0],
        newContent: content.replace(match[0], replacement),
      };
    }
  }

  return { matched: false };
}

function tryTagPatternMatch(content: string, oldContent: string, newContent: string): FlexibleMatchResult {
  const tagMatch = oldContent.match(/<(\w+)([^>]*)>/);
  if (tagMatch) {
    const tagName = tagMatch[1];
    const attrs = tagMatch[2].trim();
    const tagRegex = new RegExp(`<${tagName}\\s+[^>]*>`, 'g');
    let match;

    while ((match = tagRegex.exec(content)) !== null) {
      const foundTag = match[0];
      const keyAttrMatch = attrs.match(/(\w+)\s*=\s*["']([^"']+)["']/);

      if (keyAttrMatch) {
        const attrName = keyAttrMatch[1];
        const attrValue = keyAttrMatch[2];

        if (foundTag.includes(`${attrName}=`) && foundTag.includes(attrValue)) {
          logger.info(`Tag pattern matched: "${foundTag.substring(0, 80)}..."`);

          const newAttrMatch = newContent.match(/(\w+)\s*=\s*["']([^"']+)["']\s*$/);
          if (newAttrMatch && !foundTag.includes(newAttrMatch[1])) {
            const updatedTag = foundTag.replace(/>$/, ` ${newAttrMatch[0]}>`);

            return {
              matched: true,
              matchedContent: foundTag,
              newContent: content.replace(foundTag, updatedTag),
            };
          }
          
          return {
            matched: true,
            matchedContent: foundTag,
            newContent: content.replace(foundTag, newContent),
          };
        }
      }
    }
  }

  return { matched: false };
}

function handleEpubTypeRoleAddition(
  content: string,
  oldContent: string,
  newContent: string
): { result: string; matched: boolean; matchedContent?: string } {
  const epubTypeMatch = oldContent.match(/epub:type\s*=\s*["']([^"']+)["']/);
  if (!epubTypeMatch) {
    return { result: content, matched: false };
  }

  const epubTypeValue = epubTypeMatch[1];
  logger.info(`Looking for epub:type="${epubTypeValue}"`);

  const roleMatch = newContent.match(/role\s*=\s*["']([^"']+)["']/);
  if (!roleMatch) {
    return { result: content, matched: false };
  }

  const roleValue = roleMatch[1];
  logger.info(`Will add role="${roleValue}"`);

  const elementRegex = new RegExp(
    `(<[a-zA-Z][^>]*)(epub:type\\s*=\\s*["']${escapeRegExp(epubTypeValue)}["'])([^>]*>)`,
    'gi'
  );

  let matchCount = 0;
  const newContentResult = content.replace(elementRegex, (fullMatch, before, epubTypePart, after) => {
    if (fullMatch.toLowerCase().includes('role=')) {
      logger.info(`Element already has role, skipping: ${fullMatch.substring(0, 80)}...`);
      return fullMatch;
    }

    matchCount++;
    logger.info(`Found match ${matchCount}: ${fullMatch.substring(0, 80)}...`);

    return `${before}${epubTypePart} role="${roleValue}"${after}`;
  });

  if (matchCount > 0) {
    logger.info(`Modified ${matchCount} element(s) with epub:type="${epubTypeValue}"`);
    return {
      result: newContentResult,
      matched: true,
      matchedContent: `${matchCount} elements with epub:type="${epubTypeValue}"`,
    };
  }

  logger.warn(`No elements found with epub:type="${epubTypeValue}"`);

  const existingEpubTypes = content.match(/epub:type\s*=\s*["'][^"']+["']/gi) || [];
  logger.info(`Existing epub:types in file: ${[...new Set(existingEpubTypes)].join(', ')}`);

  return { result: content, matched: false };
}

function performFlexibleReplace(content: string, oldContent: string, newContent: string): { 
  result: string; 
  matched: boolean; 
  matchedContent?: string;
} {
  if (content.includes(oldContent)) {
    logger.info(`Exact match found for: ${oldContent.substring(0, 50)}...`);
    return {
      result: content.replace(oldContent, newContent),
      matched: true,
      matchedContent: oldContent,
    };
  }

  logger.info(`Exact match failed, trying flexible patterns...`);

  if (oldContent.includes('epub:type') && newContent.includes('role=')) {
    const epubRoleResult = handleEpubTypeRoleAddition(content, oldContent, newContent);
    if (epubRoleResult.matched) {
      return epubRoleResult;
    }
  }

  const flexResult = tryFlexibleMatch(content, oldContent, newContent);
  if (flexResult.matched) {
    return {
      result: flexResult.newContent!,
      matched: true,
      matchedContent: flexResult.matchedContent,
    };
  }

  const epubTypeResult = tryEpubTypePatternMatch(content, oldContent, newContent);
  if (epubTypeResult.matched) {
    return {
      result: epubTypeResult.newContent!,
      matched: true,
      matchedContent: epubTypeResult.matchedContent,
    };
  }

  const tagResult = tryTagPatternMatch(content, oldContent, newContent);
  if (tagResult.matched) {
    return {
      result: tagResult.newContent!,
      matched: true,
      matchedContent: tagResult.matchedContent,
    };
  }

  logger.warn(`No match found for: ${oldContent.substring(0, 100)}...`);
  return { result: content, matched: false };
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

  async applyQuickFix(
    zip: JSZip,
    changes: FileChange[],
    jobId?: string,
    issueId?: string
  ): Promise<{ modifiedFiles: string[]; results: ModificationResult[]; hasErrors: boolean }> {
    logger.info('='.repeat(60));
    logger.info('APPLY QUICK FIX - DEBUG');
    logger.info('='.repeat(60));
    logger.info(`Job ID: ${jobId || 'N/A'}`);
    logger.info(`Issue ID: ${issueId || 'N/A'}`);
    logger.info(`Number of changes: ${changes.length}`);

    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      logger.info(`Change ${i + 1}:`);
      logger.info(`  Type: ${c.type}`);
      logger.info(`  File: ${c.filePath}`);
      logger.info(`  Old: ${c.oldContent?.substring(0, 100) || 'N/A'}...`);
      logger.info(`  New: ${c.content?.substring(0, 100) || 'N/A'}...`);
    }

    const modifiedFiles: string[] = [];
    const results: ModificationResult[] = [];
    let hasErrors = false;

    for (const change of changes) {
      const filePath = change.filePath;
      
      let file = zip.file(filePath);
      let actualPath = filePath;
      if (!file) {
        file = zip.file(`EPUB/${filePath}`);
        if (file) actualPath = `EPUB/${filePath}`;
      }
      if (!file) {
        file = zip.file(`OEBPS/${filePath}`);
        if (file) actualPath = `OEBPS/${filePath}`;
      }

      if (!file) {
        if (filePath.endsWith('.opf') || change.type === 'insert' && filePath.includes('opf')) {
          const opfData = await this.getOPF(zip);
          if (opfData) {
            file = zip.file(opfData.path);
            actualPath = opfData.path;
            logger.info(`Auto-detected OPF file: ${actualPath} (requested: ${filePath})`);
          }
        }
      }

      if (!file) {
        logger.warn(`File not found in EPUB: ${filePath}`);
        results.push({
          success: false,
          filePath,
          modificationType: change.type,
          description: `File not found in EPUB: ${filePath}`,
        });
        hasErrors = true;
        continue;
      }

      const content = await file.async('string');
      const before = content.substring(0, 200);
      let modified = content;
      let changeApplied = false;

      switch (change.type) {
        case 'insert':
          {
            if (!isTextFile(actualPath)) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: `Insert not allowed for binary/non-text file: ${actualPath}`,
              });
              hasErrors = true;
              continue;
            }
            
            if (filePath.endsWith('.opf')) {
              if (modified.includes('</metadata>')) {
                modified = modified.replace('</metadata>', `${change.content}\n</metadata>`);
                changeApplied = true;
              } else {
                results.push({
                  success: false,
                  filePath: actualPath,
                  modificationType: change.type,
                  description: 'No </metadata> tag found for insertion',
                });
                hasErrors = true;
                continue;
              }
            } else if (change.oldContent) {
              if (!content.includes(change.oldContent)) {
                results.push({
                  success: false,
                  filePath: actualPath,
                  modificationType: change.type,
                  description: 'Insert anchor (oldContent) not found in file',
                });
                hasErrors = true;
                continue;
              }
              modified = content.replace(change.oldContent, change.oldContent + (change.content || ''));
              changeApplied = true;
            } else {
              modified += '\n' + (change.content || '');
              changeApplied = true;
            }
          }
          break;

        case 'replace':
          {
            if (!isTextFile(actualPath)) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: `Replace not allowed for binary/non-text file: ${actualPath}`,
              });
              hasErrors = true;
              continue;
            }
            
            if (!change.oldContent) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: 'oldContent is required for replace operation',
              });
              hasErrors = true;
              continue;
            }
            
            const replaceResult = performFlexibleReplace(content, change.oldContent, change.content || '');
            if (!replaceResult.matched) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: 'oldContent not found in file (exact and flexible matching failed)',
              });
              hasErrors = true;
              continue;
            }
            modified = replaceResult.result;
            changeApplied = true;
            if (replaceResult.matchedContent && replaceResult.matchedContent !== change.oldContent) {
              logger.info(`Flexible match used - original: "${change.oldContent.substring(0, 50)}...", matched: "${replaceResult.matchedContent.substring(0, 50)}..."`);
            }
          }
          break;

        case 'delete':
          {
            if (!isTextFile(actualPath)) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: `Delete not allowed for binary/non-text file: ${actualPath}`,
              });
              hasErrors = true;
              continue;
            }
            
            if (!change.oldContent) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: 'oldContent is required for delete operation',
              });
              hasErrors = true;
              continue;
            }
            
            const deleteResult = performFlexibleReplace(content, change.oldContent, '');
            if (!deleteResult.matched) {
              results.push({
                success: false,
                filePath: actualPath,
                modificationType: change.type,
                description: 'oldContent not found in file (exact and flexible matching failed)',
              });
              hasErrors = true;
              continue;
            }
            modified = deleteResult.result;
            changeApplied = true;
            if (deleteResult.matchedContent && deleteResult.matchedContent !== change.oldContent) {
              logger.info(`Flexible match used for delete - original: "${change.oldContent.substring(0, 50)}...", matched: "${deleteResult.matchedContent.substring(0, 50)}..."`);
            }
          }
          break;
        
        default:
          results.push({
            success: false,
            filePath: actualPath,
            modificationType: String(change.type),
            description: `Unsupported change type: ${change.type}. Supported types: insert, replace, delete`,
          });
          hasErrors = true;
          continue;
      }

      if (changeApplied) {
        zip.file(actualPath, modified);
        modifiedFiles.push(actualPath);

        results.push({
          success: true,
          filePath: actualPath,
          modificationType: change.type,
          description: change.description || `Applied ${change.type} operation`,
          before,
          after: modified.substring(0, 200),
        });

        logger.info(`Quick fix modified file: ${actualPath}`);
      }
    }

    logger.info(`Quick fix applied to ${modifiedFiles.length} files, errors: ${hasErrors}`);

    return { modifiedFiles, results, hasErrors };
  }

  async addAriaRolesToEpubTypes(
    zip: JSZip,
    epubTypesToFix: Array<{ epubType: string; role: string }>
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];

    const xhtmlFiles = Object.keys(zip.files).filter(path =>
      /\.(xhtml|html|htm)$/i.test(path) && !zip.files[path].dir
    );

    console.log(`Adding ARIA roles to ${epubTypesToFix.length} epub:types across ${xhtmlFiles.length} files`);

    for (const filePath of xhtmlFiles) {
      try {
        let content = await zip.file(filePath)?.async('text');
        if (!content) continue;

        let fileModified = false;
        const originalContent = content;

        for (const { epubType, role } of epubTypesToFix) {
          // Use regex replacement instead of cheerio to preserve original format
          // Match elements with epub:type containing the target type, that don't already have role=
          const pattern = new RegExp(
            `(<[^>]*epub:type=["'][^"']*\\b${epubType}\\b[^"']*["'])(?![^>]*\\brole=)([^>]*>)`,
            'g'
          );

          const matches = content.match(pattern);
          if (matches) {
            content = content.replace(pattern, `$1 role="${role}"$2`);

            for (const match of matches) {
              results.push({
                success: true,
                filePath,
                modificationType: 'add_role',
                description: `Added role="${role}" to element with epub:type="${epubType}"`,
                before: match.substring(0, 100),
                after: match.replace(pattern, `$1 role="${role}"$2`).substring(0, 100),
              });
            }

            fileModified = true;
          }
        }

        if (fileModified) {
          zip.file(filePath, content);
          console.log(`Modified ${filePath}`);
        }
      } catch (err) {
        console.error(`Error processing ${filePath}:`, err);
        results.push({
          success: false,
          filePath,
          modificationType: 'add_role',
          description: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      }
    }

    console.log(`Completed: ${results.filter(r => r.success).length} successful, ${results.filter(r => !r.success).length} failed`);
    return results;
  }

  async scanEpubTypes(zip: JSZip): Promise<{
    epubTypes: Array<{
      value: string;
      file: string;
      count: number;
      suggestedRole: string;
      elementType: string;
    }>;
    files: string[];
  }> {
    console.log('=== scanEpubTypes START ===');

    const epubTypeMap = new Map<string, {
      value: string;
      files: Set<string>;
      count: number;
      elementType: string;
    }>();
    const scannedFiles: string[] = [];

    const roleMapping: Record<string, string> = {
      'chapter': 'doc-chapter',
      'part': 'doc-part',
      'toc': 'doc-toc',
      'nav': 'navigation',
      'landmarks': 'navigation',
      'frontmatter': 'doc-prologue',
      'bodymatter': 'main',
      'backmatter': 'doc-epilogue',
      'titlepage': 'doc-cover',
      'dedication': 'doc-dedication',
      'epigraph': 'doc-epigraph',
      'noteref': 'doc-noteref',
      'rearnote': 'doc-endnote',
      'rearnotes': 'doc-endnotes',
    };

    const allFiles = Object.keys(zip.files);
    console.log('All files in EPUB:', allFiles);

    const xhtmlFiles = allFiles.filter(path =>
      /\.(xhtml|html|htm)$/i.test(path) && !zip.files[path].dir
    );
    console.log('XHTML files to scan:', xhtmlFiles);

    for (const filePath of xhtmlFiles) {
      try {
        const content = await zip.file(filePath)?.async('text');
        if (!content) {
          console.log(`No content for ${filePath}`);
          continue;
        }

        console.log(`\n--- Scanning: ${filePath} ---`);
        console.log(`Content length: ${content.length} chars`);

        const rawMatches = content.match(/epub:type\s*=\s*["'][^"']+["']/g);
        console.log(`Raw epub:type matches in ${filePath}:`, rawMatches);

        scannedFiles.push(filePath);

        const $ = cheerio.load(content, {
          xmlMode: true,
          decodeEntities: false
        });

        const selector1 = $('[epub\\:type]');
        const selector2 = $('*').filter((_, el) => $(el).attr('epub:type') !== undefined);

        console.log(`Selector [epub\\:type] found: ${selector1.length} elements`);
        console.log(`Filter method found: ${selector2.length} elements`);

        selector2.each((_, elem) => {
          const epubTypeAttr = $(elem).attr('epub:type');
          console.log(`Found element: <${elem.tagName}> with epub:type="${epubTypeAttr}"`);

          if (!epubTypeAttr) return;

          const types = epubTypeAttr.trim().split(/\s+/);
          const elementType = elem.tagName?.toLowerCase() || 'unknown';

          for (const type of types) {
            const normalizedType = type.toLowerCase();
            const existing = epubTypeMap.get(normalizedType);

            if (existing) {
              existing.files.add(filePath);
              existing.count++;
            } else {
              epubTypeMap.set(normalizedType, {
                value: type,
                files: new Set([filePath]),
                count: 1,
                elementType,
              });
            }
          }
        });
      } catch (err) {
        console.error(`Error parsing ${filePath}:`, err);
      }
    }

    const epubTypes = Array.from(epubTypeMap.entries()).map(([key, data]) => ({
      value: data.value,
      file: Array.from(data.files).join(', '),
      count: data.count,
      suggestedRole: roleMapping[key] || 'region',
      elementType: data.elementType,
    }));

    console.log('\n=== scanEpubTypes RESULT ===');
    console.log('Total unique epub:types found:', epubTypes.length);
    console.log('epub:types:', epubTypes);
    console.log('Files scanned:', scannedFiles);

    return {
      epubTypes: epubTypes.sort((a, b) => b.count - a.count),
      files: scannedFiles,
    };
  }
}

interface FileChange {
  type: 'insert' | 'replace' | 'delete';
  filePath: string;
  content?: string;
  oldContent?: string;
  lineNumber?: number;
  description?: string;
}

export type { FileChange };

export const epubModifier = new EPUBModifierService();
