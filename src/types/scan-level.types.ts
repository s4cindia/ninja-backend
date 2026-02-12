/**
 * Scan Level Types
 *
 * Defines different levels of PDF accessibility scanning:
 * - Basic: Fast scan covering essential checks (~10s)
 * - Comprehensive: Full Matterhorn Protocol compliance (~30-60s)
 * - Custom: User-selected validators
 */

export type ScanLevel = 'basic' | 'comprehensive' | 'custom';

export interface ScanLevelConfig {
  level: ScanLevel;
  name: string;
  description: string;
  estimatedTime: string;
  validators: ValidatorType[];
  checksIncluded: string[];
}

export type ValidatorType =
  | 'structure'
  | 'alt-text'
  | 'contrast'
  | 'tables'
  | 'headings'
  | 'reading-order'
  | 'lists'
  | 'language'
  | 'metadata';

/**
 * Scan level configurations
 */
export const SCAN_LEVEL_CONFIGS: Record<ScanLevel, ScanLevelConfig> = {
  basic: {
    level: 'basic',
    name: 'Basic Scan',
    description: 'Quick scan covering essential accessibility checks',
    estimatedTime: '~10 seconds',
    validators: ['structure', 'alt-text', 'tables'],
    checksIncluded: [
      'Tagged PDF structure',
      'Document language & title',
      'Image alternative text',
      'Basic table structure',
      'Critical Matterhorn Protocol checks',
    ],
  },
  comprehensive: {
    level: 'comprehensive',
    name: 'Comprehensive Scan',
    description: 'Complete Matterhorn Protocol compliance audit',
    estimatedTime: '~30-60 seconds',
    validators: [
      'structure',
      'alt-text',
      'contrast',
      'tables',
      'headings',
      'reading-order',
      'lists',
      'language',
      'metadata',
    ],
    checksIncluded: [
      'All Basic checks',
      'Heading hierarchy analysis',
      'Reading order validation',
      'List structure verification',
      'Color contrast analysis',
      'Complete Matterhorn Protocol',
      'WCAG 2.1 Level AA compliance',
    ],
  },
  custom: {
    level: 'custom',
    name: 'Custom Scan',
    description: 'Select specific validators to run',
    estimatedTime: 'Varies',
    validators: [], // User-defined
    checksIncluded: ['User-selected validators only'],
  },
};

/**
 * Custom scan configuration
 */
export interface CustomScanConfig {
  selectedValidators: ValidatorType[];
}
