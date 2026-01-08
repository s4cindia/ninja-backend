export interface ComparisonSummary {
  totalChanges: number;
  applied: number;
  rejected: number;
  skipped: number;
  failed: number;
  issuesBefore?: number;
  issuesAfter?: number;
  resolutionRate?: number;
}

export interface ChangeSummaryByCategory {
  count: number;
  applied: number;
  rejected: number;
  skipped?: number;
  failed?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ComparisonData {
  jobId: string;
  fileName: string;
  originalFileId?: string;
  remediatedFileId?: string;
  auditedAt?: Date;
  remediatedAt?: Date;
  summary: ComparisonSummary;
  byType: Record<string, ChangeSummaryByCategory>;
  bySeverity: Record<string, ChangeSummaryByCategory>;
  byWcag: Record<string, ChangeSummaryByCategory>;
  pagination?: PaginationInfo;
  changes: any[];
}

export interface ComparisonFilters {
  changeType?: string;
  severity?: string;
  status?: string;
  wcagCriteria?: string;
  filePath?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateChangeData {
  jobId: string;
  taskId?: string;
  issueId?: string;
  ruleId?: string;
  filePath: string;
  elementXPath?: string;
  lineNumber?: number;
  changeType: string;
  description: string;
  beforeContent?: string;
  afterContent?: string;
  contextBefore?: string;
  contextAfter?: string;
  severity?: string;
  wcagCriteria?: string;
  wcagLevel?: string;
  appliedBy?: string;
}
