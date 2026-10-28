/**
 * Best-effort job file name from its input/output JSON, mirroring the
 * frontend's extractFileNameFromJob (ninja-frontend/src/utils/jobTypes.ts)
 * fallback order so report tables and the job list agree on what to show.
 * Shared by cost-report.service.ts and quality-report.service.ts;
 * throughput-report.service.ts predates this and only checks input.fileName
 * -- left as-is since it already works for every PDF/EPUB job today.
 */
export function extractJobFileName(input: unknown, output: unknown): string | null {
  const outputObj = output as Record<string, unknown> | null;
  const inputObj = input as Record<string, unknown> | null;
  if (typeof outputObj?.originalName === 'string') return outputObj.originalName;
  if (typeof inputObj?.originalName === 'string') return inputObj.originalName;
  if (typeof inputObj?.fileName === 'string') return inputObj.fileName;
  if (typeof inputObj?.filename === 'string') return inputObj.filename;
  return null;
}
