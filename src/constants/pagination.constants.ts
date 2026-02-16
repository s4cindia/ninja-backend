/**
 * Pagination constants for API endpoints
 *
 * These constants are used across controllers and services to ensure
 * consistent pagination behavior and prevent OOM errors.
 */

/**
 * Maximum number of records to return per page
 * Prevents OOM errors and excessive query times for large result sets
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
 * Prevents performance issues from skip > 2M records (10000 * 200).
 * For datasets larger than 2M records, consider cursor-based pagination.
 *
 * @constant
 * @default 10000
 */
export const MAX_PAGE = 10000;
