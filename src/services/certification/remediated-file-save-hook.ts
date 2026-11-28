/**
 * Save-time half of the EPUB-from-certified-PDF "PDF changed" check (B3b).
 *
 * Registered on fileStorageService.onRemediatedFileSaved at startup (web
 * and worker), so storage itself stays unaware of certifications. After
 * every remediated-file save it:
 *   - caches the new bytes' sha256 against the written object's
 *     fingerprint, so the next certification read only needs a HEAD;
 *   - revokes an active certification of that same stored file whose
 *     certified hash no longer matches ('pdf-changed').
 *
 * This only makes revocation prompt. The guarantee is the read-time check
 * in certification.service.ts (getCertificationState / certifyJob), which
 * also covers saves made by processes that never registered this hook.
 */

import { fileStorageService, type RemediatedFileSavedEvent } from '../storage/file-storage.service';
import { logger } from '../../lib/logger';
import { sha256Hex, cacheRemediatedFileHash } from './remediated-file-hash';
import { revokeActiveCertification } from './certification-revoke';

export async function onRemediatedFileSaved(event: RemediatedFileSavedEvent): Promise<void> {
  // Only PDFs are ever certified; EPUB jobs share saveRemediatedFile.
  if (!event.fileName.toLowerCase().endsWith('.pdf')) return;

  const sha256 = sha256Hex(event.buffer);
  await cacheRemediatedFileHash(event.jobId, event.fileRef, event.fingerprint, sha256);
  const revoked = await revokeActiveCertification(event.jobId, 'pdf-changed', null, {
    remediatedFileRef: event.fileRef,
    pdfSha256Not: sha256,
  });
  if (revoked) logger.info(`[Certification] Remediated PDF re-saved for job ${event.jobId}; certification revoked`);
}

let unsubscribe: (() => void) | null = null;

/** Idempotent: registering twice keeps one listener. */
export function registerRemediatedFileSaveHook(): void {
  if (unsubscribe) return;
  unsubscribe = fileStorageService.onRemediatedFileSaved(onRemediatedFileSaved);
}

/** Tests only. */
export function unregisterRemediatedFileSaveHook(): void {
  unsubscribe?.();
  unsubscribe = null;
}
