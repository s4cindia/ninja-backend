/**
 * Pagination constants for API endpoints
 *
 * These constants are used across controllers and services to ensure
 * consistent pagination behavior and prevent OOM errors.
 */

/**
 * Maximum number of records to return per page
 *
 * Chosen based on:
 * - Typical RemediationChange size: ~1-2KB each
 * - Memory constraint: 200 * 2KB = ~400KB per response
 * - Query performance: Prisma can fetch 200 records in <100ms
 * - Frontend pagination: Standard page sizes are 50-100
 * - Prevents OOM errors and excessive query times for large result sets
 *
 * This limit is enforced at both controller and service layers for defense-in-depth.
 *
 * @constant
 * @default 200
 */
export const MAX_PAGINATION_LIMIT = 200;

/**
 * Default number of records to return when no limit is specified
 *
 * @constant
 * @default 50
 */
export const DEFAULT_PAGINATION_LIMIT = 50;

/**
 * Maximum page number allowed to prevent excessive offset calculations
 *
 * Lowered from 10000 to 1000 based on PostgreSQL performance considerations:
 * - Max offset: (1000 - 1) * 200 = 199,800 records
 * - Large OFFSET requires PostgreSQL to scan all skipped rows
 * - Performance degrades significantly beyond ~200K offset
 *
 * For datasets requiring deeper pagination:
 * - Implement cursor-based pagination (keyset pagination)
 * - Use indexed columns for efficient seeking
 * - Consider paginating by date ranges or other natural boundaries
 *
 * When users approach this limit, the API logs a warning for monitoring.
 *
 * @constant
 * @default 1000
 */
export const MAX_PAGE = 1000;
