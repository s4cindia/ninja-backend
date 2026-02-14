/**
 * PDF Contrast Validator
 *
 * Validates color contrast in PDFs for WCAG compliance.
 * Implements US-PDF-2.3 requirements.
 */

import { logger } from '../../../lib/logger';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';

/**
 * RGB color representation
 */
interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Contrast check result
 */
interface ContrastCheckResult {
  ratio: number;
  meetsAA: boolean;
  meetsAAA: boolean;
  textColor: RgbColor;
  backgroundColor: RgbColor;
}

/**
 * PDF Contrast Validator
 *
 * Checks color contrast ratios for text and non-text elements
 */
export class PdfContrastValidator {
  name = 'PdfContrastValidator';
  private issueCounter = 0;
  private hasLoggedColorWarning = false;

  /**
   * Validate PDF contrast
   *
   * @param parsed - Parsed PDF
   * @returns Array of contrast issues
   */
  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfContrastValidator] Starting contrast validation...');
    this.issueCounter = 0;
    this.hasLoggedColorWarning = false;

    const issues: AuditIssue[] = [];

    try {
      // Validate text contrast on each page
      for (const page of parsed.pages) {
        const pageIssues = await this.validatePageContrast(page, parsed);
        issues.push(...pageIssues);
      }

      logger.info(`[PdfContrastValidator] Found ${issues.length} contrast issues`);
    } catch (error) {
      logger.error('[PdfContrastValidator] Validation failed:', error);
      throw error;
    }

    return issues;
  }

  /**
   * Validate contrast for a single page
   *
   * @param page - PDF page
   * @param parsed - Full parsed PDF for context
   * @returns Array of issues found on this page
   */
  private async validatePageContrast(
    page: PdfParseResult['pages'][0],
    _parsed: PdfParseResult
  ): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // For each text content item, check contrast
    for (const content of page.content) {
      // Extract font size and check if it's large text
      const fontSize = content.font?.size || 12;
      const isBold = content.font?.name?.toLowerCase().includes('bold') || false;
      const isLargeText = this.isLargeText(fontSize, isBold);

      // TODO: Implement actual color extraction from PDF content streams
      // Issue: https://github.com/s4cindia/ninja-backend/issues/TBD
      // Currently using placeholder colors - real implementation needs to extract
      // colors from PDF graphics state and content stream operators
      if (!this.hasLoggedColorWarning) {
        logger.warn(
          '[PdfContrastValidator] Using hardcoded colors for contrast check. ' +
          'Actual color extraction from PDF content streams not yet implemented.'
        );
        this.hasLoggedColorWarning = true;
      }

      const textColor: RgbColor = { r: 0, g: 0, b: 0 }; // Black text (placeholder)
      const backgroundColor: RgbColor = { r: 255, g: 255, b: 255 }; // White background (placeholder)

      const contrastResult = this.checkContrast(textColor, backgroundColor, isLargeText);

      if (!contrastResult.meetsAA) {
        const issue = this.createContrastIssue(
          page.pageNumber,
          content.position,
          contrastResult,
          isLargeText,
          content.text
        );
        issues.push(issue);
      }
    }

    return issues;
  }

  /**
   * Check contrast ratio and compliance
   *
   * @param textColor - Text color RGB
   * @param backgroundColor - Background color RGB
   * @param isLargeText - Whether text is considered large
   * @returns Contrast check result
   */
  private checkContrast(
    textColor: RgbColor,
    backgroundColor: RgbColor,
    isLargeText: boolean
  ): ContrastCheckResult {
    const ratio = this.calculateContrastRatio(textColor, backgroundColor);

    // WCAG AA requirements
    const aaThreshold = isLargeText ? 3.0 : 4.5;
    // WCAG AAA requirements
    const aaaThreshold = isLargeText ? 4.5 : 7.0;

    return {
      ratio,
      meetsAA: ratio >= aaThreshold,
      meetsAAA: ratio >= aaaThreshold,
      textColor,
      backgroundColor,
    };
  }

  /**
   * Create contrast issue
   *
   * @param pageNumber - Page number
   * @param position - Text position
   * @param contrastResult - Contrast check result
   * @param isLargeText - Whether text is large
   * @param text - Sample text
   * @returns Audit issue
   */
  private createContrastIssue(
    pageNumber: number,
    position: { x: number; y: number; width: number; height: number },
    contrastResult: ContrastCheckResult,
    isLargeText: boolean,
    text: string
  ): AuditIssue {
    const { ratio, meetsAA } = contrastResult;
    const threshold = isLargeText ? 3.0 : 4.5;

    // Determine severity based on how far below threshold
    let severity: AuditIssue['severity'];
    if (ratio < 3.0) {
      severity = 'critical';
    } else if (ratio < 4.5 && !isLargeText) {
      severity = 'serious';
    } else if (ratio < 4.5 && isLargeText) {
      severity = 'moderate';
    } else {
      severity = 'minor';
    }

    // Determine WCAG criteria
    const wcagCriteria: string[] = [];
    if (!meetsAA) {
      wcagCriteria.push('1.4.3'); // Contrast (Minimum) - Level AA
    }
    if (ratio < 7.0 && !isLargeText) {
      wcagCriteria.push('1.4.6'); // Contrast (Enhanced) - Level AAA
    }

    // Generate suggested fix
    const suggestedFix = this.generateContrastFix(
      contrastResult.textColor,
      contrastResult.backgroundColor,
      threshold
    );

    const textSample = text.length > 50 ? text.substring(0, 50) + '...' : text;

    return {
      id: `contrast-${++this.issueCounter}`,
      source: 'contrast-validator',
      severity,
      code: 'PDF-LOW-CONTRAST',
      message: `Text has insufficient contrast ratio of ${ratio.toFixed(2)}:1 (minimum ${threshold}:1 required)`,
      wcagCriteria,
      location: `Page ${pageNumber} at (${Math.round(position.x)}, ${Math.round(position.y)})`,
      category: 'contrast',
      element: 'text',
      suggestion: suggestedFix,
      context: `Text: "${textSample}"`,
    };
  }

  /**
   * Generate suggested fix for contrast issue
   *
   * @param textColor - Current text color
   * @param backgroundColor - Current background color
   * @param targetRatio - Target contrast ratio
   * @returns Suggested fix description
   */
  private generateContrastFix(
    textColor: RgbColor,
    backgroundColor: RgbColor,
    targetRatio: number
  ): string {
    const textLuminance = this.getLuminance(textColor.r, textColor.g, textColor.b);
    const bgLuminance = this.getLuminance(backgroundColor.r, backgroundColor.g, backgroundColor.b);

    const suggestions: string[] = [];

    if (textLuminance > bgLuminance) {
      // Light text on dark background
      suggestions.push('Increase background darkness or text brightness');
      suggestions.push(`Suggested: Use pure white text (#FFFFFF) or darker background`);
    } else {
      // Dark text on light background
      suggestions.push('Increase text darkness or background brightness');
      suggestions.push(`Suggested: Use pure black text (#000000) or lighter background`);
    }

    suggestions.push(`Target contrast ratio: ${targetRatio}:1 or higher`);

    return suggestions.join('. ');
  }

  /**
   * Calculate contrast ratio between two colors
   *
   * Uses WCAG formula: (L1 + 0.05) / (L2 + 0.05)
   * where L1 is lighter color luminance and L2 is darker
   *
   * @param color1 - First color RGB
   * @param color2 - Second color RGB
   * @returns Contrast ratio (1.0 to 21.0)
   */
  calculateContrastRatio(color1: RgbColor, color2: RgbColor): number {
    const l1 = this.getLuminance(color1.r, color1.g, color1.b);
    const l2 = this.getLuminance(color2.r, color2.g, color2.b);

    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);

    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Calculate relative luminance of a color
   *
   * Uses WCAG formula for sRGB colors
   *
   * @param r - Red (0-255)
   * @param g - Green (0-255)
   * @param b - Blue (0-255)
   * @returns Relative luminance (0.0 to 1.0)
   */
  getLuminance(r: number, g: number, b: number): number {
    // Convert to 0-1 range
    const [rs, gs, bs] = [r, g, b].map(c => {
      const val = c / 255;
      return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
    });

    // Calculate luminance using WCAG formula
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /**
   * Check if text is considered large
   *
   * Large text: 18pt+ or 14pt+ bold
   *
   * @param fontSize - Font size in points
   * @param isBold - Whether font is bold
   * @returns True if text is large
   */
  isLargeText(fontSize: number, isBold: boolean): boolean {
    if (fontSize >= 18) {
      return true;
    }
    if (fontSize >= 14 && isBold) {
      return true;
    }
    return false;
  }

  /**
   * Convert hex color to RGB
   *
   * @param hex - Hex color string (e.g., "#FF0000" or "FF0000")
   * @returns RGB color object
   */
  hexToRgb(hex: string): RgbColor {
    // Remove # if present
    const cleanHex = hex.replace(/^#/, '');

    // Parse hex values
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);

    return { r, g, b };
  }

  /**
   * Convert RGB to hex color
   *
   * @param rgb - RGB color object
   * @returns Hex color string with #
   */
  rgbToHex(rgb: RgbColor): string {
    const toHex = (n: number) => {
      const hex = Math.round(n).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };

    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  }
}

export const pdfContrastValidator = new PdfContrastValidator();
