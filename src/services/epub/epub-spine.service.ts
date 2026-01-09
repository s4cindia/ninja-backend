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
  spineItem: SpineItem;
  beforeContent: SpineItemContent;
  afterContent: SpineItemContent;
  change: {
    id: string;
    changeNumber: number;
    description: string;
    changeType: string;
    severity: string | null;
  };
  highlightData: ChangeHighlight;
}

class EPUBSpineService {
  private async loadEPUB(jobId: string, version: 'original' | 'remediated'): Promise<JSZip> {
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

    return await JSZip.loadAsync(buffer);
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
    throw new Error('Not implemented');
  }

  async getSpineItemContent(
    jobId: string,
    spineItemId: string,
    version: 'original' | 'remediated'
  ): Promise<SpineItemContent> {
    throw new Error('Not implemented');
  }

  async getSpineItemForChange(
    jobId: string,
    changeId: string
  ): Promise<SpineItemWithChange> {
    throw new Error('Not implemented');
  }
}

export const epubSpineService = new EPUBSpineService();
