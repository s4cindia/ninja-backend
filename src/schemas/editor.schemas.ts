import { z } from 'zod';

// ============================================
// Editor Session Schemas
// ============================================

export const createSessionSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
  mode: z.enum(['edit', 'view']).optional().default('edit'),
});

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID'),
});

export const documentIdParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID'),
});

// ============================================
// Type Exports
// ============================================

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
