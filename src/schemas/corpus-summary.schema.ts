import { z } from 'zod';

/**
 * Query-param schema for corpus-summary v2 endpoints.
 *
 * Both params are optional ISO-8601 strings. The spec calls out "ISO date"
 * (e.g. `2026-04-01`), but we also accept full ISO datetimes with offsets
 * (e.g. `2026-04-01T12:00:00Z`) so callers can express sub-day precision
 * when needed. Defaults applied by `resolveCorpusRange` below.
 *
 * Validation rules:
 * - `from` / `to` must match YYYY-MM-DD OR a valid ISO-8601 datetime with offset.
 * - When both are provided, `from <= to` (enforced after normalization).
 */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isoDateOrDatetime = (fieldName: 'from' | 'to') =>
  z
    .string()
    .refine(
      (v) => {
        if (ISO_DATE_ONLY.test(v)) {
          // Validate it's a real calendar date. Date.parse rolls 2026-02-31
          // over to 2026-03-03, so we have to round-trip and compare.
          const [y, m, d] = v.split('-').map(Number);
          const parsed = new Date(Date.UTC(y!, (m ?? 0) - 1, d ?? 0));
          return (
            parsed.getUTCFullYear() === y &&
            parsed.getUTCMonth() === (m ?? 0) - 1 &&
            parsed.getUTCDate() === d
          );
        }
        // Fall back to strict datetime with timezone offset.
        return (
          /T/.test(v) &&
          /(Z|[+-]\d{2}:?\d{2})$/.test(v) &&
          Number.isFinite(Date.parse(v))
        );
      },
      { message: `${fieldName} must be an ISO-8601 date (YYYY-MM-DD) or datetime with offset` },
    )
    .optional();

export const corpusRangeQuerySchema = z
  .object({
    from: isoDateOrDatetime('from'),
    to: isoDateOrDatetime('to'),
  })
  .superRefine((val, ctx) => {
    if (val.from && val.to) {
      // Compare after normalizing both ends — date-only `from` parses as 00:00Z
      // and date-only `to` parses as 23:59Z, so same-day from=to is valid.
      const fromMs = normalizeRangeBound(val.from, 'from').getTime();
      const toMs = normalizeRangeBound(val.to, 'to').getTime();
      if (fromMs > toMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['from'],
          message: 'from must be on or before to',
        });
      }
    }
  });

export type CorpusRangeQuery = z.infer<typeof corpusRangeQuerySchema>;

/**
 * Normalize a validated range bound to a Date.
 * - `YYYY-MM-DD` as `from` → start of UTC day (00:00:00.000Z)
 * - `YYYY-MM-DD` as `to`   → end of UTC day   (23:59:59.999Z)
 * - Full datetime          → parsed as-is
 */
function normalizeRangeBound(value: string, which: 'from' | 'to'): Date {
  if (ISO_DATE_ONLY.test(value)) {
    const suffix = which === 'from' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    return new Date(`${value}${suffix}`);
  }
  return new Date(value);
}

/**
 * Default window — last 30 days ending "now" — applied when a caller omits
 * either end. Returned alongside the resolved Dates so handlers can echo the
 * range back in the response envelope.
 */
export function resolveCorpusRange(query: CorpusRangeQuery): { from: Date; to: Date } {
  const now = new Date();
  const to = query.to ? normalizeRangeBound(query.to, 'to') : now;
  const from = query.from
    ? normalizeRangeBound(query.from, 'from')
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}
