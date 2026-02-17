import { z } from 'zod';

export const batchAcrGenerateSchema = z.object({
  batchId: z.string().min(1, 'Batch ID is required'),
  mode: z.enum(['individual', 'aggregate']).describe('Mode is required'),
  options: z.object({
    edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']),
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
