# Issue #50: Complete Dashboard Stats & Jobs Page Implementation

## Detailed Implementation Design

**Issue**: https://github.com/s4cindia/ninja-backend/issues/50
**Created**: December 30, 2025
**Status**: Open

---

## 1. Executive Summary

### Current State
The dashboard and jobs functionality has partial implementation across both frontend and backend. Feature branches exist with stashed work:
- Backend: `feature/dashboard-jobs-api`
- Frontend: `feature/dashboard-jobs-ui`

### Remaining Work (from issue)
1. **Backend**: Add `output` field to job list Prisma select clause
2. **Frontend**: Verify file name extraction works with output data
3. **Frontend**: Test job type labels display correctly
4. **Testing**: End-to-end verification of all dashboard cards
5. **Testing**: Jobs page shows real file names and statuses

### Scope of This Design
This document provides a comprehensive implementation plan addressing all remaining work plus identified gaps discovered during codebase analysis.

---

## 2. Problem Analysis

### 2.1 Backend Issues Identified

**Issue A: Missing `output` field in Job List Query**

Location: `/src/controllers/job.controller.ts` - `getJobs()` function

Current Prisma select clause:
```typescript
select: {
  id: true,
  type: true,
  status: true,
  progress: true,
  priority: true,
  input: true,           // ✅ Has input
  createdAt: true,
  startedAt: true,
  completedAt: true,
  productId: true,
  userId: true,
  product: { select: { title: true } }
  // ❌ MISSING: output field
}
```

**Impact**: Frontend cannot extract file names from job output for display in Jobs list.

**Issue B: File Name Extraction Logic**

The `output` field contains structured data like:
```json
{
  "fileName": "book.epub",
  "filePath": "/tmp/epub-storage/job-123/book.epub",
  "complianceScore": 87,
  "issueCount": 12,
  "auditResults": { ... }
}
```

Without `output`, the Jobs page shows generic labels instead of actual file names.

**Issue C: Dashboard Activity Type Mapping**

Location: `/src/controllers/dashboard.controller.ts`

Current job type to activity type mapping is limited:
```typescript
function mapJobTypeToActivityType(jobType: string): string {
  switch (jobType) {
    case 'EPUB_ACCESSIBILITY':
    case 'PDF_ACCESSIBILITY':
      return 'validation';
    case 'VPAT_GENERATION':
    case 'ACR_WORKFLOW':
      return 'compliance';
    default:
      return 'processing';
  }
}
```

Missing mappings for: `ALT_TEXT_GENERATION`, `METADATA_EXTRACTION`, `BATCH_VALIDATION`

### 2.2 Frontend Issues Identified

**Issue D: Jobs Page is a Stub**

Location: `/src/pages/Jobs.tsx`

Current implementation:
```typescript
// Just shows "No validation jobs yet" message
// No data fetching, no job list, no filtering
```

**Issue E: Job Type Labels**

The frontend needs human-readable labels for job types:
- `EPUB_ACCESSIBILITY` → "EPUB Accessibility Audit"
- `PDF_ACCESSIBILITY` → "PDF Accessibility Audit"
- `VPAT_GENERATION` → "VPAT Generation"
- etc.

**Issue F: File Name Extraction from Output**

Frontend needs to safely extract file name from job output:
```typescript
// Current: No extraction logic
// Needed: fileName from output.fileName or input.originalName or fallback
```

---

## 3. Technical Design

### 3.1 Backend Changes

#### 3.1.1 Add `output` to Job List Query

**File**: `/src/controllers/job.controller.ts`

**Change**: Update `getJobs()` Prisma select clause

```typescript
// BEFORE
const jobs = await prisma.job.findMany({
  where: { tenantId },
  select: {
    id: true,
    type: true,
    status: true,
    progress: true,
    priority: true,
    input: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
    productId: true,
    userId: true,
    product: { select: { title: true } }
  },
  // ...
});

// AFTER
const jobs = await prisma.job.findMany({
  where: { tenantId },
  select: {
    id: true,
    type: true,
    status: true,
    progress: true,
    priority: true,
    input: true,
    output: true,        // ✅ ADD THIS
    error: true,         // ✅ ADD THIS (useful for failed jobs)
    createdAt: true,
    startedAt: true,
    completedAt: true,
    productId: true,
    userId: true,
    product: { select: { title: true } }
  },
  // ...
});
```

**Rationale**:
- `output` contains file names, compliance scores, and results summary
- `error` provides context for failed jobs
- Both are needed for a complete Jobs page experience

#### 3.1.2 Update Dashboard Activity Type Mapping

**File**: `/src/controllers/dashboard.controller.ts`

```typescript
// UPDATED mapping function
function mapJobTypeToActivityType(jobType: string): string {
  switch (jobType) {
    case 'EPUB_ACCESSIBILITY':
    case 'PDF_ACCESSIBILITY':
      return 'validation';
    case 'VPAT_GENERATION':
    case 'ACR_WORKFLOW':
      return 'compliance';
    case 'ALT_TEXT_GENERATION':
      return 'alt-text';
    case 'METADATA_EXTRACTION':
      return 'metadata';
    case 'BATCH_VALIDATION':
      return 'batch';
    default:
      return 'processing';
  }
}
```

#### 3.1.3 Add File Name Helper to Dashboard Controller

**File**: `/src/controllers/dashboard.controller.ts`

```typescript
/**
 * Extract file name from job input/output
 * Priority: output.fileName > input.originalName > input.fileName > 'Unknown file'
 */
function extractFileName(job: { input: any; output: any }): string {
  // Try output first (contains processed file info)
  if (job.output && typeof job.output === 'object') {
    if (job.output.fileName) return job.output.fileName;
    if (job.output.originalName) return job.output.originalName;
  }

  // Fall back to input (contains uploaded file info)
  if (job.input && typeof job.input === 'object') {
    if (job.input.originalName) return job.input.originalName;
    if (job.input.fileName) return job.input.fileName;
    if (job.input.filename) return job.input.filename;
  }

  return 'Unknown file';
}
```

#### 3.1.4 Enhanced Dashboard Stats Endpoint

**File**: `/src/controllers/dashboard.controller.ts`

Add additional useful metrics:

```typescript
export async function getDashboardStats(req: AuthenticatedRequest, res: Response) {
  const tenantId = req.user!.tenantId;

  const [
    totalFiles,
    filesProcessed,
    filesPending,
    filesFailed,
    completedJobs,
    // NEW: Additional metrics
    totalJobs,
    jobsByStatus,
    jobsByType,
    recentCompletedJobs
  ] = await Promise.all([
    // Existing queries...
    prisma.file.count({ where: { tenantId, deletedAt: null } }),
    prisma.file.count({ where: { tenantId, status: 'PROCESSED', deletedAt: null } }),
    prisma.file.count({ where: { tenantId, status: { in: ['UPLOADED', 'PROCESSING'] }, deletedAt: null } }),
    prisma.file.count({ where: { tenantId, status: 'ERROR', deletedAt: null } }),
    prisma.job.findMany({
      where: { tenantId, status: 'COMPLETED', type: 'EPUB_ACCESSIBILITY' },
      select: { output: true },
      orderBy: { completedAt: 'desc' },
      take: 100
    }),

    // NEW: Job-related stats
    prisma.job.count({ where: { tenantId } }),
    prisma.job.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: true
    }),
    prisma.job.groupBy({
      by: ['type'],
      where: { tenantId },
      _count: true
    }),
    prisma.job.findMany({
      where: { tenantId, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      take: 5,
      select: { id: true, type: true, completedAt: true, output: true }
    })
  ]);

  // Calculate compliance score
  const scores = completedJobs
    .map(job => {
      const output = job.output as any;
      return output?.complianceScore ?? output?.score ?? null;
    })
    .filter((score): score is number => score !== null);

  const averageComplianceScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  // Format job stats
  const jobStats = {
    total: totalJobs,
    byStatus: Object.fromEntries(
      jobsByStatus.map(s => [s.status, s._count])
    ),
    byType: Object.fromEntries(
      jobsByType.map(t => [t.type, t._count])
    )
  };

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    success: true,
    data: {
      // File metrics
      totalFiles,
      filesProcessed,
      filesPending,
      filesFailed,
      averageComplianceScore,

      // Job metrics (NEW)
      jobStats,

      // Processing metrics (NEW)
      processingRate: totalFiles > 0
        ? Math.round((filesProcessed / totalFiles) * 100)
        : 0,
      failureRate: totalFiles > 0
        ? Math.round((filesFailed / totalFiles) * 100)
        : 0
    }
  });
}
```

### 3.2 Frontend Changes

#### 3.2.1 Job Type Labels Utility

**File**: `/src/utils/jobTypes.ts` (NEW)

```typescript
export const JOB_TYPE_LABELS: Record<string, string> = {
  'EPUB_ACCESSIBILITY': 'EPUB Accessibility Audit',
  'PDF_ACCESSIBILITY': 'PDF Accessibility Audit',
  'VPAT_GENERATION': 'VPAT Generation',
  'ACR_WORKFLOW': 'ACR Workflow',
  'ALT_TEXT_GENERATION': 'Alt Text Generation',
  'METADATA_EXTRACTION': 'Metadata Extraction',
  'BATCH_VALIDATION': 'Batch Validation'
};

export const JOB_STATUS_COLORS: Record<string, string> = {
  'QUEUED': 'bg-gray-100 text-gray-800',
  'PROCESSING': 'bg-blue-100 text-blue-800',
  'COMPLETED': 'bg-green-100 text-green-800',
  'FAILED': 'bg-red-100 text-red-800',
  'CANCELLED': 'bg-yellow-100 text-yellow-800'
};

export const JOB_STATUS_ICONS: Record<string, string> = {
  'QUEUED': 'Clock',
  'PROCESSING': 'Loader',
  'COMPLETED': 'CheckCircle',
  'FAILED': 'XCircle',
  'CANCELLED': 'Ban'
};

export function getJobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] || type.replace(/_/g, ' ');
}

export function extractFileNameFromJob(job: { input?: any; output?: any }): string {
  // Try output first
  if (job.output && typeof job.output === 'object') {
    if (job.output.fileName) return job.output.fileName;
    if (job.output.originalName) return job.output.originalName;
  }

  // Fall back to input
  if (job.input && typeof job.input === 'object') {
    if (job.input.originalName) return job.input.originalName;
    if (job.input.fileName) return job.input.fileName;
    if (job.input.filename) return job.input.filename;
  }

  return 'Unknown file';
}
```

#### 3.2.2 Jobs Service

**File**: `/src/services/jobs.service.ts` (NEW or UPDATE)

```typescript
import api from './api';

export interface Job {
  id: string;
  type: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress?: number;
  priority: number;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  productId?: string;
  userId?: string;
  product?: { title: string };
}

export interface JobsListResponse {
  jobs: Job[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface JobsFilter {
  status?: string;
  type?: string;
  page?: number;
  limit?: number;
}

export interface JobStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  recentJobs: Job[];
}

class JobsService {
  async getJobs(filters: JobsFilter = {}): Promise<JobsListResponse> {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.type) params.append('type', filters.type);
    if (filters.page) params.append('page', String(filters.page));
    if (filters.limit) params.append('limit', String(filters.limit));

    const response = await api.get(`/jobs?${params.toString()}`);
    return response.data.data;
  }

  async getJob(jobId: string): Promise<Job> {
    const response = await api.get(`/jobs/${jobId}`);
    return response.data.data;
  }

  async getJobStatus(jobId: string): Promise<{ status: string; progress?: number; error?: string }> {
    const response = await api.get(`/jobs/${jobId}/status`);
    return response.data.data;
  }

  async getJobResults(jobId: string): Promise<any> {
    const response = await api.get(`/jobs/${jobId}/results`);
    return response.data.data;
  }

  async getJobStats(): Promise<JobStats> {
    const response = await api.get('/jobs/stats');
    return response.data.data;
  }

  async cancelJob(jobId: string): Promise<void> {
    await api.delete(`/jobs/${jobId}`);
  }

  async createJob(type: string, fileId: string, options?: Record<string, any>): Promise<{ jobId: string }> {
    const response = await api.post('/jobs', { type, fileId, options });
    return response.data.data;
  }
}

export const jobsService = new JobsService();
export default jobsService;
```

#### 3.2.3 Jobs Hook

**File**: `/src/hooks/useJobs.ts` (NEW)

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import jobsService, { JobsFilter, Job } from '../services/jobs.service';

export function useJobs(filters: JobsFilter = {}) {
  return useQuery({
    queryKey: ['jobs', filters],
    queryFn: () => jobsService.getJobs(filters),
    staleTime: 10 * 1000, // 10 seconds
    refetchInterval: (query) => {
      // Auto-refresh if any jobs are processing
      const data = query.state.data;
      if (data?.jobs.some(j => j.status === 'PROCESSING' || j.status === 'QUEUED')) {
        return 5000; // 5 second refresh
      }
      return 30000; // 30 second refresh otherwise
    }
  });
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['job', jobId],
    queryFn: () => jobsService.getJob(jobId!),
    enabled: !!jobId,
    staleTime: 5000
  });
}

export function useJobStats() {
  return useQuery({
    queryKey: ['jobs', 'stats'],
    queryFn: () => jobsService.getJobStats(),
    staleTime: 30000
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => jobsService.cancelJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    }
  });
}
```

#### 3.2.4 Jobs Page Implementation

**File**: `/src/pages/Jobs.tsx` (REPLACE)

```typescript
import React, { useState } from 'react';
import {
  FileText, Clock, CheckCircle, XCircle, Loader,
  Filter, RefreshCw, Ban, ChevronLeft, ChevronRight,
  AlertCircle
} from 'lucide-react';
import { useJobs, useJobStats, useCancelJob } from '../hooks/useJobs';
import { getJobTypeLabel, extractFileNameFromJob, JOB_STATUS_COLORS } from '../utils/jobTypes';
import { formatDistanceToNow } from '../utils/date';

const STATUS_OPTIONS = ['ALL', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];
const TYPE_OPTIONS = [
  'ALL',
  'EPUB_ACCESSIBILITY',
  'PDF_ACCESSIBILITY',
  'VPAT_GENERATION',
  'ALT_TEXT_GENERATION',
  'BATCH_VALIDATION'
];

export default function Jobs() {
  const [filters, setFilters] = useState({
    status: '',
    type: '',
    page: 1,
    limit: 20
  });
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useJobs(filters);
  const { data: stats } = useJobStats();
  const cancelJob = useCancelJob();

  const handleFilterChange = (key: string, value: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: value === 'ALL' ? '' : value,
      page: 1 // Reset to first page on filter change
    }));
  };

  const handlePageChange = (newPage: number) => {
    setFilters(prev => ({ ...prev, page: newPage }));
  };

  const handleCancelJob = async (jobId: string) => {
    if (confirm('Are you sure you want to cancel this job?')) {
      await cancelJob.mutateAsync(jobId);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'QUEUED': return <Clock className="w-4 h-4" />;
      case 'PROCESSING': return <Loader className="w-4 h-4 animate-spin" />;
      case 'COMPLETED': return <CheckCircle className="w-4 h-4" />;
      case 'FAILED': return <XCircle className="w-4 h-4" />;
      case 'CANCELLED': return <Ban className="w-4 h-4" />;
      default: return <FileText className="w-4 h-4" />;
    }
  };

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500" />
          <div>
            <p className="font-medium text-red-800">Failed to load jobs</p>
            <p className="text-sm text-red-600">{error.message}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
          <p className="text-gray-500">Monitor and manage processing jobs</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <p className="text-sm text-gray-500">Total Jobs</p>
            <p className="text-2xl font-bold">{stats.total}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <p className="text-sm text-gray-500">Queued</p>
            <p className="text-2xl font-bold text-gray-600">{stats.byStatus?.QUEUED || 0}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <p className="text-sm text-gray-500">Processing</p>
            <p className="text-2xl font-bold text-blue-600">{stats.byStatus?.PROCESSING || 0}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <p className="text-sm text-gray-500">Completed</p>
            <p className="text-2xl font-bold text-green-600">{stats.byStatus?.COMPLETED || 0}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <p className="text-sm text-gray-500">Failed</p>
            <p className="text-2xl font-bold text-red-600">{stats.byStatus?.FAILED || 0}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 bg-white p-4 rounded-lg border">
        <Filter className="w-5 h-5 text-gray-400" />

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Status:</label>
          <select
            value={filters.status || 'ALL'}
            onChange={(e) => handleFilterChange('status', e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
          >
            {STATUS_OPTIONS.map(status => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Type:</label>
          <select
            value={filters.type || 'ALL'}
            onChange={(e) => handleFilterChange('type', e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
          >
            {TYPE_OPTIONS.map(type => (
              <option key={type} value={type}>
                {type === 'ALL' ? 'ALL' : getJobTypeLabel(type)}
              </option>
            ))}
          </select>
        </div>

        {(filters.status || filters.type) && (
          <button
            onClick={() => setFilters({ status: '', type: '', page: 1, limit: 20 })}
            className="text-sm text-blue-600 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Jobs Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center">
            <Loader className="w-8 h-8 animate-spin mx-auto text-blue-500" />
            <p className="mt-2 text-gray-500">Loading jobs...</p>
          </div>
        ) : !data?.jobs.length ? (
          <div className="p-12 text-center">
            <FileText className="w-12 h-12 mx-auto text-gray-300" />
            <p className="mt-2 text-gray-500">No jobs found</p>
            <p className="text-sm text-gray-400">Jobs will appear here when you start processing files</p>
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">File</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Progress</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.jobs.map((job) => (
                  <tr
                    key={job.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-gray-400" />
                        <span className="font-medium text-gray-900 truncate max-w-[200px]">
                          {extractFileNameFromJob(job)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-gray-600">
                        {getJobTypeLabel(job.type)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${JOB_STATUS_COLORS[job.status] || 'bg-gray-100'}`}>
                        {getStatusIcon(job.status)}
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {job.status === 'PROCESSING' && job.progress !== undefined ? (
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 transition-all"
                              style={{ width: `${job.progress}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{job.progress}%</span>
                        </div>
                      ) : job.status === 'COMPLETED' ? (
                        <span className="text-sm text-green-600">100%</span>
                      ) : (
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {formatDistanceToNow(new Date(job.createdAt))}
                    </td>
                    <td className="px-4 py-3">
                      {(job.status === 'QUEUED' || job.status === 'PROCESSING') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelJob(job.id);
                          }}
                          className="text-sm text-red-600 hover:underline"
                        >
                          Cancel
                        </button>
                      )}
                      {job.status === 'FAILED' && job.error && (
                        <span className="text-xs text-red-500 truncate max-w-[150px] block" title={job.error}>
                          {job.error}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {data.pagination && data.pagination.pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
                <p className="text-sm text-gray-500">
                  Showing {((data.pagination.page - 1) * data.pagination.limit) + 1} to{' '}
                  {Math.min(data.pagination.page * data.pagination.limit, data.pagination.total)} of{' '}
                  {data.pagination.total} jobs
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePageChange(data.pagination.page - 1)}
                    disabled={data.pagination.page === 1}
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <span className="text-sm">
                    Page {data.pagination.page} of {data.pagination.pages}
                  </span>
                  <button
                    onClick={() => handlePageChange(data.pagination.page + 1)}
                    disabled={data.pagination.page === data.pagination.pages}
                    className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Job Details Modal - simplified inline for this design */}
      {selectedJobId && (
        <JobDetailsModal
          jobId={selectedJobId}
          onClose={() => setSelectedJobId(null)}
        />
      )}
    </div>
  );
}

// Separate component for job details modal
function JobDetailsModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  // Implementation would use useJob(jobId) hook
  // Displays full job details, output, errors, timeline
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold mb-4">Job Details</h2>
        <p className="text-gray-500">Job ID: {jobId}</p>
        {/* Full implementation would show complete job details */}
        <button onClick={onClose} className="mt-4 px-4 py-2 bg-gray-100 rounded hover:bg-gray-200">
          Close
        </button>
      </div>
    </div>
  );
}
```

#### 3.2.5 Update Dashboard Page

**File**: `/src/pages/Dashboard.tsx`

Add job stats section and improve activity feed:

```typescript
// Add to imports
import { useJobStats } from '../hooks/useJobs';

// Inside Dashboard component, add:
const { data: jobStats } = useJobStats();

// Add a "Jobs Overview" section showing:
// - Active jobs (QUEUED + PROCESSING count)
// - Recent completions
// - Failed jobs needing attention
```

---

## 4. Data Flow Diagrams

### 4.1 Dashboard Stats Flow

```
┌─────────────┐     GET /dashboard/stats     ┌──────────────┐
│  Dashboard  │ ─────────────────────────────▶│   Backend    │
│    Page     │                               │  Controller  │
└─────────────┘                               └──────────────┘
       │                                              │
       │                                              ▼
       │                                    ┌──────────────────┐
       │                                    │  Prisma Queries  │
       │                                    │  (5 parallel)    │
       │                                    └──────────────────┘
       │                                              │
       │              Response JSON                   │
       │◀─────────────────────────────────────────────┘
       │
       ▼
┌─────────────────┐
│  React Query    │
│  Cache (30s)    │
└─────────────────┘
       │
       ▼
┌─────────────────┐
│  Stats Cards    │
│  Compliance %   │
│  Activity Feed  │
└─────────────────┘
```

### 4.2 Jobs List Flow

```
┌─────────────┐   GET /jobs?status=&type=&page=   ┌──────────────┐
│  Jobs Page  │ ─────────────────────────────────▶│   Backend    │
│             │                                    │  Controller  │
└─────────────┘                                    └──────────────┘
       │                                                  │
       │                                                  ▼
       │                                        ┌──────────────────┐
       │                                        │   Prisma Query   │
       │                                        │  (with output)   │
       │                                        └──────────────────┘
       │                                                  │
       │          { jobs: [...], pagination: {...} }      │
       │◀─────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Jobs Table                            │
│  ┌───────────┬──────────┬────────┬──────────┬────────┐  │
│  │ File Name │   Type   │ Status │ Progress │ Actions│  │
│  │ (from     │ (mapped) │ (badge)│ (bar)    │ (cancel│  │
│  │  output)  │          │        │          │  etc)  │  │
│  └───────────┴──────────┴────────┴──────────┴────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Database Considerations

### 5.1 No Schema Changes Required

The existing Prisma schema already supports all required functionality:
- `Job.output` field exists (JSON type)
- `Job.error` field exists (String type)
- All necessary indexes are in place

### 5.2 Query Optimization

Current implementation uses parallel queries which is good. Consider adding:

```typescript
// Potential optimization: Single aggregation query for stats
const stats = await prisma.$queryRaw`
  SELECT
    COUNT(*) FILTER (WHERE status = 'UPLOADED') as files_uploaded,
    COUNT(*) FILTER (WHERE status = 'PROCESSING') as files_processing,
    COUNT(*) FILTER (WHERE status = 'PROCESSED') as files_processed,
    COUNT(*) FILTER (WHERE status = 'ERROR') as files_failed
  FROM "File"
  WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
`;
```

---

## 6. Testing Strategy

### 6.1 Backend Unit Tests

**File**: `/tests/unit/dashboard.controller.test.ts`

```typescript
describe('Dashboard Controller', () => {
  describe('getDashboardStats', () => {
    it('should return correct file counts by status');
    it('should calculate average compliance score correctly');
    it('should handle empty results gracefully');
    it('should filter by tenant ID');
  });

  describe('getDashboardActivity', () => {
    it('should return recent jobs as activities');
    it('should map job types to activity types correctly');
    it('should extract file names from job output');
    it('should limit results based on query param');
  });
});

describe('Job Controller', () => {
  describe('getJobs', () => {
    it('should include output field in response');
    it('should include error field in response');
    it('should filter by status');
    it('should filter by type');
    it('should paginate correctly');
  });
});
```

### 6.2 Frontend Component Tests

**File**: `/tests/components/Jobs.test.tsx`

```typescript
describe('Jobs Page', () => {
  it('should display loading state');
  it('should display jobs list when data loads');
  it('should extract file names from job output');
  it('should display job type labels correctly');
  it('should show correct status badges');
  it('should handle filter changes');
  it('should handle pagination');
  it('should allow job cancellation');
  it('should handle API errors gracefully');
});
```

### 6.3 End-to-End Tests

```typescript
describe('Dashboard E2E', () => {
  it('should display correct file counts from database');
  it('should show real compliance score average');
  it('should update activity feed in real-time');
  it('should navigate to Jobs page from dashboard');
});

describe('Jobs Page E2E', () => {
  it('should list all jobs with correct file names');
  it('should filter by status');
  it('should filter by type');
  it('should show real-time progress for processing jobs');
  it('should allow cancelling queued jobs');
});
```

---

## 7. Implementation Plan

### Phase 1: Backend Changes (1-2 hours)

| Task | File | Priority |
|------|------|----------|
| Add `output` and `error` to job list select | `job.controller.ts` | P0 |
| Add `extractFileName` helper | `dashboard.controller.ts` | P0 |
| Update activity type mapping | `dashboard.controller.ts` | P1 |
| Add job stats to dashboard stats | `dashboard.controller.ts` | P2 |

### Phase 2: Frontend Utilities (1 hour)

| Task | File | Priority |
|------|------|----------|
| Create job types utility | `utils/jobTypes.ts` | P0 |
| Create jobs service | `services/jobs.service.ts` | P0 |
| Create useJobs hook | `hooks/useJobs.ts` | P0 |

### Phase 3: Jobs Page Implementation (2-3 hours)

| Task | File | Priority |
|------|------|----------|
| Implement Jobs page UI | `pages/Jobs.tsx` | P0 |
| Add stats cards | `pages/Jobs.tsx` | P1 |
| Add filters and pagination | `pages/Jobs.tsx` | P1 |
| Add job details modal | `components/jobs/JobDetailsModal.tsx` | P2 |

### Phase 4: Dashboard Enhancements (1 hour)

| Task | File | Priority |
|------|------|----------|
| Add job stats section | `pages/Dashboard.tsx` | P2 |
| Improve activity feed | `pages/Dashboard.tsx` | P2 |

### Phase 5: Testing (2-3 hours)

| Task | Type | Priority |
|------|------|----------|
| Backend unit tests | Unit | P0 |
| Frontend component tests | Unit | P1 |
| E2E dashboard tests | E2E | P1 |
| E2E jobs page tests | E2E | P1 |

---

## 8. Acceptance Criteria

### Dashboard Stats Card Verification

- [ ] Total Files shows accurate count from database
- [ ] Files Processed shows files with PROCESSED status
- [ ] Files Pending shows UPLOADED + PROCESSING status files
- [ ] Files Failed shows ERROR status files
- [ ] Compliance Score shows average from completed EPUB audits

### Dashboard Activity Feed Verification

- [ ] Shows recent jobs with correct activity types
- [ ] Displays actual file names (not "Unknown file")
- [ ] Shows relative timestamps (e.g., "5 minutes ago")
- [ ] Links to job details or file

### Jobs Page Verification

- [ ] Lists all jobs with pagination
- [ ] Shows actual file names from job output/input
- [ ] Displays human-readable job type labels
- [ ] Shows correct status badges with icons
- [ ] Progress bar works for processing jobs
- [ ] Filters work (status, type)
- [ ] Cancel action works for queued/processing jobs
- [ ] Error messages shown for failed jobs

---

## 9. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Large `output` field increases response size | Medium | Add field selection or summary mode |
| N+1 queries if not careful | High | Use Prisma includes, not separate queries |
| Breaking API changes | Medium | Additive changes only, don't remove fields |
| Cache invalidation issues | Low | Use React Query mutation callbacks |

---

## 10. Future Enhancements (Out of Scope)

1. **Real-time updates via WebSocket/SSE** - Use existing SSE service
2. **Job retry functionality** - Re-queue failed jobs
3. **Batch job operations** - Cancel/retry multiple jobs
4. **Job scheduling** - Schedule jobs for later execution
5. **Job dependencies** - Chain jobs together
6. **Email notifications** - Alert on job completion/failure
7. **Dashboard customization** - User-configurable widgets

---

## 11. Related Issues & References

- **Issue #50**: This design document
- **Issue #62**: Workflow Lineage System (related to job tracking)
- **Issue #47**: Batch processing with quick fixes
- **Feature branches**: `feature/dashboard-jobs-api`, `feature/dashboard-jobs-ui`

---

## 12. Appendix: API Response Examples

### Dashboard Stats Response

```json
{
  "success": true,
  "data": {
    "totalFiles": 156,
    "filesProcessed": 142,
    "filesPending": 8,
    "filesFailed": 6,
    "averageComplianceScore": 87,
    "jobStats": {
      "total": 312,
      "byStatus": {
        "QUEUED": 3,
        "PROCESSING": 5,
        "COMPLETED": 298,
        "FAILED": 6
      },
      "byType": {
        "EPUB_ACCESSIBILITY": 245,
        "PDF_ACCESSIBILITY": 52,
        "VPAT_GENERATION": 15
      }
    },
    "processingRate": 91,
    "failureRate": 4
  }
}
```

### Jobs List Response

```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "id": "job_abc123",
        "type": "EPUB_ACCESSIBILITY",
        "status": "COMPLETED",
        "progress": 100,
        "priority": 1,
        "input": {
          "fileId": "file_xyz",
          "originalName": "chemistry-textbook.epub"
        },
        "output": {
          "fileName": "chemistry-textbook.epub",
          "complianceScore": 92,
          "issueCount": 8,
          "fixableCount": 5
        },
        "error": null,
        "createdAt": "2025-12-30T10:15:00Z",
        "startedAt": "2025-12-30T10:15:02Z",
        "completedAt": "2025-12-30T10:16:45Z",
        "product": {
          "title": "Chemistry 101"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 312,
      "pages": 16
    }
  }
}
```

---

**Document Version**: 1.0
**Last Updated**: January 6, 2026
**Author**: Claude Code Assistant
