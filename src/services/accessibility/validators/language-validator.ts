import { randomUUID } from 'crypto';
import {
  AccessibilityIssue,
  LanguageValidationResult,
  ValidatorContext,
} from '../types';
import { isValidISO639Code } from './heading-validator';

export function validateLanguageDeclaration(
  documentLanguage: string | null | undefined,
  _context: ValidatorContext
): LanguageValidationResult {
  const issues: AccessibilityIssue[] = [];

  const hasLanguageDeclaration = !!documentLanguage && documentLanguage.trim().length > 0;
  const normalizedLanguage = documentLanguage?.trim() || null;
  const isValidLanguageCode = normalizedLanguage ? isValidISO639Code(normalizedLanguage) : false;

  if (!hasLanguageDeclaration) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '3.1.1',
      wcagLevel: 'A',
      severity: 'serious',
      title: 'Missing document language',
      description: 'The document does not declare a language. Screen readers need this information to use the correct pronunciation rules.',
      location: { page: 1 },
      remediation: 'Set the document language in PDF properties. In Adobe Acrobat: File > Properties > Advanced > Language.',
    });
  } else if (!isValidLanguageCode) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '3.1.1',
      wcagLevel: 'A',
      severity: 'moderate',
      title: 'Invalid language code',
      description: `The document language "${normalizedLanguage}" is not a valid ISO 639-1 language code.`,
      location: { page: 1 },
      remediation: `Use a valid ISO 639-1 language code (e.g., "en" for English, "es" for Spanish, "fr" for French, "de" for German).`,
    });
  }

  return {
    issues,
    documentLanguage: normalizedLanguage,
    isValidLanguageCode,
    hasLanguageDeclaration,
  };
}
