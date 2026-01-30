import { describe, it, expect, beforeEach } from 'vitest';
import { pdfAcrGeneratorService, ProductInfo, ACRReport } from './acr-generator.service';
import { AuditReport } from '../audit/base-audit.service';

describe('PdfAcrGeneratorService', () => {
  let mockAuditReport: AuditReport;
  let mockProductInfo: ProductInfo;

  beforeEach(() => {
    mockProductInfo = {
      name: 'Test PDF Document',
      version: '1.0',
      vendor: 'Test Vendor',
      evaluationDate: '2024-01-30',
      evaluator: 'Automated Audit System',
    };

    mockAuditReport = {
      jobId: 'job-123',
      fileName: 'test-document.pdf',
      score: 85,
      scoreBreakdown: {
        score: 85,
        formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
        weights: { critical: 15, serious: 8, moderate: 4, minor: 1 },
        deductions: {
          critical: { count: 0, points: 0 },
          serious: { count: 1, points: 8 },
          moderate: { count: 1, points: 4 },
          minor: { count: 3, points: 3 },
        },
        totalDeduction: 15,
        maxScore: 100,
      },
      issues: [
        {
          id: 'issue-1',
          source: 'structure-validator',
          severity: 'serious',
          code: 'PDF-NO-LANGUAGE',
          message: 'PDF document does not specify a language',
          wcagCriteria: ['3.1.1'],
          category: 'structure',
        },
        {
          id: 'issue-2',
          source: 'alt-text-validator',
          severity: 'critical',
          code: 'PDF-IMAGE-NO-ALT',
          message: 'Image missing alternative text',
          wcagCriteria: ['1.1.1'],
          location: 'Page 1',
          category: 'alt-text',
        },
        {
          id: 'issue-3',
          source: 'contrast-validator',
          severity: 'moderate',
          code: 'PDF-LOW-CONTRAST',
          message: 'Text has insufficient contrast ratio',
          wcagCriteria: ['1.4.3'],
          location: 'Page 2',
          category: 'contrast',
        },
      ],
      summary: {
        critical: 1,
        serious: 1,
        moderate: 1,
        minor: 0,
        total: 3,
      },
      wcagMappings: [
        {
          issueId: 'issue-1',
          criteria: ['3.1.1'],
          level: 'A',
          principle: 'Understandable',
        },
        {
          issueId: 'issue-2',
          criteria: ['1.1.1'],
          level: 'A',
          principle: 'Perceivable',
        },
        {
          issueId: 'issue-3',
          criteria: ['1.4.3'],
          level: 'AA',
          principle: 'Perceivable',
        },
      ],
      metadata: {
        validator: 'PDF Accessibility Audit',
      },
      auditedAt: new Date('2024-01-30T10:00:00Z'),
    };
  });

  describe('generateAcr', () => {
    it('should generate ACR report from audit results', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      expect(acr).toBeDefined();
      expect(acr.id).toMatch(/^acr-/);
      expect(acr.productInfo).toEqual(mockProductInfo);
      expect(acr.wcagResults).toBeDefined();
      expect(Array.isArray(acr.wcagResults)).toBe(true);
      expect(acr.summary).toBeDefined();
      expect(acr.notes).toBeDefined();
      expect(Array.isArray(acr.notes)).toBe(true);
      expect(acr.generatedAt).toBeInstanceOf(Date);
    });

    it('should include product information', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      expect(acr.productInfo.name).toBe('Test PDF Document');
      expect(acr.productInfo.version).toBe('1.0');
      expect(acr.productInfo.vendor).toBe('Test Vendor');
      expect(acr.productInfo.evaluationDate).toBe('2024-01-30');
      expect(acr.productInfo.evaluator).toBe('Automated Audit System');
    });

    it('should evaluate all Level A and AA WCAG criteria', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      // Should have all Level A and AA criteria (not AAA)
      expect(acr.wcagResults.length).toBeGreaterThan(0);

      // Should not include Level AAA criteria
      const hasAAA = acr.wcagResults.some(r => r.level === 'AAA');
      expect(hasAAA).toBe(false);

      // Should include both Level A and AA
      const hasA = acr.wcagResults.some(r => r.level === 'A');
      const hasAA = acr.wcagResults.some(r => r.level === 'AA');
      expect(hasA).toBe(true);
      expect(hasAA).toBe(true);
    });

    it('should map issues to WCAG criteria correctly', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      // Find criterion 1.1.1 (Non-text Content)
      const criterion111 = acr.wcagResults.find(r => r.criterion === '1.1.1');
      expect(criterion111).toBeDefined();
      expect(criterion111?.name).toBe('Non-text Content');
      expect(criterion111?.level).toBe('A');
      expect(criterion111?.issueCount).toBe(1);
      expect(criterion111?.conformance).toBe('Does Not Support'); // Has critical issue

      // Find criterion 3.1.1 (Language of Page)
      const criterion311 = acr.wcagResults.find(r => r.criterion === '3.1.1');
      expect(criterion311).toBeDefined();
      expect(criterion311?.name).toBe('Language of Page');
      expect(criterion311?.level).toBe('A');
      expect(criterion311?.issueCount).toBe(1);
      expect(criterion311?.conformance).toBe('Does Not Support'); // Has serious issue

      // Find criterion 1.4.3 (Contrast Minimum)
      const criterion143 = acr.wcagResults.find(r => r.criterion === '1.4.3');
      expect(criterion143).toBeDefined();
      expect(criterion143?.name).toBe('Contrast (Minimum)');
      expect(criterion143?.level).toBe('AA');
      expect(criterion143?.issueCount).toBe(1);
      expect(criterion143?.conformance).toBe('Partially Supports'); // Has moderate issue
    });

    it('should calculate overall conformance levels', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      expect(acr.overallConformance).toBeDefined();
      expect(acr.overallConformance.levelA).toBe('Does Not Support'); // Has critical/serious A issues
      expect(acr.overallConformance.levelAA).toBe('Does Not Support'); // Includes A + AA issues
      expect(acr.overallConformance.levelAAA).toBe('Not Applicable'); // Not evaluated
    });

    it('should generate summary text', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      expect(acr.summary).toContain('test-document.pdf');
      expect(acr.summary).toContain('85/100');
      expect(acr.summary).toContain('Total issues found: 3');
      expect(acr.summary).toContain('Critical: 1');
      expect(acr.summary).toContain('Serious: 1');
      expect(acr.summary).toContain('Moderate: 1');
      expect(acr.summary).toContain('Level A:');
      expect(acr.summary).toContain('Level AA:');
    });

    it('should generate notes', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      expect(acr.notes.length).toBeGreaterThan(0);
      expect(acr.notes.some(n => n.includes('automatically generated'))).toBe(true);
      expect(acr.notes.some(n => n.includes('manual verification'))).toBe(true);
    });
  });

  describe('conformance determination', () => {
    it('should mark as "Supports" when no issues', async () => {
      const cleanAudit: AuditReport = {
        ...mockAuditReport,
        issues: [],
        summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
      };

      const acr = await pdfAcrGeneratorService.generateAcr(cleanAudit, mockProductInfo);

      // All criteria without issues should be "Supports"
      const allSupports = acr.wcagResults.every(r => r.conformance === 'Supports');
      expect(allSupports).toBe(true);
    });

    it('should mark as "Does Not Support" for critical issues', async () => {
      const criticalIssueAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'critical',
            code: 'TEST-001',
            message: 'Critical issue',
            wcagCriteria: ['2.4.2'],
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(criticalIssueAudit, mockProductInfo);

      const criterion242 = acr.wcagResults.find(r => r.criterion === '2.4.2');
      expect(criterion242?.conformance).toBe('Does Not Support');
    });

    it('should mark as "Does Not Support" for serious issues', async () => {
      const seriousIssueAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'serious',
            code: 'TEST-001',
            message: 'Serious issue',
            wcagCriteria: ['2.4.2'],
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(seriousIssueAudit, mockProductInfo);

      const criterion242 = acr.wcagResults.find(r => r.criterion === '2.4.2');
      expect(criterion242?.conformance).toBe('Does Not Support');
    });

    it('should mark as "Partially Supports" for 1-3 minor/moderate issues', async () => {
      const minorIssueAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'moderate',
            code: 'TEST-001',
            message: 'Moderate issue',
            wcagCriteria: ['2.4.2'],
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(minorIssueAudit, mockProductInfo);

      const criterion242 = acr.wcagResults.find(r => r.criterion === '2.4.2');
      expect(criterion242?.conformance).toBe('Partially Supports');
    });

    it('should mark as "Does Not Support" for 4+ issues', async () => {
      const manyIssuesAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'minor',
            code: 'TEST-001',
            message: 'Issue 1',
            wcagCriteria: ['2.4.2'],
          },
          {
            id: 'issue-2',
            source: 'test',
            severity: 'minor',
            code: 'TEST-002',
            message: 'Issue 2',
            wcagCriteria: ['2.4.2'],
          },
          {
            id: 'issue-3',
            source: 'test',
            severity: 'minor',
            code: 'TEST-003',
            message: 'Issue 3',
            wcagCriteria: ['2.4.2'],
          },
          {
            id: 'issue-4',
            source: 'test',
            severity: 'minor',
            code: 'TEST-004',
            message: 'Issue 4',
            wcagCriteria: ['2.4.2'],
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(manyIssuesAudit, mockProductInfo);

      const criterion242 = acr.wcagResults.find(r => r.criterion === '2.4.2');
      expect(criterion242?.conformance).toBe('Does Not Support');
    });
  });

  describe('remarks generation', () => {
    it('should generate positive remarks for supported criteria', async () => {
      const cleanAudit: AuditReport = {
        ...mockAuditReport,
        issues: [],
        summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
      };

      const acr = await pdfAcrGeneratorService.generateAcr(cleanAudit, mockProductInfo);

      const supportedCriterion = acr.wcagResults.find(r => r.conformance === 'Supports');
      expect(supportedCriterion?.remarks).toContain('meets all requirements');
      expect(supportedCriterion?.remarks).toContain('No issues detected');
    });

    it('should include issue count and severity in remarks', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const criterion111 = acr.wcagResults.find(r => r.criterion === '1.1.1');
      expect(criterion111?.remarks).toContain('1 issue');
      expect(criterion111?.remarks).toContain('critical');
    });

    it('should include examples of issues in remarks', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const criterion111 = acr.wcagResults.find(r => r.criterion === '1.1.1');
      expect(criterion111?.remarks).toContain('Examples:');
      expect(criterion111?.remarks).toContain('Image missing alternative text');
    });

    it('should include remediation suggestions', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const doesNotSupportCriterion = acr.wcagResults.find(r => r.conformance === 'Does Not Support');
      expect(doesNotSupportCriterion?.remarks).toContain('remediation required');

      const partiallySupportsCriterion = acr.wcagResults.find(r => r.conformance === 'Partially Supports');
      expect(partiallySupportsCriterion?.remarks).toContain('improvements recommended');
    });
  });

  describe('overall conformance calculation', () => {
    it('should calculate Level A conformance correctly', async () => {
      const levelAIssueAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'critical',
            code: 'TEST-001',
            message: 'Level A issue',
            wcagCriteria: ['1.1.1'], // Level A
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(levelAIssueAudit, mockProductInfo);

      expect(acr.overallConformance.levelA).toBe('Does Not Support');
    });

    it('should calculate Level AA conformance correctly', async () => {
      const levelAAIssueAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'serious',
            code: 'TEST-001',
            message: 'Level AA issue',
            wcagCriteria: ['1.4.3'], // Level AA
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(levelAAIssueAudit, mockProductInfo);

      // Level AA conformance includes Level A criteria, so if Level A passes but AA fails
      expect(acr.overallConformance.levelAA).toBe('Does Not Support');
    });

    it('should mark as "Supports" when all criteria pass', async () => {
      const cleanAudit: AuditReport = {
        ...mockAuditReport,
        issues: [],
        summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
      };

      const acr = await pdfAcrGeneratorService.generateAcr(cleanAudit, mockProductInfo);

      expect(acr.overallConformance.levelA).toBe('Supports');
      expect(acr.overallConformance.levelAA).toBe('Supports');
    });

    it('should mark as "Partially Supports" when some criteria partially support', async () => {
      const partialAudit: AuditReport = {
        ...mockAuditReport,
        issues: [
          {
            id: 'issue-1',
            source: 'test',
            severity: 'moderate',
            code: 'TEST-001',
            message: 'Moderate issue',
            wcagCriteria: ['1.4.3'],
          },
        ],
      };

      const acr = await pdfAcrGeneratorService.generateAcr(partialAudit, mockProductInfo);

      expect(acr.overallConformance.levelAA).toBe('Partially Supports');
    });
  });

  describe('WCAG criteria coverage', () => {
    it('should include all Perceivable criteria', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const perceivableCriteria = acr.wcagResults.filter(r => r.criterion.startsWith('1.'));
      expect(perceivableCriteria.length).toBeGreaterThan(0);
      expect(perceivableCriteria.some(r => r.criterion === '1.1.1')).toBe(true);
      expect(perceivableCriteria.some(r => r.criterion === '1.4.3')).toBe(true);
    });

    it('should include all Operable criteria', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const operableCriteria = acr.wcagResults.filter(r => r.criterion.startsWith('2.'));
      expect(operableCriteria.length).toBeGreaterThan(0);
      expect(operableCriteria.some(r => r.criterion === '2.4.2')).toBe(true);
    });

    it('should include all Understandable criteria', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const understandableCriteria = acr.wcagResults.filter(r => r.criterion.startsWith('3.'));
      expect(understandableCriteria.length).toBeGreaterThan(0);
      expect(understandableCriteria.some(r => r.criterion === '3.1.1')).toBe(true);
    });

    it('should include all Robust criteria', async () => {
      const acr = await pdfAcrGeneratorService.generateAcr(mockAuditReport, mockProductInfo);

      const robustCriteria = acr.wcagResults.filter(r => r.criterion.startsWith('4.'));
      expect(robustCriteria.length).toBeGreaterThan(0);
      expect(robustCriteria.some(r => r.criterion === '4.1.2')).toBe(true);
    });
  });
});
