import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import path from 'path';
import prisma from '../../lib/prisma';
import { fileService } from '../file.service';

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
    throw new Error('Not implemented');
  }

  private async findOPFPath(zip: JSZip): Promise<string> {
    throw new Error('Not implemented');
  }

  private extractSpineFromOPF(opfContent: string, opfPath: string): SpineItem[] {
    throw new Error('Not implemented');
  }

  private async extractStyles(zip: JSZip, htmlPath: string, html: string): Promise<string[]> {
    throw new Error('Not implemented');
  }

  private resolvePath(from: string, to: string): string {
    const dir = path.dirname(from);
    return path.posix.normalize(path.posix.join(dir, to));
  }

  private xpathToCssSelector(xpath: string): string | undefined {
    throw new Error('Not implemented');
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
