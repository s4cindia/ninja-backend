import {
  mapFixTypeToChangeType,
  extractWcagCriteria,
  extractWcagLevel,
  extractSeverity,
} from '../../src/services/comparison/change-logging.helpers';

describe('change-logging.helpers', () => {
  describe('mapFixTypeToChangeType', () => {
    describe('PDF codes', () => {
      it('should map PDF auto-fixable codes correctly', () => {
        expect(mapFixTypeToChangeType('MATTERHORN-01-001')).toBe('set-marked-flag');
        expect(mapFixTypeToChangeType('MATTERHORN-01-002')).toBe('set-display-doc-title');
        expect(mapFixTypeToChangeType('MATTERHORN-01-005')).toBe('set-suspects-flag');
      });

      it('should map PDF quick-fix codes correctly', () => {
        expect(mapFixTypeToChangeType('PDF-NO-LANGUAGE')).toBe('add-language');
        expect(mapFixTypeToChangeType('PDF-NO-TITLE')).toBe('add-title');
        expect(mapFixTypeToChangeType('PDF-NO-CREATOR')).toBe('add-creator');
        expect(mapFixTypeToChangeType('PDF-NO-METADATA')).toBe('add-metadata');
      });

      it('should map Matterhorn codes correctly', () => {
        expect(mapFixTypeToChangeType('MATTERHORN-11-001')).toBe('add-language');
        expect(mapFixTypeToChangeType('MATTERHORN-01-003')).toBe('add-title');
      });

      it('should map WCAG codes correctly', () => {
        expect(mapFixTypeToChangeType('WCAG-2.4.2')).toBe('add-title');
      });
    });

    describe('EPUB codes', () => {
      it('should map EPUB codes correctly', () => {
        expect(mapFixTypeToChangeType('EPUB-META-001')).toBe('add-language');
        expect(mapFixTypeToChangeType('EPUB-IMG-001')).toBe('add-alt-text');
        expect(mapFixTypeToChangeType('EPUB-STRUCT-002')).toBe('add-table-headers');
      });
    });

    describe('unknown codes', () => {
      it('should convert unknown codes to kebab-case', () => {
        expect(mapFixTypeToChangeType('UNKNOWN_CODE')).toBe('unknown-code');
        expect(mapFixTypeToChangeType('TEST CODE')).toBe('test-code');
      });
    });
  });

  describe('extractWcagCriteria', () => {
    describe('PDF codes', () => {
      it('should extract WCAG criteria for PDF auto-fixable codes', () => {
        expect(extractWcagCriteria('MATTERHORN-01-001')).toBe('1.3.1');
        expect(extractWcagCriteria('MATTERHORN-01-002')).toBe('2.4.2');
        expect(extractWcagCriteria('MATTERHORN-01-005')).toBe('1.3.1');
      });

      it('should extract WCAG criteria for PDF quick-fix codes', () => {
        expect(extractWcagCriteria('PDF-NO-LANGUAGE')).toBe('3.1.1');
        expect(extractWcagCriteria('PDF-NO-TITLE')).toBe('2.4.2');
        expect(extractWcagCriteria('PDF-NO-CREATOR')).toBe('4.1.2');
        expect(extractWcagCriteria('PDF-NO-METADATA')).toBe('1.3.1');
      });

      it('should extract WCAG criteria from code pattern', () => {
        expect(extractWcagCriteria('WCAG-2.4.2')).toBe('2.4.2');
      });
    });

    describe('EPUB codes', () => {
      it('should extract WCAG criteria for EPUB codes', () => {
        expect(extractWcagCriteria('EPUB-META-001')).toBe('3.1.1');
        expect(extractWcagCriteria('EPUB-IMG-001')).toBe('1.1.1');
        expect(extractWcagCriteria('EPUB-CONTRAST-001')).toBe('1.4.3');
      });
    });

    describe('unknown codes', () => {
      it('should return undefined for unknown codes', () => {
        expect(extractWcagCriteria('UNKNOWN-CODE')).toBeUndefined();
      });

      it('should extract WCAG pattern if present in unknown code', () => {
        expect(extractWcagCriteria('CUSTOM-1.2.3-ERROR')).toBe('1.2.3');
      });
    });
  });

  describe('extractWcagLevel', () => {
    describe('PDF codes', () => {
      it('should return Level A for PDF auto-fixable codes', () => {
        expect(extractWcagLevel('MATTERHORN-01-001')).toBe('A');
        expect(extractWcagLevel('MATTERHORN-01-002')).toBe('A');
        expect(extractWcagLevel('MATTERHORN-01-005')).toBe('A');
      });

      it('should return Level A for PDF quick-fix codes', () => {
        expect(extractWcagLevel('PDF-NO-LANGUAGE')).toBe('A');
        expect(extractWcagLevel('PDF-NO-TITLE')).toBe('A');
        expect(extractWcagLevel('PDF-NO-METADATA')).toBe('A');
      });
    });

    describe('EPUB codes', () => {
      it('should return Level A for most EPUB codes', () => {
        expect(extractWcagLevel('EPUB-META-001')).toBe('A');
        expect(extractWcagLevel('EPUB-IMG-001')).toBe('A');
      });

      it('should return Level AA for contrast codes', () => {
        expect(extractWcagLevel('EPUB-CONTRAST-001')).toBe('AA');
        expect(extractWcagLevel('COLOR-CONTRAST')).toBe('AA');
      });
    });

    describe('unknown codes', () => {
      it('should default to Level A for unknown codes', () => {
        expect(extractWcagLevel('UNKNOWN-CODE')).toBe('A');
      });
    });
  });

  describe('extractSeverity', () => {
    describe('CRITICAL severity', () => {
      it('should return CRITICAL for PDF/UA breaking issues', () => {
        expect(extractSeverity('MATTERHORN-01-001')).toBe('CRITICAL'); // Marked flag
        expect(extractSeverity('MATTERHORN-01-005')).toBe('CRITICAL'); // Suspects flag
      });

      it('should return CRITICAL for missing alt text', () => {
        expect(extractSeverity('EPUB-IMG-001')).toBe('CRITICAL');
      });
    });

    describe('MAJOR severity', () => {
      it('should return MAJOR for language issues', () => {
        expect(extractSeverity('PDF-NO-LANGUAGE')).toBe('MAJOR');
        expect(extractSeverity('MATTERHORN-11-001')).toBe('MAJOR');
      });

      it('should return MAJOR for page title issues', () => {
        expect(extractSeverity('WCAG-2.4.2')).toBe('MAJOR');
      });

      it('should return MAJOR for most EPUB issues', () => {
        expect(extractSeverity('EPUB-META-001')).toBe('MAJOR');
        expect(extractSeverity('EPUB-STRUCT-002')).toBe('MAJOR');
        expect(extractSeverity('EPUB-CONTRAST-001')).toBe('MAJOR');
      });
    });

    describe('MINOR severity', () => {
      it('should return MINOR for DisplayDocTitle', () => {
        expect(extractSeverity('MATTERHORN-01-002')).toBe('MINOR');
      });

      it('should return MINOR for metadata issues', () => {
        expect(extractSeverity('PDF-NO-TITLE')).toBe('MINOR');
        expect(extractSeverity('PDF-NO-CREATOR')).toBe('MINOR');
        expect(extractSeverity('PDF-NO-METADATA')).toBe('MINOR');
        expect(extractSeverity('MATTERHORN-01-003')).toBe('MINOR');
      });
    });

    describe('unknown codes', () => {
      it('should default to MAJOR for unknown codes', () => {
        expect(extractSeverity('UNKNOWN-CODE')).toBe('MAJOR');
      });
    });

    describe('severity rationale', () => {
      it('should classify structure issues as CRITICAL', () => {
        // Rationale: These break PDF/UA completely - AT cannot navigate
        expect(extractSeverity('MATTERHORN-01-001')).toBe('CRITICAL');
        expect(extractSeverity('MATTERHORN-01-005')).toBe('CRITICAL');
      });

      it('should classify AT-impacting issues as MAJOR', () => {
        // Rationale: Significantly impacts users but doesn't prevent usage
        expect(extractSeverity('PDF-NO-LANGUAGE')).toBe('MAJOR');
      });

      it('should classify cosmetic/informational issues as MINOR', () => {
        // Rationale: Helpful improvements with workarounds available
        expect(extractSeverity('PDF-NO-TITLE')).toBe('MINOR');
        expect(extractSeverity('MATTERHORN-01-002')).toBe('MINOR');
      });
    });
  });

  describe('integration scenarios', () => {
    it('should handle PDF auto-fix workflow', () => {
      const code = 'MATTERHORN-01-001';
      expect(mapFixTypeToChangeType(code)).toBe('set-marked-flag');
      expect(extractWcagCriteria(code)).toBe('1.3.1');
      expect(extractWcagLevel(code)).toBe('A');
      expect(extractSeverity(code)).toBe('CRITICAL');
    });

    it('should handle PDF quick-fix workflow', () => {
      const code = 'PDF-NO-LANGUAGE';
      expect(mapFixTypeToChangeType(code)).toBe('add-language');
      expect(extractWcagCriteria(code)).toBe('3.1.1');
      expect(extractWcagLevel(code)).toBe('A');
      expect(extractSeverity(code)).toBe('MAJOR');
    });

    it('should handle EPUB workflow', () => {
      const code = 'EPUB-IMG-001';
      expect(mapFixTypeToChangeType(code)).toBe('add-alt-text');
      expect(extractWcagCriteria(code)).toBe('1.1.1');
      expect(extractWcagLevel(code)).toBe('A');
      expect(extractSeverity(code)).toBe('CRITICAL');
    });
  });
});
