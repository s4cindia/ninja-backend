import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        'dist/'
      ]
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    // Real CI-only bug (2026-11-24, see git log): @napi-rs/canvas's
    // font-name resolution doesn't fall back for a generic alias
    // ("sans-serif") or an uninstalled standard name ("Helvetica",
    // "Arial") on Linux -- it draws nothing, not even a fallback glyph.
    // canvas-fonts.ts registers the same alias mapping
    // src/lib/canvas-font-aliases.ts's ensureCanvasFontAliases() sets up
    // for the real app, so any test that renders a PDF page (contrast
    // detection/verification) gets the same working fonts.
    setupFiles: ['./tests/setup/canvas-fonts.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
