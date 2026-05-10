/**
 * Orchestrator for PRH UK validators. Loads the OPF once via JSZip, runs
 * each validator, and returns a flat list of `PrhValidatorIssue` objects
 * for the audit pipeline to translate into `AccessibilityIssue` records.
 *
 * Best-effort: if the EPUB can't be parsed we return an empty list rather
 * than throwing — a validator failure must never break the surrounding
 * audit. Same defensive posture as the publisher-profile detector.
 */

import JSZip from 'jszip';
import { logger } from '../../../../lib/logger';
import { validatePrhMetadata } from './validators/metadata-validator';
import { validatePrhSpine } from './validators/spine-validator';
import type { PrhValidatorIssue } from './validators/types';

export async function runPrhUkValidators(buffer: Buffer): Promise<PrhValidatorIssue[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const opf = await readOpf(zip);
    if (!opf) {
      logger.warn('[PRH validators] OPF not found; skipping');
      return [];
    }
    const input = { opfContent: opf.content, opfPath: opf.path };
    return [
      ...validatePrhMetadata(input),
      ...validatePrhSpine(input),
    ];
  } catch (err) {
    logger.warn(
      `[PRH validators] run failed; returning no issues: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return [];
  }
}

async function readOpf(zip: JSZip): Promise<{ path: string; content: string } | null> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) return null;
  const m = containerXml.match(/rootfile[^>]+full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/);
  const opfPath = m?.[1] ?? m?.[2];
  if (!opfPath) return null;
  const content = await zip.file(opfPath)?.async('text');
  if (!content) return null;
  return { path: opfPath, content };
}
