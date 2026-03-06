/**
 * DOCX Conversion Service
 *
 * Uses Pandoc for high-fidelity DOCX to HTML conversion and vice versa.
 * Pandoc preserves:
 * - Table formatting (borders, cell styles, column widths)
 * - Footnotes and endnotes
 * - Lists with proper numbering/bullets
 * - Images (embedded or linked)
 * - Text styling (bold, italic, underline, colors)
 * - Headings and paragraph styles
 *
 * Falls back to mammoth.js if Pandoc is not available.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as mammoth from 'mammoth';
import * as JSZip from 'jszip';
import pdfParse from 'pdf-parse';
import { logger } from '../../lib/logger';
import { computeWordSimilarity, computeSequenceSimilarity } from '../../utils/text-similarity';

type PdfParseResult = {
  numpages: number;
  text: string;
  info: { Title?: string; Author?: string };
};

const execAsync = promisify(exec);

/**
 * Conversion result with content and metadata
 */
export interface ConversionResult {
  html: string;
  styles: string;
  warnings: string[];
  metadata: {
    wordCount: number;
    tableCount: number;
    imageCount: number;
    footnoteCount: number;
  };
  usedPandoc: boolean;
}

let pandocPath: string | null = null;
let libreOfficePath: string | null = null;

/**
 * Check if Pandoc is available
 */
async function isPandocAvailable(): Promise<boolean> {
  // Try standard pandoc first, then user-specific locations, then env-configured path
  const commands = [
    'pandoc',
    process.env.HOME ? `${process.env.HOME}/.local/bin/pandoc.exe` : '',
    process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.local\\bin\\pandoc.exe` : '',
    process.env.PANDOC_PATH || '',
  ].filter(Boolean);

  for (const cmd of commands) {
    try {
      await execAsync(`"${cmd}" --version`);
      pandocPath = cmd;
      logger.info(`[DocxConversion] Found Pandoc at: ${cmd}`);
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

/**
 * Get the working Pandoc path
 */
function getPandocPath(): string {
  return pandocPath || 'pandoc';
}

/**
 * Check if LibreOffice is available (for high-fidelity DOCX conversion)
 */
async function isLibreOfficeAvailable(): Promise<boolean> {
  if (libreOfficePath) return true;

  const commands = [
    'soffice',
    'libreoffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ].filter(Boolean);

  for (const cmd of commands) {
    try {
      await execAsync(`${cmd} --version`, { timeout: 5000 });
      libreOfficePath = cmd;
      logger.info(`[DocxConversion] Found LibreOffice at: ${cmd}`);
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

/**
 * Get the working LibreOffice path
 */
function getLibreOfficePath(): string {
  return libreOfficePath || 'soffice';
}

/**
 * Convert DOCX to HTML using LibreOffice headless.
 * LibreOffice renders equations as images, preserves tables, and maintains formatting.
 */
async function convertWithLibreOffice(docxPath: string, docxBuffer: Buffer): Promise<string> {
  const outDir = path.dirname(docxPath);
  const soffice = getLibreOfficePath();

  await execAsync(
    `${soffice} --headless --convert-to html:"HTML (StarWriter)" --outdir "${outDir}" "${docxPath}"`,
    { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
  );

  const htmlPath = docxPath.replace(/\.docx$/i, '.html');
  let html = await fs.readFile(htmlPath, 'utf-8');
  await fs.unlink(htmlPath).catch(() => {});

  // LibreOffice may produce companion image files alongside the HTML.
  // Embed them as base64 and also check DOCX media for any referenced images.
  const mediaMap = await extractAndEmbedMedia(docxBuffer);

  // Embed external image references from the output directory
  const imgRefPattern = /src="([^"]+)"/g;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRefPattern.exec(html)) !== null) {
    const imgSrc = imgMatch[1];
    // Skip already-embedded base64 images
    if (imgSrc.startsWith('data:')) continue;

    const imgPath = path.resolve(outDir, imgSrc);
    try {
      const imgBuffer = await fs.readFile(imgPath);
      const ext = path.extname(imgSrc).toLowerCase();
      let mime = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.svg') mime = 'image/svg+xml';
      const dataUrl = `data:${mime};base64,${imgBuffer.toString('base64')}`;
      html = html.replace(new RegExp(imgSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), dataUrl);
      // Clean up the image file
      await fs.unlink(imgPath).catch(() => {});
    } catch {
      // Image file not found — check DOCX media map
      const fileName = path.basename(imgSrc);
      const docxDataUrl = mediaMap.get(fileName);
      if (docxDataUrl) {
        html = html.replace(new RegExp(imgSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), docxDataUrl);
      }
    }
  }

  // Extract just the body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    html = bodyMatch[1].trim();
  }

  // Convert deprecated <font> tags to <span> with inline styles so TipTap can parse them.
  // LibreOffice uses <font face="..." size="..." style="font-size: ..."> extensively.
  html = html.replace(/<font([^>]*)>/gi, (_match, attrs: string) => {
    const styles: string[] = [];
    const faceMatch = attrs.match(/face="([^"]+)"/i);
    if (faceMatch) styles.push(`font-family: ${faceMatch[1]}`);
    const styleMatch = attrs.match(/style="([^"]+)"/i);
    if (styleMatch) styles.push(styleMatch[1].trim().replace(/;$/, ''));
    const colorMatch = attrs.match(/color="([^"]+)"/i);
    if (colorMatch) styles.push(`color: ${colorMatch[1]}`);
    return styles.length > 0 ? `<span style="${styles.join('; ')}">` : '<span>';
  });
  html = html.replace(/<\/font>/gi, '</span>');

  // LibreOffice wraps whitespace between text runs in separate <span> elements,
  // e.g. </b></span></span><span...><span...>\n</span></span><span...>.
  // TipTap strips these whitespace-only spans, joining adjacent text.
  // Collapse them into a single space to preserve word boundaries.
  html = html.replace(/<\/span>\s*<span[^>]*>\s*<span[^>]*>\s*\n\s*<\/span>\s*<\/span>\s*<span/gi,
    '</span> <span');

  // Also ensure space after closing inline formatting tags when next char is a letter
  html = html.replace(/<\/(b|i|strong|em)>(<\/span>)*\s*(<span[^>]*>)*(<span[^>]*>)*([A-Za-z])/gi,
    '</$1>$2 $3$4$5');

  // Remove diagram/figure annotation elements that produce garbage text in the editor.
  // These are small positioned textboxes and frames that label figure components.
  // Collect all removal ranges first, then rebuild the string once (avoids O(k*n) from
  // repeated string slicing inside a loop).
  const removalRanges: Array<[number, number]> = [];

  const findSpanRange = (id: string): void => {
    const openTag = `id="${id}"`;
    let idx = html.indexOf(openTag);
    while (idx >= 0) {
      const start = html.lastIndexOf('<span', idx);
      if (start < 0) { idx = html.indexOf(openTag, idx + 1); continue; }
      let depth = 0;
      let pos = start;
      while (pos < html.length) {
        const nextOpen = html.indexOf('<span', pos + 1);
        const nextClose = html.indexOf('</span>', pos + 1);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) { depth++; pos = nextOpen; }
        else if (depth > 0) { depth--; pos = nextClose; }
        else { removalRanges.push([start, nextClose + 7]); break; }
      }
      idx = html.indexOf(openTag, idx + 1);
    }
  };

  // Collect textbox spans (figure/diagram annotations like "Scale factor", "O₂", "Controller 2")
  const textboxIds = html.match(/id="(textbox\d+)"/gi) || [];
  for (const m of textboxIds) {
    const id = m.match(/id="([^"]+)"/)?.[1];
    if (id) findSpanRange(id);
  }

  // Collect small Frame spans (< 1.5 inch wide — also diagram annotations)
  const framePattern = /id="(Frame\d+)"[^>]*width:\s*([\d.]+)\s*(in|pt|px)/gi;
  let frameMatch: RegExpExecArray | null;
  while ((frameMatch = framePattern.exec(html)) !== null) {
    const width = parseFloat(frameMatch[2]);
    const unit = frameMatch[3];
    const widthInInches = unit === 'in' ? width : unit === 'pt' ? width / 72 : width / 96;
    if (widthInInches < 1.5) findSpanRange(frameMatch[1]);
  }

  // Apply all removals in a single pass (sort by start, merge overlaps, rebuild once)
  if (removalRanges.length > 0) {
    removalRanges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [removalRanges[0]];
    for (let i = 1; i < removalRanges.length; i++) {
      const prev = merged[merged.length - 1];
      if (removalRanges[i][0] <= prev[1]) {
        prev[1] = Math.max(prev[1], removalRanges[i][1]);
      } else {
        merged.push(removalRanges[i]);
      }
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) parts.push(html.slice(cursor, start));
      cursor = end;
    }
    if (cursor < html.length) parts.push(html.slice(cursor));
    html = parts.join('');
  }

  // Strip absolute positioning CSS from remaining elements so text flows normally
  html = html.replace(/position:\s*absolute\s*;?\s*/gi, '');
  html = html.replace(/\s*top:\s*-?[\d.]+\s*(in|pt|px|cm|mm|em|%)\s*;?\s*/gi, ' ');
  html = html.replace(/\s*left:\s*-?[\d.]+\s*(in|pt|px|cm|mm|em|%)\s*;?\s*/gi, ' ');

  // Remove VML shape wrappers (decorative images only)
  html = html.replace(/<span[^>]*class="sd-abs-pos"[^>]*><img[^>]*\/?><\/span>/gi, '');

  // Remove the <div title="header"> block (journal running header — not part of content)
  html = html.replace(/<div\s+title="header"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Clean up empty style attributes
  html = html.replace(/\s*style="\s*"/gi, '');

  // Remove blank paragraphs: <p> containing only whitespace, &nbsp;, <br>, or empty spans.
  // TipTap strips CSS classes so we can't style blank lines — just remove them.
  const emptyParagraph = /<p[^>]*>(?:\s|&nbsp;|<br\s*\/?>|<span[^>]*>\s*<\/span>)*<\/p>/gi;
  html = html.replace(emptyParagraph, '<!-- empty -->')
    // Keep max 1 blank paragraph between content sections
    .replace(/(<!-- empty -->\s*){2,}/gi, '')
    .replace(/<!-- empty -->/gi, '');

  // Add cellpadding to tables for readability
  html = html.replace(/<table([^>]*)cellpadding="0"/gi, '<table$1cellpadding="4"');

  return html;
}

/**
 * Create a temporary file from buffer
 */
async function createTempFile(buffer: Buffer, extension: string): Promise<string> {
  const tempDir = os.tmpdir();
  const fileName = `docx-conv-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
  const filePath = path.join(tempDir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Clean up temporary file
 */
async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Extract media files from DOCX and save to temp directory
 * Returns map of original paths to new base64 data URLs
 */
async function extractAndEmbedMedia(docxBuffer: Buffer): Promise<Map<string, string>> {
  const mediaMap = new Map<string, string>();

  try {
    const zip = await JSZip.loadAsync(docxBuffer);
    const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith('word/media/'));

    for (const mediaPath of mediaFiles) {
      const file = zip.file(mediaPath);
      if (file) {
        const data = await file.async('base64');
        const fileName = path.basename(mediaPath);
        const ext = path.extname(fileName).toLowerCase();

        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.svg') mimeType = 'image/svg+xml';
        else if (ext === '.webp') mimeType = 'image/webp';
        else if (ext === '.emf') mimeType = 'image/emf';
        else if (ext === '.wmf') mimeType = 'image/wmf';

        mediaMap.set(fileName, `data:${mimeType};base64,${data}`);
      }
    }
  } catch (error) {
    logger.warn('[DocxConversion] Failed to extract media:', error);
  }

  return mediaMap;
}

/**
 * Convert DOCX to HTML using Pandoc
 */
async function convertWithPandoc(docxPath: string, mediaMap: Map<string, string>): Promise<string> {
  // Pandoc options for best HTML output:
  // --standalone: Include full HTML document structure
  // --embed-resources: Embed images as base64
  // --wrap=none: Don't wrap lines
  // --track-changes=all: Preserve track changes as markup
  const pandoc = getPandocPath();
  const { stdout } = await execAsync(
    `"${pandoc}" "${docxPath}" -f docx -t html --standalone --wrap=none --track-changes=all 2>&1`,
    { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for large documents
  );

  let html = stdout;

  // Replace image references with base64 data URLs
  mediaMap.forEach((dataUrl, fileName) => {
    // Escape regex metacharacters in filename to prevent ReDoS
    const safeFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Pandoc generates img src like "media/image1.png" or "./media/image1.png"
    const patterns = [
      new RegExp(`src="[^"]*${safeFileName}"`, 'g'),
      new RegExp(`src='[^']*${safeFileName}'`, 'g'),
    ];
    patterns.forEach(pattern => {
      html = html.replace(pattern, `src="${dataUrl}"`);
    });
  });

  return html;
}

/**
 * Convert DOCX to HTML using mammoth (fallback)
 */
async function convertWithMammoth(buffer: Buffer): Promise<{ html: string; warnings: string[] }> {
  const styleMap = [
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Heading 5'] => h5:fresh",
    "p[style-name='Heading 6'] => h6:fresh",
    "p[style-name='Footnote Text'] => p.footnote:fresh",
    "r[style-name='Footnote Reference'] => sup.footnote-ref",
    "p[style-name='Quote'] => blockquote:fresh",
    "p[style-name='List Paragraph'] => li:fresh",
  ];

  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap,
      convertImage: {
        img: async (image: { read: () => Promise<Buffer>; contentType?: string }) => {
          try {
            const imageBuffer = await image.read();
            const base64 = imageBuffer.toString('base64');
            const contentType = image.contentType || 'image/png';
            return { src: `data:${contentType};base64,${base64}` };
          } catch {
            return { src: '' };
          }
        },
      } as mammoth.Options['convertImage'],
      includeDefaultStyleMap: true,
    }
  );

  return {
    html: result.value,
    warnings: result.messages.map(m => m.message),
  };
}

/**
 * Post-process HTML to infer headings from formatting
 * Converts <p><strong>Short Text</strong></p> to proper heading tags
 */
function inferHeadingsFromFormatting(html: string): string {
  // Pattern: <p> containing only <strong> or <em><strong> with short text (likely a heading)
  // Match paragraphs that are ONLY bold text (no other content)
  const headingPattern = /<p>(\s*<(strong|b)>([^<]{1,100})<\/(strong|b)>\s*)<\/p>/gi;

  let result = html;
  const matches = [...html.matchAll(headingPattern)];

  for (const match of matches) {
    const fullMatch = match[0];
    const innerText = match[3].trim();

    // Skip if it looks like a regular sentence (has punctuation at end or is too long)
    if (innerText.length > 80 || /[.,:;]$/.test(innerText)) {
      continue;
    }

    // Skip numbered items like "1." or bullet points
    if (/^\d+\.?\s/.test(innerText) || /^[•\-\*]\s/.test(innerText)) {
      continue;
    }

    // Determine heading level based on context and text patterns
    let headingLevel = 2; // Default to h2

    // Common section headings
    const h1Patterns = /^(abstract|introduction|conclusion|references|bibliography|acknowledgments?|methods|results|discussion|summary)$/i;
    const h2Patterns = /^(background|materials|data|analysis|limitations|future work|related work|methodology|findings|implications)$/i;

    if (h1Patterns.test(innerText)) {
      headingLevel = 1;
    } else if (h2Patterns.test(innerText)) {
      headingLevel = 2;
    } else if (innerText.length < 30) {
      headingLevel = 3;
    }

    // Replace with proper heading
    const replacement = `<h${headingLevel}>${innerText}</h${headingLevel}>`;
    result = result.replace(fullMatch, replacement);
  }

  return result;
}

/**
 * Post-process HTML to handle different list types
 * Pandoc may not distinguish between different bullet styles
 */
function improveListFormatting(html: string): string {
  let result = html;

  // Fix nested paragraphs in list items - remove <p> wrapper inside <li>
  // Handle multiline content: <li><p>content</p></li> -> <li>content</li>
  result = result.replace(/<li>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g, '<li>$1</li>');

  // Also handle cases with attributes: <li><p class="...">
  result = result.replace(/<li>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/g, '<li>$1</li>');

  // Detect reference/bibliography sections and add class for styling
  // Look for "References" heading followed by ordered list
  result = result.replace(
    /(<h[1-3]>References<\/h[1-3]>\s*)(<ol[^>]*>)/gi,
    '$1<ol class="reference-list" type="1">'
  );

  // Also handle case where References isn't converted to heading yet
  result = result.replace(
    /(<p>\s*References\s*<\/p>\s*)(<ol[^>]*>)/gi,
    '<h2>References</h2><ol class="reference-list" type="1">'
  );

  return result;
}

/**
 * Parsed style info from a DOCX word/styles.xml
 */
interface DocxStyleInfo {
  defaultFont?: string;
  defaultSize?: number; // in pt
  normal?: { font?: string; size?: number; bold?: boolean; italic?: boolean };
  headings: Record<number, { font?: string; size?: number; bold?: boolean; italic?: boolean; color?: string }>;
  title?: { font?: string; size?: number; bold?: boolean; italic?: boolean };
}

/**
 * Extract actual styles from a DOCX buffer by reading word/styles.xml
 */
export async function extractDocxStyles(buffer: Buffer): Promise<DocxStyleInfo> {
  const info: DocxStyleInfo = { headings: {} };
  try {
    const zip = await JSZip.loadAsync(buffer);
    const stylesXml = await zip.file('word/styles.xml')?.async('string');
    if (!stylesXml) return info;

    // Document defaults
    const defaultsBlock = stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] || '';
    const defFont = defaultsBlock.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1];
    const defSize = defaultsBlock.match(/<w:sz w:val="(\d+)"/)?.[1];
    if (defFont) info.defaultFont = defFont;
    if (defSize) info.defaultSize = parseInt(defSize) / 2;

    // Parse individual styles
    const styleBlocks = stylesXml.match(/<w:style[\s\S]*?<\/w:style>/g) || [];
    for (const block of styleBlocks) {
      const id = block.match(/w:styleId="([^"]+)"/)?.[1];
      if (!id) continue;

      const font = block.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1];
      const sz = block.match(/<w:sz w:val="(\d+)"/)?.[1];
      const bold = block.includes('<w:b/>') || block.includes('<w:b ');
      const italic = block.includes('<w:i/>') || block.includes('<w:i ');
      const color = block.match(/<w:color w:val="([^"]+)"/)?.[1];
      const parsed = {
        font: font || undefined,
        size: sz ? parseInt(sz) / 2 : undefined,
        bold,
        italic,
        color: color || undefined,
      };

      if (id === 'Normal') info.normal = parsed;
      else if (id === 'Title') info.title = parsed;
      else if (id.startsWith('Heading')) {
        const level = parseInt(id.replace('Heading', ''));
        if (level >= 1 && level <= 6) info.headings[level] = parsed;
      }
    }
  } catch (e) {
    logger.warn('[DocxConversion] Could not extract DOCX styles, using defaults', e);
  }
  return info;
}

/**
 * Inline critical DOCX styles directly onto HTML elements.
 * TipTap strips <style> blocks and custom CSS classes, so Pandoc's class-based
 * output loses all formatting. This function adds inline style="" attributes
 * to headings, paragraphs, and table cells so TipTap preserves them.
 *
 * NOTE: The regex patterns (e.g. /<h${lvl}([^>]*)>/gi) assume Pandoc's predictable
 * single-line HTML output. They would fail on attributes spanning multiple lines,
 * attributes containing '>' in quoted values, or escaped quotes. This is acceptable
 * because our only HTML source is Pandoc, which produces well-structured single-line tags.
 */
function inlineDocxStyles(html: string, docxStyles?: DocxStyleInfo): string {
  const bodyFont = docxStyles?.normal?.font || docxStyles?.defaultFont || 'Calibri';
  const bodySize = docxStyles?.normal?.size || docxStyles?.defaultSize || 11;

  // Build inline style strings for each heading level
  const fallbackSizes: Record<number, number> = { 1: 24, 2: 18, 3: 14, 4: 12, 5: 11, 6: 10 };
  const minRatios: Record<number, number> = { 1: 1.8, 2: 1.4, 3: 1.2, 4: 1.1, 5: 1.0, 6: 0.9 };

  const headingStyles: Record<number, string> = {};
  const headingColors: Record<number, string> = {};
  for (let lvl = 1; lvl <= 6; lvl++) {
    const ext = docxStyles?.headings[lvl];
    const font = ext?.font || bodyFont;
    const rawSize = ext?.size || fallbackSizes[lvl] || 12;
    const minSize = Math.round(bodySize * (minRatios[lvl] || 1.0));
    const size = Math.max(rawSize, minSize);
    // Keep color on the element style for non-TipTap renderers, but also track it
    // separately so we can inject a <span> for TipTap's Color extension (span-level only).
    const color = ext?.color ? `color: #${ext.color}; ` : '';
    if (ext?.color) headingColors[lvl] = `#${ext.color}`;
    const style = ext?.italic ? 'font-style: italic; ' : '';
    headingStyles[lvl] = `font-family: '${font}', sans-serif; font-size: ${size}pt; font-weight: bold; ${style}${color}margin: ${Math.round(size * 0.75)}pt 0 ${Math.round(size * 0.375)}pt 0;`;
  }

  // Inline styles onto heading tags
  for (let lvl = 1; lvl <= 6; lvl++) {
    const re = new RegExp(`<h${lvl}([^>]*)>`, 'gi');
    html = html.replace(re, (_match, attrs) => {
      const existingStyle = attrs.match(/style="([^"]*)"/)?.[1] || '';
      const merged = existingStyle ? `${existingStyle}; ${headingStyles[lvl]}` : headingStyles[lvl];
      const cleanAttrs = attrs.replace(/style="[^"]*"/, '').trim();
      return `<h${lvl} ${cleanAttrs} style="${merged}">`.replace(/\s+/g, ' ');
    });
  }

  // TipTap only preserves color via TextStyle marks (span-level), not on block elements.
  // Wrap heading content in <span style="color:..."> so the Color extension keeps it.
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (!headingColors[lvl]) continue;
    const re = new RegExp(`(<h${lvl}[^>]*>)([\\s\\S]*?)(<\\/h${lvl}>)`, 'gi');
    html = html.replace(re, `$1<span style="color: ${headingColors[lvl]}">$2</span>$3`);
  }

  // Inline base font on the container div (TipTap strips the div but ProseMirror inherits)
  // Instead, apply to each <p> so TipTap's TextStyle extension preserves it
  const pStyle = `font-family: '${bodyFont}', sans-serif; font-size: ${bodySize}pt; line-height: 1.5;`;
  html = html.replace(/<p([^>]*)>/gi, (_match, attrs) => {
    const existingStyle = attrs.match(/style="([^"]*)"/)?.[1] || '';
    if (existingStyle) return _match; // don't override existing inline styles
    const cleanAttrs = attrs.replace(/style="[^"]*"/, '').trim();
    return `<p ${cleanAttrs} style="${pStyle}">`.replace(/\s+/g, ' ');
  });

  // Inline table cell styles
  html = html.replace(/<td([^>]*)>/gi, (_match, attrs) => {
    const existingStyle = attrs.match(/style="([^"]*)"/)?.[1] || '';
    const base = `border: 1px solid #333; padding: 6pt 8pt; vertical-align: top; font-size: ${bodySize}pt;`;
    const merged = existingStyle ? `${existingStyle}; ${base}` : base;
    const cleanAttrs = attrs.replace(/style="[^"]*"/, '').trim();
    return `<td ${cleanAttrs} style="${merged}">`.replace(/\s+/g, ' ');
  });

  html = html.replace(/<th([^>]*)>/gi, (_match, attrs) => {
    const existingStyle = attrs.match(/style="([^"]*)"/)?.[1] || '';
    const base = `border: 1px solid #333; padding: 6pt 8pt; vertical-align: top; font-weight: bold; background-color: #f0f0f0; font-size: ${bodySize}pt;`;
    const merged = existingStyle ? `${existingStyle}; ${base}` : base;
    const cleanAttrs = attrs.replace(/style="[^"]*"/, '').trim();
    return `<th ${cleanAttrs} style="${merged}">`.replace(/\s+/g, ' ');
  });

  return html;
}

/**
 * Generate CSS styles for the document, using extracted DOCX styles when available
 */
export function generateStyles(docxStyles?: DocxStyleInfo): string {
  // Resolve fonts and sizes from extracted styles, with sensible fallbacks
  const bodyFont = docxStyles?.normal?.font || docxStyles?.defaultFont || 'Calibri';
  const bodySize = docxStyles?.normal?.size || docxStyles?.defaultSize || 11;

  const h = (level: number) => {
    const extracted = docxStyles?.headings[level];
    const fallbackSizes: Record<number, number> = { 1: 24, 2: 18, 3: 14, 4: 12, 5: 11, 6: 10 };
    const font = extracted?.font || bodyFont;
    const extractedSize = extracted?.size || fallbackSizes[level] || 12;
    // Enforce minimum heading sizes relative to body text so headings are visually distinct.
    // E.g., if body is 11pt and h1 extracted as 15pt, bump h1 to at least bodySize * 1.8 = ~20pt
    const minSizeRatios: Record<number, number> = { 1: 1.8, 2: 1.4, 3: 1.2, 4: 1.1, 5: 1.0, 6: 0.9 };
    const minSize = Math.round(bodySize * (minSizeRatios[level] || 1.0));
    const size = Math.max(extractedSize, minSize);
    // Always enforce bold for headings — even if the DOCX style says normal weight,
    // headings must be visually distinct from body text in the editor.
    const weight = 'bold';
    const style = extracted?.italic ? 'italic' : 'normal';
    const color = extracted?.color ? `color: #${extracted.color};` : '';
    const margin = Math.round(size * 0.75);
    return `.docx-content h${level} { font-family: '${font}', sans-serif; font-size: ${size}pt; font-weight: ${weight}; font-style: ${style}; ${color} margin: ${margin}pt 0 ${Math.round(margin / 2)}pt 0; }`;
  };

  return `
<style>
  /* Document container — styles extracted from original DOCX */
  .docx-content {
    font-family: '${bodyFont}', 'Arial', sans-serif;
    font-size: ${bodySize}pt;
    line-height: 1.5;
    color: #000;
    max-width: 100%;
  }

  /* Headings */
  ${h(1)}
  ${h(2)}
  ${h(3)}
  ${h(4)}
  ${h(5)}
  ${h(6)}

  /* Paragraphs */
  .docx-content p { margin: 0 0 ${Math.round(bodySize * 0.5)}pt 0; line-height: 1.4; }

  /* Tables - preserve borders and structure */
  .docx-content table {
    border-collapse: collapse;
    width: 100%;
    margin: 12pt 0;
    font-size: ${bodySize}pt;
  }
  .docx-content th, .docx-content td {
    border: 1px solid #333;
    padding: 6pt 8pt;
    vertical-align: top;
    line-height: 1.3;
  }
  .docx-content th {
    background-color: #f0f0f0;
    font-weight: bold;
  }
  .docx-content thead th {
    background-color: #e0e0e0;
  }
  /* Style first row as header when no <th> elements are used */
  .docx-content table tr:first-child td {
    font-weight: bold;
    background-color: #f5f5f5;
    border-bottom: 2px solid #333;
  }

  /* Lists */
  .docx-content ul, .docx-content ol {
    margin: 10pt 0 10pt 0;
    padding-left: 24pt;
  }
  .docx-content li {
    margin-bottom: 6pt;
    line-height: 1.5;
  }
  .docx-content li p {
    margin: 0;
    display: inline;
  }

  /* Numbered lists - ensure numbers show */
  .docx-content ol {
    list-style-type: decimal;
    list-style-position: outside;
  }
  .docx-content ol[type="1"] {
    list-style-type: decimal;
  }
  .docx-content ol[type="a"] {
    list-style-type: lower-alpha;
  }
  .docx-content ol[type="A"] {
    list-style-type: upper-alpha;
  }
  .docx-content ol[type="i"] {
    list-style-type: lower-roman;
  }
  .docx-content ol[type="I"] {
    list-style-type: upper-roman;
  }

  /* Bullet lists */
  .docx-content ul {
    list-style-type: disc;
    list-style-position: outside;
  }

  /* Nested lists */
  .docx-content ul ul, .docx-content ol ol,
  .docx-content ul ol, .docx-content ol ul {
    margin: 6pt 0 6pt 0;
    padding-left: 24pt;
  }
  .docx-content ul ul {
    list-style-type: circle;
  }
  .docx-content ul ul ul {
    list-style-type: square;
  }

  /* Reference/Bibliography list */
  .docx-content ol.reference-list {
    padding-left: 36pt;
  }
  .docx-content ol.reference-list li {
    margin-bottom: 8pt;
    text-indent: -12pt;
    padding-left: 12pt;
  }

  /* Footnotes */
  .docx-content .footnotes {
    border-top: 1px solid #ccc;
    margin-top: 24pt;
    padding-top: 12pt;
    font-size: 9pt;
  }
  .docx-content .footnote-ref, .docx-content .footnote-back {
    text-decoration: none;
    color: #0066cc;
  }
  .docx-content .footnote-ref {
    vertical-align: super;
    font-size: 0.8em;
  }

  /* Endnotes */
  .docx-content section.endnotes {
    border-top: 1px solid #ccc;
    margin-top: 24pt;
    padding-top: 12pt;
  }

  /* Block quotes - Pandoc wraps indented academic text in blockquotes,
     so keep normal styling (not italic/gray) */
  .docx-content blockquote {
    margin: 0 0 0 0;
    padding: 0 0 0 0;
    border-left: none;
    font-style: normal;
    color: inherit;
  }
  .docx-content blockquote p {
    margin: 0 0 ${Math.round(bodySize * 0.9)}pt 0;
  }

  /* Images - inline equation images stay inline, large figures are block-centered */
  .docx-content img {
    max-width: 100%;
    height: auto;
  }
  /* Small images (equations, symbols) display inline */
  .docx-content p > img {
    display: inline;
    vertical-align: middle;
    margin: 0 2pt;
  }
  /* Large standalone images (figures) display as block centered */
  .docx-content p > img:only-child {
    display: block;
    margin: 12pt auto;
    max-width: 80%;
  }
  .docx-content figure {
    margin: 12pt 0;
    text-align: center;
  }
  .docx-content figcaption {
    font-size: 10pt;
    color: #555;
    margin-top: 6pt;
  }

  /* Code */
  .docx-content pre, .docx-content code {
    font-family: 'Consolas', 'Courier New', monospace;
    background-color: #f5f5f5;
  }
  .docx-content pre {
    padding: 12pt;
    overflow-x: auto;
    border: 1px solid #ddd;
  }
  .docx-content code {
    padding: 2pt 4pt;
  }

  /* Track changes (if preserved by Pandoc) */
  .docx-content ins {
    background-color: #d4edda;
    text-decoration: underline;
  }
  .docx-content del {
    background-color: #f8d7da;
    text-decoration: line-through;
  }

  /* Subscript and superscript */
  .docx-content sub { vertical-align: sub; font-size: 0.8em; }
  .docx-content sup { vertical-align: super; font-size: 0.8em; }

  /* Links */
  .docx-content a {
    color: #0066cc;
    text-decoration: underline;
  }

  /* Page breaks (visual indicator in editor) */
  .docx-content hr.pagebreak {
    border: none;
    border-top: 2px dashed #ccc;
    margin: 24pt 0;
  }
</style>
`;
}

/**
 * Convert DOCX buffer to HTML with formatting preservation.
 * Priority: LibreOffice (best for complex DOCX) → Pandoc → mammoth
 */
export async function convertDocxToHtml(buffer: Buffer): Promise<ConversionResult> {
  const warnings: string[] = [];
  let html = '';
  let usedPandoc = false;
  let usedConverter: 'libreoffice' | 'pandoc' | 'mammoth' = 'mammoth';
  let docxPath: string | null = null;

  try {
    // Extract media files first
    const mediaMap = await extractAndEmbedMedia(buffer);
    const imageCount = mediaMap.size;

    // Priority 1: Try LibreOffice (best fidelity for complex DOCX with equations/tables)
    const libreOfficeAvailable = await isLibreOfficeAvailable();
    if (libreOfficeAvailable) {
      try {
        docxPath = await createTempFile(buffer, '.docx');
        html = await convertWithLibreOffice(docxPath, buffer);
        usedConverter = 'libreoffice';
        logger.info('[DocxConversion] Converted using LibreOffice');
      } catch (loErr) {
        logger.warn('[DocxConversion] LibreOffice conversion failed, trying Pandoc:', loErr);
        html = '';
      }
    }

    // Priority 2: Try Pandoc
    if (!html) {
      const pandocAvailable = await isPandocAvailable();
      if (pandocAvailable) {
        if (!docxPath) docxPath = await createTempFile(buffer, '.docx');
        html = await convertWithPandoc(docxPath, mediaMap);
        usedPandoc = true;
        usedConverter = 'pandoc';
        logger.info('[DocxConversion] Converted using Pandoc');
      }
    }

    // Priority 3: Fall back to mammoth
    if (!html) {
      const result = await convertWithMammoth(buffer);
      html = result.html;
      warnings.push(...result.warnings);
      warnings.push('Pandoc/LibreOffice not available - using mammoth.js (some formatting may be lost)');
      usedConverter = 'mammoth';
      logger.info('[DocxConversion] Converted using mammoth (Pandoc/LibreOffice not available)');
    }

    // Extract just the body content if Pandoc generated full HTML
    if (usedConverter === 'pandoc' && html.includes('<body')) {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) {
        html = bodyMatch[1].trim();
      }
    }

    // Fix missing spaces at formatting boundaries.
    // Both Pandoc and LibreOffice can produce HTML where closing inline tags
    // (<b>, <i>, <em>, <strong>) run directly into the next word with no space.
    // TipTap strips whitespace-only nodes, so we must inject spaces explicitly.
    html = html.replace(/<\/(b|i|strong|em)>([A-Z])/g, '</$1> $2');
    html = html.replace(/<\/(b|i|strong|em)>(<\/span>)+\s*(<span[^>]*>)+([A-Z])/g,
      (match, tag, closeSpans, openSpans, letter) =>
        `</${tag}>${closeSpans} ${openSpans}${letter}`);

    // Post-process to infer headings from bold-only paragraphs
    html = inferHeadingsFromFormatting(html);

    // Improve list formatting
    html = improveListFormatting(html);

    // Wrap in container
    html = `<div class="docx-content">${html}</div>`;

    // Extract actual styles from the DOCX and generate matching CSS
    const docxStyles = await extractDocxStyles(buffer);
    const styles = generateStyles(docxStyles);

    // Inline critical styles onto HTML elements so TipTap preserves them.
    // TipTap strips <style> blocks and custom classes, so Pandoc's class-based
    // CSS never reaches the rendered editor. Mammoth doesn't have this problem
    // because it produces inline styles natively.
    if (usedConverter === 'pandoc') {
      html = inlineDocxStyles(html, docxStyles);
    }

    // Calculate metadata
    const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;
    const tableCount = (html.match(/<table/g) || []).length;
    const footnoteCount = (html.match(/class="footnote/g) || []).length +
                          (html.match(/<aside[^>]*epub:type="footnote"/g) || []).length +
                          (html.match(/class="footnotes"/g) || []).length;

    return {
      html,
      styles,
      warnings,
      metadata: {
        wordCount,
        tableCount,
        imageCount,
        footnoteCount,
      },
      usedPandoc: usedPandoc || usedConverter === 'pandoc',
    };
  } finally {
    // Cleanup temp file
    if (docxPath) {
      await cleanupTempFile(docxPath);
    }
  }
}

/**
 * Convert HTML content to DOCX buffer using Pandoc
 */
export async function convertHtmlToDocx(html: string, options?: {
  title?: string;
  author?: string;
}): Promise<Buffer> {
  let htmlPath: string | null = null;
  let docxPath: string | null = null;

  try {
    // Wrap HTML with proper document structure
    const fullHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${options?.title || 'Document'}</title>
</head>
<body>
${html}
</body>
</html>
`;

    // Create temp files
    htmlPath = await createTempFile(Buffer.from(fullHtml), '.html');
    docxPath = htmlPath.replace('.html', '.docx');

    // Check if Pandoc is available
    const pandocAvailable = await isPandocAvailable();

    if (pandocAvailable) {
      // Use Pandoc for high-fidelity conversion
      const pandoc = getPandocPath();
      await execAsync(
        `"${pandoc}" "${htmlPath}" -f html -t docx -o "${docxPath}" --wrap=none`,
        { maxBuffer: 50 * 1024 * 1024 }
      );

      const buffer = await fs.readFile(docxPath);
      logger.info('[DocxConversion] Exported to DOCX using Pandoc');
      return buffer;
    } else {
      // Pandoc not available - throw error (we need Pandoc for proper export)
      throw new Error('Pandoc is required for DOCX export but is not available');
    }
  } finally {
    // Cleanup temp files
    if (htmlPath) await cleanupTempFile(htmlPath);
    if (docxPath) await cleanupTempFile(docxPath);
  }
}

/**
 * Apply changes to original DOCX while preserving formatting
 * This creates a new DOCX by modifying the original rather than converting from HTML
 */
export async function applyChangesToDocx(
  originalBuffer: Buffer,
  changes: Array<{ oldText: string; newText: string }>
): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(originalBuffer);
    let documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      throw new Error('Invalid DOCX: missing document.xml');
    }

    // Apply text replacements using cross-run matching
    // Text in DOCX is split across multiple <w:t> elements within <w:r> runs,
    // so we use replaceTextAcrossRuns to handle this properly
    let applied = 0;
    for (const change of changes) {
      // XML-encode old text to match content within <w:t> tags
      const xmlOldText = change.oldText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const xmlNewText = change.newText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const result = replaceTextAcrossRuns(documentXml, xmlOldText, xmlNewText);
      if (result.count > 0) {
        documentXml = result.xml;
        applied += result.count;
      } else {
        // Try with original (non-XML-encoded) text
        const result2 = replaceTextAcrossRuns(documentXml, change.oldText, change.newText);
        if (result2.count > 0) {
          documentXml = result2.xml;
          applied += result2.count;
        }
      }
    }

    logger.info(`[DocxConversion] Clean mode: applied ${applied}/${changes.length} text replacements`);

    // Clean up empty elements
    documentXml = documentXml.replace(/<w:r><w:t[^>]*><\/w:t><\/w:r>/g, '');
    documentXml = documentXml.replace(/<w:t[^>]*><\/w:t>/g, '');

    // Update the document.xml in the ZIP
    zip.file('word/document.xml', documentXml);

    // Generate new DOCX
    const newBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    return newBuffer;
  } catch (error) {
    logger.error('[DocxConversion] Failed to apply changes to DOCX:', error);
    throw error;
  }
}

/**
 * Apply changes to a DOCX file using proper Word Track Changes (revision marks).
 * Creates <w:del> and <w:ins> elements that appear as tracked changes in Word,
 * preserving the original DOCX formatting and allowing accept/reject in Word.
 */
export async function applyRevisionMarksToDocx(
  originalBuffer: Buffer,
  changes: Array<{ oldText: string; newText: string; source?: string }>,
  author = 'Ninja Editorial'
): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(originalBuffer);
    let documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      throw new Error('Invalid DOCX: missing document.xml');
    }

    // Source-to-author mapping for track change attribution
    const sourceAuthorMap: Record<string, string> = {
      'style': 'Style Validation',
      'integrity': 'Integrity Check',
      'plagiarism': 'Plagiarism Check',
      'manual': 'Manual Edit',
    };

    // --- PHASE 1: Replace target text with placeholders (handles cross-run matching) ---
    const placeholders = new Map<string, { oldText: string; newText: string; source?: string }>();
    let phIndex = 0;
    let applied = 0;

    for (const change of changes) {
      const placeholder = `__REVMARK_PH_${phIndex}__`;
      placeholders.set(placeholder, change);
      phIndex++;

      // XML-encode the old text for matching within <w:t> content
      const xmlOldText = change.oldText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const result = replaceTextAcrossRuns(documentXml, xmlOldText, placeholder);
      if (result.count > 0) {
        documentXml = result.xml;
        applied += result.count;
        logger.debug(`[DocxConversion] Phase 1: Placed placeholder for change (${result.count} match)`);
      } else {
        // Try with original (non-XML-encoded) text
        const result2 = replaceTextAcrossRuns(documentXml, change.oldText, placeholder);
        if (result2.count > 0) {
          documentXml = result2.xml;
          applied += result2.count;
          logger.debug(`[DocxConversion] Phase 1: Placed placeholder (alt) for change (${result2.count} match)`);
        } else {
          logger.debug(`[DocxConversion] Phase 1: No match found for change`);
        }
      }
    }

    // --- PHASE 2: Replace placeholders with <w:del>/<w:ins> revision marks ---
    const revisionDate = new Date().toISOString();
    let revisionId = 100;

    for (const [placeholder, change] of placeholders) {
      const escapedOld = escapeXmlForDocx(change.oldText);

      // Resolve author from source label, falling back to default
      // XML-escape the author to prevent injection from special characters in attribute values
      const changeAuthor = escapeXmlAttribute(
        (change.source && sourceAuthorMap[change.source]) || author
      );

      // Find the placeholder within a <w:t> element
      const phRegex = new RegExp(
        `(<w:t[^>]{0,200}>)([^<]{0,10000}?)${escapeRegexStr(placeholder)}([^<]{0,10000}?)(</w:t>)`
      );
      const phMatch = phRegex.exec(documentXml);

      if (phMatch) {
        const [fullMatch, openTag, before, after, closeTag] = phMatch;

        // Extract <w:rPr> from the enclosing <w:r> that contains this <w:t>
        // Look backwards from the match position to find the nearest <w:rPr>...</w:rPr> within the same <w:r>
        const lookbackStart: number = Math.max(0, phMatch.index - 2000);
        const lookbackStr: string = documentXml.substring(lookbackStart, phMatch.index);
        // Find the last <w:rPr>...</w:rPr> block before this <w:t> (within the same run)
        const rPrMatches: RegExpMatchArray[] = [...lookbackStr.matchAll(/<w:rPr>[\s\S]*?<\/w:rPr>/g)];
        const lastRPr: string = rPrMatches.length > 0 ? rPrMatches[rPrMatches.length - 1][0] : '';

        // Build deletion revision mark with formatting preserved
        const delXml = `<w:del w:id="${revisionId}" w:author="${changeAuthor}" w:date="${revisionDate}">` +
          `<w:r>${lastRPr}<w:delText xml:space="preserve">${escapedOld}</w:delText></w:r>` +
          `</w:del>`;
        revisionId++;

        // Build insertion revision mark (if replacement, not pure deletion)
        let insXml = '';
        if (change.newText) {
          const escapedNew = escapeXmlForDocx(change.newText);
          insXml = `<w:ins w:id="${revisionId}" w:author="${changeAuthor}" w:date="${revisionDate}">` +
            `<w:r>${lastRPr}<w:t xml:space="preserve">${escapedNew}</w:t></w:r>` +
            `</w:ins>`;
          revisionId++;
        }

        // Rebuild: keep text before/after the placeholder in their own runs, splice in revision marks
        // Include lastRPr in the after-segment run so the trailing text retains original formatting
        // Always use xml:space="preserve" on before/after <w:t> tags so Word doesn't trim
        // leading/trailing spaces that result from splitting the original text around revision marks
        const preserveTag = openTag.includes('xml:space="preserve"')
          ? openTag
          : openTag.replace('<w:t', '<w:t xml:space="preserve"');
        const replacement = `${preserveTag}${before}${closeTag}</w:r>` +
          delXml + insXml +
          `<w:r>${lastRPr}${preserveTag}${after}${closeTag}`;

        documentXml = documentXml.replace(fullMatch, replacement);
      }
    }

    // Clean up empty elements
    documentXml = documentXml.replace(/<w:r><w:t[^>]*><\/w:t><\/w:r>/g, '');
    documentXml = documentXml.replace(/<w:t[^>]*><\/w:t>/g, '');

    // Update the document.xml
    zip.file('word/document.xml', documentXml);

    logger.info(`[DocxConversion] Phase 2 complete: ${applied} revision marks applied`);

    return await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  } catch (error) {
    logger.error('[DocxConversion] Failed to apply revision marks to DOCX:', error);
    throw error;
  }
}

/**
 * Escape a string for use as regex pattern
 */
function escapeRegexStr(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape text for safe inclusion in DOCX XML
 */
function escapeXmlForDocx(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape a string for safe inclusion in an XML attribute value.
 * Prevents XML injection from special characters in user-supplied strings.
 */
function escapeXmlAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Replace text that may span across multiple <w:t> elements within <w:r> runs.
 * Uses the same approach as the citation module's replaceCitationUniversal:
 * 1. Extract all <w:t> segments with positions
 * 2. Build combined text with character-to-segment mapping
 * 3. Find matches in combined text
 * 4. Replace across segments (putting replacement in first, clearing middle, adjusting last)
 */
function replaceTextAcrossRuns(
  xml: string,
  searchText: string,
  replacement: string
): { xml: string; count: number } {
  let count = 0;

  interface TextSegment {
    start: number;
    end: number;
    text: string;
    fullMatch: string;
  }

  // Step 1: Extract all <w:t> content with positions
  let segments: TextSegment[] = [];
  const textTagRegex = /<w:t(?:\s[^>]{0,500})?>([\s\S]{0,50000}?)<\/w:t>/g;
  let m: RegExpExecArray | null;

  while ((m = textTagRegex.exec(xml)) !== null) {
    segments.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[1],
      fullMatch: m[0],
    });
  }

  if (segments.length === 0) return { xml, count: 0 };

  // Step 2: Build combined text and character-to-segment mapping
  let charToSegment: Array<{ segmentIndex: number; charIndex: number }> = [];
  const textParts: string[] = [];

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    textParts.push(seg.text);
    for (let charIdx = 0; charIdx < seg.text.length; charIdx++) {
      charToSegment.push({ segmentIndex: segIdx, charIndex: charIdx });
    }
  }
  const combinedText = textParts.join('');

  // Step 3: Find occurrences in combined text
  const searchPattern = new RegExp(escapeRegexStr(searchText), 'g');
  const matches: Array<{ start: number; end: number }> = [];
  let sm: RegExpExecArray | null;

  while ((sm = searchPattern.exec(combinedText)) !== null) {
    matches.push({ start: sm.index, end: sm.index + sm[0].length });
  }

  if (matches.length === 0) return { xml, count: 0 };

  // Step 4: Replace (process in reverse to preserve positions)
  let modifiedXml = xml;

  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const startInfo = charToSegment[match.start];
    const endInfo = charToSegment[match.end - 1];

    if (!startInfo || !endInfo) continue;

    const startSegIdx = startInfo.segmentIndex;
    const endSegIdx = endInfo.segmentIndex;

    if (startSegIdx === endSegIdx) {
      // Text within a single segment
      const seg = segments[startSegIdx];
      const beforeText = seg.text.substring(0, startInfo.charIndex);
      const afterText = seg.text.substring(endInfo.charIndex + 1);
      const newText = beforeText + replacement + afterText;
      // Ensure xml:space="preserve" when text has leading/trailing spaces
      let newTag = seg.fullMatch.replace(/>([\s\S]*?)<\/w:t>/, `>${newText}</w:t>`);
      if ((newText.startsWith(' ') || newText.endsWith(' ')) && !newTag.includes('xml:space="preserve"')) {
        newTag = newTag.replace('<w:t>', '<w:t xml:space="preserve">');
      }
      modifiedXml = modifiedXml.substring(0, seg.start) + newTag + modifiedXml.substring(seg.end);
      count++;
    } else {
      // Text spans multiple segments
      const firstSeg = segments[startSegIdx];
      const lastSeg = segments[endSegIdx];

      const beforeText = firstSeg.text.substring(0, startInfo.charIndex);
      const afterText = lastSeg.text.substring(endInfo.charIndex + 1);

      // Work backwards to preserve positions
      // 1. Modify last segment — ensure xml:space="preserve" for leading spaces
      let newLastTag = lastSeg.fullMatch.replace(/>([\s\S]*?)<\/w:t>/, `>${afterText}</w:t>`);
      if (afterText.startsWith(' ') && !newLastTag.includes('xml:space="preserve"')) {
        newLastTag = newLastTag.replace('<w:t>', '<w:t xml:space="preserve">');
      }
      modifiedXml = modifiedXml.substring(0, lastSeg.start) + newLastTag + modifiedXml.substring(lastSeg.end);

      // 2. Clear middle segments
      for (let segIdx = endSegIdx - 1; segIdx > startSegIdx; segIdx--) {
        const midSeg = segments[segIdx];
        const newMidTag = midSeg.fullMatch.replace(/>([\s\S]*?)<\/w:t>/, `></w:t>`);
        modifiedXml = modifiedXml.substring(0, midSeg.start) + newMidTag + modifiedXml.substring(midSeg.end);
      }

      // 3. Modify first segment (put replacement here) — ensure xml:space="preserve" for trailing spaces
      const firstText = beforeText + replacement;
      let newFirstTag = firstSeg.fullMatch.replace(/>([\s\S]*?)<\/w:t>/, `>${firstText}</w:t>`);
      if (firstText.endsWith(' ') && !newFirstTag.includes('xml:space="preserve"')) {
        newFirstTag = newFirstTag.replace('<w:t>', '<w:t xml:space="preserve">');
      }
      modifiedXml = modifiedXml.substring(0, firstSeg.start) + newFirstTag + modifiedXml.substring(firstSeg.end);
      count++;
    }
  }

  return { xml: modifiedXml, count };
}

/**
 * Convert PDF buffer to HTML
 * Note: PDF is a presentation format, so conversion is text-based
 */
export async function convertPdfToHtml(buffer: Buffer): Promise<ConversionResult> {
  const warnings: string[] = [];

  try {
    const data = (await pdfParse(buffer)) as PdfParseResult;

    // Split text into paragraphs (double newlines)
    const paragraphs: string[] = data.text
      .split(/\n\s*\n/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);

    // Convert to HTML paragraphs
    let html = paragraphs.map((p: string) => {
      // Preserve single line breaks within paragraphs
      const lines = p.split('\n').map((l: string) => l.trim()).join('<br>');
      return `<p>${lines}</p>`;
    }).join('\n');

    // Try to detect headings (short lines that might be titles)
    html = html.replace(/<p>([^<]{1,80})<\/p>/g, (_match: string, text: string) => {
      const trimmed = text.trim();
      // If it's short, all caps or title case, and no punctuation at end, might be heading
      if (trimmed.length < 60 && !/[.,:;]$/.test(trimmed)) {
        if (trimmed === trimmed.toUpperCase() && trimmed.length > 3) {
          return `<h2>${trimmed}</h2>`;
        }
      }
      return `<p>${text}</p>`;
    });

    // Wrap in container
    html = `<div class="docx-content pdf-converted">${html}</div>`;

    const styles = generateStyles();

    warnings.push('PDF converted to editable format. Some formatting may not be preserved.');
    warnings.push(`PDF Info: ${data.numpages} pages, ${data.info?.Title || 'No title'}`);

    return {
      html,
      styles,
      warnings,
      metadata: {
        wordCount: data.text.split(/\s+/).filter(Boolean).length,
        tableCount: 0, // PDF tables are hard to detect
        imageCount: 0, // Images not extracted in text mode
        footnoteCount: 0,
      },
      usedPandoc: false,
    };
  } catch (error) {
    logger.error('[DocxConversion] PDF conversion failed:', error);
    throw new Error('Failed to convert PDF: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}

/**
 * Detect file type from buffer
 */
export function detectFileType(buffer: Buffer): 'docx' | 'pdf' | 'unknown' {
  // Check for PDF magic number: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'pdf';
  }
  // Check for ZIP magic number (DOCX is a ZIP file): PK
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
    return 'docx';
  }
  return 'unknown';
}

/**
 * Convert any supported document to HTML
 */
export async function convertDocumentToHtml(buffer: Buffer, fileName?: string): Promise<ConversionResult> {
  const fileType = detectFileType(buffer);

  // Also check file extension as fallback
  const ext = fileName ? path.extname(fileName).toLowerCase() : '';

  if (fileType === 'pdf' || ext === '.pdf') {
    logger.info('[DocxConversion] Converting PDF to HTML');
    return convertPdfToHtml(buffer);
  } else if (fileType === 'docx' || ext === '.docx') {
    logger.info('[DocxConversion] Converting DOCX to HTML');
    return convertDocxToHtml(buffer);
  } else {
    throw new Error(`Unsupported file type: ${fileType} (extension: ${ext})`);
  }
}


/**
 * Decode HTML entities in text extracted from HTML spans.
 */
function decodeHtmlEntities(text: string): string {
  // Decode &amp; last to prevent double-decoding (e.g., &amp;lt; → &lt; → <)
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Strip all HTML tags from a string.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Parse track-change spans from the editor HTML and return replacement pairs.
 * Track changes appear as adjacent deletion + insertion spans:
 *   <span class="track-deletion" ...>old</span><span class="track-insertion" ...>new</span>
 */
function parseTrackChangePairs(html: string): Array<{ oldText: string; newText: string; source: string }> {
  const changes: Array<{ oldText: string; newText: string; source: string }> = [];
  const matched = new Set<number>();

  // Helper to extract data-source from a span's attributes
  const extractSource = (spanTag: string): string => {
    const srcMatch = spanTag.match(/data-source="([^"]*)"/);
    return srcMatch ? srcMatch[1] : '';
  };

  // Pattern 1: Deletion immediately followed by insertion (replacement pair)
  // Capture the full opening deletion span tag to extract data-source from it
  const pairRe = /(<span[^>]*class="track-deletion"[^>]*>)([\s\S]*?)<\/span>\s*<span[^>]*class="track-insertion"[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = pairRe.exec(html)) !== null) {
    const source = extractSource(m[1]);
    const oldText = decodeHtmlEntities(stripHtmlTags(m[2]));
    const newText = decodeHtmlEntities(stripHtmlTags(m[3]));
    if (oldText.trim()) {
      changes.push({ oldText, newText, source });
      matched.add(m.index);
    }
  }

  // Pattern 2: Standalone deletions (not part of a pair)
  const delRe = /(<span[^>]*class="track-deletion"[^>]*>)([\s\S]*?)<\/span>/g;
  while ((m = delRe.exec(html)) !== null) {
    if (matched.has(m.index)) continue;
    const source = extractSource(m[1]);
    const oldText = decodeHtmlEntities(stripHtmlTags(m[2]));
    if (oldText.trim()) {
      changes.push({ oldText, newText: '', source });
    }
  }

  return changes;
}

/**
 * Build a "clean" HTML string from the editor content:
 *  - deletion spans are removed entirely
 *  - insertion spans are unwrapped (text kept, mark removed)
 */
function buildCleanHtml(html: string): string {
  let clean = html;
  // Remove deletion-marked text
  clean = clean.replace(/<span[^>]*class="track-deletion"[^>]*>[\s\S]*?<\/span>/g, '');
  // Unwrap insertion-marked text (keep content)
  clean = clean.replace(/<span[^>]*class="track-insertion"[^>]*>([\s\S]*?)<\/span>/g, '$1');
  return clean;
}

/**
 * Export with track changes applied to original DOCX.
 *
 * @param mode 'clean'   — accept all changes: deletions removed, insertions kept (plain text replacement)
 *             'tracked' — produce Word Track Changes: <w:del>/<w:ins> revision marks
 *
 * Strategy:
 *  1. Parse track-change spans directly from the HTML to extract {old, new} pairs
 *  2. 'clean'   → apply plain text replacements (old→new) to original DOCX XML
 *     'tracked' → apply Word revision marks (<w:del>/<w:ins>) to original DOCX XML
 *  3. Falls back to Pandoc HTML→DOCX if the XML approach fails
 */
export interface ExportResult {
  buffer: Buffer;
  /** true when the original DOCX was returned unchanged (edits below similarity threshold) */
  originalPreserved: boolean;
  /** Word-level similarity (0–1) between original DOCX text and current HTML text. Present when originalPreserved is true. */
  wordSimilarity?: number;
  /** Sequence-level similarity (0–1). Present when originalPreserved is true. */
  sequenceSimilarity?: number;
}

export async function exportWithTrackChanges(
  originalBuffer: Buffer,
  currentHtml: string,
  options?: { title?: string; mode?: 'clean' | 'tracked' }
): Promise<ExportResult> {
  const cleanHtml = buildCleanHtml(currentHtml);
  const mode = options?.mode || 'clean';

  try {
    // Extract replacement pairs directly from track change HTML spans
    const trackChanges = parseTrackChangePairs(currentHtml);

    if (trackChanges.length > 0) {
      logger.info(`[DocxConversion] Found ${trackChanges.length} track change pairs from HTML (mode: ${mode})`);

      try {
        let result: Buffer;
        if (mode === 'tracked') {
          // Word Track Changes — revision marks that can be accepted/rejected in Word
          result = await applyRevisionMarksToDocx(originalBuffer, trackChanges);
          logger.info(`[DocxConversion] Applied ${trackChanges.length} revision marks to original DOCX`);
        } else {
          // Clean — plain text replacement, no revision marks
          result = await applyChangesToDocx(originalBuffer, trackChanges);
          logger.info(`[DocxConversion] Applied ${trackChanges.length} clean replacements to original DOCX`);
        }
        return { buffer: result, originalPreserved: false };
      } catch (applyErr) {
        logger.warn('[DocxConversion] XML replacement failed, falling back to Pandoc:', applyErr);
        return { buffer: await convertHtmlToDocx(cleanHtml, options), originalPreserved: false };
      }
    }

    // No track change spans found — check if text was manually edited
    // by comparing original DOCX text with the current HTML text using
    // word-level similarity (exact comparison always fails due to
    // conversion artifacts from the DOCX→HTML roundtrip).
    const zip = await JSZip.loadAsync(originalBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      logger.warn('[DocxConversion] No document.xml found, falling back to Pandoc');
      return { buffer: await convertHtmlToDocx(cleanHtml, options), originalPreserved: false };
    }

    const xmlTextRuns: string[] = [];
    const textRunPattern = /<w:t[^>]*>([^<]+)<\/w:t>/g;
    let match;
    while ((match = textRunPattern.exec(documentXml)) !== null) {
      xmlTextRuns.push(match[1]);
    }
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const originalPlainText = normalize(decodeHtmlEntities(xmlTextRuns.join('')));
    // Insert spaces between adjacent tags before stripping so </p><p> doesn't merge words.
    // normalize() then collapses any resulting multiple spaces.
    const spacedHtml = cleanHtml.replace(/>\s*</g, '> <');
    const cleanPlainText = normalize(decodeHtmlEntities(stripHtmlTags(spacedHtml)));

    // Dual similarity check: bag-of-words Jaccard (content) + sequence LCS (order).
    // Jaccard alone misses reordering; sequence alone is noisy with minor token diffs.
    // Both must pass to treat the document as unchanged.
    const wordSim = computeWordSimilarity(originalPlainText, cleanPlainText);
    const seqSim = computeSequenceSimilarity(originalPlainText, cleanPlainText);
    logger.info(`[DocxConversion] Similarity — word: ${(wordSim * 100).toFixed(1)}%, sequence: ${(seqSim * 100).toFixed(1)}% (original: ${originalPlainText.length} chars, html: ${cleanPlainText.length} chars)`);

    // Thresholds: 0.95 word / 0.90 sequence.
    // Trade-off: very small edits (a few words in a long doc) may still exceed these
    // thresholds and return the original DOCX, silently discarding the edit. This is
    // acceptable because (a) such tiny diffs are usually roundtrip artifacts not real
    // edits, and (b) real edits should use track changes which take a separate code path.
    if (wordSim >= 0.95 && seqSim >= 0.90) {
      if (wordSim < 1 || seqSim < 1) {
        logger.warn(`[DocxConversion] Minor edits detected but below threshold — returning original DOCX (word: ${(wordSim * 100).toFixed(1)}%, seq: ${(seqSim * 100).toFixed(1)}%). Edits will NOT appear in the exported file.`);
      } else {
        logger.info('[DocxConversion] No changes detected, returning original DOCX');
      }
      return { buffer: originalBuffer, originalPreserved: true, wordSimilarity: wordSim, sequenceSimilarity: seqSim };
    }

    // Text was manually changed without track changes — use Pandoc
    logger.info('[DocxConversion] Manual edits detected (no track changes), using Pandoc');
    return { buffer: await convertHtmlToDocx(cleanHtml, options), originalPreserved: false };
  } catch (error) {
    logger.warn('[DocxConversion] Track change export failed, falling back to Pandoc:', error);
    return { buffer: await convertHtmlToDocx(cleanHtml, options), originalPreserved: false };
  }
}

export const docxConversionService = {
  convertDocxToHtml,
  convertPdfToHtml,
  convertDocumentToHtml,
  convertHtmlToDocx,
  applyChangesToDocx,
  applyRevisionMarksToDocx,
  exportWithTrackChanges,
  isPandocAvailable,
  isLibreOfficeAvailable,
  detectFileType,
  generateStyles,
  extractDocxStyles,
};
