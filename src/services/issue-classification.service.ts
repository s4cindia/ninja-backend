import { logger } from '../lib/logger';
import { 
  calculateConfidence, 
  classifyIssue, 
  IssueContext, 
  FixClassification 
} from '../utils/confidence-scoring';
import * as cheerio from 'cheerio';

interface ClassificationResult {
  fixType: FixClassification;
  isAutoFixable: boolean;
  isQuickFixable: boolean;
}

interface ZipEntry {
  getData(): Buffer;
}

interface ZipWithEntries {
  getEntry?(path: string): ZipEntry | null;
}

export class IssueClassificationService {
  calculateConfidence(issueCode: string, context?: IssueContext): number {
    return calculateConfidence(issueCode, context);
  }

  classifyIssue(confidence: number, riskLevel: string = 'medium'): ClassificationResult {
    const fixType = classifyIssue(confidence, riskLevel);
    
    return {
      fixType,
      isAutoFixable: fixType === 'autofix',
      isQuickFixable: fixType === 'quickfix' || fixType === 'autofix'
    };
  }

  async analyzeIssueContext(
    issueCode: string, 
    filePath: string, 
    location: string, 
    zip: Record<string, unknown>
  ): Promise<IssueContext> {
    const context: IssueContext = {};

    try {
      const code = issueCode.toUpperCase();
      
      if (code.includes('STRUCT-002')) {
        context.tableStructure = await this.analyzeTableStructure(zip, filePath, location);
      } else if (code.includes('IMG-001') || code.includes('A11Y-001')) {
        context.imageType = await this.analyzeImageType(zip, filePath, location);
      }
    } catch (error) {
      logger.warn(`[Issue Classification] Context analysis failed: ${error instanceof Error ? error.message : error}`);
    }

    return context;
  }

  private async analyzeTableStructure(
    zip: Record<string, unknown>, 
    filePath: string, 
    _location: string
  ): Promise<'simple' | 'complex'> {
    try {
      const normalizedPath = filePath.replace(/^\/+/, '');
      const zipWithEntries = zip as ZipWithEntries;
      const entry = zipWithEntries.getEntry?.(normalizedPath) || zipWithEntries.getEntry?.(`OEBPS/${normalizedPath}`);

      if (!entry) {
        return 'simple';
      }

      const content = entry.getData().toString('utf-8');
      const $ = cheerio.load(content, { xmlMode: true });

      const tables = $('table');
      let maxComplexity = 0;

      tables.each((_, table) => {
        const $table = $(table);
        const hasNestedTables = $table.find('table').length > 0;
        const hasColspan = $table.find('[colspan]').length > 0;
        const hasRowspan = $table.find('[rowspan]').length > 0;
        const rowCount = $table.find('tr').length;
        const colCount = Math.max(...$table.find('tr').map((_, tr) => $(tr).find('td, th').length).get());
        
        let complexity = 0;
        if (hasNestedTables) complexity += 3;
        if (hasColspan || hasRowspan) complexity += 2;
        if (rowCount > 10) complexity += 1;
        if (colCount > 5) complexity += 1;
        
        maxComplexity = Math.max(maxComplexity, complexity);
      });

      return maxComplexity >= 2 ? 'complex' : 'simple';
    } catch (error) {
      logger.debug(`[Table Analysis] Failed to analyze table structure: ${error instanceof Error ? error.message : error}`);
      return 'simple';
    }
  }

  private async analyzeImageType(
    zip: Record<string, unknown>,
    filePath: string,
    _location: string
  ): Promise<'decorative' | 'content' | 'chart' | 'diagram'> {
    try {
      const normalizedPath = filePath.replace(/^\/+/, '');
      const zipWithEntries = zip as ZipWithEntries;
      const entry = zipWithEntries.getEntry?.(normalizedPath) || zipWithEntries.getEntry?.(`OEBPS/${normalizedPath}`);

      if (!entry) {
        return 'content';
      }

      const content = entry.getData().toString('utf-8');
      const $ = cheerio.load(content, { xmlMode: true });
      
      const images = $('img');
      let imageType: 'decorative' | 'content' | 'chart' | 'diagram' = 'content';

      images.each((_, img) => {
        const $img = $(img);
        const src = $img.attr('src') || '';
        const role = $img.attr('role');
        const ariaHidden = $img.attr('aria-hidden');
        const className = $img.attr('class') || '';

        if (role === 'presentation' || ariaHidden === 'true') {
          imageType = 'decorative';
          return false;
        }

        const srcLower = src.toLowerCase();
        const classLower = className.toLowerCase();

        if (srcLower.includes('chart') || srcLower.includes('graph') || 
            classLower.includes('chart') || classLower.includes('graph')) {
          imageType = 'chart';
          return false;
        }

        if (srcLower.includes('diagram') || srcLower.includes('flowchart') ||
            classLower.includes('diagram') || classLower.includes('flowchart')) {
          imageType = 'diagram';
          return false;
        }

        const decorativePatterns = [
          /spacer/i, /blank/i, /pixel/i, /divider/i, 
          /separator/i, /border/i, /background/i
        ];
        
        if (decorativePatterns.some(p => p.test(src) || p.test(className))) {
          imageType = 'decorative';
          return false;
        }
      });

      return imageType;
    } catch (error) {
      logger.debug(`[Image Analysis] Failed to analyze image type: ${error instanceof Error ? error.message : error}`);
      return 'content';
    }
  }

  async classifyWithContext(
    issueCode: string,
    severity: string,
    filePath: string,
    location: string,
    zip: Record<string, unknown>
  ): Promise<{
    confidence: number;
    fixType: FixClassification;
    isAutoFixable: boolean;
    isQuickFixable: boolean;
    context: IssueContext;
  }> {
    const context = await this.analyzeIssueContext(issueCode, filePath, location, zip);
    
    context.riskLevel = severity === 'critical' ? 'high' : 
                        severity === 'major' ? 'medium' : 'low';

    const confidence = this.calculateConfidence(issueCode, context);
    const classification = this.classifyIssue(confidence, context.riskLevel);

    logger.debug(`[Classification] ${issueCode}: confidence=${confidence.toFixed(2)}, type=${classification.fixType}`);

    return {
      confidence,
      ...classification,
      context
    };
  }
}

export const issueClassificationService = new IssueClassificationService();
