/**
 * Publisher profile detector — runs after the JS auditor, before validators
 * downstream of the existing audit pipeline. Reads the EPUB once via JSZip
 * (the JS auditor uses the same library) and dispatches to per-publisher
 * sub-detectors. Today: PRH UK only.
 *
 * Returned profile attaches to `EpubAuditResult.publisherProfile` so the
 * frontend (and PR2+ validators) can read it. When no profile is detected the
 * function returns `NO_PROFILE` rather than null, so callers don't need to
 * branch on undefined.
 */

import JSZip from 'jszip';
import { logger } from '../../../lib/logger';
import { NO_PROFILE, type DetectionConfidence, type ProfileSignal, type PublisherProfile } from './types';
import { detectPrhImprint } from './prh-uk';

/** How many bytes of body content to feed the detectors. Capped to keep this fast. */
const CONTENT_SAMPLE_BYTES = 32 * 1024;

/**
 * Best-effort detection. Failures (corrupt zip, missing OPF, etc.) are caught
 * and logged; the function returns `NO_PROFILE` rather than throwing so that
 * a detection bug never breaks the surrounding audit.
 */
export async function detectPublisherProfile(
  buffer: Buffer,
): Promise<PublisherProfile> {
  try {
    const zip = await JSZip.loadAsync(buffer);

    const opfContent = await readOpf(zip);
    const filePaths = Object.keys(zip.files);
    const contentSample = await readContentSample(zip);

    // Today only one sub-detector. Future: dispatch to others and pick the
    // strongest match.
    const prh = detectPrhImprint({ opfContent, filePaths, contentSample });

    if (!prh.isPrhUk) return NO_PROFILE;

    const confidence = aggregateConfidence(prh.signals);

    return {
      publisher: 'PRH-UK',
      imprint: prh.imprint,
      confidence,
      signals: prh.signals,
    };
  } catch (err) {
    logger.warn(
      `[profile-detector] detection failed; treating as no-profile: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return NO_PROFILE;
  }
}

async function readOpf(zip: JSZip): Promise<string> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) return '';
  const match = containerXml.match(/rootfile[^>]+full-path="([^"]+)"/);
  if (!match) return '';
  const opfPath = match[1];
  return (await zip.file(opfPath)?.async('text')) ?? '';
}

async function readContentSample(zip: JSZip): Promise<string> {
  const xhtmlPaths = Object.keys(zip.files)
    .filter((p) => /\.(xhtml|html)$/i.test(p))
    // Prefer cover/title/copyright/nav — those carry the strongest imprint
    // signals for branded EPUBs.
    .sort((a, b) => priority(a) - priority(b));

  let collected = '';
  for (const p of xhtmlPaths) {
    if (collected.length >= CONTENT_SAMPLE_BYTES) break;
    const content = await zip.file(p)?.async('text');
    if (!content) continue;
    collected += content;
  }
  return collected.slice(0, CONTENT_SAMPLE_BYTES);
}

function priority(path: string): number {
  const lower = path.toLowerCase();
  if (lower.includes('cover')) return 0;
  if (lower.includes('title')) return 1;
  if (lower.includes('copyright')) return 2;
  if (lower.includes('nav')) return 3;
  if (lower.includes('brand')) return 4;
  return 5;
}

/**
 * Translate the bag of per-signal strengths into a single confidence band.
 *
 * - **high**: at least one strong signal AND any second signal of any
 *   strength. Mitigates false positives where a single mention of
 *   "penguin.co.uk" would otherwise tip an EPUB into PRH territory.
 * - **medium**: any single strong signal, OR multiple moderate signals.
 * - **low**: any other detection (single moderate / single weak).
 *
 * Validators in PR2+ should treat `low` as advisory-only and only emit
 * issues for `medium` or `high`.
 */
export function aggregateConfidence(signals: ProfileSignal[]): DetectionConfidence {
  if (signals.length === 0) return 'low';
  const strongCount = signals.filter((s) => s.strength === 'strong').length;
  const moderateCount = signals.filter((s) => s.strength === 'moderate').length;

  if (strongCount >= 1 && signals.length >= 2) return 'high';
  if (strongCount >= 1) return 'medium';
  if (moderateCount >= 2) return 'medium';
  return 'low';
}
