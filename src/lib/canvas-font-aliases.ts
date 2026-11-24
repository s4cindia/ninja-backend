/**
 * Real bug, found live via CI investigation (2026-11-24, see git log): on
 * Linux, @napi-rs/canvas's font-name resolution does not fall back for a
 * generic CSS alias ("sans-serif") or a standard PDF base-14 font name
 * that isn't a LITERAL installed family ("Helvetica", "Arial", "Times",
 * "Courier") -- it draws nothing at all, not even a fallback glyph.
 * Confirmed directly: fillText with "sans-serif"/"Arial"/"Helvetica"
 * rendered a completely blank canvas on Linux; fillText with the exact
 * installed family name "Liberation Sans" rendered correctly. This is not
 * Windows-specific or CI-specific -- production also runs on Linux (ECS
 * Fargate), and the production Dockerfile installed no font package at
 * all, so any real document whose contrast-checked text uses a
 * non-embedded standard font (extremely common -- any PDF using the
 * base-14 fonts without embedding them) would render blank in
 * color-contrast-verification.ts / pdf-contrast.validator.ts on the real
 * backend, not just in tests.
 *
 * Fix: alias every standard PDF base-14 family name (and the generic CSS
 * aliases pdfjs-dist's own font substitution can also request) to the
 * metric-compatible Liberation font family the Dockerfile now installs
 * (see Dockerfile's apt-get list). GlobalFonts.setAlias(fontName, alias)
 * requires fontName to be an EXISTING installed family -- it becomes
 * ALSO reachable under `alias` -- confirmed via real CI runs that the
 * reverse order always returns false, since "Helvetica" etc. were never
 * going to exist as a literal family to alias FROM. Harmlessly returns
 * false on Windows (no Liberation fonts there), where this fix was never
 * needed -- only logged, never thrown.
 */
import { GlobalFonts } from '@napi-rs/canvas';
import { logger } from './logger';

let registered = false;

const ALIASES: Record<string, string> = {
  Helvetica: 'Liberation Sans',
  'Helvetica-Bold': 'Liberation Sans',
  'Helvetica-Oblique': 'Liberation Sans',
  'Helvetica-BoldOblique': 'Liberation Sans',
  Arial: 'Liberation Sans',
  'sans-serif': 'Liberation Sans',
  Times: 'Liberation Serif',
  'Times-Roman': 'Liberation Serif',
  'Times-Bold': 'Liberation Serif',
  'Times-Italic': 'Liberation Serif',
  'Times New Roman': 'Liberation Serif',
  serif: 'Liberation Serif',
  Courier: 'Liberation Mono',
  'Courier-Bold': 'Liberation Mono',
  'Courier New': 'Liberation Mono',
  monospace: 'Liberation Mono',
};

export function ensureCanvasFontAliases(): void {
  if (registered) return;
  for (const [alias, target] of Object.entries(ALIASES)) {
    const ok = GlobalFonts.setAlias(target, alias);
    if (!ok) {
      logger.warn(`[canvas-font-aliases] setAlias(${target}, ${alias}) failed -- ${target} isn't installed on this host`);
    }
  }
  registered = true;
}
