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
    // whitespace before `lang` to disambiguate.
    const langMatch = attrs.match(/(?:^|\s)lang\s*=\s*(["'])([^"']*)\1/i);
    const xmlLangMatch = attrs.match(/\bxml:lang\s*=\s*(["'])([^"']*)\1/i);

    const langValue = langMatch?.[2] ?? null;
    const xmlLangValue = xmlLangMatch?.[2] ?? null;

    if (langValue && xmlLangValue) {
      alreadyOk++;
      continue;
    }

    // Decide the language code: prefer existing lang, else xml:lang, else default.
    const language = langValue ?? xmlLangValue ?? defaultLanguage;
    let newAttrs = attrs;
    if (!langMatch) {
      newAttrs = `${newAttrs} lang="${language}"`;
    }
    if (!xmlLangMatch) {
      newAttrs = `${newAttrs} xml:lang="${language}"`;
    }
    const updated = content.replace(/<html\b[^>]*>/i, `<html${newAttrs}>`);
    if (updated !== content) {
      zip.file(filePath, updated);
      touched++;
      logger.debug(`[PRH-XHTML-XML-LANG] ${filePath}: added ${[!langMatch && 'lang', !xmlLangMatch && 'xml:lang'].filter(Boolean).join(' + ')}`);
    }
  }

  if (touched === 0) {
    results.push({
      success: true,
      description: `PRH-XHTML-XML-LANG: all XHTML files already carry both lang and xml:lang (${alreadyOk} files inspected)`,
    });
  } else {
    results.push({
      success: true,
      description: `PRH-XHTML-XML-LANG: added missing lang/xml:lang to ${touched} XHTML file(s); ${alreadyOk} were already compliant`,
    });
  }
  return results;
}
