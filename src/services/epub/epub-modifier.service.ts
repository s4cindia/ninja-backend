import JSZip from 'jszip';
import * as cheerio from 'cheerio';

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
      const featurePattern = new RegExp(`schema:accessibilityFeature[^>]*>${feature}<`, 'i');
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

      $('img').each((_, el) => {
        const $el = $(el);
        if (!$el.attr('alt')) {
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
          description: `Marked ${count} image(s) as decorative with alt=""`,
        });
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
}

export const epubModifier = new EPUBModifierService();
