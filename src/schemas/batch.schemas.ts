import { z } from 'zod';
import { ACR_EDITIONS } from '../services/acr/acr-generator.service';

export const batchCreateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export const batchStartSchema = z.object({
  options: z.object({
    skipAudit: z.boolean().optional(),
    autoRemediateOnly: z.boolean().optional(),
  }).optional(),
});

export const batchListSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(['DRAFT', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
});

export const batchAcrGenerateSchema = z.object({
  mode: z.enum(['individual', 'aggregate']),
  options: z.object({
    edition: z.enum(ACR_EDITIONS),
    batchName: z.string().min(1),
    vendor: z.string().min(1),
    contactEmail: z.string().email(),
    aggregationStrategy: z.enum(['conservative', 'optimistic']),
  }).optional(),
});

export const batchExportSchema = z.object({
  format: z.enum(['zip']).default('zip'),
  includeOriginals: z.boolean().optional().default(false),
  includeComparisons: z.boolean().optional().default(false),
});
