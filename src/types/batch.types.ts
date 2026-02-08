export interface BatchCreateRequest {
  name?: string;
}

export interface BatchFileUploadRequest {
  files: File[];
}

export interface BatchStartRequest {
  options?: {
    skipAudit?: boolean;
    autoRemediateOnly?: boolean;
  };
}

export interface BatchSummary {
  batchId: string;
  name: string;
  status: BatchStatus;

  totalFiles: number;
  filesUploaded: number;
  filesAudited: number;
  filesPlanned: number;
  filesRemediated: number;
  filesFailed: number;

  totalIssuesFound: number;
  autoFixedIssues: number;
  quickFixIssues: number;
  manualIssues: number;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BatchFileDetails {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  status: BatchFileStatus;

  auditScore?: number;
  issuesFound?: number;
  issuesAutoFixed?: number;
  remainingQuickFix?: number;
  remainingManual?: number;

  error?: string;

  uploadedAt: string;
  remediationCompletedAt?: string;
}

export interface BatchWithFiles extends BatchSummary {
  files: BatchFileDetails[];
}

export type BatchStatus =
  | 'DRAFT'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type BatchFileStatus =
  | 'UPLOADED'
  | 'AUDITING'
  | 'AUDITED'
  | 'PLANNING'
  | 'PLANNED'
  | 'REMEDIATING'
  | 'REMEDIATED'
  | 'FAILED'
  | 'SKIPPED';
