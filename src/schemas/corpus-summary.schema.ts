import { z } from 'zod';

/**
 * Query-param schema for corpus-summary v2 endpoints.
 *
 * Both params are optional ISO-8601 strings. Defaults applied by the caller
 * (NOT here) so we can distinguish "caller omitted" from "caller sent nothing"
 * cleanly when merging with feature-flag defaults.
 *
 * Validation rules:
 * - `from` and `to` must be parseable ISO-8601 dates if present
 * - When both are provided, `from <= to`
 */
export const corpusRangeQuerySchema = z
  .object({
    from: z
      .string()
      .datetime({ offset: true, message: 'from must be an ISO-8601 datetime' })
      .optional(),
    to: z
      .string()
      .datetime({ offset: true, message: 'to must be an ISO-8601 datetime' })
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.from && val.to && new Date(val.from).getTime() > new Date(val.to).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must be on or before to',
      });
    }
  });

export type CorpusRangeQuery = z.infer<typeof corpusRangeQuerySchema>;

/**
 * Default window — last 30 days ending "now" — applied when a caller omits
 * either end. Returned alongside the resolved Dates so handlers can echo the
 * range back in the response envelope.
 */
export function resolveCorpusRange(query: CorpusRangeQuery): { from: Date; to: Date } {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}
