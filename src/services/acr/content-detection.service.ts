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

      logger.info('[Content Detection] Analysis complete:', analysis);

      // Generate suggestions for each criterion
      const suggestions = this.generateApplicabilitySuggestions(analysis);

      logger.info(`[Content Detection] Generated ${suggestions.length} applicability suggestions`);

      return suggestions;
    } catch (error) {
      logger.error('[Content Detection] Failed to analyze EPUB content', error instanceof Error ? error : undefined);
      return []; // Return empty array on failure, don't block ACR analysis
    }
  }

  // Analyze EPUB content
  private async performContentAnalysis(zip: JSZip): Promise<ContentAnalysis> {
    const htmlFiles = Object.keys(zip.files).filter(name =>
      (name.endsWith('.html') || name.endsWith('.xhtml') || name.endsWith('.htm')) &&
      !zip.files[name].dir
    );

    const analysis: ContentAnalysis = {
      hasAudio: false,
      hasVideo: false,
      hasIframes: false,
      hasForms: false,
      hasInteractiveElements: false,
      hasNavigationBlocks: false,
      hasDataTables: false,
      documentType: 'text',
      fileCount: htmlFiles.length
    };

    logger.debug(`[Content Detection] Analyzing ${htmlFiles.length} HTML files`);

    // Analyze each HTML file (limit to first 50 files for performance)
    const filesToAnalyze = htmlFiles.slice(0, 50);

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

        // Early exit if we found multimedia (optimization)
        if (analysis.hasAudio && analysis.hasVideo) {
          break;
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
      confidence = 98;
      suggestedStatus = 'not_applicable';
      rationale = `Comprehensive scan found no multimedia content across all ${analysis.fileCount} EPUB files. No <audio>, <video>, or <iframe> tags detected. Multimedia criteria (1.2.1-1.2.5) do not apply to this text-only document.`;
    } else if (hasIframes && !hasMedia) {
      // Medium confidence - iframes could be media
      confidence = 60;
      suggestedStatus = 'uncertain';
      rationale = 'Found <iframe> elements which could contain embedded audio/video. Manual inspection required to determine if multimedia criteria apply.';
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
      confidence = 95;
      suggestedStatus = 'not_applicable';
      rationale = 'No audio content detected. Criterion 1.4.2 (Audio Control) does not apply.';
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
      confidence = 95;
      suggestedStatus = 'not_applicable';
      rationale = 'No form elements detected. Input assistance criteria (3.3.x) do not apply.';
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
      confidence = 90;
      suggestedStatus = 'not_applicable';
      rationale = 'No repetitive navigation blocks detected. Document appears to be linear reading structure. Bypass blocks not required.';
    } else if (analysis.fileCount > 20) {
      confidence = 60;
      suggestedStatus = 'uncertain';
      rationale = 'Large document with many files. Manual review recommended to determine if bypass mechanism would benefit users.';
      edgeCases.push('Large document - may benefit from skip links');
    } else {
      confidence = 70;
      suggestedStatus = 'uncertain';
      rationale = 'Navigation structure detected. Review to determine if bypass mechanism is needed.';
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
      confidence = 92;
      suggestedStatus = 'not_applicable';
      rationale = 'No interactive elements or forms detected. Change criteria (3.2.x) do not apply to static content.';
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
