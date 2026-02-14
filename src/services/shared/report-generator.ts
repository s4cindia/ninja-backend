/**
 * Report Generator Service
 * Generates validation reports in JSON, PDF, and DOCX formats
 * Used by Plagiarism, Citation, and Style validation services
 */

export interface ValidationIssue {
  id: string;
  type: 'plagiarism' | 'citation' | 'style' | 'content';
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  title: string;
  description: string;
  location: {
    pageNumber?: number;
    paragraphIndex?: number;
    startOffset: number;
    endOffset: number;
  };
  originalText?: string;
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

export interface ReportConfig {
  title: string;
  documentName: string;
  generatedAt: Date;
  analyzedBy: string;
  includeOriginalText: boolean;
  includeSuggestions: boolean;
  groupByType: boolean;
}

export interface GeneratedReport {
  format: 'json' | 'pdf' | 'docx';
  content: Buffer | object;
  filename: string;
}

export interface ReportSummary {
  total: number;
  bySeverity: Record<string, number>;
  byType: Record<string, number>;
}

export class ReportGenerator {
  /**
   * Generate report in specified format
   * @param issues - Array of validation issues to include
   * @param config - Report configuration options
   * @param format - Output format (json, pdf, docx)
   */
  async generate(
    issues: ValidationIssue[],
    config: ReportConfig,
    format: 'json' | 'pdf' | 'docx' = 'json'
  ): Promise<GeneratedReport> {
    switch (format) {
      case 'json':
        return this.generateJSON(issues, config);
      case 'pdf':
        return this.generatePDF(issues, config);
      case 'docx':
        return this.generateDOCX(issues, config);
    }
  }

  /**
   * Generate JSON format report (fully implemented)
   */
  private async generateJSON(
    issues: ValidationIssue[],
    config: ReportConfig
  ): Promise<GeneratedReport> {
    const filteredIssues = issues.map(issue => {
      const filtered: ValidationIssue = { ...issue };
      if (!config.includeOriginalText) {
        delete filtered.originalText;
      }
      if (!config.includeSuggestions) {
        delete filtered.suggestedFix;
      }
      return filtered;
    });

    const report = {
      title: config.title,
      document: config.documentName,
      generatedAt: config.generatedAt.toISOString(),
      analyzedBy: config.analyzedBy,
      summary: {
        total: issues.length,
        bySeverity: this.countBySeverity(issues),
        byType: this.countByType(issues),
      },
      issues: config.groupByType 
        ? this.groupByType(filteredIssues)
        : filteredIssues,
    };

    const sanitizedName = config.documentName
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase();

    return {
      format: 'json',
      content: report,
      filename: `${sanitizedName}-report.json`,
    };
  }

  /**
   * Generate PDF format report
   * TODO: Implement using pdf-lib (Week 6 - US-3.4)
   */
  private async generatePDF(
    _issues: ValidationIssue[],
    _config: ReportConfig
  ): Promise<GeneratedReport> {
    throw new Error('PDF report generation not yet implemented. Coming in Week 6.');
  }

  /**
   * Generate DOCX format report
   * TODO: Implement using docx library (Week 6 - US-3.4)
   */
  private async generateDOCX(
    _issues: ValidationIssue[],
    _config: ReportConfig
  ): Promise<GeneratedReport> {
    throw new Error('DOCX report generation not yet implemented. Coming in Week 6.');
  }

  /**
   * Count issues by severity level
   */
  private countBySeverity(issues: ValidationIssue[]): Record<string, number> {
    const counts: Record<string, number> = {
      critical: 0,
      major: 0,
      minor: 0,
      suggestion: 0,
    };

    for (const issue of issues) {
      counts[issue.severity] = (counts[issue.severity] || 0) + 1;
    }

    return counts;
  }

  /**
   * Count issues by type
   */
  private countByType(issues: ValidationIssue[]): Record<string, number> {
    const counts: Record<string, number> = {
      plagiarism: 0,
      citation: 0,
      style: 0,
      content: 0,
    };

    for (const issue of issues) {
      counts[issue.type] = (counts[issue.type] || 0) + 1;
    }

    return counts;
  }

  /**
   * Group issues by type for organized display
   */
  private groupByType(issues: ValidationIssue[]): Record<string, ValidationIssue[]> {
    return issues.reduce((acc, issue) => {
      if (!acc[issue.type]) {
        acc[issue.type] = [];
      }
      acc[issue.type].push(issue);
      return acc;
    }, {} as Record<string, ValidationIssue[]>);
  }

  /**
   * Get summary statistics without generating full report
   */
  getSummary(issues: ValidationIssue[]): ReportSummary {
    return {
      total: issues.length,
      bySeverity: this.countBySeverity(issues),
      byType: this.countByType(issues),
    };
  }

  /**
   * Filter issues by severity threshold
   */
  filterBySeverity(
    issues: ValidationIssue[],
    minSeverity: 'critical' | 'major' | 'minor' | 'suggestion'
  ): ValidationIssue[] {
    const severityOrder = ['critical', 'major', 'minor', 'suggestion'];
    const threshold = severityOrder.indexOf(minSeverity);
    
    return issues.filter(issue => 
      severityOrder.indexOf(issue.severity) <= threshold
    );
  }

  /**
   * Filter issues by type
   */
  filterByType(
    issues: ValidationIssue[],
    types: ValidationIssue['type'][]
  ): ValidationIssue[] {
    return issues.filter(issue => types.includes(issue.type));
  }
}

export const reportGenerator = new ReportGenerator();
