import { z } from 'zod';

export const listFilesSchema = {
  query: z.object({
    page: z.string().optional().transform((val) => val ? parseInt(val, 10) : 1),
    limit: z.string().optional().transform((val) => val ? parseInt(val, 10) : 20),
    status: z.enum(['UPLOADED', 'PROCESSING', 'PROCESSED', 'ERROR']).optional(),
    mimeType: z.string().optional(),
    sortBy: z.enum(['createdAt', 'size', 'originalName']).optional().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
};

export const fileIdParamSchema = {
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
};

export const updateFileStatusSchema = {
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
  body: z.object({
    status: z.enum(['UPLOADED', 'PROCESSING', 'PROCESSED', 'ERROR']),
    metadata: z.record(z.unknown()).optional(),
  }),
};

export type ListFilesQuery = z.infer<typeof listFilesSchema.query>;
