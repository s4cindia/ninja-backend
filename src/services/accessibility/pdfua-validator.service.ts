import { PDFDocument, PDFName, PDFDict, PDFStream } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { pdfParserService, ParsedPDF } from '../pdf/pdf-parser.service';
import { structureAnalyzerService } from '../pdf/structure-analyzer.service';
import { imageExtractorService } from '../pdf/image-extractor.service';
import { MatterhornCheckpoint, PdfUaValidationResult } from './types';

class PdfUaValidatorService {
  async validatePdfUa(filePath: string): Promise<PdfUaValidationResult> {
    let parsedPdf: ParsedPDF | null = null;

    try {
      parsedPdf = await pdfParserService.parse(filePath);
      const checkpoints: MatterhornCheckpoint[] = [];

      const pdfUaVersion = this.checkPdfUaIdentifier(parsedPdf.pdfLibDoc, checkpoints);
      this.checkMarkInfo(parsedPdf.pdfLibDoc, checkpoints);
      await this.checkStructureTree(parsedPdf, checkpoints);
      await this.checkFigureAltText(parsedPdf, checkpoints);
      await this.checkTableStructure(parsedPdf, checkpoints);
      this.checkLanguage(parsedPdf, checkpoints);
      await this.checkUnicodeMappings(parsedPdf, checkpoints);

      const summary = {
        passed: checkpoints.filter(c => c.status === 'pass').length,
        failed: checkpoints.filter(c => c.status === 'fail').length,
        manual: checkpoints.filter(c => c.status === 'manual').length,
      };

      const isPdfUaCompliant = summary.failed === 0 && pdfUaVersion !== null;

      logger.info(`PDF/UA validation completed - Version: ${pdfUaVersion || 'Not marked'}, Compliant: ${isPdfUaCompliant}`);

      return {
        isPdfUaCompliant,
        pdfUaVersion,
        matterhornCheckpoints: checkpoints,
        summary,
      };
    } finally {
      if (parsedPdf) {
        await pdfParserService.close(parsedPdf);
      }
    }
  }

  private checkPdfUaIdentifier(pdfLibDoc: PDFDocument, checkpoints: MatterhornCheckpoint[]): string | null {
    let pdfUaVersion: string | null = null;

    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (!(catalog instanceof PDFDict)) {
        checkpoints.push({
          id: '01-001',
          category: 'PDF/UA Identifier',
          description: 'PDF/UA identifier in XMP metadata',
          status: 'fail',
          details: 'Cannot access document catalog',
        });
        return null;
      }

      const metadataRef = catalog.get(PDFName.of('Metadata'));
      if (!metadataRef) {
        checkpoints.push({
          id: '01-001',
          category: 'PDF/UA Identifier',
          description: 'PDF/UA identifier in XMP metadata',
          status: 'fail',
          details: 'No XMP metadata stream found in document',
        });
        return null;
      }

      const metadataStream = pdfLibDoc.context.lookup(metadataRef);
      if (metadataStream instanceof PDFStream) {
        const metadataBytes = metadataStream.getContents();
        const metadataXml = new TextDecoder().decode(metadataBytes);

        const pdfuaMatch = metadataXml.match(/pdfuaid:part[>"']?\s*(?:>|")?\s*(\d+)/i);
        if (pdfuaMatch) {
          pdfUaVersion = pdfuaMatch[1];
          checkpoints.push({
            id: '01-001',
            category: 'PDF/UA Identifier',
            description: 'PDF/UA identifier in XMP metadata',
            status: 'pass',
            details: `PDF/UA-${pdfUaVersion} identifier found`,
          });
        } else {
          const hasXmpMeta = metadataXml.includes('xmpmeta') || metadataXml.includes('x:xmpmeta');
          checkpoints.push({
            id: '01-001',
            category: 'PDF/UA Identifier',
            description: 'PDF/UA identifier in XMP metadata',
            status: 'fail',
            details: hasXmpMeta 
              ? 'XMP metadata exists but pdfuaid:part property not found' 
              : 'XMP metadata stream does not contain valid XMP',
          });
        }
      } else {
        checkpoints.push({
          id: '01-001',
          category: 'PDF/UA Identifier',
          description: 'PDF/UA identifier in XMP metadata',
          status: 'fail',
          details: 'Metadata reference does not point to a valid stream',
        });
      }
    } catch (error) {
      checkpoints.push({
        id: '01-001',
        category: 'PDF/UA Identifier',
        description: 'PDF/UA identifier in XMP metadata',
        status: 'fail',
        details: `Error checking PDF/UA identifier: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    return pdfUaVersion;
  }

  private checkMarkInfo(pdfLibDoc: PDFDocument, checkpoints: MatterhornCheckpoint[]): void {
    try {
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
      if (!(catalog instanceof PDFDict)) {
        checkpoints.push({
          id: '01-002',
          category: 'Document Tagged',
          description: 'Document marked as tagged (Marked = true in MarkInfo)',
          status: 'fail',
          details: 'Cannot access document catalog',
        });
        return;
      }

      const markInfo = catalog.get(PDFName.of('MarkInfo'));
      if (!markInfo) {
        checkpoints.push({
          id: '01-002',
          category: 'Document Tagged',
          description: 'Document marked as tagged (Marked = true in MarkInfo)',
          status: 'fail',
          details: 'MarkInfo dictionary not found in document catalog',
        });
        return;
      }

      const markInfoDict = pdfLibDoc.context.lookup(markInfo);
      if (markInfoDict instanceof PDFDict) {
        const marked = markInfoDict.get(PDFName.of('Marked'));
        const isMarked = marked?.toString() === 'true';

        checkpoints.push({
          id: '01-002',
          category: 'Document Tagged',
          description: 'Document marked as tagged (Marked = true in MarkInfo)',
          status: isMarked ? 'pass' : 'fail',
          details: isMarked ? 'Document is properly marked as tagged' : 'MarkInfo.Marked is not set to true',
        });
      } else {
        checkpoints.push({
          id: '01-002',
          category: 'Document Tagged',
          description: 'Document marked as tagged (Marked = true in MarkInfo)',
          status: 'fail',
          details: 'MarkInfo is not a valid dictionary',
        });
      }
    } catch (error) {
      checkpoints.push({
        id: '01-002',
        category: 'Document Tagged',
        description: 'Document marked as tagged (Marked = true in MarkInfo)',
        status: 'fail',
        details: `Error checking MarkInfo: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  private async checkStructureTree(parsedPdf: ParsedPDF, checkpoints: MatterhornCheckpoint[]): Promise<void> {
    try {
      const pdfLibDoc = parsedPdf.pdfLibDoc;
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);

      if (!(catalog instanceof PDFDict)) {
        checkpoints.push({
          id: '02-001',
          category: 'Structure Tree',
          description: 'Document has a valid structure tree root',
          status: 'fail',
          details: 'Cannot access document catalog',
        });
        return;
      }

      const structTreeRoot = catalog.get(PDFName.of('StructTreeRoot'));
      if (!structTreeRoot) {
        checkpoints.push({
          id: '02-001',
          category: 'Structure Tree',
          description: 'Document has a valid structure tree root',
          status: 'fail',
          details: 'No StructTreeRoot found - document has no structure tree',
        });
        return;
      }

      const structTreeRootDict = pdfLibDoc.context.lookup(structTreeRoot);
      if (!(structTreeRootDict instanceof PDFDict)) {
        checkpoints.push({
          id: '02-001',
          category: 'Structure Tree',
          description: 'Document has a valid structure tree root',
          status: 'fail',
          details: 'StructTreeRoot is not a valid dictionary',
        });
        return;
      }

      const hasKids = structTreeRootDict.has(PDFName.of('K'));

      if (hasKids) {
        checkpoints.push({
          id: '02-001',
          category: 'Structure Tree',
          description: 'Document has a valid structure tree root',
          status: 'pass',
          details: 'Valid StructTreeRoot with content found',
        });
      } else {
        checkpoints.push({
          id: '02-001',
          category: 'Structure Tree',
          description: 'Document has a valid structure tree root',
          status: 'fail',
          details: 'StructTreeRoot exists but has no child elements (K array)',
        });
      }

      checkpoints.push({
        id: '02-002',
        category: 'Structure Tree',
        description: 'All content is tagged (no untagged content)',
        status: 'manual',
        details: 'Complete verification requires manual review - structure tree exists but full content coverage cannot be automatically verified',
      });

      const structureResult = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: true,
        analyzeTables: false,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });

      const headings = structureResult.headings;
      const hasHeadingIssues = !headings.hasProperHierarchy;
      const skippedLevels = headings.skippedLevels.length > 0;
      const multipleH1 = headings.multipleH1;

      if (hasHeadingIssues) {
        checkpoints.push({
          id: '02-003',
          category: 'Structure Tree',
          description: 'Proper tag nesting and hierarchy',
          status: 'fail',
          details: multipleH1 
            ? 'Multiple H1 headings found - should have single H1'
            : skippedLevels 
              ? `Skipped heading levels detected: ${headings.skippedLevels.map(s => `H${s.from} to H${s.to}`).join(', ')}`
              : 'Heading hierarchy issues detected',
        });
      } else {
        checkpoints.push({
          id: '02-003',
          category: 'Structure Tree',
          description: 'Proper tag nesting and hierarchy',
          status: 'manual',
          details: 'Heading hierarchy passes automated checks. Full structure tree nesting validation (paragraphs, lists, spans, etc.) requires manual review per Matterhorn Protocol.',
        });
      }
    } catch (error) {
      checkpoints.push({
        id: '02-001',
        category: 'Structure Tree',
        description: 'Document has a valid structure tree root',
        status: 'fail',
        details: `Error checking structure tree: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  private async checkFigureAltText(parsedPdf: ParsedPDF, checkpoints: MatterhornCheckpoint[]): Promise<void> {
    try {
      const documentImages = await imageExtractorService.extractImages(parsedPdf, {
        includeBase64: false,
        minWidth: 20,
        minHeight: 20,
      });

      const allImages = documentImages.pages.flatMap(p => p.images);
      const nonDecorativeImages = allImages.filter(img => !img.isDecorative);

      if (allImages.length === 0) {
        checkpoints.push({
          id: '07-001',
          category: 'Figure Alt Text',
          description: 'All Figure tags have Alt or ActualText attribute',
          status: 'pass',
          details: 'No figures found in document',
        });
        return;
      }

      const imagesMissingAlt = nonDecorativeImages.filter(img => !img.altText || img.altText.trim().length === 0);
      const decorativeImages = allImages.filter(img => img.isDecorative);

      if (imagesMissingAlt.length === 0) {
        checkpoints.push({
          id: '07-001',
          category: 'Figure Alt Text',
          description: 'All Figure tags have Alt or ActualText attribute',
          status: 'pass',
          details: `All ${nonDecorativeImages.length} non-decorative figures have alt text. ${decorativeImages.length} decorative images properly marked as artifacts.`,
        });
      } else {
        checkpoints.push({
          id: '07-001',
          category: 'Figure Alt Text',
          description: 'All Figure tags have Alt or ActualText attribute',
          status: 'fail',
          details: `${imagesMissingAlt.length} of ${nonDecorativeImages.length} non-decorative figures missing Alt or ActualText. Pages: ${[...new Set(imagesMissingAlt.map(i => i.pageNumber))].join(', ')}`,
        });
      }

      checkpoints.push({
        id: '07-002',
        category: 'Figure Alt Text',
        description: 'Decorative images marked as Artifact',
        status: decorativeImages.length > 0 ? 'pass' : 'manual',
        details: decorativeImages.length > 0 
          ? `${decorativeImages.length} decorative images properly marked as Artifact`
          : 'No decorative images detected - manual review may be needed to verify all decorative content is properly marked',
      });
    } catch (error) {
      checkpoints.push({
        id: '07-001',
        category: 'Figure Alt Text',
        description: 'All Figure tags have Alt or ActualText attribute',
        status: 'fail',
        details: `Error checking figure alt text: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  private async checkTableStructure(parsedPdf: ParsedPDF, checkpoints: MatterhornCheckpoint[]): Promise<void> {
    try {
      const structureResult = await structureAnalyzerService.analyzeStructure(parsedPdf, {
        analyzeHeadings: false,
        analyzeTables: true,
        analyzeLists: false,
        analyzeLinks: false,
        analyzeReadingOrder: false,
        analyzeLanguage: false,
      });

      const tables = structureResult.tables;

      if (tables.length === 0) {
        checkpoints.push({
          id: '06-001',
          category: 'Table Structure',
          description: 'TH elements have Scope attribute',
          status: 'pass',
          details: 'No tables found in document',
        });
        checkpoints.push({
          id: '06-002',
          category: 'Table Structure',
          description: 'Complex tables have proper id/headers association',
          status: 'pass',
          details: 'No tables found in document',
        });
        return;
      }

      const tablesWithHeaders = tables.filter(t => t.hasHeaderRow || t.hasHeaderColumn);
      const tablesWithoutHeaders = tables.filter(t => !t.hasHeaderRow && !t.hasHeaderColumn && t.rowCount > 1);

      if (tablesWithoutHeaders.length === 0) {
        checkpoints.push({
          id: '06-001',
          category: 'Table Structure',
          description: 'TH elements have Scope attribute',
          status: tablesWithHeaders.length > 0 ? 'manual' : 'pass',
          details: tablesWithHeaders.length > 0
            ? `${tablesWithHeaders.length} tables have headers. Scope attribute verification requires manual review.`
            : 'All tables have header cells defined',
        });
      } else {
        checkpoints.push({
          id: '06-001',
          category: 'Table Structure',
          description: 'TH elements have Scope attribute',
          status: 'fail',
          details: `${tablesWithoutHeaders.length} of ${tables.length} tables are missing header cell definitions. Pages: ${[...new Set(tablesWithoutHeaders.map(t => t.pageNumber))].join(', ')}`,
        });
      }

      const complexTables = tables.filter(t => {
        const hasSpannedCells = t.cells.some(c => c.rowSpan > 1 || c.colSpan > 1);
        return hasSpannedCells || t.rowCount > 5 || t.columnCount > 5;
      });

      if (complexTables.length === 0) {
        checkpoints.push({
          id: '06-002',
          category: 'Table Structure',
          description: 'Complex tables have proper id/headers association',
          status: 'pass',
          details: 'No complex tables found in document',
        });
      } else {
        checkpoints.push({
          id: '06-002',
          category: 'Table Structure',
          description: 'Complex tables have proper id/headers association',
          status: 'manual',
          details: `${complexTables.length} complex tables found. Manual verification of id/headers associations required for merged cells.`,
        });
      }
    } catch (error) {
      checkpoints.push({
        id: '06-001',
        category: 'Table Structure',
        description: 'TH elements have Scope attribute',
        status: 'fail',
        details: `Error checking table structure: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  private checkLanguage(parsedPdf: ParsedPDF, checkpoints: MatterhornCheckpoint[]): void {
    const documentLanguage = parsedPdf.structure.metadata.language;

    if (documentLanguage && documentLanguage.trim().length > 0) {
      // BCP 47: language[-script][-region][-variant][-extension][-privateuse]
      // Examples: en, en-US, zh-Hans, zh-Hant-TW, sr-Latn-RS
      const isValidLangCode = /^[a-z]{2,3}(-[A-Za-z]{4})?(-[A-Z]{2}|-[0-9]{3})?(-[A-Za-z0-9]{5,8})*$/i.test(documentLanguage);
      
      checkpoints.push({
        id: '05-001',
        category: 'Language',
        description: 'Document Lang attribute specified',
        status: isValidLangCode ? 'pass' : 'fail',
        details: isValidLangCode 
          ? `Document language set to: ${documentLanguage}`
          : `Document has language "${documentLanguage}" but format may not be a valid BCP 47 language code`,
      });
    } else {
      checkpoints.push({
        id: '05-001',
        category: 'Language',
        description: 'Document Lang attribute specified',
        status: 'fail',
        details: 'Document Lang attribute not set in document catalog',
      });
    }

    checkpoints.push({
      id: '05-002',
      category: 'Language',
      description: 'Language changes marked with Lang attribute',
      status: 'manual',
      details: 'Language change detection requires content-level analysis - manual review recommended',
    });
  }

  private async checkUnicodeMappings(parsedPdf: ParsedPDF, checkpoints: MatterhornCheckpoint[]): Promise<void> {
    try {
      const pdfLibDoc = parsedPdf.pdfLibDoc;
      const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);

      if (!(catalog instanceof PDFDict)) {
        checkpoints.push({
          id: '08-001',
          category: 'Unicode Mapping',
          description: 'All fonts have Unicode mappings (ToUnicode)',
          status: 'manual',
          details: 'Cannot access document catalog for font analysis',
        });
        return;
      }

      const fonts: { name: string; hasToUnicode: boolean; hasEncoding: boolean }[] = [];
      
      for (let i = 0; i < parsedPdf.structure.pageCount; i++) {
        try {
          const page = pdfLibDoc.getPage(i);
          const resources = page.node.get(PDFName.of('Resources'));
          if (!resources) continue;

          const resourcesDict = pdfLibDoc.context.lookup(resources);
          if (!(resourcesDict instanceof PDFDict)) continue;

          const fontDict = resourcesDict.get(PDFName.of('Font'));
          if (!fontDict) continue;

          const fontsDict = pdfLibDoc.context.lookup(fontDict);
          if (!(fontsDict instanceof PDFDict)) continue;

          const entries = fontsDict.entries();
          for (const [fontName, fontRef] of entries) {
            const fontObj = pdfLibDoc.context.lookup(fontRef);
            if (fontObj instanceof PDFDict) {
              const hasToUnicode = fontObj.has(PDFName.of('ToUnicode'));
              const encoding = fontObj.get(PDFName.of('Encoding'));
              const hasEncoding = encoding !== undefined;

              const name = fontName.toString();
              if (!fonts.some(f => f.name === name)) {
                fonts.push({
                  name,
                  hasToUnicode,
                  hasEncoding,
                });
              }
            }
          }
        } catch {
          // Continue with other pages
        }
      }

      if (fonts.length === 0) {
        checkpoints.push({
          id: '08-001',
          category: 'Unicode Mapping',
          description: 'All fonts have Unicode mappings (ToUnicode)',
          status: 'manual',
          details: 'No font resources detected - manual review recommended',
        });
        return;
      }

      const fontsWithToUnicode = fonts.filter(f => f.hasToUnicode);
      const fontsWithStandardEncoding = fonts.filter(f => !f.hasToUnicode && f.hasEncoding);
      const fontsWithNoMapping = fonts.filter(f => !f.hasToUnicode && !f.hasEncoding);

      if (fontsWithNoMapping.length > 0) {
        checkpoints.push({
          id: '08-001',
          category: 'Unicode Mapping',
          description: 'All fonts have Unicode mappings (ToUnicode)',
          status: 'fail',
          details: `${fontsWithNoMapping.length} of ${fonts.length} fonts lack Unicode mapping: ${fontsWithNoMapping.map(f => f.name).join(', ')}. PDF/UA requires ToUnicode CMaps for all fonts.`,
        });
      } else if (fontsWithStandardEncoding.length > 0) {
        checkpoints.push({
          id: '08-001',
          category: 'Unicode Mapping',
          description: 'All fonts have Unicode mappings (ToUnicode)',
          status: 'manual',
          details: `${fontsWithToUnicode.length} fonts have ToUnicode, ${fontsWithStandardEncoding.length} rely on standard encoding. Manual verification needed to confirm text extraction works correctly.`,
        });
      } else {
        checkpoints.push({
          id: '08-001',
          category: 'Unicode Mapping',
          description: 'All fonts have Unicode mappings (ToUnicode)',
          status: 'pass',
          details: `All ${fonts.length} fonts have ToUnicode CMap for proper Unicode mapping`,
        });
      }

      checkpoints.push({
        id: '08-002',
        category: 'Unicode Mapping',
        description: 'No text relies on visual appearance only',
        status: 'manual',
        details: 'Visual appearance verification requires manual review - checking for ligatures, symbols, or special characters that may not extract correctly',
      });
    } catch (error) {
      checkpoints.push({
        id: '08-001',
        category: 'Unicode Mapping',
        description: 'All fonts have Unicode mappings (ToUnicode)',
        status: 'manual',
        details: `Error checking Unicode mappings: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }
}

export const pdfUaValidatorService = new PdfUaValidatorService();
