import { randomUUID } from 'crypto';
import {
  AccessibilityIssue,
  ValidatorContext,
  ContrastIssue,
  ContrastValidationResult,
  TextColorInfo,
} from '../types';

const NORMAL_TEXT_RATIO_AA = 4.5;
const LARGE_TEXT_RATIO_AA = 3.0;
const NORMAL_TEXT_RATIO_AAA = 7.0;
const LARGE_TEXT_RATIO_AAA = 4.5;

const LARGE_TEXT_SIZE_PT = 18;
const LARGE_TEXT_BOLD_SIZE_PT = 14;

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return null;
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function linearize(channel: number): number {
  const sRGB = channel / 255;
  return sRGB <= 0.03928
    ? sRGB / 12.92
    : Math.pow((sRGB + 0.055) / 1.055, 2.4);
}

function getRelativeLuminance(r: number, g: number, b: number): number {
  const rLin = linearize(r);
  const gLin = linearize(g);
  const bLin = linearize(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

export function calculateContrastRatio(fg: string, bg: string): number {
  const fgRgb = hexToRgb(fg);
  const bgRgb = hexToRgb(bg);

  if (!fgRgb || !bgRgb) return 1;

  const fgLuminance = getRelativeLuminance(fgRgb.r, fgRgb.g, fgRgb.b);
  const bgLuminance = getRelativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b);

  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

function isLargeText(fontSize: number, isBold: boolean): boolean {
  if (isBold) {
    return fontSize >= LARGE_TEXT_BOLD_SIZE_PT;
  }
  return fontSize >= LARGE_TEXT_SIZE_PT;
}

function getRequiredRatio(fontSize: number, isBold: boolean, level: 'AA' | 'AAA'): number {
  const large = isLargeText(fontSize, isBold);
  if (level === 'AAA') {
    return large ? LARGE_TEXT_RATIO_AAA : NORMAL_TEXT_RATIO_AAA;
  }
  return large ? LARGE_TEXT_RATIO_AA : NORMAL_TEXT_RATIO_AA;
}

export function validateContrast(
  textElements: TextColorInfo[],
  _context: ValidatorContext
): ContrastValidationResult {
  const issues: ContrastIssue[] = [];
  const accessibilityIssues: AccessibilityIssue[] = [];
  let passing = 0;
  let failing = 0;
  let needsManualReview = 0;

  for (const element of textElements) {
    if (element.needsManualReview || !element.foregroundColor || !element.backgroundColor) {
      needsManualReview++;
      continue;
    }

    const large = isLargeText(element.fontSize, element.isBold);
    const requiredRatio = getRequiredRatio(element.fontSize, element.isBold, 'AA');
    const contrastRatio = calculateContrastRatio(element.foregroundColor, element.backgroundColor);

    if (contrastRatio >= requiredRatio) {
      passing++;
    } else {
      failing++;

      const contrastIssue: ContrastIssue = {
        page: element.pageNumber,
        elementId: element.id,
        text: element.text.length > 50 ? element.text.substring(0, 50) + '...' : element.text,
        foregroundColor: element.foregroundColor,
        backgroundColor: element.backgroundColor,
        contrastRatio: Math.round(contrastRatio * 100) / 100,
        requiredRatio,
        isLargeText: large,
        wcagCriterion: '1.4.3',
      };
      issues.push(contrastIssue);

      const severity = contrastRatio < requiredRatio * 0.5 ? 'serious' : 'moderate';

      accessibilityIssues.push({
        id: randomUUID(),
        wcagCriterion: '1.4.3',
        wcagLevel: 'AA',
        severity,
        title: 'Insufficient color contrast',
        description: `Text "${contrastIssue.text}" has contrast ratio ${contrastIssue.contrastRatio}:1, but requires ${requiredRatio}:1 for ${large ? 'large' : 'normal'} text.`,
        location: {
          page: element.pageNumber,
          element: element.id,
        },
        remediation: `Increase the contrast between foreground (${element.foregroundColor}) and background (${element.backgroundColor}) colors. Use darker text or lighter background to achieve at least ${requiredRatio}:1 contrast ratio.`,
      });
    }
  }

  const totalAnalyzed = passing + failing;
  const totalChecks = textElements.length;

  return {
    totalTextElements: textElements.length,
    passing,
    failing,
    issues: issues.sort((a, b) => a.contrastRatio - b.contrastRatio),
    accessibilityIssues: accessibilityIssues.sort((a, b) => {
      const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    needsManualReview,
    summary: {
      totalChecks,
      passed: passing,
      failed: failing,
      warnings: needsManualReview,
    },
  };
}

export function parseColorFromPdfOperator(colorArray: number[], colorSpace: string): string {
  if (colorSpace === 'DeviceGray' || colorSpace === 'G') {
    const gray = Math.round(colorArray[0] * 255);
    return rgbToHex(gray, gray, gray);
  }

  if (colorSpace === 'DeviceRGB' || colorSpace === 'RGB') {
    const r = Math.round((colorArray[0] || 0) * 255);
    const g = Math.round((colorArray[1] || 0) * 255);
    const b = Math.round((colorArray[2] || 0) * 255);
    return rgbToHex(r, g, b);
  }

  if (colorSpace === 'DeviceCMYK' || colorSpace === 'CMYK') {
    const c = colorArray[0] || 0;
    const m = colorArray[1] || 0;
    const y = colorArray[2] || 0;
    const k = colorArray[3] || 0;

    const r = Math.round(255 * (1 - c) * (1 - k));
    const g = Math.round(255 * (1 - m) * (1 - k));
    const b = Math.round(255 * (1 - y) * (1 - k));

    return rgbToHex(r, g, b);
  }

  return '#000000';
}

export { rgbToHex, hexToRgb, getRelativeLuminance, isLargeText, getRequiredRatio };
