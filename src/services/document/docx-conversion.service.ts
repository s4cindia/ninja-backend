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
 * Generate CSS styles for the document
 */
function generateStyles(): string {
  return `
<style>
  /* Document container */
  .docx-content {
    font-family: 'Calibri', 'Arial', sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #000;
    max-width: 100%;
  }

  /* Headings */
  .docx-content h1 { font-size: 24pt; font-weight: bold; margin: 24pt 0 12pt 0; }
  .docx-content h2 { font-size: 18pt; font-weight: bold; margin: 18pt 0 9pt 0; }
  .docx-content h3 { font-size: 14pt; font-weight: bold; margin: 14pt 0 7pt 0; }
  .docx-content h4 { font-size: 12pt; font-weight: bold; margin: 12pt 0 6pt 0; }
  .docx-content h5 { font-size: 11pt; font-weight: bold; margin: 11pt 0 5pt 0; }
  .docx-content h6 { font-size: 10pt; font-weight: bold; margin: 10pt 0 5pt 0; }

  /* Paragraphs */
  .docx-content p { margin: 0 0 10pt 0; }

  /* Tables - preserve borders and structure */
  .docx-content table {
    border-collapse: collapse;
    width: 100%;
    margin: 12pt 0;
  }
  .docx-content th, .docx-content td {
    border: 1px solid #000;
    padding: 6pt 8pt;
    vertical-align: top;
  }
  .docx-content th {
    background-color: #f0f0f0;
    font-weight: bold;
  }
  .docx-content thead th {
    background-color: #e0e0e0;
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

  /* Block quotes */
  .docx-content blockquote {
    margin: 12pt 0 12pt 24pt;
    padding: 6pt 12pt;
    border-left: 3px solid #ccc;
    font-style: italic;
    color: #555;
  }

  /* Images */
  .docx-content img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 12pt auto;
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
 * Convert DOCX buffer to HTML with formatting preservation
 */
export async function convertDocxToHtml(buffer: Buffer): Promise<ConversionResult> {
  const warnings: string[] = [];
  let html = '';
  let usedPandoc = false;
  let docxPath: string | null = null;

  try {
    // Extract media files first
    const mediaMap = await extractAndEmbedMedia(buffer);
    const imageCount = mediaMap.size;

    // Check if Pandoc is available
    const pandocAvailable = await isPandocAvailable();

    if (pandocAvailable) {
      // Use Pandoc for high-fidelity conversion
      docxPath = await createTempFile(buffer, '.docx');
      html = await convertWithPandoc(docxPath, mediaMap);
      usedPandoc = true;
      logger.info('[DocxConversion] Converted using Pandoc');
    } else {
      // Fall back to mammoth
      const result = await convertWithMammoth(buffer);
      html = result.html;
      warnings.push(...result.warnings);
      warnings.push('Pandoc not available - using mammoth.js (some formatting may be lost)');
      logger.info('[DocxConversion] Converted using mammoth (Pandoc not available)');
    }

    // Extract just the body content if Pandoc generated full HTML
    if (usedPandoc && html.includes('<body')) {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (bodyMatch) {
        html = bodyMatch[1].trim();
      }
    }

    // Post-process to infer headings from bold-only paragraphs
    html = inferHeadingsFromFormatting(html);

    // Improve list formatting
    html = improveListFormatting(html);

    // Wrap in container
    html = `<div class="docx-content">${html}</div>`;

    // Generate styles
    const styles = generateStyles();

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
      usedPandoc,
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

    // Apply text replacements (preserving XML structure)
    for (const change of changes) {
      // Escape special XML characters
      const escapedOld = change.oldText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const escapedNew = change.newText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      // Simple text replacement within <w:t> tags
      // This is a simplified approach - for complex changes, would need proper XML parsing
      documentXml = documentXml.replace(
        new RegExp(escapedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        escapedNew
      );
    }

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

export const docxConversionService = {
  convertDocxToHtml,
  convertPdfToHtml,
  convertDocumentToHtml,
  convertHtmlToDocx,
  applyChangesToDocx,
  isPandocAvailable,
  detectFileType,
};
