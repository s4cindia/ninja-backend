import { randomUUID } from 'crypto';
import { AccessibilityIssue, ValidatorContext } from '../types';
import { ImageInfo } from '../../pdf/image-extractor.service';

export interface ImageAltTextStatus {
  imageId: string;
  page: number;
  position: { x: number; y: number; width: number; height: number };
  hasAltText: boolean;
  altText: string | null;
  isDecorative: boolean;
  wcagCompliant: boolean;
  issue?: AccessibilityIssue;
  qualityFlags: string[];
}

export interface AltTextValidationResult {
  totalImages: number;
  withAltText: number;
  missingAltText: number;
  decorativeImages: number;
  compliancePercentage: number;
  images: ImageAltTextStatus[];
  issues: AccessibilityIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

const FILENAME_PATTERN = /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|gif|bmp|webp|svg|tiff?)$/i;
const REDUNDANT_PREFIXES = [
  'image of',
  'picture of',
  'photo of',
  'photograph of',
  'graphic of',
  'icon of',
  'illustration of',
];

function detectQualityFlags(altText: string): string[] {
  const flags: string[] = [];
  const trimmed = altText.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length < 5) {
    flags.push('too_short');
  }

  if (FILENAME_PATTERN.test(trimmed)) {
    flags.push('filename_as_alt');
  }

  for (const prefix of REDUNDANT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      flags.push('starts_with_image_of');
      break;
    }
  }

  if (trimmed.length > 500) {
    flags.push('too_long');
  }

  if (/^\d+$/.test(trimmed)) {
    flags.push('numbers_only');
  }

  return flags;
}

export function validateAltText(
  images: ImageInfo[],
  _context: ValidatorContext
): AltTextValidationResult {
  const imageStatuses: ImageAltTextStatus[] = [];
  const issues: AccessibilityIssue[] = [];

  let withAltText = 0;
  let missingAltText = 0;
  let decorativeImages = 0;
  let compliantCount = 0;

  for (const img of images) {
    const hasAltText = !!img.altText && img.altText.trim().length > 0;
    const isDecorative = img.isDecorative === true;
    const qualityFlags: string[] = hasAltText ? detectQualityFlags(img.altText!) : [];

    let wcagCompliant = false;
    let issue: AccessibilityIssue | undefined;

    if (isDecorative) {
      decorativeImages++;
      if (!hasAltText || img.altText?.trim() === '') {
        wcagCompliant = true;
        compliantCount++;
      } else {
        issue = {
          id: randomUUID(),
          wcagCriterion: '1.1.1',
          wcagLevel: 'A',
          severity: 'minor',
          title: 'Decorative image has alt text',
          description: `Decorative image "${img.id}" has alt text "${img.altText}" but should have empty alt text or no alt attribute since it is marked as decorative.`,
          location: {
            page: img.pageNumber,
            element: img.id,
          },
          remediation: 'Remove the alt text or set alt="" for decorative images to prevent screen readers from announcing them.',
        };
        issues.push(issue);
      }
    } else if (hasAltText) {
      withAltText++;
      wcagCompliant = true;
      compliantCount++;

      if (qualityFlags.includes('filename_as_alt')) {
        issue = {
          id: randomUUID(),
          wcagCriterion: '1.1.1',
          wcagLevel: 'A',
          severity: 'moderate',
          title: 'Alt text appears to be a filename',
          description: `Image "${img.id}" has alt text "${img.altText}" which appears to be a filename rather than descriptive text.`,
          location: {
            page: img.pageNumber,
            element: img.id,
          },
          remediation: 'Replace the filename with meaningful descriptive text that conveys the purpose or content of the image.',
        };
        issues.push(issue);
      } else if (qualityFlags.includes('too_short')) {
        issue = {
          id: randomUUID(),
          wcagCriterion: '1.1.1',
          wcagLevel: 'A',
          severity: 'minor',
          title: 'Alt text may be too short',
          description: `Image "${img.id}" has very short alt text "${img.altText}" (less than 5 characters). Consider if this adequately describes the image.`,
          location: {
            page: img.pageNumber,
            element: img.id,
          },
          remediation: 'Review the alt text and ensure it adequately describes the image content or purpose.',
        };
        issues.push(issue);
      } else if (qualityFlags.includes('starts_with_image_of')) {
        issue = {
          id: randomUUID(),
          wcagCriterion: '1.1.1',
          wcagLevel: 'A',
          severity: 'minor',
          title: 'Alt text has redundant prefix',
          description: `Image "${img.id}" has alt text starting with a redundant phrase like "image of" or "picture of". Screen readers already announce this is an image.`,
          location: {
            page: img.pageNumber,
            element: img.id,
          },
          remediation: 'Remove redundant phrases like "image of", "picture of" from the beginning of alt text.',
        };
        issues.push(issue);
      }
    } else {
      missingAltText++;
      issue = {
        id: randomUUID(),
        wcagCriterion: '1.1.1',
        wcagLevel: 'A',
        severity: 'critical',
        title: 'Image missing alternative text',
        description: `Image "${img.id}" on page ${img.pageNumber} does not have alternative text. All non-decorative images must have alt text for screen reader users.`,
        location: {
          page: img.pageNumber,
          element: img.id,
        },
        remediation: 'Add descriptive alt text that conveys the purpose or content of the image, or mark the image as decorative if it is purely presentational.',
      };
      issues.push(issue);
    }

    imageStatuses.push({
      imageId: img.id,
      page: img.pageNumber,
      position: img.position,
      hasAltText,
      altText: img.altText || null,
      isDecorative,
      wcagCompliant,
      issue,
      qualityFlags,
    });
  }

  const totalImages = images.length;
  const compliancePercentage = totalImages > 0
    ? Math.round((compliantCount / totalImages) * 1000) / 10
    : 100;

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const seriousCount = issues.filter(i => i.severity === 'serious').length;
  const moderateCount = issues.filter(i => i.severity === 'moderate').length;
  const minorCount = issues.filter(i => i.severity === 'minor').length;

  const failed = criticalCount + seriousCount;
  const warnings = moderateCount + minorCount;

  return {
    totalImages,
    withAltText,
    missingAltText,
    decorativeImages,
    compliancePercentage,
    images: imageStatuses,
    issues: issues.sort((a, b) => {
      const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    summary: {
      totalChecks: totalImages,
      passed: compliantCount,
      failed,
      warnings,
    },
  };
}
