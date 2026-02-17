/**
 * PDF Classification-Handler Sync Tests
 *
 * Ensures that AUTO_FIXABLE codes have registered handlers and vice versa
 */
/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { describe, it, expect } from 'vitest';
import { AUTO_FIXABLE_CODES, QUICK_FIXABLE_CODES, MANUAL_CODES } from '../../src/constants/pdf-fix-classification';
import { pdfAutoRemediationService } from '../../src/services/pdf/pdf-auto-remediation.service';

describe('PDF Classification-Handler Synchronization', () => {
  describe('AUTO_FIXABLE codes', () => {
    it('should have handlers registered for all AUTO_FIXABLE codes', () => {
      const missingHandlers: string[] = [];

      // Access private handlers via a type assertion for testing
      const service = pdfAutoRemediationService as any;
      const handlers: Map<string, unknown> = service.handlers;

      for (const code of AUTO_FIXABLE_CODES) {
        if (!handlers.has(code)) {
          missingHandlers.push(code);
        }
      }

      expect(missingHandlers).toEqual([]);

      if (missingHandlers.length > 0) {
        console.error('[TEST FAILURE] AUTO_FIXABLE codes missing handlers:', missingHandlers);
        console.error('Registered handlers:', Array.from(handlers.keys()));
      }
    });

    it('should not have overlapping codes between AUTO_FIXABLE and MANUAL', () => {
      const overlapping: string[] = [];

      for (const code of AUTO_FIXABLE_CODES) {
        if (MANUAL_CODES.has(code)) {
          overlapping.push(code);
        }
      }

      expect(overlapping).toEqual([]);

      if (overlapping.length > 0) {
        console.error('[TEST FAILURE] Codes in both AUTO_FIXABLE and MANUAL:', overlapping);
      }
    });

    it('should not have overlapping codes between AUTO_FIXABLE and QUICK_FIXABLE', () => {
      const overlapping: string[] = [];

      for (const code of AUTO_FIXABLE_CODES) {
        if (QUICK_FIXABLE_CODES.has(code)) {
          overlapping.push(code);
        }
      }

      expect(overlapping).toEqual([]);

      if (overlapping.length > 0) {
        console.error('[TEST FAILURE] Codes in both AUTO_FIXABLE and QUICK_FIXABLE:', overlapping);
      }
    });
  });

  describe('Registered handlers', () => {
    it('should have all registered handlers classified as either AUTO_FIXABLE or QUICK_FIXABLE', () => {
      const service = pdfAutoRemediationService as any;
      const handlers: Map<string, unknown> = service.handlers;
      const unclassifiedHandlers: string[] = [];

      for (const code of handlers.keys()) {
        const isClassified =
          AUTO_FIXABLE_CODES.has(code) ||
          QUICK_FIXABLE_CODES.has(code);

        if (!isClassified) {
          unclassifiedHandlers.push(code);
        }
      }

      expect(unclassifiedHandlers).toEqual([]);

      if (unclassifiedHandlers.length > 0) {
        console.error('[TEST FAILURE] Handlers without classification:', unclassifiedHandlers);
        console.error('These handlers are registered but not in AUTO_FIXABLE or QUICK_FIXABLE sets');
      }
    });

    it('should not have handlers for MANUAL codes', () => {
      const service = pdfAutoRemediationService as any;
      const handlers: Map<string, unknown> = service.handlers;
      const incorrectHandlers: string[] = [];

      for (const code of MANUAL_CODES) {
        if (handlers.has(code)) {
          incorrectHandlers.push(code);
        }
      }

      expect(incorrectHandlers).toEqual([]);

      if (incorrectHandlers.length > 0) {
        console.error('[TEST FAILURE] Handlers registered for MANUAL codes:', incorrectHandlers);
        console.error('These codes are classified as MANUAL but have handlers registered');
      }
    });
  });

  describe('Classification integrity', () => {
    it('should have no duplicate codes across all classification sets', () => {
      const allCodes = new Set<string>();
      const duplicates: string[] = [];

      for (const code of AUTO_FIXABLE_CODES) {
        if (allCodes.has(code)) {
          duplicates.push(code);
        }
        allCodes.add(code);
      }

      for (const code of QUICK_FIXABLE_CODES) {
        if (allCodes.has(code)) {
          duplicates.push(code);
        }
        allCodes.add(code);
      }

      for (const code of MANUAL_CODES) {
        if (allCodes.has(code)) {
          duplicates.push(code);
        }
        allCodes.add(code);
      }

      expect(duplicates).toEqual([]);

      if (duplicates.length > 0) {
        console.error('[TEST FAILURE] Duplicate codes across classification sets:', duplicates);
      }
    });
  });

  describe('Coverage metrics', () => {
    it('should report classification and handler statistics', () => {
      const service = pdfAutoRemediationService as any;
      const handlers: Map<string, unknown> = service.handlers;

      const stats = {
        autoFixableCodes: AUTO_FIXABLE_CODES.size,
        quickFixableCodes: QUICK_FIXABLE_CODES.size,
        manualCodes: MANUAL_CODES.size,
        totalClassified: AUTO_FIXABLE_CODES.size + QUICK_FIXABLE_CODES.size + MANUAL_CODES.size,
        registeredHandlers: handlers.size,
        handlerCoverage: (handlers.size / AUTO_FIXABLE_CODES.size) * 100,
      };

      console.log('\n📊 PDF Auto-Fix Coverage Statistics:');
      console.log(`  AUTO_FIXABLE codes: ${stats.autoFixableCodes}`);
      console.log(`  QUICK_FIXABLE codes: ${stats.quickFixableCodes}`);
      console.log(`  MANUAL codes: ${stats.manualCodes}`);
      console.log(`  Total classified: ${stats.totalClassified}`);
      console.log(`  Registered handlers: ${stats.registeredHandlers}`);
      console.log(`  Handler coverage: ${stats.handlerCoverage.toFixed(1)}%\n`);

      // Pass test - just reporting stats
      expect(stats.autoFixableCodes).toBeGreaterThan(0);
      expect(stats.registeredHandlers).toBeGreaterThan(0);
    });
  });
});
