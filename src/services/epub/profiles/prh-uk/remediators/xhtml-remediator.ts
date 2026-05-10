/**
 * PRH UK per-XHTML remediators.
 *
 * Currently exposes one fix: `fixXmlLang` ensures every `<html>` element
 * carries BOTH `lang` and `xml:lang`. The existing
 * `epub-modifier.service.ts:addHtmlLangAttributes` short-circuits whenever
 * `lang` alone is present, so it cannot upgrade a file from
 * `<html lang="en">` to `<html lang="en" xml:lang="en">` — which is what
 * the PRH Technical Guide requires (`<html ... lang="en" xml:lang="en">`).
 *
 * The fix is idempotent: when both attributes are already present, the
 * file is left untouched.
 */

import JSZip from 'jszip';
import { logger } from '../../../../../lib/logger';

interface ChangeResult {
  success: boolean;
  description: string;
  before?: string;
  after?: string;
}

/**
 * Walk every XHTML/HTML file in the EPUB, ensuring `<html>` has both
 * `lang` and `xml:lang` attributes. Defaults to `"en"` if neither is
 * present (PRH books are English-language unless explicitly translated;
 * the Style Guide doesn't define a way to derive language from OPF for
 * this fix). When one attribute is present and the other is missing,
 * the existing value is reused so we don't drift the language code.
 */
export async function fixXmlLang(zip: JSZip, defaultLanguage: string = 'en'): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  const filePaths = Object.keys(zip.files);
  let touched = 0;
  let alreadyOk = 0;

  for (const filePath of filePaths) {
    if (!/\.(x?html?)$/i.test(filePath)) continue;

    const content = await zip.file(filePath)?.async('text');
    if (!content) continue;

    const htmlMatch = content.match(/<html\b([^>]*)>/i);
    if (!htmlMatch) continue;

    const attrs = htmlMatch[1];
    // Same regex caveat as the validator: `\blang` matches inside `xml:lang`
    // because the colon is a word boundary. Require start-of-attrs or
    // whitespace before `lang` to disambiguate. We capture the value to
    // detect empty attributes (`lang=""`) which need replacement, not
    // insertion — they're "present but invalid" per the validator.
    const langMatch = attrs.match(/(?:^|\s)lang\s*=\s*(["'])([^"']*)\1/i);
    const xmlLangMatch = attrs.match(/\bxml:lang\s*=\s*(["'])([^"']*)\1/i);

    const langValue = langMatch?.[2] ?? null;
    const xmlLangValue = xmlLangMatch?.[2] ?? null;
    // "Present and non-empty" — anything else (missing or empty string) is
    // treated as needing a fix.
    const hasGoodLang = langValue !== null && langValue.length > 0;
    const hasGoodXmlLang = xmlLangValue !== null && xmlLangValue.length > 0;

    if (hasGoodLang && hasGoodXmlLang) {
      alreadyOk++;
      continue;
    }

    // Decide the language code: prefer existing non-empty lang, else
    // existing non-empty xml:lang, else default.
    const language = (hasGoodLang ? langValue : null)
      ?? (hasGoodXmlLang ? xmlLangValue : null)
      ?? defaultLanguage;

    let newAttrs = attrs;
    if (!hasGoodLang) {
      if (langMatch) {
        // Replace the existing empty lang="" with the correct value.
        newAttrs = newAttrs.replace(/(?:^|\s)lang\s*=\s*(["'])([^"']*)\1/i, ` lang="${language}"`);
      } else {
        newAttrs = `${newAttrs} lang="${language}"`;
      }
    }
    if (!hasGoodXmlLang) {
      if (xmlLangMatch) {
        newAttrs = newAttrs.replace(/\bxml:lang\s*=\s*(["'])([^"']*)\1/i, `xml:lang="${language}"`);
      } else {
        newAttrs = `${newAttrs} xml:lang="${language}"`;
      }
    }
    const updated = content.replace(/<html\b[^>]*>/i, `<html${newAttrs}>`);
    if (updated !== content) {
      zip.file(filePath, updated);
      touched++;
      const actions: string[] = [];
      if (!hasGoodLang) actions.push(langMatch ? 'replaced empty lang' : 'added lang');
      if (!hasGoodXmlLang) actions.push(xmlLangMatch ? 'replaced empty xml:lang' : 'added xml:lang');
      logger.debug(`[PRH-XHTML-XML-LANG] ${filePath}: ${actions.join(' + ')}`);
      // Record one ChangeResult per touched file so the caller can map
      // task completion back to a specific XHTML — important for the
      // remediation service's per-task completion accounting.
      results.push({
        success: true,
        description: `PRH-XHTML-XML-LANG: ${actions.join(' + ')} in ${filePath}`,
        before: htmlMatch[0],
        after: `<html${newAttrs}>`,
      });
    }
  }

  if (results.length === 0) {
    // Nothing to fix — emit a single informational entry so the caller's
    // success/skip accounting still records the no-op.
    results.push({
      success: true,
      description: `PRH-XHTML-XML-LANG: all XHTML files already carry both lang and xml:lang (${alreadyOk} files inspected)`,
    });
  }
  // Otherwise: one ChangeResult per touched file is already accumulated.
  void touched;
  return results;
}
