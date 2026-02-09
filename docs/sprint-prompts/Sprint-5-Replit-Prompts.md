# Sprint 5 Replit Prompts
## Metadata Extraction + AI Alt Text Generation

**Version:** 3.0 - VPAT/ACR Compliance Focus  
**Sprint Duration:** Weeks 9-10 (January 17 - January 31, 2026)  
**Total Story Points:** 38

---

## Sprint 5 Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **AI Service** | Google Gemini (gemini-pro-vision) |
| **PDF Libraries** | pdf-lib, pdfjs-dist |
| **Image Processing** | sharp |
| **External APIs** | OpenLibrary, CrossRef |

**⚠️ MODIFIED SPRINT:** Three stories have been removed to focus on VPAT/ACR compliance: Common Core Alignment, Style Guide Compliance, and Color Palette Extraction. These are deferred to post-MVP.

---

## Epic 5.1: Metadata Extraction

### Prompt US-5.1.1: PDF Metadata Extraction

#### Context
Building comprehensive metadata extraction for PDFs to support cataloging and compliance documentation.

#### Prerequisites
- Sprint 2 PDF parsing services complete
- File storage working

#### Current State
You should have:
- PDF parser extracting basic metadata
- Text extraction working

#### Objective
Create comprehensive PDF metadata extraction service including XMP metadata and custom properties.

#### Technical Requirements

**Create `src/services/metadata/pdf-metadata.service.ts`:**

```typescript
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';

export interface PdfMetadataResult {
  basic: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
    creator?: string;
    producer?: string;
    creationDate?: Date;
    modificationDate?: Date;
  };
  document: {
    pageCount: number;
    pdfVersion: string;
    fileSize: number;
    isEncrypted: boolean;
    isLinearized: boolean;
    hasOutlines: boolean;
    hasAcroForm: boolean;
    hasJavaScript: boolean;
  };
  accessibility: {
    isTagged: boolean;
    language?: string;
    hasStructureTree: boolean;
    displayDocTitle: boolean;
  };
  xmp?: {
    format?: string;
    rights?: string;
    description?: string;
    custom: Record<string, string>;
  };
  fonts: {
    name: string;
    type: string;
    embedded: boolean;
  }[];
  images: {
    count: number;
    totalSize: number;
    formats: string[];
  };
}

export class PdfMetadataService {
  async extract(filePath: string): Promise<PdfMetadataResult> {
    const fileBuffer = await fs.readFile(filePath);
    const fileStats = await fs.stat(filePath);

    // Use pdf-lib for document-level metadata
    const pdfDoc = await PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
    });

    // Use pdfjs-dist for detailed analysis
    const loadingTask = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await loadingTask.promise;
    const pdfMetadata = await pdf.getMetadata();

    // Extract basic metadata
    const basic = {
      title: pdfDoc.getTitle() || pdfMetadata.info?.Title,
      author: pdfDoc.getAuthor() || pdfMetadata.info?.Author,
      subject: pdfDoc.getSubject() || pdfMetadata.info?.Subject,
      keywords: pdfDoc.getKeywords()?.split(',').map(k => k.trim()),
      creator: pdfDoc.getCreator() || pdfMetadata.info?.Creator,
      producer: pdfDoc.getProducer() || pdfMetadata.info?.Producer,
      creationDate: pdfDoc.getCreationDate(),
      modificationDate: pdfDoc.getModificationDate(),
    };

    // Extract document properties
    const document = {
      pageCount: pdf.numPages,
      pdfVersion: pdfMetadata.info?.PDFFormatVersion || 'unknown',
      fileSize: fileStats.size,
      isEncrypted: pdfDoc.isEncrypted,
      isLinearized: pdfMetadata.info?.IsLinearized === 'true',
      hasOutlines: (await pdf.getOutline()) !== null,
      hasAcroForm: pdfMetadata.info?.IsAcroFormPresent === 'true',
      hasJavaScript: false, // Would need deeper analysis
    };

    // Extract accessibility metadata
    const markInfo = pdfMetadata.info?.MarkInfo;
    const accessibility = {
      isTagged: markInfo?.Marked === true,
      language: pdfMetadata.info?.Lang,
      hasStructureTree: markInfo?.Marked === true,
      displayDocTitle: pdfMetadata.info?.DisplayDocTitle === 'true',
    };

    // Extract XMP metadata if present
    const xmp = await this.extractXmpMetadata(pdfDoc);

    // Extract font information
    const fonts = await this.extractFontInfo(pdf);

    // Extract image statistics
    const images = await this.extractImageStats(pdf);

    return {
      basic,
      document,
      accessibility,
      xmp,
      fonts,
      images,
    };
  }

  private async extractXmpMetadata(pdfDoc: PDFDocument): Promise<PdfMetadataResult['xmp'] | undefined> {
    try {
      // XMP metadata is typically stored in the document catalog
      // This is a simplified extraction - full XMP parsing would need xml2js
      const xmpData = pdfDoc.context.trailerInfo.Info;

      if (!xmpData) return undefined;

      return {
        format: 'application/pdf',
        custom: {},
      };
    } catch {
      return undefined;
    }
  }

  private async extractFontInfo(pdf: pdfjsLib.PDFDocumentProxy): Promise<PdfMetadataResult['fonts']> {
    const fonts: PdfMetadataResult['fonts'] = [];
    const seenFonts = new Set<string>();

    // Check first 10 pages for fonts
    for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
      const page = await pdf.getPage(i);
      const operatorList = await page.getOperatorList();

      // Font references are in the operator list
      // This is a simplified approach
    }

    return fonts;
  }

  private async extractImageStats(pdf: pdfjsLib.PDFDocumentProxy): Promise<PdfMetadataResult['images']> {
    let count = 0;
    const formats = new Set<string>();

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const ops = await page.getOperatorList();

      count += ops.fnArray.filter(fn =>
        fn === pdfjsLib.OPS.paintImageXObject ||
        fn === pdfjsLib.OPS.paintInlineImageXObject
      ).length;
    }

    return {
      count,
      totalSize: 0, // Would need deep extraction to calculate
      formats: Array.from(formats),
    };
  }

  formatForCatalog(metadata: PdfMetadataResult): Record<string, string> {
    return {
      'dc:title': metadata.basic.title || '',
      'dc:creator': metadata.basic.author || '',
      'dc:subject': metadata.basic.subject || '',
      'dc:description': metadata.basic.subject || '',
      'dc:publisher': '',
      'dc:date': metadata.basic.creationDate?.toISOString() || '',
      'dc:type': 'Text',
      'dc:format': `application/pdf; version=${metadata.document.pdfVersion}`,
      'dc:language': metadata.accessibility.language || '',
      'dc:rights': metadata.xmp?.rights || '',
    };
  }
}

export const pdfMetadataService = new PdfMetadataService();
```

#### Acceptance Criteria
- [ ] Given a PDF is uploaded
- [ ] When metadata extraction runs
- [ ] Then title, author, subject, keywords are extracted
- [ ] And creation/modification dates are captured
- [ ] And page count, file size, PDF version are recorded
- [ ] And custom metadata fields are detected

#### Implementation Notes
- Extract XMP metadata if present
- Parse document info dictionary
- Handle encrypted metadata gracefully

---

### Prompt US-5.1.2: EPUB Metadata Extraction

#### Context
Extracting comprehensive metadata from EPUB files for cataloging.

#### Prerequisites
- Sprint 4 EPUB parsing complete

#### Current State
You should have:
- EPUB structure analyzer working
- ZIP extraction functional

#### Objective
Create EPUB metadata extraction service for Dublin Core and schema.org properties.

#### Technical Requirements

**Create `src/services/metadata/epub-metadata.service.ts`:**

```typescript
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import sharp from 'sharp';

export interface EpubMetadataResult {
  dublinCore: {
    title?: string;
    creator?: string[];
    contributor?: string[];
    publisher?: string;
    date?: string;
    language?: string;
    identifier?: string[];
    subject?: string[];
    description?: string;
    rights?: string;
    type?: string;
    format?: string;
    source?: string;
    coverage?: string;
    relation?: string;
  };
  opfMetadata: {
    uniqueIdentifier?: string;
    modifiedDate?: string;
    publicationType?: string;
  };
  accessibility: {
    accessMode?: string[];
    accessModeSufficient?: string[];
    accessibilityFeature?: string[];
    accessibilityHazard?: string[];
    accessibilitySummary?: string;
    conformsTo?: string;
  };
  cover?: {
    hasImage: boolean;
    imageData?: Buffer;
    mimeType?: string;
    dimensions?: { width: number; height: number };
  };
  tableOfContents: {
    title: string;
    depth: number;
    itemCount: number;
  };
  spine: {
    itemCount: number;
    pageProgressionDirection: 'ltr' | 'rtl' | 'default';
  };
  manifest: {
    totalItems: number;
    mediaTypes: Record<string, number>;
  };
}

export class EpubMetadataService {
  private parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
  });

  async extract(epubPath: string): Promise<EpubMetadataResult> {
    const zip = new AdmZip(epubPath);

    // Find and parse OPF file
    const containerXml = zip.getEntry('META-INF/container.xml');
    if (!containerXml) {
      throw new Error('Invalid EPUB: Missing container.xml');
    }

    const container = this.parser.parse(containerXml.getData().toString());
    const opfPath = container.container.rootfiles.rootfile['@_full-path'];
    const opfDir = path.dirname(opfPath);

    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) {
      throw new Error('Invalid EPUB: Missing OPF file');
    }

    const opf = this.parser.parse(opfEntry.getData().toString());
    const metadata = opf.package.metadata;

    // Extract Dublin Core metadata
    const dublinCore = this.extractDublinCore(metadata);

    // Extract OPF-specific metadata
    const opfMetadata = this.extractOpfMetadata(opf.package, metadata);

    // Extract accessibility metadata
    const accessibility = this.extractAccessibilityMetadata(metadata);

    // Extract cover image
    const cover = await this.extractCover(zip, opf.package, opfDir);

    // Analyze TOC
    const tableOfContents = await this.analyzeToc(zip, opf.package, opfDir);

    // Analyze spine
    const spine = this.analyzeSpine(opf.package);

    // Analyze manifest
    const manifest = this.analyzeManifest(opf.package);

    return {
      dublinCore,
      opfMetadata,
      accessibility,
      cover,
      tableOfContents,
      spine,
      manifest,
    };
  }

  private extractDublinCore(metadata: any): EpubMetadataResult['dublinCore'] {
    const getValues = (key: string): string[] => {
      const value = metadata[`dc:${key}`];
      if (!value) return [];
      const items = Array.isArray(value) ? value : [value];
      return items.map(v => typeof v === 'string' ? v : v['#text'] || '');
    };

    const getValue = (key: string): string | undefined => {
      const values = getValues(key);
      return values.length > 0 ? values[0] : undefined;
    };

    return {
      title: getValue('title'),
      creator: getValues('creator'),
      contributor: getValues('contributor'),
      publisher: getValue('publisher'),
      date: getValue('date'),
      language: getValue('language'),
      identifier: getValues('identifier'),
      subject: getValues('subject'),
      description: getValue('description'),
      rights: getValue('rights'),
      type: getValue('type'),
      format: getValue('format'),
      source: getValue('source'),
      coverage: getValue('coverage'),
      relation: getValue('relation'),
    };
  }

  private extractOpfMetadata(pkg: any, metadata: any): EpubMetadataResult['opfMetadata'] {
    const modified = metadata?.['meta']?.find?.((m: any) => 
      m['@_property'] === 'dcterms:modified'
    );

    return {
      uniqueIdentifier: pkg['@_unique-identifier'],
      modifiedDate: modified?.['#text'],
      publicationType: metadata?.['meta']?.find?.((m: any) =>
        m['@_property'] === 'rendition:layout'
      )?.['#text'] || 'reflowable',
    };
  }

  private extractAccessibilityMetadata(metadata: any): EpubMetadataResult['accessibility'] {
    const getMetas = (property: string): string[] => {
      const metas = Array.isArray(metadata?.['meta']) ? metadata['meta'] : [metadata?.['meta']].filter(Boolean);
      return metas
        .filter((m: any) => m?.['@_property'] === property)
        .map((m: any) => m['#text'] || '');
    };

    return {
      accessMode: getMetas('schema:accessMode'),
      accessModeSufficient: getMetas('schema:accessModeSufficient'),
      accessibilityFeature: getMetas('schema:accessibilityFeature'),
      accessibilityHazard: getMetas('schema:accessibilityHazard'),
      accessibilitySummary: getMetas('schema:accessibilitySummary')[0],
      conformsTo: getMetas('dcterms:conformsTo')[0],
    };
  }

  private async extractCover(
    zip: AdmZip,
    pkg: any,
    opfDir: string
  ): Promise<EpubMetadataResult['cover']> {
    // Find cover image reference
    const manifest = pkg.manifest.item;
    const items = Array.isArray(manifest) ? manifest : [manifest];

    const coverItem = items.find((item: any) =>
      item['@_properties']?.includes('cover-image') ||
      item['@_id'] === 'cover-image' ||
      item['@_id'] === 'cover'
    );

    if (!coverItem) {
      return { hasImage: false };
    }

    const coverPath = path.join(opfDir, coverItem['@_href']);
    const coverEntry = zip.getEntry(coverPath.replace(/^\//, ''));

    if (!coverEntry) {
      return { hasImage: false };
    }

    const imageData = coverEntry.getData();
    const mimeType = coverItem['@_media-type'];

    try {
      const metadata = await sharp(imageData).metadata();

      return {
        hasImage: true,
        imageData,
        mimeType,
        dimensions: {
          width: metadata.width || 0,
          height: metadata.height || 0,
        },
      };
    } catch {
      return {
        hasImage: true,
        imageData,
        mimeType,
      };
    }
  }

  private async analyzeToc(
    zip: AdmZip,
    pkg: any,
    opfDir: string
  ): Promise<EpubMetadataResult['tableOfContents']> {
    const manifest = pkg.manifest.item;
    const items = Array.isArray(manifest) ? manifest : [manifest];

    const navItem = items.find((item: any) =>
      item['@_properties']?.includes('nav')
    );

    if (!navItem) {
      return { title: 'Table of Contents', depth: 0, itemCount: 0 };
    }

    const navPath = path.join(opfDir, navItem['@_href']);
    const navEntry = zip.getEntry(navPath.replace(/^\//, ''));

    if (!navEntry) {
      return { title: 'Table of Contents', depth: 0, itemCount: 0 };
    }

    const navContent = navEntry.getData().toString();

    // Count TOC items and depth
    const itemCount = (navContent.match(/<li/gi) || []).length;
    const maxDepth = Math.max(
      ...Array.from(navContent.matchAll(/<ol/gi)).map((_, i) => i + 1),
      0
    );

    return {
      title: 'Table of Contents',
      depth: maxDepth,
      itemCount,
    };
  }

  private analyzeSpine(pkg: any): EpubMetadataResult['spine'] {
    const spine = pkg.spine;
    const itemrefs = Array.isArray(spine.itemref) ? spine.itemref : [spine.itemref];

    return {
      itemCount: itemrefs.filter(Boolean).length,
      pageProgressionDirection: spine['@_page-progression-direction'] || 'default',
    };
  }

  private analyzeManifest(pkg: any): EpubMetadataResult['manifest'] {
    const items = Array.isArray(pkg.manifest.item) ? pkg.manifest.item : [pkg.manifest.item];
    const mediaTypes: Record<string, number> = {};

    items.forEach((item: any) => {
      const type = item['@_media-type'] || 'unknown';
      mediaTypes[type] = (mediaTypes[type] || 0) + 1;
    });

    return {
      totalItems: items.length,
      mediaTypes,
    };
  }

  formatForCatalog(metadata: EpubMetadataResult): Record<string, string> {
    return {
      'dc:title': metadata.dublinCore.title || '',
      'dc:creator': metadata.dublinCore.creator?.join('; ') || '',
      'dc:subject': metadata.dublinCore.subject?.join('; ') || '',
      'dc:description': metadata.dublinCore.description || '',
      'dc:publisher': metadata.dublinCore.publisher || '',
      'dc:date': metadata.dublinCore.date || '',
      'dc:type': 'Text',
      'dc:format': 'application/epub+zip',
      'dc:identifier': metadata.dublinCore.identifier?.[0] || '',
      'dc:language': metadata.dublinCore.language || '',
      'dc:rights': metadata.dublinCore.rights || '',
    };
  }
}

export const epubMetadataService = new EpubMetadataService();
```

#### Acceptance Criteria
- [ ] Given an EPUB is uploaded
- [ ] When metadata extraction runs
- [ ] Then Dublin Core metadata is extracted (title, creator, publisher, date)
- [ ] And EPUB-specific metadata (identifier, language, rights) is captured
- [ ] And cover image is extracted
- [ ] And table of contents structure is captured

#### Implementation Notes
- Parse OPF package metadata
- Extract dc: and opf: elements
- Handle multiple identifiers (ISBN, DOI)

---

### Prompt US-5.1.3: ISBN/DOI Lookup

#### Context
Enriching extracted metadata with information from external APIs.

#### Prerequisites
- US-5.1.1 (PDF Metadata Extraction) is complete
- US-5.1.2 (EPUB Metadata Extraction) is complete

#### Current State
You should have:
- Metadata extraction working
- ISBN/DOI values captured

#### Objective
Create external lookup service for ISBN and DOI metadata enrichment.

#### Technical Requirements

**Create `src/services/metadata/lookup.service.ts`:**

```typescript
import axios from 'axios';

export interface IsbnLookupResult {
  found: boolean;
  isbn: string;
  title?: string;
  authors?: string[];
  publisher?: string;
  publishDate?: string;
  subjects?: string[];
  description?: string;
  coverUrl?: string;
  pageCount?: number;
  language?: string;
}

export interface DoiLookupResult {
  found: boolean;
  doi: string;
  title?: string;
  authors?: { given: string; family: string }[];
  publisher?: string;
  publishDate?: string;
  containerTitle?: string; // Journal name
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  abstract?: string;
  type?: string;
}

export class MetadataLookupService {
  private openLibraryUrl = 'https://openlibrary.org/api/books';
  private crossrefUrl = 'https://api.crossref.org/works';
  private timeout = 10000;

  async lookupIsbn(isbn: string): Promise<IsbnLookupResult> {
    // Normalize ISBN (remove hyphens)
    const normalizedIsbn = isbn.replace(/[-\s]/g, '');

    try {
      // Try OpenLibrary API
      const response = await axios.get(this.openLibraryUrl, {
        params: {
          bibkeys: `ISBN:${normalizedIsbn}`,
          format: 'json',
          jscmd: 'data',
        },
        timeout: this.timeout,
      });

      const data = response.data[`ISBN:${normalizedIsbn}`];

      if (!data) {
        // Try Google Books as fallback
        return this.lookupIsbnGoogleBooks(normalizedIsbn);
      }

      return {
        found: true,
        isbn: normalizedIsbn,
        title: data.title,
        authors: data.authors?.map((a: any) => a.name),
        publisher: data.publishers?.[0]?.name,
        publishDate: data.publish_date,
        subjects: data.subjects?.map((s: any) => s.name),
        coverUrl: data.cover?.medium,
        pageCount: data.number_of_pages,
      };
    } catch (error) {
      return {
        found: false,
        isbn: normalizedIsbn,
      };
    }
  }

  private async lookupIsbnGoogleBooks(isbn: string): Promise<IsbnLookupResult> {
    try {
      const response = await axios.get('https://www.googleapis.com/books/v1/volumes', {
        params: {
          q: `isbn:${isbn}`,
        },
        timeout: this.timeout,
      });

      const items = response.data.items;
      if (!items || items.length === 0) {
        return { found: false, isbn };
      }

      const volumeInfo = items[0].volumeInfo;

      return {
        found: true,
        isbn,
        title: volumeInfo.title,
        authors: volumeInfo.authors,
        publisher: volumeInfo.publisher,
        publishDate: volumeInfo.publishedDate,
        subjects: volumeInfo.categories,
        description: volumeInfo.description,
        coverUrl: volumeInfo.imageLinks?.thumbnail,
        pageCount: volumeInfo.pageCount,
        language: volumeInfo.language,
      };
    } catch {
      return { found: false, isbn };
    }
  }

  async lookupDoi(doi: string): Promise<DoiLookupResult> {
    // Normalize DOI
    const normalizedDoi = doi.replace(/^(doi:|https?:\/\/doi\.org\/)/i, '');

    try {
      const response = await axios.get(`${this.crossrefUrl}/${encodeURIComponent(normalizedDoi)}`, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'NinjaPlatform/1.0 (mailto:support@s4carlisle.com)',
        },
      });

      const work = response.data.message;

      return {
        found: true,
        doi: normalizedDoi,
        title: work.title?.[0],
        authors: work.author?.map((a: any) => ({
          given: a.given,
          family: a.family,
        })),
        publisher: work.publisher,
        publishDate: work.published?.['date-parts']?.[0]?.join('-'),
        containerTitle: work['container-title']?.[0],
        volume: work.volume,
        issue: work.issue,
        pages: work.page,
        url: work.URL,
        abstract: work.abstract,
        type: work.type,
      };
    } catch {
      return {
        found: false,
        doi: normalizedDoi,
      };
    }
  }

  async enrichMetadata(metadata: {
    isbn?: string;
    doi?: string;
    title?: string;
    author?: string;
  }): Promise<{
    original: typeof metadata;
    enriched: typeof metadata;
    sources: string[];
  }> {
    const enriched = { ...metadata };
    const sources: string[] = [];

    // Try ISBN lookup
    if (metadata.isbn) {
      const isbnResult = await this.lookupIsbn(metadata.isbn);
      if (isbnResult.found) {
        if (!enriched.title && isbnResult.title) {
          enriched.title = isbnResult.title;
          sources.push('OpenLibrary (ISBN)');
        }
        if (!enriched.author && isbnResult.authors?.length) {
          enriched.author = isbnResult.authors.join('; ');
          sources.push('OpenLibrary (ISBN)');
        }
      }
    }

    // Try DOI lookup
    if (metadata.doi) {
      const doiResult = await this.lookupDoi(metadata.doi);
      if (doiResult.found) {
        if (!enriched.title && doiResult.title) {
          enriched.title = doiResult.title;
          sources.push('CrossRef (DOI)');
        }
        if (!enriched.author && doiResult.authors?.length) {
          enriched.author = doiResult.authors
            .map(a => `${a.family}, ${a.given}`)
            .join('; ');
          sources.push('CrossRef (DOI)');
        }
      }
    }

    return {
      original: metadata,
      enriched,
      sources: [...new Set(sources)],
    };
  }
}

export const metadataLookupService = new MetadataLookupService();
```

#### Acceptance Criteria
- [ ] Given a document has ISBN or DOI
- [ ] When lookup is requested
- [ ] Then metadata is fetched from OpenLibrary/CrossRef APIs
- [ ] And missing fields are populated
- [ ] And user can review and approve enriched metadata
- [ ] And original vs enriched values are distinguished

#### Implementation Notes
- Use OpenLibrary API for ISBN lookup
- Use CrossRef API for DOI lookup
- Cache lookups to avoid rate limits
- Handle API failures gracefully

---

## Epic 5.2: AI-Powered Alt Text Generation

### Prompt US-5.2.1: Image Classification

#### Context
Classifying images by type to apply appropriate alt text generation strategies.

#### Prerequisites
- Sprint 2 Gemini AI integration complete
- Image extraction from PDFs working

#### Current State
You should have:
- Gemini Vision API working
- Images extracted from documents

#### Objective
Create image classification service that categorizes images for appropriate alt text treatment.

#### Technical Requirements

**Create `src/services/ai/image-classifier.service.ts`:**

```typescript
import { geminiService } from './gemini.service.js';

export type ImageType = 'photo' | 'diagram' | 'chart' | 'table' | 'logo' | 'screenshot' | 'decorative' | 'unknown';

export interface ClassificationResult {
  type: ImageType;
  confidence: number;
  subtype?: string;
  isDecorative: boolean;
  suggestedApproach: 'concise' | 'detailed' | 'data-table' | 'skip';
  reasoning: string;
}

export class ImageClassifierService {
  private classificationPrompt = `Analyze this image and classify it into one of these categories:
- photo: A photograph of real-world scenes, people, or objects
- diagram: Technical diagrams, flowcharts, process diagrams, anatomical drawings
- chart: Data visualizations like bar charts, pie charts, line graphs, scatter plots
- table: Tabular data presented as an image
- logo: Company logos, brand marks, icons
- screenshot: Screenshots of software, websites, or interfaces
- decorative: Purely decorative images with no informational content (borders, backgrounds, spacers)

Respond with JSON only:
{
  "type": "category name",
  "confidence": 0.0-1.0,
  "subtype": "more specific type if applicable",
  "isDecorative": true/false,
  "reasoning": "brief explanation"
}`;

  async classify(imageBuffer: Buffer, mimeType: string): Promise<ClassificationResult> {
    try {
      const { text, tokensUsed } = await geminiService.analyzeImage(
        imageBuffer,
        mimeType,
        this.classificationPrompt
      );

      // Parse response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.defaultClassification();
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        type: this.validateType(result.type),
        confidence: Math.max(0, Math.min(1, result.confidence || 0.5)),
        subtype: result.subtype,
        isDecorative: result.isDecorative === true,
        suggestedApproach: this.determineSuggestedApproach(result.type, result.isDecorative),
        reasoning: result.reasoning || '',
      };
    } catch (error) {
      console.error('Image classification error:', error);
      return this.defaultClassification();
    }
  }

  async classifyBatch(
    images: { id: string; buffer: Buffer; mimeType: string }[]
  ): Promise<Map<string, ClassificationResult>> {
    const results = new Map<string, ClassificationResult>();

    // Process in parallel with concurrency limit
    const concurrencyLimit = 5;
    for (let i = 0; i < images.length; i += concurrencyLimit) {
      const batch = images.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(async (img) => {
          const result = await this.classify(img.buffer, img.mimeType);
          return { id: img.id, result };
        })
      );

      batchResults.forEach(({ id, result }) => {
        results.set(id, result);
      });
    }

    return results;
  }

  private validateType(type: string): ImageType {
    const validTypes: ImageType[] = ['photo', 'diagram', 'chart', 'table', 'logo', 'screenshot', 'decorative'];
    return validTypes.includes(type as ImageType) ? (type as ImageType) : 'unknown';
  }

  private determineSuggestedApproach(
    type: string,
    isDecorative: boolean
  ): 'concise' | 'detailed' | 'data-table' | 'skip' {
    if (isDecorative) return 'skip';

    switch (type) {
      case 'photo':
      case 'logo':
      case 'screenshot':
        return 'concise';
      case 'diagram':
        return 'detailed';
      case 'chart':
      case 'table':
        return 'data-table';
      default:
        return 'concise';
    }
  }

  private defaultClassification(): ClassificationResult {
    return {
      type: 'unknown',
      confidence: 0,
      isDecorative: false,
      suggestedApproach: 'concise',
      reasoning: 'Classification failed - defaulting to unknown',
    };
  }
}

export const imageClassifierService = new ImageClassifierService();
```

#### Acceptance Criteria
- [ ] Given images are extracted from a document
- [ ] When classification runs
- [ ] Then images are categorized: Photo, Diagram, Chart, Table, Logo, Decorative
- [ ] And confidence score is provided for each classification
- [ ] And decorative images are flagged for alt='' treatment

#### Implementation Notes
- Use Gemini Vision for classification
- Train on publishing-specific image types
- Handle edge cases (mixed content)
- Batch process for efficiency

---

### Prompt US-5.2.2: AI Alt Text Generation

#### Context
Generating appropriate alt text for images using AI vision capabilities.

#### Prerequisites
- US-5.2.1 (Image Classification) is complete

#### Current State
You should have:
- Image classification working
- Gemini Vision API integrated

#### Objective
Create AI-powered alt text generation with type-specific prompting strategies.

#### Technical Requirements

**Create `src/services/ai/alt-text-generator.service.ts`:**

```typescript
import { geminiService } from './gemini.service.js';
import { ImageType, ClassificationResult } from './image-classifier.service.js';

export interface AltTextResult {
  altText: string;
  longDescription?: string;
  confidence: number;
  imageType: ImageType;
  tokensUsed: number;
  warnings?: string[];
}

export class AltTextGeneratorService {
  private prompts: Record<ImageType, string> = {
    photo: `Generate concise alt text for this photograph. 
- Describe the main subject and key details
- Keep it under 150 characters
- Don't start with "Image of" or "Photo of"
- Focus on what's most important for understanding the content

Respond with JSON:
{
  "altText": "your alt text here",
  "confidence": 0.0-1.0
}`,

    diagram: `Generate descriptive alt text for this diagram.
- Explain what the diagram shows and its purpose
- Describe the key components and their relationships
- Include any labels or text visible in the diagram
- Keep it under 250 characters

Also provide a longer description (100-300 words) for complex understanding.

Respond with JSON:
{
  "altText": "brief alt text",
  "longDescription": "detailed description",
  "confidence": 0.0-1.0
}`,

    chart: `Generate alt text for this data visualization/chart.
- State the type of chart (bar, line, pie, etc.)
- Describe the data being shown
- Mention key trends or notable data points
- Include the approximate values if clearly visible

Also provide a longer description with specific data points if visible.

Respond with JSON:
{
  "altText": "brief alt text describing the chart",
  "longDescription": "detailed description with data points",
  "confidence": 0.0-1.0
}`,

    table: `Generate alt text for this table image.
- Describe the table structure (rows x columns)
- Explain what data the table contains
- Mention column headers if visible
- Note any key insights from the data

Provide a structured description of the table contents.

Respond with JSON:
{
  "altText": "brief description of the table",
  "longDescription": "detailed table structure and content description",
  "confidence": 0.0-1.0
}`,

    logo: `Generate alt text for this logo.
- Identify the organization/brand if recognizable
- Describe the visual elements briefly
- Keep it very concise (under 50 characters)

Respond with JSON:
{
  "altText": "Company Name logo" or "Logo showing [description]",
  "confidence": 0.0-1.0
}`,

    screenshot: `Generate alt text for this screenshot.
- Identify the application or website if recognizable
- Describe the key UI elements shown
- Explain what action or state is being demonstrated
- Keep it under 200 characters

Respond with JSON:
{
  "altText": "alt text here",
  "longDescription": "if needed for complex screenshots",
  "confidence": 0.0-1.0
}`,

    decorative: `This image appears to be decorative. Confirm if this image:
1. Adds no informational content
2. Is purely for visual styling
3. Should use empty alt text (alt="")

Respond with JSON:
{
  "altText": "",
  "isDecorative": true,
  "confidence": 0.0-1.0
}`,

    unknown: `Generate appropriate alt text for this image.
- Describe what you see objectively
- Focus on informational content
- Keep it under 150 characters

Respond with JSON:
{
  "altText": "alt text here",
  "confidence": 0.0-1.0
}`,
  };

  async generate(
    imageBuffer: Buffer,
    mimeType: string,
    classification: ClassificationResult,
    context?: string
  ): Promise<AltTextResult> {
    // Skip decorative images
    if (classification.isDecorative) {
      return {
        altText: '',
        confidence: classification.confidence,
        imageType: 'decorative',
        tokensUsed: 0,
      };
    }

    // Build context-aware prompt
    let prompt = this.prompts[classification.type];
    if (context) {
      prompt = `Context from surrounding text: "${context.substring(0, 500)}"\n\n${prompt}`;
    }

    try {
      const { text, tokensUsed } = await geminiService.analyzeImage(
        imageBuffer,
        mimeType,
        prompt
      );

      // Parse response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.fallbackGeneration(imageBuffer, mimeType, classification);
      }

      const result = JSON.parse(jsonMatch[0]);
      const warnings: string[] = [];

      // Validate alt text
      let altText = result.altText || '';
      if (altText.length > 250) {
        warnings.push('Alt text exceeds recommended length of 250 characters');
        altText = altText.substring(0, 247) + '...';
      }

      if (altText.toLowerCase().startsWith('image of') || altText.toLowerCase().startsWith('photo of')) {
        warnings.push('Alt text starts with redundant phrase');
        altText = altText.replace(/^(image|photo|picture|graphic)\s+of\s+/i, '');
      }

      return {
        altText,
        longDescription: result.longDescription,
        confidence: Math.max(0, Math.min(1, result.confidence || 0.7)),
        imageType: classification.type,
        tokensUsed,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Alt text generation error:', error);
      return this.fallbackGeneration(imageBuffer, mimeType, classification);
    }
  }

  private async fallbackGeneration(
    imageBuffer: Buffer,
    mimeType: string,
    classification: ClassificationResult
  ): Promise<AltTextResult> {
    // Try a simpler prompt
    const simplePrompt = 'Describe this image in one sentence.';

    try {
      const { text, tokensUsed } = await geminiService.analyzeImage(
        imageBuffer,
        mimeType,
        simplePrompt
      );

      return {
        altText: text.substring(0, 250),
        confidence: 0.5,
        imageType: classification.type,
        tokensUsed,
        warnings: ['Used fallback generation due to parsing error'],
      };
    } catch {
      return {
        altText: '[Image description pending manual review]',
        confidence: 0,
        imageType: classification.type,
        tokensUsed: 0,
        warnings: ['Alt text generation failed - manual review required'],
      };
    }
  }

  async generateBatch(
    images: {
      id: string;
      buffer: Buffer;
      mimeType: string;
      classification: ClassificationResult;
      context?: string;
    }[]
  ): Promise<Map<string, AltTextResult>> {
    const results = new Map<string, AltTextResult>();

    // Process sequentially to manage API rate limits
    for (const image of images) {
      const result = await this.generate(
        image.buffer,
        image.mimeType,
        image.classification,
        image.context
      );
      results.set(image.id, result);

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }
}

export const altTextGeneratorService = new AltTextGeneratorService();
```

#### Acceptance Criteria
- [ ] Given an image lacks alt text
- [ ] When generation is requested
- [ ] Then Gemini Vision analyzes the image
- [ ] And generates concise alt text (1-2 sentences)
- [ ] And provides confidence score
- [ ] And user can accept, edit, or reject suggestion

#### Implementation Notes
- Use type-specific prompts for better results
- Include surrounding text context when available
- Validate alt text length and content
- Handle generation failures gracefully

---

### Prompt US-5.2.3: Long Description Generation

#### Context
Generating detailed descriptions for complex images like diagrams and charts.

#### Prerequisites
- US-5.2.2 (AI Alt Text Generation) is complete

#### Current State
You should have:
- Alt text generation working
- Image classification available

#### Objective
Create long description generator for complex images requiring detailed explanations.

#### Technical Requirements

**Create `src/services/ai/long-description.service.ts`:**

```typescript
import { geminiService } from './gemini.service.js';
import { ImageType } from './image-classifier.service.js';

export interface LongDescriptionResult {
  description: string;
  format: 'prose' | 'structured' | 'data-table';
  wordCount: number;
  confidence: number;
  tokensUsed: number;
}

export class LongDescriptionService {
  async generate(
    imageBuffer: Buffer,
    mimeType: string,
    imageType: ImageType,
    context?: string
  ): Promise<LongDescriptionResult> {
    const prompt = this.buildPrompt(imageType, context);

    try {
      const { text, tokensUsed } = await geminiService.analyzeImage(
        imageBuffer,
        mimeType,
        prompt
      );

      // Parse response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse response');
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        description: result.description,
        format: this.determineFormat(imageType),
        wordCount: result.description.split(/\s+/).length,
        confidence: result.confidence || 0.8,
        tokensUsed,
      };
    } catch (error) {
      console.error('Long description generation error:', error);
      return {
        description: 'Detailed description pending manual review.',
        format: 'prose',
        wordCount: 5,
        confidence: 0,
        tokensUsed: 0,
      };
    }
  }

  private buildPrompt(imageType: ImageType, context?: string): string {
    let basePrompt: string;

    switch (imageType) {
      case 'diagram':
        basePrompt = `Provide a detailed description of this diagram for someone who cannot see it.

Include:
1. Overall purpose and what the diagram represents
2. All labeled components and their relationships
3. The flow or sequence if applicable (use terms like "first", "then", "finally")
4. Any symbols, arrows, or connectors and their meaning
5. Colors only if they convey meaning

Structure your description logically, moving from general to specific.
Length: 150-400 words.`;
        break;

      case 'chart':
        basePrompt = `Provide a detailed description of this chart/graph for someone who cannot see it.

Include:
1. Type of chart (bar, line, pie, scatter, etc.)
2. What data is being visualized (title, axes labels)
3. The range of values on each axis
4. Key data points, trends, or patterns
5. Any notable outliers or significant values
6. The conclusion or insight the chart conveys

Format as prose or bullet points as appropriate.
Length: 150-400 words.`;
        break;

      case 'table':
        basePrompt = `Provide a detailed description of this table for someone who cannot see it.

Include:
1. The table's purpose and what data it presents
2. Number of rows and columns
3. Column headers
4. Row headers if present
5. Summary of the data patterns
6. Key values or notable entries

If possible, represent the data in an accessible text format.
Length: 100-300 words.`;
        break;

      default:
        basePrompt = `Provide a comprehensive description of this image for someone who cannot see it.

Include all visually significant details that convey meaning.
Describe spatial relationships between elements.
Note any text visible in the image.

Length: 100-300 words.`;
    }

    if (context) {
      basePrompt = `Context: This image appears in a document about: "${context.substring(0, 200)}"\n\n${basePrompt}`;
    }

    return `${basePrompt}

Respond with JSON:
{
  "description": "your detailed description here",
  "confidence": 0.0-1.0
}`;
  }

  private determineFormat(imageType: ImageType): 'prose' | 'structured' | 'data-table' {
    switch (imageType) {
      case 'chart':
      case 'table':
        return 'data-table';
      case 'diagram':
        return 'structured';
      default:
        return 'prose';
    }
  }

  formatAsHtml(result: LongDescriptionResult): string {
    if (result.format === 'prose') {
      return `<div class="long-description">
  <p>${result.description.replace(/\n\n/g, '</p><p>')}</p>
</div>`;
    }

    if (result.format === 'structured') {
      // Convert numbered points to list
      const lines = result.description.split(/\n/);
      const listItems = lines
        .filter(line => line.trim())
        .map(line => `<li>${line.replace(/^\d+\.\s*/, '')}</li>`)
        .join('\n');

      return `<div class="long-description">
  <ol>
    ${listItems}
  </ol>
</div>`;
    }

    // data-table format
    return `<div class="long-description" role="group" aria-label="Image description">
  ${result.description.replace(/\n/g, '<br>')}
</div>`;
  }
}

export const longDescriptionService = new LongDescriptionService();
```

#### Acceptance Criteria
- [ ] Given an image is classified as complex (diagram, chart, infographic)
- [ ] When long description is requested
- [ ] Then detailed description (100-300 words) is generated
- [ ] And description follows accessibility best practices
- [ ] And structured format is used where appropriate (lists, tables)
- [ ] And user can edit before applying

#### Implementation Notes
- Use structured prompts for diagram descriptions
- Generate data tables for charts
- Include spatial relationships for diagrams
- Format output as accessible HTML

---

### Prompt US-5.2.4: Contextual Caption Generation

#### Context
Generating context-aware captions that relate images to surrounding document content.

#### Prerequisites
- US-5.2.2 (AI Alt Text Generation) is complete

#### Current State
You should have:
- Alt text generation working
- Text extraction available

#### Objective
Create contextual caption generator that considers surrounding text for more relevant descriptions.

#### Technical Requirements

**Create `src/services/ai/contextual-caption.service.ts`:**

```typescript
import { geminiService } from './gemini.service.js';

export interface ContextualCaptionResult {
  caption: string;
  relationship: 'illustrates' | 'supports' | 'extends' | 'contrasts' | 'unknown';
  referencedConcepts: string[];
  confidence: number;
  tokensUsed: number;
}

export class ContextualCaptionService {
  async generate(
    imageBuffer: Buffer,
    mimeType: string,
    surroundingText: {
      before: string;
      after: string;
      sectionTitle?: string;
    }
  ): Promise<ContextualCaptionResult> {
    const prompt = this.buildPrompt(surroundingText);

    try {
      const { text, tokensUsed } = await geminiService.analyzeImage(
        imageBuffer,
        mimeType,
        prompt
      );

      // Parse response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse response');
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        caption: result.caption,
        relationship: this.validateRelationship(result.relationship),
        referencedConcepts: result.referencedConcepts || [],
        confidence: result.confidence || 0.7,
        tokensUsed,
      };
    } catch (error) {
      console.error('Contextual caption generation error:', error);
      return {
        caption: '',
        relationship: 'unknown',
        referencedConcepts: [],
        confidence: 0,
        tokensUsed: 0,
      };
    }
  }

  private buildPrompt(surroundingText: {
    before: string;
    after: string;
    sectionTitle?: string;
  }): string {
    const contextParts: string[] = [];

    if (surroundingText.sectionTitle) {
      contextParts.push(`Section: "${surroundingText.sectionTitle}"`);
    }

    if (surroundingText.before) {
      contextParts.push(`Text before image: "${surroundingText.before.substring(0, 300)}"`);
    }

    if (surroundingText.after) {
      contextParts.push(`Text after image: "${surroundingText.after.substring(0, 300)}"`);
    }

    return `Analyze this image in the context of the surrounding text:

${contextParts.join('\n')}

Generate a caption that:
1. Explains what the image shows
2. Connects it to the concepts in the surrounding text
3. Avoids repeating information already stated in adjacent paragraphs
4. Is appropriate for an educational context

Also determine the relationship between the image and text:
- illustrates: Image directly shows what text describes
- supports: Image provides evidence for text claims
- extends: Image adds information beyond the text
- contrasts: Image shows alternative or comparison
- unknown: Relationship unclear

Respond with JSON:
{
  "caption": "contextual caption here (50-150 words)",
  "relationship": "one of the relationship types",
  "referencedConcepts": ["concept1", "concept2"],
  "confidence": 0.0-1.0
}`;
  }

  private validateRelationship(
    relationship: string
  ): 'illustrates' | 'supports' | 'extends' | 'contrasts' | 'unknown' {
    const valid = ['illustrates', 'supports', 'extends', 'contrasts'];
    return valid.includes(relationship) ? (relationship as any) : 'unknown';
  }

  combineWithAltText(
    altText: string,
    contextualCaption: ContextualCaptionResult
  ): {
    shortAlt: string;
    figcaption: string;
    longdesc: string;
  } {
    // Short alt: Use original alt text
    const shortAlt = altText;

    // Figcaption: Use contextual caption (visible to all users)
    const figcaption = contextualCaption.caption;

    // Longdesc: Combine both with relationship info
    const longdesc = `${altText}\n\nIn context: ${contextualCaption.caption}\n\nThis image ${contextualCaption.relationship} the surrounding text.`;

    return { shortAlt, figcaption, longdesc };
  }
}

export const contextualCaptionService = new ContextualCaptionService();
```

#### Acceptance Criteria
- [ ] Given an image has surrounding text context
- [ ] When generation runs
- [ ] Then surrounding paragraphs are analyzed
- [ ] And caption relates image to document context
- [ ] And redundant information is avoided
- [ ] And educational purpose is considered

#### Implementation Notes
- Extract text before/after image
- Use context in Gemini prompt
- Avoid repeating adjacent text
- Identify relationship type

---

## Sprint 5 Execution Checklist

Execute prompts in this order:

### Week 1 (Jan 17-24)
- [ ] US-5.1.1: PDF Metadata Extraction
- [ ] US-5.1.2: EPUB Metadata Extraction
- [ ] US-5.1.3: ISBN/DOI Lookup
- [ ] US-5.2.1: Image Classification

### Week 2 (Jan 24-31)
- [ ] US-5.2.2: AI Alt Text Generation
- [ ] US-5.2.3: Long Description Generation
- [ ] US-5.2.4: Contextual Caption Generation

---

## Sprint 5 Success Criteria

- ✅ Metadata extraction working for PDF and EPUB
- ✅ Image classification achieving >90% accuracy
- ✅ AI alt text generation producing usable suggestions
- ✅ Long descriptions following accessibility best practices

---

*End of Sprint 5 Replit Prompts*
