/**
 * PRH UK image remediator.
 *
 * `fixDecorativeRole` adds `role="presentation"` to every `<img>` that
 * carries `alt=""` (decorative marker) but is missing the role attribute.
 * This closes the gap left by `epub-modifier.service.ts:
 * addDecorativeAltAttributes`, which only writes `role="presentation"`
 * when it also adds the missing alt — leaving pre-existing `alt=""`
 * images untouched.
 *
 * The fix is idempotent: images that already have `role="presentation"`
 * (or `role="none"`, the ARIA-1.1 equivalent) are skipped. Emits one
 * `ChangeResult` per touched file, with the per-file count in the
 * description, so the auto-remediation pipeline can attribute success
 * to specific files.
 *
 * `PRH-COVER-ALT-EMPTY` is intentionally NOT auto-fixed (`fixType:
 * 'quickfix'` in the registry) — the cover alt has to be supplied by
 * the operator via the existing quick-fix UI; we don't fabricate alt
 * text.
 */

import JSZip from 'jszip';
import { logger } from '../../../../../lib/logger';

interface ChangeResult {
  success: boolean;
  description: string;
  before?: string;
  after?: string;
}

export async function fixDecorativeRole(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  const filePaths = Object.keys(zip.files);

  for (const filePath of filePaths) {
    if (!/\.(x?html?)$/i.test(filePath)) continue;
    const content = await zip.file(filePath)?.async('text');
    if (!content) continue;

    // Skip the cover XHTML entirely — its image's alt should be
    // non-empty (PRH-COVER-ALT-EMPTY); slapping role="presentation" on
    // it would actively work against that. The two PRH issues co-fire
    // on a non-compliant cover, but only the alt fix is correct.
    if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcover\b[^"']*["']/i.test(content)) {
      continue;
    }

    let touched = 0;
    const beforeSample: string[] = [];
    const afterSample: string[] = [];

    const updated = content.replace(/<img\b([^>]*)\/?>/gi, (match, attrs: string) => {
      // Must have alt="" (empty) — non-empty alt or absent alt is a
      // different class of issue handled elsewhere.
      const altMatch = attrs.match(/\balt\s*=\s*(["'])([^"']*)\1/i);
      if (!altMatch || altMatch[2].length > 0) return match;

      // Skip whenever ANY role attribute is already present — even a
      // non-presentation role like role="button". Inserting another
      // role attribute would produce duplicate attributes (invalid XML).
      // The validator likewise only fires when no role exists.
      if (/\brole\s*=\s*["'][^"']*["']/i.test(attrs)) {
        return match;
      }

      // Insert role="presentation" immediately after <img.
      touched++;
      const rewritten = match.replace(/<img\b/i, '<img role="presentation"');
      if (beforeSample.length < 3) {
        beforeSample.push(match);
        afterSample.push(rewritten);
      }
      return rewritten;
    });

    if (updated !== content && touched > 0) {
      zip.file(filePath, updated);
      logger.debug(`[PRH-DECORATIVE] ${filePath}: added role="presentation" to ${touched} image(s)`);
      results.push({
        success: true,
        description: `PRH-DECORATIVE-MISSING-PRESENTATION-ROLE: added role="presentation" to ${touched} decorative image(s) in ${filePath}`,
        before: beforeSample.join('\n'),
        after: afterSample.join('\n'),
      });
    }
  }

  if (results.length === 0) {
    results.push({
      success: true,
      description: 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE: every decorative image already declares role="presentation" (no change)',
    });
  }
  return results;
}
