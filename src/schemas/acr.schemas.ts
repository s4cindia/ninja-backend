import { z } from 'zod';
import { ACR_EDITIONS } from '../services/acr/acr-generator.service';

export const batchAcrGenerateSchema = z.object({
  batchId: z.string().min(1, 'Batch ID is required'),
  mode: z.enum(['individual', 'aggregate']).describe('Mode is required'),
  options: z.object({
    edition: z.enum(ACR_EDITIONS),
    batchName: z.string().min(1, 'Batch name is required'),
    vendor: z.string().min(1, 'Vendor name is required'),
    contactEmail: z.string().email('Invalid email format'),
    aggregationStrategy: z.enum(['conservative', 'optimistic']).optional().default('conservative'),
  }).optional(),
}).refine((data) => {
  if (data.mode === 'aggregate' && !data.options) {
    return false;
  }
  return true;
}, {
  message: 'Options are required for aggregate mode',
  path: ['options'],
});

export const batchAcrExportSchema = z.object({
  format: z.enum(['pdf', 'docx', 'html']).describe('Export format is required'),
  includeMethodology: z.boolean().optional().default(true),
});

export type BatchAcrGenerateInput = z.infer<typeof batchAcrGenerateSchema>;
export type BatchAcrExportInput = z.infer<typeof batchAcrExportSchema>;
