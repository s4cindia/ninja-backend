import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import path from 'path';
import prisma from '../../lib/prisma';
import { fileStorageService } from '../storage/file-storage.service';

export interface SpineItem {
  id: string;
  href: string;
  mediaType: string;
  order: number;
  title?: string;
}

export interface SpineItemContent {
  spineItem: SpineItem;
  html: string;
  css: string[];
  baseHref: string;
}

export interface ChangeHighlight {
  xpath: string;
  cssSelector?: string;
  description?: string;
}

export interface SpineItemWithChange {
  spineItem: SpineItem | null;
  beforeContent: SpineItemContent | null;
  afterContent: SpineItemContent | null;
  change: {
    id: string;
    changeNumber: number;
    description: string;
    changeType: string;
    severity: string | null;
    filePath: string;
  };
  highlightData: ChangeHighlight;
  isMetadataChange: boolean;
  rawContent?: {
    before: string;
    after: string;
    fileType: string;
  };
}

class EPUBSpineService {
  private cache = new Map<string, {
    zip: JSZip;
    opfPath: string;
    fileName: string;
    timestamp: number;
  }>();

  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.CACHE_TTL) {
          console.log(`[EPUBSpineService] Evicting expired cache entry: ${key}`);
          this.cache.delete(key);
        }
      }
    }, 60000);
  }

  private async loadEPUB(jobId: string, version: 'original' | 'remediated'): Promise<JSZip> {
    const cacheKey = `${jobId}-${version}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[EPUBSpineService] Using cached EPUB for ${cacheKey}`);
      return cached.zip;
    }

    console.log(`[EPUBSpineService] Loading EPUB from file system for ${cacheKey}`);
    
    const job = await prisma.job.findUnique({
      where: { id: jobId }
    });

    if (!job) {
      throw new Error('Job not found');
    }

    const input = job.input as { fileName?: string } | null;
    const fileName = input?.fileName;
    if (!fileName) {
      throw new Error('File name not found in job input');
    }

    const buffer = version === 'original'
      ? await fileStorageService.getFile(jobId, fileName)
      : await fileStorageService.getRemediatedFile(jobId, fileName);

    if (!buffer) {
      throw new Error(`${version} file not found`);
    }

    const zip = await JSZip.loadAsync(buffer);
    const opfPath = await this.findOPFPath(zip);

    this.cache.set(cacheKey, {
      zip,
      opfPath,
      fileName,
      timestamp: Date.now()
    });

    return zip;
  }

  private async loadEPUBWithMetadata(jobId: string, version: 'original' | 'remediated'): Promise<{ zip: JSZip; opfPath: string; fileName: string }> {
    const cacheKey = `${jobId}-${version}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[EPUBSpineService] Using cached EPUB metadata for ${cacheKey}`);
      return { zip: cached.zip, opfPath: cached.opfPath, fileName: cached.fileName };
    }

    const zip = await this.loadEPUB(jobId, version);
    const entry = this.cache.get(cacheKey);
    
    if (!entry) {
      throw new Error('Cache entry not found after loading EPUB');
    }

    return { zip, opfPath: entry.opfPath, fileName: entry.fileName };
  }

  private async findOPFPath(zip: JSZip): Promise<string> {
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) {
      throw new Error('container.xml not found in EPUB');
    }

    const containerContent = await containerFile.async('text');
    const $ = cheerio.load(containerContent, { xmlMode: true });
    const opfPath = $('rootfile').attr('full-path');

    if (!opfPath) {
      throw new Error('OPF path not found in container.xml');
    }

    return opfPath;
  }

  private extractSpineFromOPF(opfContent: string, opfPath: string): SpineItem[] {
    const $ = cheerio.load(opfContent, { xmlMode: true });
    const spineItems: SpineItem[] = [];

    const manifest: Record<string, { href: string; mediaType: string }> = {};
    $('manifest item').each((_, elem) => {
      const id = $(elem).attr('id');
      const href = $(elem).attr('href');
      const mediaType = $(elem).attr('media-type');
      if (id && href) {
        manifest[id] = { href, mediaType: mediaType || '' };
      }
    });

    $('spine itemref').each((index, elem) => {
      const idref = $(elem).attr('idref');
      if (idref && manifest[idref]) {
        const manifestItem = manifest[idref];
        spineItems.push({
          id: idref,
          href: this.resolvePath(opfPath, manifestItem.href),
          mediaType: manifestItem.mediaType,
          order: index
        });
      }
    });

    return spineItems;
  }

  private async extractStyles(zip: JSZip, htmlPath: string, html: string): Promise<string[]> {
    const $ = cheerio.load(html);
    const cssFiles: string[] = [];

    const linkPromises: Promise<void>[] = [];
    $('link[rel="stylesheet"]').each((_, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        const cssPath = this.resolvePath(htmlPath, href);
        const promise = (async () => {
          const cssFile = zip.file(cssPath);
          if (cssFile) {
            const cssContent = await cssFile.async('text');
            cssFiles.push(cssContent);
          }
        })();
        linkPromises.push(promise);
      }
    });

    await Promise.all(linkPromises);

    $('style').each((_, elem) => {
      const styleContent = $(elem).html();
      if (styleContent) {
        cssFiles.push(styleContent);
      }
    });

    return cssFiles;
  }

  private resolvePath(from: string, to: string): string {
    const dir = path.dirname(from);
    return path.posix.normalize(path.posix.join(dir, to));
  }

  private xpathToCssSelector(xpath: string): string | undefined {
    if (!xpath.startsWith('/')) return undefined;

    try {
      const parts = xpath.split('/').filter(p => p);
      const cssPath = parts.map(part => {
        const match = part.match(/^(\w+)(?:\[(\d+)\])?$/);
        if (!match) return null;

        const [, element, index] = match;
        if (index) {
          return `${element}:nth-of-type(${index})`;
        }
        return element;
      }).filter(Boolean);

      if (cssPath.length === 0) return undefined;
      return cssPath.join(' > ');
    } catch {
      return undefined;
    }
  }

  async getSpineItems(jobId: string): Promise<SpineItem[]> {
    const zip = await this.loadEPUB(jobId, 'remediated');
    const opfPath = await this.findOPFPath(zip);
    const opfFile = zip.file(opfPath);

    if (!opfFile) {
      throw new Error('OPF file not found');
    }

    const opfContent = await opfFile.async('text');
    return this.extractSpineFromOPF(opfContent, opfPath);
  }

  async getSpineItemContent(
    jobId: string,
    spineItemId: string,
    version: 'original' | 'remediated'
  ): Promise<SpineItemContent> {
    const zip = await this.loadEPUB(jobId, version);
    const opfPath = await this.findOPFPath(zip);
    const opfFile = zip.file(opfPath);

    if (!opfFile) {
      throw new Error('OPF file not found');
    }

    const opfContent = await opfFile.async('text');
    const spineItems = this.extractSpineFromOPF(opfContent, opfPath);

    const spineItem = spineItems.find(item => item.id === spineItemId);
    if (!spineItem) {
      throw new Error(`Spine item ${spineItemId} not found`);
    }

    const htmlFile = zip.file(spineItem.href);
    if (!htmlFile) {
      throw new Error(`HTML file not found: ${spineItem.href}`);
    }

    const html = await htmlFile.async('text');
    const css = await this.extractStyles(zip, spineItem.href, html);

    return {
      spineItem,
      html,
      css,
      baseHref: path.posix.dirname(spineItem.href)
    };
  }

  async getSpineItemForChange(
    jobId: string,
    changeId: string
  ): Promise<SpineItemWithChange> {
    const change = await prisma.remediationChange.findUnique({
      where: { id: changeId }
    });

    if (!change || change.jobId !== jobId) {
      throw new Error('Change not found');
    }

    const highlightData: ChangeHighlight = {
      xpath: change.elementXPath || '',
      cssSelector: change.elementXPath ? this.xpathToCssSelector(change.elementXPath) : undefined,
      description: change.description
    };

    const changeInfo = {
      id: change.id,
      changeNumber: change.changeNumber,
      description: change.description,
      changeType: change.changeType,
      severity: change.severity,
      filePath: change.filePath
    };

    const isMetadataFile = change.filePath.endsWith('.opf') || 
                           change.filePath.endsWith('.ncx') ||
                           change.filePath.includes('META-INF/');

    if (isMetadataFile) {
      const originalZip = await this.loadEPUB(jobId, 'original');
      const remediatedZip = await this.loadEPUB(jobId, 'remediated');
      
      let beforeRaw = '';
      let afterRaw = '';
      
      if (change.filePath.endsWith('.opf')) {
        const origOpfPath = await this.findOPFPath(originalZip);
        const remOpfPath = await this.findOPFPath(remediatedZip);
        
        const origFile = originalZip.file(origOpfPath);
        const remFile = remediatedZip.file(remOpfPath);
        if (origFile) beforeRaw = await origFile.async('text');
        if (remFile) afterRaw = await remFile.async('text');
      } else {
        const normalizedPath = change.filePath.replace(/^OEBPS\//, 'EPUB/').replace(/^EPUB\//, '');
        const possiblePaths = [
          change.filePath,
          `EPUB/${normalizedPath}`,
          `OEBPS/${normalizedPath}`,
          normalizedPath
        ];
        
        for (const tryPath of possiblePaths) {
          const origFile = originalZip.file(tryPath);
          const remFile = remediatedZip.file(tryPath);
          if (origFile) beforeRaw = await origFile.async('text');
          if (remFile) afterRaw = await remFile.async('text');
          if (beforeRaw || afterRaw) break;
        }
      }

      return {
        spineItem: null,
        beforeContent: null,
        afterContent: null,
        change: changeInfo,
        highlightData,
        isMetadataChange: true,
        rawContent: {
          before: beforeRaw,
          after: afterRaw,
          fileType: change.filePath.endsWith('.opf') ? 'opf' : 'xml'
        }
      };
    }

    const spineItems = await this.getSpineItems(jobId);

    const spineItem = spineItems.find(item =>
      item.href === change.filePath ||
      item.href.endsWith(change.filePath) ||
      change.filePath.endsWith(item.href.split('/').pop() || '')
    );

    if (!spineItem) {
      return {
        spineItem: null,
        beforeContent: null,
        afterContent: null,
        change: changeInfo,
        highlightData,
        isMetadataChange: false
      };
    }

    const beforeContent = await this.getSpineItemContent(jobId, spineItem.id, 'original');
    const afterContent = await this.getSpineItemContent(jobId, spineItem.id, 'remediated');

    return {
      spineItem,
      beforeContent,
      afterContent,
      change: changeInfo,
      highlightData,
      isMetadataChange: false
    };
  }

  async debugChangeToSpineMapping(jobId: string, changeId: string) {
    const change = await prisma.remediationChange.findUnique({
      where: { id: changeId }
    });

    if (!change) {
      return { error: 'Change not found' };
    }

    const spineItems = await this.getSpineItems(jobId);

    console.log('[DEBUG] Change file path:', change.filePath);
    console.log('[DEBUG] Available spine items:');
    spineItems.forEach(item => {
      console.log(`  - ${item.id}: ${item.href}`);
      console.log(`    Exact match: ${item.href === change.filePath}`);
      console.log(`    Ends with: ${item.href.endsWith(change.filePath)}`);
    });

    const matchedItem = spineItems.find(item =>
      item.href === change.filePath ||
      item.href.endsWith(change.filePath)
    );

    return {
      changeFilePath: change.filePath,
      changeType: change.changeType,
      changeDescription: change.description,
      spineItems: spineItems.map(i => ({ id: i.id, href: i.href })),
      matchedSpineItem: matchedItem ? { id: matchedItem.id, href: matchedItem.href } : null
    };
  }
}

export const epubSpineService = new EPUBSpineService();
