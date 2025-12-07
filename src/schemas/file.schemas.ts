import { z } from 'zod';

export const listFilesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['UPLOADED', 'PROCESSING', 'PROCESSED', 'ERROR']).optional(),
    mimeType: z.string().optional(),
    sortBy: z.enum(['createdAt', 'size', 'originalName']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const fileIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
});

export const updateFileStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid file ID'),
  }),
  body: z.object({
    status: z.enum(['UPLOADED', 'PROCESSING', 'PROCESSED', 'ERROR']),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ListFilesQuery = z.infer<typeof listFilesSchema>['query'];
