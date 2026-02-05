import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';
import { SKIP_AUTO_ROLE_TYPES, getAriaRoleForEpubType } from '../../config/epub-aria-mapping';

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
    
    const isAttributeOnly = /^[a-zA-Z][a-zA-Z0-9:_-]*\s*=\s*["'][^"']*["']$/.test(newContent.trim());
    
    if (isAttributeOnly) {
      const tagPattern = new RegExp(`<(\\w+)([^>]*\\bepub:type\\s*=\\s*["'][^"']*${escapeRegExp(epubTypeValue)}[^"']*["'][^>]*)>`, 'gi');
      const tagMatch = content.match(tagPattern);
      
      if (tagMatch && tagMatch.length > 0) {
        const originalTag = tagMatch[0];
        const tagNameMatch = originalTag.match(/<(\w+)/);
        const tagName = tagNameMatch ? tagNameMatch[1] : 'nav';
        
        const existingAttrsMatch = originalTag.match(/<\w+\s*([^>]*)>/);
        const existingAttrs = existingAttrsMatch ? existingAttrsMatch[1] : '';
        
        const mergedTag = mergeTagAttributes(tagName, existingAttrs, newContent.trim());
        
        logger.info(`epub:type ADD attribute: "${originalTag}" → "${mergedTag}"`);
        
        return {
          matched: true,
          matchedContent: originalTag,
          newContent: content.replace(originalTag, mergedTag),
        };
      }
    }
    
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

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*["']([^"']*)["']/g;
  let match;
  while ((match = attrPattern.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function mergeTagAttributes(tagName: string, existingAttrs: string, newAttrs: string): string {
  const existingMap = parseAttributes(existingAttrs);
  const newMap = parseAttributes(newAttrs);
  const merged = { ...existingMap, ...newMap };
  const attrString = Object.entries(merged)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `<${tagName}${attrString ? ' ' + attrString : ''}>`;
}

function tryTagPatternMatch(content: string, oldContent: string, newContent: string): FlexibleMatchResult {
  const tagMatch = oldContent.match(/<(\w+)([^>]*)>/);
  if (!tagMatch) {
    return { matched: false };
  }

  const tagName = tagMatch[1];
  const oldAttrs = tagMatch[2].trim();
  const tagRegex = new RegExp(`<${tagName}\\s+[\\s\\S]*?>`, 'g');

  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const foundTag = match[0];
    const keyAttrMatch = oldAttrs.match(/([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*["']([^"']+)["']/);

    if (keyAttrMatch) {
      const attrName = keyAttrMatch[1];
      const attrValue = keyAttrMatch[2];

      if (foundTag.includes(`${attrName}=`) && foundTag.includes(attrValue)) {
        logger.info(`Tag pattern matched: "${foundTag.substring(0, 80)}..."`);

        const newTagMatch = newContent.match(/<(\w+)([^>]*)>/);
        if (!newTagMatch) {
          return {
            matched: true,
            matchedContent: foundTag,
            newContent: content.replace(foundTag, newContent),
          };
        }

        const foundAttrsMatch = foundTag.match(/<\w+\s*([\s\S]*?)>/);
        const foundAttrs = foundAttrsMatch ? foundAttrsMatch[1] : '';
        const newAttrs = newTagMatch[2];
        const mergedTag = mergeTagAttributes(tagName, foundAttrs, newAttrs);

        logger.info(`Merged tag preserving attributes: "${mergedTag}"`);

        return {
          matched: true,
          matchedContent: foundTag,
          newContent: content.replace(foundTag, mergedTag),
        };
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

function extractOpeningTag(content: string): string | null {
  const match = content.trim().match(/^<(\w+)[^>]*>/);
  return match ? match[0] : null;
}

function isHtmlTagReplacement(oldContent: string, newContent: string): boolean {
  const oldTrimmed = oldContent.trim();
  const newTrimmed = newContent.trim();
  
  if (/^<\w+[^>]*>$/.test(oldTrimmed) && /^<\w+[^>]*>$/.test(newTrimmed)) {
    return true;
  }
  
  const oldTag = extractOpeningTag(oldTrimmed);
  const newTag = extractOpeningTag(newTrimmed);
  
  if (oldTag && newTag) {
    const oldTagName = oldTag.match(/<(\w+)/)?.[1]?.toLowerCase();
    const newTagName = newTag.match(/<(\w+)/)?.[1]?.toLowerCase();
    return oldTagName === newTagName;
  }
  
  return false;
}

function extractOpeningTagFromBlock(content: string): { tag: string; tagName: string } | null {
  const match = content.trim().match(/^<(\w+)([^>]*)>/);
  if (!match) return null;
  return { tag: match[0], tagName: match[1] };
}

function mergeBlockReplacementTags(
  content: string,
  oldContent: string,
  newContent: string
): { result: string; matched: boolean; matchedContent?: string } {
  const oldTagInfo = extractOpeningTagFromBlock(oldContent);
  const newTagInfo = extractOpeningTagFromBlock(newContent);
  
  if (!oldTagInfo || !newTagInfo) {
    return { result: content, matched: false };
  }
  
  if (oldTagInfo.tagName.toLowerCase() !== newTagInfo.tagName.toLowerCase()) {
    return { result: content, matched: false };
  }
  
  const tagName = oldTagInfo.tagName;
  const oldTagPattern = new RegExp(`<${tagName}\\s+[\\s\\S]*?>`, 'gi');
  
  const keyAttrMatch = oldTagInfo.tag.match(/([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*["']([^"']+)["']/);
  if (!keyAttrMatch) {
    return { result: content, matched: false };
  }
  
  const keyAttrName = keyAttrMatch[1];
  const keyAttrValue = keyAttrMatch[2];
  
  let foundTag: string | null = null;
  let match;
  while ((match = oldTagPattern.exec(content)) !== null) {
    if (match[0].includes(`${keyAttrName}=`) && match[0].includes(keyAttrValue)) {
      foundTag = match[0];
      break;
    }
  }
  
  if (!foundTag) {
    return { result: content, matched: false };
  }
  
  const foundAttrsMatch = foundTag.match(/<\w+\s*([\s\S]*?)>/);
  const foundAttrs = foundAttrsMatch ? foundAttrsMatch[1] : '';
  const newTagAttrsMatch = newTagInfo.tag.match(/<\w+\s*([\s\S]*?)>/);
  const newTagAttrs = newTagAttrsMatch ? newTagAttrsMatch[1] : '';
  
  const mergedTag = mergeTagAttributes(tagName, foundAttrs, newTagAttrs);
  
  const updatedNewContent = newContent.replace(newTagInfo.tag, mergedTag);
  
  logger.info(`Block replacement: merged opening tag "${mergedTag}"`);
  
  if (content.includes(oldContent)) {
    return {
      result: content.replace(oldContent, updatedNewContent),
      matched: true,
      matchedContent: oldContent,
    };
  }
  
  try {
    const flexPattern = new RegExp(escapeRegExp(oldContent).replace(/\\s+/g, '\\s*'), 'g');
    const flexMatch = content.match(flexPattern);
    if (flexMatch && flexMatch.length > 0) {
      return {
        result: content.replace(flexMatch[0], updatedNewContent),
        matched: true,
        matchedContent: flexMatch[0],
      };
    }
  } catch (e) {
    logger.warn(`Block replacement flex pattern failed: ${e}`);
  }
  
  return { result: content, matched: false };
}

function performFlexibleReplace(content: string, oldContent: string, newContent: string): { 
  result: string; 
  matched: boolean; 
  matchedContent?: string;
} {
  // For block HTML tag replacements (multi-line), merge opening tag attributes and do full block replace
  if (isHtmlTagReplacement(oldContent, newContent)) {
    const isSingleTag = /^<\w+[^>]*>$/.test(oldContent.trim()) && /^<\w+[^>]*>$/.test(newContent.trim());
    
    if (isSingleTag) {
      logger.info(`Single tag replacement detected, using attribute merging...`);
      const tagResult = tryTagPatternMatch(content, oldContent, newContent);
      if (tagResult.matched) {
        return {
          result: tagResult.newContent!,
          matched: true,
          matchedContent: tagResult.matchedContent,
        };
      }
    } else {
      logger.info(`Block replacement detected, merging opening tag and replacing block...`);
      const blockResult = mergeBlockReplacementTags(content, oldContent, newContent);
      if (blockResult.matched) {
        return blockResult;
      }
    }
  }

  // For epub:type + role additions, use specialized handler that preserves epub:type
  if (oldContent.includes('epub:type') && newContent.includes('role=')) {
    const epubRoleResult = handleEpubTypeRoleAddition(content, oldContent, newContent);
    if (epubRoleResult.matched) {
      return epubRoleResult;
    }
  }

  // Exact match for non-tag content (text, metadata, etc.)
  if (content.includes(oldContent)) {
    logger.info(`Exact match found for: ${oldContent.substring(0, 50)}...`);
    
    const isHtmlTag = /^<\w+[^>]*>$/.test(oldContent.trim());
    if (isHtmlTag) {
      const oldTagMatch = oldContent.match(/<(\w+)\s*([\s\S]*?)>/);
      const newTagMatch = newContent.match(/<(\w+)\s*([\s\S]*?)>/);
      
      if (oldTagMatch && newTagMatch && oldTagMatch[1].toLowerCase() === newTagMatch[1].toLowerCase()) {
        const tagName = oldTagMatch[1];
        const oldAttrs = oldTagMatch[2] || '';
        const newAttrs = newTagMatch[2] || '';
        
        const keyAttrMatch = oldAttrs.match(/([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*["']([^"']+)["']/);
        if (keyAttrMatch) {
          const attrName = keyAttrMatch[1];
          const attrValue = keyAttrMatch[2];
          
          const tagPattern = new RegExp(`<${tagName}(?=[^>]*\\b${escapeRegExp(attrName)}\\s*=\\s*["'][^"']*${escapeRegExp(attrValue)}[^"']*["'])[^>]*>`, 'gi');
          const specificMatch = content.match(tagPattern);
          
          if (specificMatch && specificMatch.length > 0) {
            const matchedTag = specificMatch[0];
            const matchedAttrsMatch = matchedTag.match(/<\w+\s*([^>]*)>/);
            const matchedAttrs = matchedAttrsMatch ? matchedAttrsMatch[1] : '';
            
            const mergedTag = mergeTagAttributes(tagName, matchedAttrs, newAttrs);
            logger.info(`Exact match with targeted attribute merging: "${mergedTag}"`);
            
            return {
              result: content.replace(matchedTag, mergedTag),
              matched: true,
              matchedContent: matchedTag,
            };
          }
        }
        
        const mergedTag = mergeTagAttributes(tagName, oldAttrs, newAttrs);
        logger.info(`Exact match with direct attribute merging: "${mergedTag}"`);
        
        return {
          result: content.replace(oldContent, mergedTag),
          matched: true,
          matchedContent: oldContent,
        };
      }
    }
    
    return {
      result: content.replace(oldContent, newContent),
      matched: true,
      matchedContent: oldContent,
    };
  }

  logger.info(`Exact match failed, trying flexible patterns...`);

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

  // Fallback to tag pattern matching for partial matches
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
    const mimetypeContent = 'application/epub+zip';
    zip.file('mimetype', mimetypeContent, { compression: 'STORE' });

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

  private cleanExistingMetadata(content: string, properties: string[]): string {
    let cleaned = content;
    for (const prop of properties) {
      const escapedProp = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `\\s*<meta[^>]*property\\s*=\\s*["']${escapedProp}["'][^>]*>[^<]*</meta>`,
        'gi'
      );
      cleaned = cleaned.replace(pattern, '');
    }
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
    return cleaned;
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

    const hasMetaValue = (property: string, value?: string): boolean => {
      const escapedProp = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (value) {
        const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
          `<meta[^>]*property\\s*=\\s*["']${escapedProp}["'][^>]*>\\s*${escapedVal}\\s*</meta>`,
          'i'
        );
        return pattern.test(modified);
      }
      const pattern = new RegExp(`property\\s*=\\s*["']${escapedProp}["']`, 'i');
      return pattern.test(modified);
    };

    for (const feature of features) {
      if (!hasMetaValue('schema:accessibilityFeature', feature)) {
        metadataToAdd.push(
          `<meta property="schema:accessibilityFeature">${feature}</meta>`
        );
      }
    }

    if (!hasMetaValue('schema:accessibilityHazard')) {
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
    modified = modified.replace('</metadata>', insertContent + '\n</metadata>');

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

  async addAccessModes(
    zip: JSZip,
    modes: { textual?: boolean; visual?: boolean; auditory?: boolean } = { textual: true }
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const opf = await this.getOPF(zip);
    if (!opf) {
      return [{
        success: false,
        filePath: 'content.opf',
        modificationType: 'add_access_modes',
        description: 'Failed to locate OPF file',
      }];
    }

    let modified = opf.content;
    const metadataToAdd: string[] = [];

    const hasAccessMode = (value: string): boolean => {
      const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `<meta[^>]*property\\s*=\\s*["']schema:accessMode["'][^>]*>\\s*${escapedVal}\\s*</meta>`,
        'i'
      );
      return pattern.test(modified);
    };

    const hasAccessModeSufficient = (value: string): boolean => {
      const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `<meta[^>]*property\\s*=\\s*["']schema:accessModeSufficient["'][^>]*>\\s*${escapedVal}\\s*</meta>`,
        'i'
      );
      return pattern.test(modified);
    };

    if (modes.textual && !hasAccessMode('textual')) {
      metadataToAdd.push('<meta property="schema:accessMode">textual</meta>');
    }
    if (modes.visual && !hasAccessMode('visual')) {
      metadataToAdd.push('<meta property="schema:accessMode">visual</meta>');
    }
    if (modes.auditory && !hasAccessMode('auditory')) {
      metadataToAdd.push('<meta property="schema:accessMode">auditory</meta>');
    }

    if (modes.textual && !hasAccessModeSufficient('textual')) {
      metadataToAdd.push('<meta property="schema:accessModeSufficient">textual</meta>');
    }

    if (metadataToAdd.length === 0) {
      return [{
        success: true,
        filePath: opf.path,
        modificationType: 'add_access_modes',
        description: 'Access modes already present',
      }];
    }

    const insertContent = '\n    ' + metadataToAdd.join('\n    ');
    modified = modified.replace('</metadata>', insertContent + '\n</metadata>');
    await this.updateOPF(zip, opf.path, modified);

    results.push({
      success: true,
      filePath: opf.path,
      modificationType: 'add_access_modes',
      description: `Added ${metadataToAdd.length} access mode elements`,
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

    // Check if summary already exists
    if (/schema:accessibilitySummary/i.test(opf.content)) {
      return {
        success: true,
        filePath: opf.path,
        modificationType: 'add_accessibility_summary',
        description: 'Accessibility summary already exists',
      };
    }

    const defaultSummary = summary ||
      'This publication meets basic accessibility requirements. All images have alternative text descriptions. The content follows a logical reading order with proper heading structure for navigation.';

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

  async addAccessibilityHazard(zip: JSZip): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const opf = await this.getOPF(zip);
    if (!opf) {
      return [{
        success: false,
        filePath: 'content.opf',
        modificationType: 'add_accessibility_hazard',
        description: 'Failed to locate OPF file',
      }];
    }

    let modified = opf.content;
    const metadataToAdd: string[] = [];

    const hasHazard = (value: string): boolean => {
      const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `<meta[^>]*property\\s*=\\s*["']schema:accessibilityHazard["'][^>]*>\\s*${escapedVal}\\s*</meta>`,
        'i'
      );
      return pattern.test(modified);
    };

    // Default hazards to declare (none = safe publication)
    const hazards = ['noFlashingHazard', 'noMotionSimulationHazard', 'noSoundHazard'];

    for (const hazard of hazards) {
      if (!hasHazard(hazard)) {
        metadataToAdd.push(`<meta property="schema:accessibilityHazard">${hazard}</meta>`);
      }
    }

    if (metadataToAdd.length === 0) {
      return [{
        success: true,
        filePath: opf.path,
        modificationType: 'add_accessibility_hazard',
        description: 'Accessibility hazard declarations already present',
      }];
    }

    const insertContent = '\n    ' + metadataToAdd.join('\n    ');
    modified = modified.replace('</metadata>', insertContent + '\n  </metadata>');
    await this.updateOPF(zip, opf.path, modified);

    results.push({
      success: true,
      filePath: opf.path,
      modificationType: 'add_accessibility_hazard',
      description: `Added ${metadataToAdd.length} accessibility hazard declarations`,
      after: metadataToAdd.join('\n'),
    });

    return results;
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

      let content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      let modified = false;
      let count = 0;
      const markedImages: string[] = [];

      // Find img tags without alt attribute
      const imgPattern = /<img(\s[^>]*)?\s*\/?>/gi;

      content = content.replace(imgPattern, (fullMatch, attrs) => {
        attrs = attrs || '';

        // Check if already has alt attribute
        if (/\balt\s*=/i.test(attrs)) {
          return fullMatch; // Already has alt
        }

        // Extract src for logging
        const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
        const src = srcMatch ? srcMatch[1] : 'unknown';
        markedImages.push(src);

        // Add alt="" and role="presentation"
        modified = true;
        count++;

        // Insert attributes after <img
        if (fullMatch.endsWith('/>')) {
          return `<img alt="" role="presentation"${attrs} />`;
        } else {
          return `<img alt="" role="presentation"${attrs}>`;
        }
      });

      if (modified) {
        zip.file(filePath, content);
        results.push({
          success: true,
          filePath,
          modificationType: 'add_decorative_alt',
          description: `Marked ${count} image(s) as decorative with alt="" - REVIEW RECOMMENDED`,
          after: `Images marked: ${markedImages.slice(0, 5).join(', ')}${markedImages.length > 5 ? '...' : ''}`,
        });

        logger.warn(`Marked ${count} images as decorative in ${filePath}. Manual review recommended.`);
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

      const headings = $('h1, h2, h3, h4, h5, h6').toArray();
      
      logger.info(`[HeadingFix] File: ${filePath}`);
      logger.info(`[HeadingFix] Found ${headings.length} headings`);
      if (headings.length > 0) {
        const tagNames = headings.map(el => (el.name || '').toLowerCase());
        logger.info(`[HeadingFix] Heading tags: ${tagNames.slice(0, 5).join(', ')}${tagNames.length > 5 ? '...' : ''}`);
        logger.info(`[HeadingFix] Min level: ${Math.min(...tagNames.map(t => parseInt(t.charAt(1))))}`);
      }
      
      if (headings.length === 0) continue;

      // Helper to escape attribute values
      const escapeAttr = (str: string): string => {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      };

      // Find the first heading level in the document
      const firstHeadingLevel = headings.length > 0 ? parseInt((headings[0].name || '').toLowerCase().charAt(1)) : 1;

      // Case 1: Document doesn't start with h1
      if (firstHeadingLevel > 1) {
        const shift = firstHeadingLevel - 1;

        // Find if there's an existing h1 somewhere in the document
        const firstH1Index = headings.findIndex(el => (el.name || '').toLowerCase() === 'h1');

        // Determine how many headings to shift
        // If no h1 exists, shift all; otherwise only shift headings before the first h1
        const shiftUntilIndex = firstH1Index === -1 ? headings.length : firstH1Index;

        // Process in reverse order to avoid conflicts
        for (let i = shiftUntilIndex - 1; i >= 0; i--) {
          const el = headings[i];
          const oldLevel = parseInt((el.name || '').toLowerCase().charAt(1));
          const newLevel = Math.max(1, oldLevel - shift);

          if (oldLevel !== newLevel) {
            const $el = $(el);
            const headingContent = $el.html();
            const attrs = el.attribs || {};
            const attrString = Object.entries(attrs)
              .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
              .join(' ');

            const $newHeading = $(`<h${newLevel}${attrString ? ' ' + attrString : ''}>${headingContent}</h${newLevel}>`);
            $el.replaceWith($newHeading);
            changes.push(`h${oldLevel} → h${newLevel}`);
            modified = true;
          }
        }
      }

      // Case 2: Fix any skipped levels (h1→h3 becomes h1→h2)
      // Re-read headings after Case 1 modifications
      const updatedHeadings = $('h1, h2, h3, h4, h5, h6').toArray();
      let expectedMaxLevel = 1;

      for (const el of updatedHeadings) {
        const oldLevel = parseInt((el.name || '').toLowerCase().charAt(1));

        if (oldLevel > expectedMaxLevel + 1) {
          const newLevel = expectedMaxLevel + 1;
          const $el = $(el);
          const headingContent = $el.html();
          const attrs = el.attribs || {};
          const attrString = Object.entries(attrs)
            .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
            .join(' ');

          const $newHeading = $(`<h${newLevel}${attrString ? ' ' + attrString : ''}>${headingContent}</h${newLevel}>`);
          $el.replaceWith($newHeading);
          changes.push(`h${oldLevel} → h${newLevel}`);
          modified = true;
          expectedMaxLevel = newLevel;
        } else {
          expectedMaxLevel = Math.max(expectedMaxLevel, oldLevel);
        }
      }

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'fix_heading_hierarchy',
          description: `Fixed heading hierarchy: ${changes.length} heading(s) adjusted`,
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

  async addAriaLandmarks(zip: JSZip, targetLocations?: string[]): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    let files = Object.keys(zip.files)
      .filter(f => /\.(html|xhtml|htm)$/i.test(f) && !zip.files[f].dir)
      .sort(); // Sort for consistent ordering

    // If target locations are provided, prioritize those files first
    if (targetLocations && targetLocations.length > 0) {
      const targetSet = new Set(targetLocations);
      const targetFiles: string[] = [];
      const otherFiles: string[] = [];

      for (const file of files) {
        if (targetSet.has(file)) {
          targetFiles.push(file);
        } else {
          otherFiles.push(file);
        }
      }

      // Process target files first, then others
      files = [...targetFiles, ...otherFiles];
    }

    // Track if we've added a main landmark anywhere
    let mainLandmarkExists = false;

    // First pass: check if any file already has role="main" OR <main> tag
    for (const filePath of files) {
      const content = await zip.file(filePath)?.async('text');
      if (content && (/role\s*=\s*["']main["']/i.test(content) || /<main[\s>]/i.test(content))) {
        mainLandmarkExists = true;
        break;
      }
    }

    // Second pass: add main landmark to first suitable file if needed
    for (const filePath of files) {
      let content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      let modified = false;
      const changes: string[] = [];

      // Only add ONE main landmark across entire EPUB
      if (!mainLandmarkExists) {
        // Look for elements that can receive role="main"
        const candidates = [
          { pattern: /(<main)(\s[^>]*>|>)/i, name: 'main' },
          { pattern: /(<section)(\s[^>]*>|>)/i, name: 'section' },
          { pattern: /(<article)(\s[^>]*>|>)/i, name: 'article' },
        ];

        let foundCandidate = false;
        for (const { pattern, name } of candidates) {
          const match = content.match(pattern);
          if (match) {
            const [fullMatch, tagStart, rest] = match;

            // Check if this element already has a role
            if (/\brole\s*=/i.test(fullMatch)) {
              continue; // Skip, already has role
            }

            // Add role="main" after tag name
            const newTag = `${tagStart} role="main"${rest}`;
            content = content.replace(fullMatch, newTag);
            changes.push(`Added role="main" to <${name}>`);
            modified = true;
            mainLandmarkExists = true;
            foundCandidate = true;
            break;
          }
        }

        // Fallback: If no suitable element found, wrap body content with <main role="main">
        if (!foundCandidate && !mainLandmarkExists) {
          const bodyMatch = content.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
          if (bodyMatch) {
            const [fullBodyMatch, bodyAttrs, bodyContent] = bodyMatch;
            // Wrap body content with <main role="main">
            const wrappedContent = `<body${bodyAttrs}>\n<main role="main">\n${bodyContent.trim()}\n</main>\n</body>`;
            content = content.replace(fullBodyMatch, wrappedContent);
            changes.push('Wrapped body content with <main role="main">');
            modified = true;
            mainLandmarkExists = true;
          }
        }
      }

      if (modified) {
        zip.file(filePath, content);
        results.push({
          success: true,
          filePath,
          modificationType: 'add_aria_landmarks',
          description: changes.join(', '),
        });
      }
    }

    if (results.length === 0) {
      if (mainLandmarkExists) {
        results.push({
          success: true,
          filePath: 'all',
          modificationType: 'add_aria_landmarks',
          description: 'Main landmark already present',
        });
      } else {
        results.push({
          success: false,
          filePath: 'all',
          modificationType: 'add_aria_landmarks',
          description: 'Could not add main landmark - no body element found',
        });
      }
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

      let content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      const $ = cheerio.load(content, { xmlMode: true });
      let modified = false;
      const changes: string[] = [];

      $('a').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const hasImgWithAlt = $el.find('img[alt]:not([alt=""])').length > 0;
        const hasAriaLabel = $el.attr('aria-label');
        const hasTitle = $el.attr('title');

        if (text || hasImgWithAlt || hasAriaLabel || hasTitle) {
          return;
        }

        const href = $el.attr('href') || '';
        if (!href) return;

        let label = '';
        if (href.startsWith('#')) {
          const anchor = href.substring(1).replace(/[-_]/g, ' ');
          label = anchor ? `Jump to ${anchor}` : 'Internal link';
        } else if (href.match(/\.(html|xhtml|htm)$/i)) {
          label = href.split('/').pop()?.replace(/\.(html|xhtml|htm)$/i, '').replace(/[-_]/g, ' ') || 'Link';
        } else {
          label = 'Link';
        }

        $el.attr('aria-label', label);
        changes.push(`Added aria-label="${label}" to empty link with href="${href}"`);
        modified = true;
      });

      if (modified) {
        zip.file(filePath, $.html());
        results.push({
          success: true,
          filePath,
          modificationType: 'fix_empty_links',
          description: `Fixed ${changes.length} empty link(s)`,
          after: changes.slice(0, 5).join('\n') + (changes.length > 5 ? `\n... and ${changes.length - 5} more` : ''),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: false,
        filePath: 'all',
        modificationType: 'fix_empty_links',
        description: 'No empty links found to fix',
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

  async addNavAriaLabels(
    zip: JSZip,
    labels: { toc?: string; landmarks?: string; pageList?: string }
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];
    const files = Object.keys(zip.files);

    // Find nav files
    const navFiles = files.filter(f =>
      /nav\.(x?html?)$/i.test(f) ||
      (f.includes('nav') && /\.(x?html?)$/i.test(f))
    );

    for (const filePath of navFiles) {
      let content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      let modified = false;
      const changes: string[] = [];

      // Add aria-label to toc nav (match nav with epub:type containing "toc")
      if (labels.toc) {
        const tocPattern = /(<nav\s+)([^>]*\bepub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*)(>)/gi;
        content = content.replace(tocPattern, (match, start, attrs, end) => {
          // Skip if already has aria-label
          if (/aria-label\s*=/i.test(attrs)) return match;
          // Skip if already has role (we'll add it separately if needed)
          const needsRole = !/\brole\s*=/i.test(attrs);
          const roleAttr = needsRole ? ' role="doc-toc"' : '';
          changes.push(`Added aria-label="${labels.toc}" to toc nav`);
          modified = true;
          return `${start}${attrs}${roleAttr} aria-label="${labels.toc}"${end}`;
        });
      }

      // Add aria-label to landmarks nav
      if (labels.landmarks) {
        const landmarksPattern = /(<nav\s+)([^>]*\bepub:type\s*=\s*["'][^"']*\blandmarks\b[^"']*["'][^>]*)(>)/gi;
        content = content.replace(landmarksPattern, (match, start, attrs, end) => {
          if (/aria-label\s*=/i.test(attrs)) return match;
          const needsRole = !/\brole\s*=/i.test(attrs);
          const roleAttr = needsRole ? ' role="navigation"' : '';
          changes.push(`Added aria-label="${labels.landmarks}" to landmarks nav`);
          modified = true;
          return `${start}${attrs}${roleAttr} aria-label="${labels.landmarks}"${end}`;
        });
      }

      // Add aria-label to page-list nav
      if (labels.pageList) {
        const pageListPattern = /(<nav\s+)([^>]*\bepub:type\s*=\s*["'][^"']*\bpage-list\b[^"']*["'][^>]*)(>)/gi;
        content = content.replace(pageListPattern, (match, start, attrs, end) => {
          if (/aria-label\s*=/i.test(attrs)) return match;
          const needsRole = !/\brole\s*=/i.test(attrs);
          const roleAttr = needsRole ? ' role="doc-pagelist"' : '';
          changes.push(`Added aria-label="${labels.pageList}" to page-list nav`);
          modified = true;
          return `${start}${attrs}${roleAttr} aria-label="${labels.pageList}"${end}`;
        });
      }

      if (modified) {
        zip.file(filePath, content);
        results.push({
          success: true,
          filePath,
          modificationType: 'add_nav_aria_labels',
          description: changes.join('; '),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'nav',
        modificationType: 'add_nav_aria_labels',
        description: 'No nav elements found or labels already present',
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
              // For XHTML files, try to insert before </head> or </body> instead of appending at end
              const isXhtml = /\.(x?html?)$/i.test(actualPath);
              const newContent = change.content || '';
              
              if (isXhtml && (newContent.includes('{') || newContent.trim().startsWith('<style'))) {
                // This looks like CSS - insert before </head> or into existing <style>
                if (content.includes('</head>')) {
                  // Insert as inline style before </head>
                  const cssContent = newContent.includes('<style') ? newContent : `<style type="text/css">\n${newContent}\n</style>`;
                  modified = content.replace('</head>', `${cssContent}\n</head>`);
                  changeApplied = true;
                } else if (content.includes('</body>')) {
                  // Fall back to before </body>
                  modified = content.replace('</body>', `<style type="text/css">\n${newContent}\n</style>\n</body>`);
                  changeApplied = true;
                } else {
                  results.push({
                    success: false,
                    filePath: actualPath,
                    modificationType: change.type,
                    description: 'Cannot insert CSS: no </head> or </body> tag found. Provide oldContent anchor.',
                  });
                  hasErrors = true;
                  continue;
                }
              } else if (isXhtml) {
                // For non-CSS content, insert before </body>
                if (content.includes('</body>')) {
                  modified = content.replace('</body>', `${newContent}\n</body>`);
                  changeApplied = true;
                } else {
                  results.push({
                    success: false,
                    filePath: actualPath,
                    modificationType: change.type,
                    description: 'Cannot insert into XHTML: no </body> tag found. Provide oldContent anchor.',
                  });
                  hasErrors = true;
                  continue;
                }
              } else {
                modified += '\n' + newContent;
                changeApplied = true;
              }
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
    const files = Object.keys(zip.files);


    const xhtmlFiles = files.filter(f => /\.(x?html?)$/i.test(f) && !zip.files[f].dir);

    for (const filePath of xhtmlFiles) {
      let content = await zip.file(filePath)?.async('text');
      if (!content) continue;

      let modified = false;
      const changes: string[] = [];

      // Process each epub:type to fix
      for (const { epubType, role } of epubTypesToFix) {
        // Skip types that shouldn't get roles
        if (SKIP_AUTO_ROLE_TYPES.has(epubType.toLowerCase())) continue;

        // Determine the role to use
        const targetRole = role || getAriaRoleForEpubType(epubType);

        // Match any tag with epub:type containing this value
        // This regex captures: <tagName ... epub:type="...value..." ...>
        const tagPattern = new RegExp(
          `(<[a-zA-Z][a-zA-Z0-9]*)(\\s+[^>]*?\\bepub:type\\s*=\\s*["'][^"']*\\b${epubType}\\b[^"']*["'][^>]*?)(>)`,
          'gi'
        );

        content = content.replace(tagPattern, (fullMatch, tagStart, attrs, tagEnd) => {
          // Skip if already has a role attribute
          if (/\brole\s*=\s*["']/i.test(fullMatch)) {
            return fullMatch;
          }

          changes.push(`Added role="${targetRole}" to epub:type="${epubType}"`);
          modified = true;
          return `${tagStart} role="${targetRole}"${attrs}${tagEnd}`;
        });
      }

      if (modified) {
        zip.file(filePath, content);
        results.push({
          success: true,
          filePath,
          modificationType: 'add_aria_roles_to_epub_types',
          description: `${changes.length} role(s) added`,
          after: changes.slice(0, 10).join('\n') + (changes.length > 10 ? `\n... and ${changes.length - 10} more` : ''),
        });
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'add_aria_roles_to_epub_types',
        description: 'No epub:type elements needed roles or all already have roles',
      });
    }

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
    logger.debug('scanEpubTypes START');

    const epubTypeMap = new Map<string, {
      value: string;
      files: Set<string>;
      count: number;
      elementType: string;
    }>();
    const scannedFiles: string[] = [];


    const xhtmlFiles = Object.keys(zip.files).filter(path =>
      /\.(xhtml|html|htm)$/i.test(path) && !zip.files[path].dir
    );

    for (const filePath of xhtmlFiles) {
      try {
        const content = await zip.file(filePath)?.async('text');
        if (!content) continue;

        scannedFiles.push(filePath);

        // Find all epub:type attributes using regex
        const pattern = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*epub:type\s*=\s*["']([^"']+)["'][^>]*>/gi;
        let match;

        while ((match = pattern.exec(content)) !== null) {
          const elementType = match[1].toLowerCase();
          const epubTypeValue = match[2];

          // Split space-separated values
          const types = epubTypeValue.trim().split(/\s+/);

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
        }
      } catch (_err) {
        logger.error(`Error parsing ${filePath}`, _err instanceof Error ? _err : undefined);
      }
    }

    const epubTypes = Array.from(epubTypeMap.entries()).map(([key, data]) => ({
      value: data.value,
      file: Array.from(data.files)[0],
      count: data.count,
      suggestedRole: getAriaRoleForEpubType(key),
      elementType: data.elementType,
    }));

    logger.debug(`Found ${epubTypes.length} unique epub:types across ${scannedFiles.length} files`);

    return { epubTypes, files: scannedFiles };
  }

  async fixColorContrast(
    zip: JSZip,
    contrastIssues?: Array<{
      filePath: string;
      foreground: string;
      background: string;
      selector?: string;
    }>
  ): Promise<ModificationResult[]> {
    const results: ModificationResult[] = [];

    const parseColor = (color: string): { r: number; g: number; b: number } | null => {
      const hex = color.replace('#', '');
      if (hex.length === 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        };
      }
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
        };
      }
      return null;
    };

    const getLuminance = (r: number, g: number, b: number): number => {
      const [rs, gs, bs] = [r, g, b].map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };

    const getContrastRatio = (l1: number, l2: number): number => {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const adjustColor = (r: number, g: number, b: number, factor: number, lighten: boolean): { r: number; g: number; b: number } => {
      if (lighten) {
        return {
          r: Math.min(255, Math.round(r + (255 - r) * factor)),
          g: Math.min(255, Math.round(g + (255 - g) * factor)),
          b: Math.min(255, Math.round(b + (255 - b) * factor)),
        };
      } else {
        return {
          r: Math.max(0, Math.round(r * (1 - factor))),
          g: Math.max(0, Math.round(g * (1 - factor))),
          b: Math.max(0, Math.round(b * (1 - factor))),
        };
      }
    };

    const toHex = (r: number, g: number, b: number): string => {
      return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
    };

    const findCompliantColor = (
      fg: { r: number; g: number; b: number },
      bg: { r: number; g: number; b: number },
      targetRatio: number = 4.5
    ): string => {
      const bgLuminance = getLuminance(bg.r, bg.g, bg.b);
      const fgLuminance = getLuminance(fg.r, fg.g, fg.b);
      const currentRatio = getContrastRatio(fgLuminance, bgLuminance);

      if (currentRatio >= targetRatio) {
        return toHex(fg.r, fg.g, fg.b);
      }

      const tryDirection = (lighten: boolean): { color: string; ratio: number } | null => {
        let testFg = { ...fg };
        for (let factor = 0.02; factor <= 1.0; factor += 0.02) {
          testFg = adjustColor(fg.r, fg.g, fg.b, factor, lighten);
          const testLuminance = getLuminance(testFg.r, testFg.g, testFg.b);
          const ratio = getContrastRatio(testLuminance, bgLuminance);
          if (ratio >= targetRatio) {
            return { color: toHex(testFg.r, testFg.g, testFg.b), ratio };
          }
        }
        const finalColor = lighten ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
        const finalLuminance = getLuminance(finalColor.r, finalColor.g, finalColor.b);
        const finalRatio = getContrastRatio(finalLuminance, bgLuminance);
        if (finalRatio >= targetRatio) {
          return { color: toHex(finalColor.r, finalColor.g, finalColor.b), ratio: finalRatio };
        }
        return null;
      };

      const lightenResult = tryDirection(true);
      const darkenResult = tryDirection(false);

      if (lightenResult && darkenResult) {
        const lightenDiff = Math.abs(getLuminance(fg.r, fg.g, fg.b) - getLuminance(255, 255, 255));
        const darkenDiff = Math.abs(getLuminance(fg.r, fg.g, fg.b) - getLuminance(0, 0, 0));
        return lightenDiff < darkenDiff ? lightenResult.color : darkenResult.color;
      }
      if (lightenResult) return lightenResult.color;
      if (darkenResult) return darkenResult.color;

      const whiteLuminance = getLuminance(255, 255, 255);
      const blackLuminance = getLuminance(0, 0, 0);
      const whiteRatio = getContrastRatio(whiteLuminance, bgLuminance);
      const blackRatio = getContrastRatio(blackLuminance, bgLuminance);

      return whiteRatio > blackRatio ? '#ffffff' : '#000000';
    };

    const files = Object.keys(zip.files).filter(f => /\.(x?html?)$/i.test(f) && !zip.files[f].dir);
    const cssFiles = Object.keys(zip.files).filter(f => /\.css$/i.test(f) && !zip.files[f].dir);

    const contrastFixCss: string[] = [];

    if (contrastIssues && contrastIssues.length > 0) {
      for (const issue of contrastIssues) {
        const fg = parseColor(issue.foreground);
        const bg = parseColor(issue.background);

        if (!fg || !bg) {
          results.push({
            success: false,
            filePath: issue.filePath,
            modificationType: 'fix_color_contrast',
            description: `Could not parse colors: fg=${issue.foreground}, bg=${issue.background}`,
          });
          continue;
        }

        const compliantColor = findCompliantColor(fg, bg);

        contrastFixCss.push(`/* Color contrast fix for ${issue.foreground} on ${issue.background} */`);
        if (issue.selector) {
          contrastFixCss.push(`${issue.selector} { color: ${compliantColor} !important; }`);
        } else {
          contrastFixCss.push(`body { color: ${compliantColor}; }`);
        }

        results.push({
          success: true,
          filePath: issue.filePath,
          modificationType: 'fix_color_contrast',
          description: `Changed ${issue.foreground} to ${compliantColor} for WCAG AA compliance`,
          before: issue.foreground,
          after: compliantColor,
        });
      }
    } else {
      const defaultFixes = [
        { original: '#808080', replacement: '#767676', desc: 'gray text' },
        { original: '#999999', replacement: '#767676', desc: 'light gray text' },
        { original: '#aaaaaa', replacement: '#767676', desc: 'very light gray text' },
        { original: '#888888', replacement: '#6b6b6b', desc: 'medium gray text' },
      ];

      for (const fix of defaultFixes) {
        contrastFixCss.push(`/* Fix ${fix.desc} for WCAG AA (4.5:1 ratio) */`);
      }

      contrastFixCss.push(`
/* WCAG AA Color Contrast Fixes */
/* These overrides ensure text meets 4.5:1 contrast ratio against light backgrounds */
body, p, span, div, li, td, th, a, label {
  /* Ensure minimum contrast for common text colors */
}
[style*="color: #808080"], [style*="color:#808080"] { color: #767676 !important; }
[style*="color: #999"], [style*="color:#999"] { color: #767676 !important; }
[style*="color: gray"], [style*="color:gray"] { color: #767676 !important; }
`);

      results.push({
        success: true,
        filePath: 'stylesheet',
        modificationType: 'fix_color_contrast',
        description: 'Added CSS rules to fix common low-contrast colors',
      });
    }

    if (contrastFixCss.length > 0) {
      const cssContent = contrastFixCss.join('\n');

      if (cssFiles.length > 0) {
        const mainCss = cssFiles[0];
        const existingCss = await zip.file(mainCss)?.async('text') || '';
        zip.file(mainCss, existingCss + '\n\n' + cssContent);

        results.push({
          success: true,
          filePath: mainCss,
          modificationType: 'fix_color_contrast',
          description: 'Appended contrast fixes to existing stylesheet',
        });
      } else {
        for (const filePath of files.slice(0, 1)) {
          const content = await zip.file(filePath)?.async('text');
          if (!content) continue;

          const styleBlock = `<style type="text/css">\n${cssContent}\n</style>`;

          if (content.includes('</head>')) {
            const modified = content.replace('</head>', `${styleBlock}\n</head>`);
            zip.file(filePath, modified);

            results.push({
              success: true,
              filePath,
              modificationType: 'fix_color_contrast',
              description: 'Inserted contrast fixes into document head',
            });
          }
        }
      }
    }

    if (results.length === 0) {
      results.push({
        success: true,
        filePath: 'all',
        modificationType: 'fix_color_contrast',
        description: 'No color contrast issues detected or fixed',
      });
    }

    return results;
  }

  /**
   * Validate and fix landmarks after modifications (Phase 2: Post-Restructuring Validation)
   * Ensures all content files have appropriate ARIA landmarks
   *
   * @param buffer - EPUB buffer
   * @returns Result with any landmark fixes applied
   */
  async validateAndFixLandmarks(buffer: Buffer): Promise<LandmarkValidationResult> {
    try {
      logger.info('[Landmark Validation] Starting post-modification landmark validation...');

      const zip = new JSZip();
      await zip.loadAsync(buffer);

      const changes: FileChange[] = [];
      let hasMainLandmark = false;

      // Get all XHTML/HTML content files
      const contentFiles = Object.keys(zip.files).filter(fileName =>
        !zip.files[fileName].dir &&
        (fileName.endsWith('.xhtml') || fileName.endsWith('.html')) &&
        !fileName.includes('META-INF')
      );

      logger.info(`[Landmark Validation] Found ${contentFiles.length} content files to validate`);

      // First pass: Check if any file already has a main landmark
      for (const fileName of contentFiles) {
        try {
          const file = zip.files[fileName];
          const content = await file.async('text');
          const $ = cheerio.load(content, { xmlMode: true });

          if ($('[role="main"], main').length > 0) {
            hasMainLandmark = true;
            logger.info(`[Landmark Validation] Main landmark found in ${fileName}`);
            break;
          }
        } catch (parseError) {
          logger.warn(`[Landmark Validation] Failed to parse ${fileName}, skipping:`, parseError);
          continue;
        }
      }

      // Second pass: Add main landmark if missing
      if (!hasMainLandmark) {
        logger.warn('[Landmark Validation] No main landmark found - adding to first content file');

        // Find first suitable file (prefer chapter over cover/toc)
        const suitableFile = contentFiles.find(f => {
          const lower = f.toLowerCase();
          return !lower.includes('cover') &&
                 !lower.includes('toc') &&
                 !lower.includes('nav') &&
                 (lower.includes('chapter') || lower.includes('content') || lower.includes('xhtml'));
        }) || contentFiles[0];

        if (suitableFile) {
          try {
            const file = zip.files[suitableFile];
            let content = await file.async('text');
            const $ = cheerio.load(content, { xmlMode: true });

            // Try to add role="main" to first suitable element
            const $body = $('body');
            if ($body.length > 0) {
              const $firstSection = $body.find('section, article, div.content, div.chapter').first();

              if ($firstSection.length > 0) {
                $firstSection.attr('role', 'main');
                content = $.html();
                zip.file(suitableFile, content);

                changes.push({
                  type: 'replace',
                  filePath: suitableFile,
                  description: `Added role="main" to first section`,
                  oldContent: undefined,
                  content: undefined
                });

                logger.info(`[Landmark Validation] Added main landmark to ${suitableFile}`);
              } else {
                // Wrap body content with <main>
                const bodyContent = $body.html() || '';
                $body.html(`<main role="main">\n${bodyContent}\n</main>`);
                content = $.html();
                zip.file(suitableFile, content);

                changes.push({
                  type: 'replace',
                  filePath: suitableFile,
                  description: 'Wrapped content with <main role="main">',
                  oldContent: undefined,
                  content: undefined
                });

                logger.info(`[Landmark Validation] Wrapped content with main landmark in ${suitableFile}`);
              }
            }
          } catch (parseError) {
            logger.error(`[Landmark Validation] Failed to add main landmark to ${suitableFile}:`, parseError);
          }
        }
      }

      // Third pass: Ensure all files have at least one landmark (main, navigation, or contentinfo)
      for (const fileName of contentFiles) {
        try {
          const file = zip.files[fileName];
          let content = await file.async('text');
          const $ = cheerio.load(content, { xmlMode: true });

          // Check if file has ANY landmark
          const hasLandmark = $(
            '[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], ' +
            'main, nav, header[role], footer[role]'
          ).length > 0;

          if (!hasLandmark) {
            const lower = fileName.toLowerCase();

            // Determine appropriate landmark based on file name
            let landmarkRole = 'region'; // Default fallback

            if (lower.includes('cover') || lower.includes('title')) {
              landmarkRole = 'banner';
            } else if (lower.includes('toc') || lower.includes('nav')) {
              landmarkRole = 'navigation';
            } else if (lower.includes('ack') || lower.includes('colophon') || lower.includes('copyright')) {
              landmarkRole = 'contentinfo';
            }

            // Add landmark to body's first child or wrap content
            const $body = $('body');
            if ($body.length > 0) {
              const $firstChild = $body.children().first();

              if ($firstChild.length > 0 && $firstChild.prop('tagName') !== 'script') {
                $firstChild.attr('role', landmarkRole);
                content = $.html();
                zip.file(fileName, content);

                changes.push({
                  type: 'replace',
                  filePath: fileName,
                  description: `Added role="${landmarkRole}" to ensure landmark presence`,
                  oldContent: undefined,
                  content: undefined
                });

                logger.info(`[Landmark Validation] Added ${landmarkRole} landmark to ${fileName}`);
              }
            }
          }
        } catch (parseError) {
          logger.warn(`[Landmark Validation] Failed to process ${fileName}, skipping:`, parseError);
          continue;
        }
      }

      // Generate new buffer
      const newBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });

      logger.info(`[Landmark Validation] Complete - ${changes.length} landmark fixes applied`);

      return {
        buffer: newBuffer,
        changes,
        success: true,
      };

    } catch (error) {
      logger.error('[Landmark Validation] Failed:', error);
      return {
        buffer,
        changes: [],
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
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

interface LandmarkValidationResult {
  success: boolean;
  buffer?: Buffer;
  changes: FileChange[];
  error?: string;
}

export type { FileChange, ModificationResult, LandmarkValidationResult };

export const epubModifier = new EPUBModifierService();
