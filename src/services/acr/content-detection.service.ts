import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';

export interface DetectionCheck {
  check: string;
  result: 'pass' | 'fail' | 'warning';
  details?: string;
}

export interface ApplicabilitySuggestion {
  criterionId: string;
  suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
  confidence: number;
  detectionChecks: DetectionCheck[];
  rationale: string;
  edgeCases: string[];
}

interface ContentAnalysis {
  hasAudio: boolean;
  hasVideo: boolean;
  hasIframes: boolean;
  hasForms: boolean;
  hasInteractiveElements: boolean;
  hasNavigationBlocks: boolean;
  hasDataTables: boolean;
  documentType: string;
  fileCount: number;
  scannedFiles: number;
  scanCoverage: number; // 0-1 indicating % of files scanned
}

class ContentDetectionService {
  // Main analysis function
  async analyzeEPUBContent(buffer: Buffer): Promise<ApplicabilitySuggestion[]> {
    logger.info('[Content Detection] Starting EPUB content analysis');

    try {
      // Load EPUB
      const zip = await JSZip.loadAsync(buffer);

      // Analyze content
      const analysis = await this.performContentAnalysis(zip);

      logger.info('[Content Detection] Analysis complete:', { analysis });

      // Generate suggestions for each criterion
      const suggestions = this.generateApplicabilitySuggestions(analysis);

      logger.info(`[Content Detection] Generated ${suggestions.length} applicability suggestions`);

      return suggestions;
    } catch (error) {
      // Preserve and log all error types (Error or non-Error)
      const errorDetails = error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : JSON.stringify(error));

      logger.error('[Content Detection] Failed to analyze EPUB content', errorDetails);
      return []; // Return empty array on failure, don't block ACR analysis
    }
  }

  // Analyze EPUB content
  private async performContentAnalysis(zip: JSZip): Promise<ContentAnalysis> {
    const htmlFiles = Object.keys(zip.files).filter(name => {
      const lowerName = name.toLowerCase();
      return (lowerName.endsWith('.html') || lowerName.endsWith('.xhtml') || lowerName.endsWith('.htm')) &&
        !zip.files[name].dir;
    });

    // Analyze each HTML file (limit to first 50 files for performance)
    const filesToAnalyze = htmlFiles.slice(0, 50);
    const scanCoverage = htmlFiles.length > 0 ? filesToAnalyze.length / htmlFiles.length : 1;

    const analysis: ContentAnalysis = {
      hasAudio: false,
      hasVideo: false,
      hasIframes: false,
      hasForms: false,
      hasInteractiveElements: false,
      hasNavigationBlocks: false,
      hasDataTables: false,
      documentType: 'text',
      fileCount: htmlFiles.length,
      scannedFiles: filesToAnalyze.length,
      scanCoverage
    };

    logger.debug(`[Content Detection] Analyzing ${filesToAnalyze.length} of ${htmlFiles.length} HTML files (${Math.round(scanCoverage * 100)}% coverage)`);

    for (const fileName of filesToAnalyze) {
      try {
        const content = await zip.file(fileName)?.async('text');
        if (!content) continue;

        const $ = cheerio.load(content);

        // Check for audio
        if ($('audio').length > 0) {
          analysis.hasAudio = true;
        }

        // Check for video
        if ($('video').length > 0) {
          analysis.hasVideo = true;
        }

        // Check for iframes (could be embedded media)
        if ($('iframe').length > 0) {
          analysis.hasIframes = true;
        }

        // Check for forms
        if ($('form, input, select, textarea').length > 0) {
          analysis.hasForms = true;
        }

        // Check for interactive elements
        if ($('button, [role="button"], [onclick]').length > 0) {
          analysis.hasInteractiveElements = true;
        }

        // Check for navigation blocks
        if ($('nav, [role="navigation"]').length > 0) {
          analysis.hasNavigationBlocks = true;
        }

        // Check for data tables
        if ($('table').length > 0) {
          const tables = $('table');
          let hasDataTable = false;
          tables.each((_, elem) => {
            const $table = $(elem);
            // Data tables typically have th elements
            if ($table.find('th').length > 0) {
              hasDataTable = true;
            }
          });
          if (hasDataTable) {
            analysis.hasDataTables = true;
          }
        }
      } catch (error) {
        logger.warn(`[Content Detection] Failed to parse file ${fileName}, skipping`, error instanceof Error ? error : undefined);
        continue;
      }
    }

    // Determine document type
    if (analysis.hasAudio || analysis.hasVideo || analysis.hasIframes) {
      analysis.documentType = 'multimedia';
    } else if (analysis.hasForms || analysis.hasInteractiveElements) {
      analysis.documentType = 'interactive';
    } else {
      analysis.documentType = 'text';
    }

    return analysis;
  }

  // Generate N/A suggestions based on content analysis
  private generateApplicabilitySuggestions(analysis: ContentAnalysis): ApplicabilitySuggestion[] {
    const suggestions: ApplicabilitySuggestion[] = [];

    // Multimedia criteria (1.2.x)
    suggestions.push(this.analyzeMultimediaCriteria(analysis));

    // Audio control (1.4.2)
    suggestions.push(this.analyzeAudioControl(analysis));

    // Form/Input criteria (3.3.x)
    suggestions.push(...this.analyzeFormCriteria(analysis));

    // Bypass blocks (2.4.1)
    suggestions.push(this.analyzeBypassBlocks(analysis));

    // Interactive change criteria (3.2.x)
    suggestions.push(...this.analyzeChangeCriteria(analysis));

    return suggestions;
  }

  // Helper to adjust confidence based on scan coverage
  private adjustConfidenceForCoverage(baseConfidence: number, scanCoverage: number): number {
    // Reduce confidence if scan coverage is incomplete
    // Full coverage (100%) = no reduction
    // 50% coverage = reduce confidence by up to 10 points
    if (scanCoverage >= 1) return baseConfidence;

    const coveragePenalty = Math.round((1 - scanCoverage) * 10);
    return Math.max(baseConfidence - coveragePenalty, 50);
  }

  // Helper to add partial scan warning to rationale
  private addPartialScanWarning(rationale: string, analysis: ContentAnalysis): string {
    if (analysis.scanCoverage < 1) {
      const coveragePercent = Math.round(analysis.scanCoverage * 100);
      return `${rationale} Note: Analysis based on ${analysis.scannedFiles} of ${analysis.fileCount} files (${coveragePercent}% coverage).`;
    }
    return rationale;
  }

  // Analyze multimedia criteria (1.2.1 - 1.2.5)
  private analyzeMultimediaCriteria(analysis: ContentAnalysis): ApplicabilitySuggestion {
    const detectionChecks: DetectionCheck[] = [
      {
        check: 'No <audio> tags found',
        result: analysis.hasAudio ? 'fail' : 'pass'
      },
      {
        check: 'No <video> tags found',
        result: analysis.hasVideo ? 'fail' : 'pass'
      },
      {
        check: 'No <iframe> tags found',
        result: analysis.hasIframes ? 'fail' : 'pass',
        details: analysis.hasIframes ? 'Could be embedded media' : undefined
      }
    ];

    const hasMedia = analysis.hasAudio || analysis.hasVideo;
    const hasIframes = analysis.hasIframes;

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;
    const edgeCases: string[] = [];

    if (!hasMedia && !hasIframes) {
      // High confidence N/A
      const baseConfidence = 98;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = `Scan found no multimedia content in ${analysis.scannedFiles} EPUB files. No <audio>, <video>, or <iframe> tags detected. Multimedia criteria (1.2.1-1.2.5) do not apply to this text-only document.`;
      rationale = this.addPartialScanWarning(baseRationale, analysis);
    } else if (hasIframes && !hasMedia) {
      // Medium confidence - iframes could be media
      const baseConfidence = 60;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'uncertain';
      const baseRationale = 'Found <iframe> elements which could contain embedded audio/video. Manual inspection required to determine if multimedia criteria apply.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
      edgeCases.push('Iframes detected - may contain external media');
    } else {
      // Media detected - definitely applicable
      confidence = 98;
      suggestedStatus = 'applicable';
      rationale = 'Audio and/or video content detected. Multimedia criteria (1.2.1-1.2.5) are applicable.';
    }

    return {
      criterionId: '1.2.x', // Represents all 1.2.x criteria
      suggestedStatus,
      confidence,
      detectionChecks,
      rationale,
      edgeCases
    };
  }

  // Analyze audio control (1.4.2)
  private analyzeAudioControl(analysis: ContentAnalysis): ApplicabilitySuggestion {
    const detectionChecks: DetectionCheck[] = [
      {
        check: 'No <audio> tags found',
        result: analysis.hasAudio ? 'fail' : 'pass'
      },
      {
        check: 'Unable to detect autoplay attribute',
        result: 'warning',
        details: 'Autoplay can be set via JavaScript'
      }
    ];

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;
    const edgeCases: string[] = [];

    if (!analysis.hasAudio) {
      const baseConfidence = 95;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = 'No audio content detected. Criterion 1.4.2 (Audio Control) does not apply.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
    } else {
      confidence = 50;
      suggestedStatus = 'uncertain';
      rationale = 'Audio content detected, but cannot determine if it autoplays. Manual verification required.';
      edgeCases.push('Cannot detect autoplay behavior');
    }

    return {
      criterionId: '1.4.2',
      suggestedStatus,
      confidence,
      detectionChecks,
      rationale,
      edgeCases
    };
  }

  // Analyze form/input criteria (3.3.1, 3.3.2, 3.3.3, 3.3.4)
  private analyzeFormCriteria(analysis: ContentAnalysis): ApplicabilitySuggestion[] {
    const suggestions: ApplicabilitySuggestion[] = [];

    const detectionChecks: DetectionCheck[] = [
      {
        check: 'No form elements found',
        result: analysis.hasForms ? 'fail' : 'pass'
      }
    ];

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;

    if (!analysis.hasForms) {
      const baseConfidence = 95;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = 'No form elements detected. Input assistance criteria (3.3.x) do not apply.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
    } else {
      confidence = 98;
      suggestedStatus = 'applicable';
      rationale = 'Form elements detected. Input assistance criteria (3.3.x) are applicable.';
    }

    // Apply to all 3.3.x criteria
    ['3.3.1', '3.3.2', '3.3.3', '3.3.4'].forEach(criterionId => {
      suggestions.push({
        criterionId,
        suggestedStatus,
        confidence,
        detectionChecks: [...detectionChecks],
        rationale,
        edgeCases: []
      });
    });

    return suggestions;
  }

  // Analyze bypass blocks (2.4.1)
  private analyzeBypassBlocks(analysis: ContentAnalysis): ApplicabilitySuggestion {
    const detectionChecks: DetectionCheck[] = [
      {
        check: 'No navigation blocks detected',
        result: analysis.hasNavigationBlocks ? 'fail' : 'pass'
      },
      {
        check: `Document has ${analysis.fileCount} files`,
        result: analysis.fileCount > 20 ? 'warning' : 'pass',
        details: analysis.fileCount > 20 ? 'Large document may benefit from skip links' : undefined
      }
    ];

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;
    const edgeCases: string[] = [];

    if (!analysis.hasNavigationBlocks && analysis.fileCount < 10) {
      const baseConfidence = 90;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = 'No repetitive navigation blocks detected. Document appears to be linear reading structure. Bypass blocks not required.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
    } else if (analysis.fileCount > 20) {
      const baseConfidence = 60;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'uncertain';
      const baseRationale = 'Large document with many files. Manual review recommended to determine if bypass mechanism would benefit users.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
      edgeCases.push('Large document - may benefit from skip links');
    } else {
      const baseConfidence = 70;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'uncertain';
      const baseRationale = 'Navigation structure detected. Review to determine if bypass mechanism is needed.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
      edgeCases.push('Custom navigation detected');
    }

    return {
      criterionId: '2.4.1',
      suggestedStatus,
      confidence,
      detectionChecks,
      rationale,
      edgeCases
    };
  }

  // Analyze change on request criteria (3.2.1, 3.2.2, 3.2.5)
  private analyzeChangeCriteria(analysis: ContentAnalysis): ApplicabilitySuggestion[] {
    const suggestions: ApplicabilitySuggestion[] = [];

    const detectionChecks: DetectionCheck[] = [
      {
        check: 'No interactive elements found',
        result: analysis.hasInteractiveElements ? 'fail' : 'pass'
      },
      {
        check: 'No form elements found',
        result: analysis.hasForms ? 'fail' : 'pass'
      }
    ];

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;

    if (!analysis.hasInteractiveElements && !analysis.hasForms) {
      const baseConfidence = 92;
      confidence = this.adjustConfidenceForCoverage(baseConfidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = 'No interactive elements or forms detected. Change criteria (3.2.x) do not apply to static content.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
    } else {
      confidence = 95;
      suggestedStatus = 'applicable';
      rationale = 'Interactive elements or forms detected. Change criteria (3.2.x) are applicable.';
    }

    // Apply to specific change criteria
    ['3.2.1', '3.2.2', '3.2.5'].forEach(criterionId => {
      suggestions.push({
        criterionId,
        suggestedStatus,
        confidence,
        detectionChecks: [...detectionChecks],
        rationale,
        edgeCases: []
      });
    });

    return suggestions;
  }
}

export const contentDetectionService = new ContentDetectionService();
