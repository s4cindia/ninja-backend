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
  hasJavaScript: boolean;
  hasExternalUrls: boolean;
  externalUrlCount: number;
  hasAudioFiles: boolean;
  hasVideoFiles: boolean;
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

    // Check manifest for media files
    const allFiles = Object.keys(zip.files);
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac'];
    const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
    const hasAudioFiles = allFiles.some(f => audioExtensions.some(ext => f.toLowerCase().endsWith(ext)));
    const hasVideoFiles = allFiles.some(f => videoExtensions.some(ext => f.toLowerCase().endsWith(ext)));

    const analysis: ContentAnalysis = {
      hasAudio: false,
      hasVideo: false,
      hasIframes: false,
      hasForms: false,
      hasInteractiveElements: false,
      hasNavigationBlocks: false,
      hasDataTables: false,
      hasJavaScript: false,
      hasExternalUrls: false,
      externalUrlCount: 0,
      hasAudioFiles,
      hasVideoFiles,
      documentType: 'text',
      fileCount: htmlFiles.length,
      scannedFiles: filesToAnalyze.length,
      scanCoverage
    };

    logger.debug(`[Content Detection] Analyzing ${filesToAnalyze.length} of ${htmlFiles.length} HTML files (${Math.round(scanCoverage * 100)}% coverage)`);
    logger.debug(`[Content Detection] Manifest check: audioFiles=${hasAudioFiles}, videoFiles=${hasVideoFiles}`);

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

        // Check for JavaScript
        if ($('script').length > 0) {
          analysis.hasJavaScript = true;
        }

        // Check for external URLs (potential embedded media) - comprehensive element check
        $('a[href], iframe[src], embed[src], object[data], audio[src], video[src], source[src], link[href], script[src], img[src]').each((_, elem) => {
          const url = $(elem).attr('href') || $(elem).attr('src') || $(elem).attr('data') || '';
          if (url.startsWith('http://') || url.startsWith('https://')) {
            analysis.hasExternalUrls = true;
            analysis.externalUrlCount++;
          }
        });
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

  // Calculate confidence using spec formula (additive/subtractive factors)
  private calculateSpecConfidence(analysis: ContentAnalysis, hasRelevantElements: boolean, hasRelevantFiles: boolean): number {
    // Base confidence = 50%
    let confidence = 50;
    
    // Positive factors (add)
    if (!hasRelevantFiles) confidence += 15;  // No relevant file types in manifest
    if (!hasRelevantElements) confidence += 15;  // No relevant HTML elements
    if (analysis.documentType === 'text') confidence += 10;  // Text-only document
    if (!analysis.hasExternalUrls) confidence += 10;  // No external media references
    
    // Negative factors (subtract)
    if (analysis.hasExternalUrls) confidence -= 20;  // External URLs found
    if (analysis.hasJavaScript) confidence -= 15;  // JavaScript present
    if (analysis.hasIframes) confidence -= 10;  // Iframe elements present
    
    // Maximum 95% (always leave room for edge cases)
    return Math.min(95, Math.max(0, confidence));
  }

  // Analyze multimedia criteria (1.2.1 - 1.2.5)
  private analyzeMultimediaCriteria(analysis: ContentAnalysis): ApplicabilitySuggestion {
    const detectionChecks: DetectionCheck[] = [
      {
        check: 'Audio file presence',
        result: analysis.hasAudioFiles ? 'fail' : 'pass',
        details: analysis.hasAudioFiles ? 'Audio files found in manifest' : 'No .mp3, .wav, .ogg, or .aac files found in manifest'
      },
      {
        check: 'Video file presence',
        result: analysis.hasVideoFiles ? 'fail' : 'pass',
        details: analysis.hasVideoFiles ? 'Video files found in manifest' : 'No .mp4, .webm, .mov, or .avi files found in manifest'
      },
      {
        check: 'Embedded media elements',
        result: (analysis.hasAudio || analysis.hasVideo) ? 'fail' : 'pass',
        details: (analysis.hasAudio || analysis.hasVideo) ? '<audio> or <video> HTML elements detected' : 'No <audio> or <video> HTML elements detected'
      },
      {
        check: 'External media references',
        result: analysis.hasExternalUrls ? 'warning' : 'pass',
        details: analysis.hasExternalUrls ? `Found ${analysis.externalUrlCount} external URLs - manual verification recommended` : 'No external media references found'
      }
    ];

    const hasMediaElements = analysis.hasAudio || analysis.hasVideo;
    const hasMediaFiles = analysis.hasAudioFiles || analysis.hasVideoFiles;
    const hasMedia = hasMediaElements || hasMediaFiles;

    let confidence: number;
    let suggestedStatus: 'not_applicable' | 'applicable' | 'uncertain';
    let rationale: string;
    const edgeCases: string[] = [];

    if (!hasMedia && !analysis.hasIframes) {
      // Calculate confidence using spec formula
      confidence = this.calculateSpecConfidence(analysis, hasMediaElements, hasMediaFiles);
      confidence = this.adjustConfidenceForCoverage(confidence, analysis.scanCoverage);
      suggestedStatus = 'not_applicable';
      const baseRationale = `No audio-only or video-only prerecorded content was detected in this EPUB. The publication contains only text and static images.`;
      rationale = this.addPartialScanWarning(baseRationale, analysis);
      
      // Add edge cases based on analysis
      if (analysis.hasJavaScript) {
        edgeCases.push('JavaScript-loaded media content cannot be analyzed statically');
      }
      if (analysis.hasExternalUrls) {
        edgeCases.push('External embedded media players may not be detected');
      }
    } else if (analysis.hasIframes && !hasMedia) {
      // Medium confidence - iframes could be media
      confidence = this.calculateSpecConfidence(analysis, hasMediaElements, hasMediaFiles);
      confidence = this.adjustConfidenceForCoverage(confidence, analysis.scanCoverage);
      suggestedStatus = 'uncertain';
      const baseRationale = 'Found <iframe> elements which could contain embedded audio/video. Manual inspection required to determine if multimedia criteria apply.';
      rationale = this.addPartialScanWarning(baseRationale, analysis);
      edgeCases.push('Iframes detected - may contain external media');
    } else {
      // Media detected - definitely applicable
      confidence = 95;
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
