export function mapFixTypeToChangeType(fixCode: string): string {
  const mappings: Record<string, string> = {
    'EPUB-META-001': 'add-language',
    'EPUB-META-002': 'add-accessibility-features',
    'EPUB-META-003': 'add-accessibility-summary',
    'EPUB-META-004': 'add-access-modes',
    'EPUB-SEM-001': 'add-html-lang',
    'EPUB-SEM-002': 'fix-empty-link',
    'EPUB-SEM-003': 'add-aria-role',
    'EPUB-IMG-001': 'add-alt-text',
    'EPUB-STRUCT-002': 'add-table-headers',
    'EPUB-STRUCT-003': 'fix-heading-hierarchy',
    'EPUB-STRUCT-004': 'add-aria-landmarks',
    'EPUB-NAV-001': 'add-skip-navigation',
    'EPUB-FIG-001': 'add-figure-structure',
    'EPUB-CONTRAST-001': 'fix-color-contrast',
    'EPUB-TYPE-HAS-MATCHING-ROLE': 'add-aria-role',
    'COLOR-CONTRAST': 'fix-color-contrast',
  };

  return mappings[fixCode] || fixCode.toLowerCase().replace(/[_\s]+/g, '-');
}

export function extractWcagCriteria(ruleId: string): string | undefined {
  const wcagMappings: Record<string, string> = {
    'EPUB-META-001': '3.1.1',
    'EPUB-META-002': '4.1.2',
    'EPUB-META-003': '4.1.2',
    'EPUB-META-004': '4.1.2',
    'EPUB-SEM-001': '3.1.1',
    'EPUB-SEM-002': '2.4.4',
    'EPUB-SEM-003': '4.1.2',
    'EPUB-IMG-001': '1.1.1',
    'EPUB-STRUCT-002': '1.3.1',
    'EPUB-STRUCT-003': '1.3.1',
    'EPUB-STRUCT-004': '1.3.1',
    'EPUB-NAV-001': '2.4.1',
    'EPUB-FIG-001': '1.1.1',
    'EPUB-CONTRAST-001': '1.4.3',
    'COLOR-CONTRAST': '1.4.3',
  };

  if (wcagMappings[ruleId]) {
    return wcagMappings[ruleId];
  }

  const wcagMatch = ruleId.match(/(\d+\.\d+\.\d+)/);
  if (wcagMatch) {
    return wcagMatch[1];
  }

  return undefined;
}

export function extractWcagLevel(ruleId: string): string {
  const levelMappings: Record<string, string> = {
    'EPUB-META-001': 'A',
    'EPUB-META-002': 'A',
    'EPUB-META-003': 'A',
    'EPUB-META-004': 'A',
    'EPUB-SEM-001': 'A',
    'EPUB-SEM-002': 'A',
    'EPUB-SEM-003': 'A',
    'EPUB-IMG-001': 'A',
    'EPUB-STRUCT-002': 'A',
    'EPUB-STRUCT-003': 'A',
    'EPUB-STRUCT-004': 'A',
    'EPUB-NAV-001': 'A',
    'EPUB-FIG-001': 'A',
    'EPUB-CONTRAST-001': 'AA',
    'COLOR-CONTRAST': 'AA',
  };

  return levelMappings[ruleId] || 'A';
}
