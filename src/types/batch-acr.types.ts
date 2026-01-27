import { AcrDocument } from '../services/acr/acr-generator.service';

export type ConformanceLevel = 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';

export interface BatchAcrOptions {
  edition: 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';
  batchName: string;
  vendor: string;
  contactEmail: string;
  aggregationStrategy: 'conservative' | 'optimistic';
}

export interface BatchAcrGenerationRequest {
  batchId: string;
  mode: 'individual' | 'aggregate';
  options?: BatchAcrOptions;
}

export interface IndividualAcrGenerationResult {
  mode: 'individual';
  acrWorkflowIds: string[];
  totalAcrs: number;
  message: string;
}

export interface AggregateAcrGenerationResult {
  mode: 'aggregate';
  acrWorkflowId: string;
  totalDocuments: number;
  totalCriteria: number;
  message: string;
}

export type BatchAcrGenerationResult = IndividualAcrGenerationResult | AggregateAcrGenerationResult;

export interface AggregateAcrDocument extends AcrDocument {
  batchInfo: {
    isBatch: true;
    totalDocuments: number;
    documentList: Array<{
      fileName: string;
      jobId: string;
    }>;
    aggregationStrategy: 'conservative' | 'optimistic';
    sourceJobIds: string[];
  };
}

export interface AggregateAcrCriterion {
  criterionId: string;
  criterionName: string;
  level: 'A' | 'AA' | 'AAA';
  conformanceLevel: ConformanceLevel;
  remarks: string;
  perEpubDetails: Array<{
    fileName: string;
    jobId: string;
    status: ConformanceLevel;
    issueCount: number;
    issues?: Array<{
      code: string;
      message: string;
      location?: string;
    }>;
  }>;
}

export interface AcrGenerationHistoryEntry {
  mode: 'individual' | 'aggregate';
  acrWorkflowIds: string[];
  generatedAt: string;
  generatedBy: string;
}

export class BatchNotFoundError extends Error {
  constructor(batchId: string) {
    super(`Batch not found: ${batchId}`);
    this.name = 'BatchNotFoundError';
  }
}

export class IncompleteBatchError extends Error {
  constructor(batchId: string, completedJobs: number, totalJobs: number) {
    super(`Batch ${batchId} is incomplete: ${completedJobs}/${totalJobs} jobs completed`);
    this.name = 'IncompleteBatchError';
  }
}

export class TenantMismatchError extends Error {
  constructor(expectedTenantId: string, actualTenantId: string) {
    super(`Tenant mismatch: expected ${expectedTenantId}, got ${actualTenantId}`);
    this.name = 'TenantMismatchError';
  }
}

export class InvalidAcrOptionsError extends Error {
  constructor(message: string) {
    super(`Invalid ACR options: ${message}`);
    this.name = 'InvalidAcrOptionsError';
  }
}
