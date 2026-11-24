// See src/lib/canvas-font-aliases.ts's doc comment -- without this, any
// test that renders a PDF page via @napi-rs/canvas (contrast detection/
// verification, page-render-crop) gets a blank canvas on Linux CI.
import { ensureCanvasFontAliases } from '../../src/lib/canvas-font-aliases';

ensureCanvasFontAliases();
