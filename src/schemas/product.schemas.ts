import { z } from 'zod';

const isbnSchema = z
  .string()
  .regex(/^(\d{10}|\d{13})$/, 'ISBN must be 10 or 13 digits');

export const createProductSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  isbn: isbnSchema,
  format: z.enum(['PDF', 'EPUB', 'HTML'], { 
    message: 'Format must be PDF, EPUB, or HTML'
  })
});

export const updateProductSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  isbn: isbnSchema.optional(),
  format: z.enum(['PDF', 'EPUB', 'HTML']).optional()
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
