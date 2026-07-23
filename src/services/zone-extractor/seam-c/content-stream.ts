// Seam C — Phase 2c core: content-stream MCID tagging.
//
// Nothing in the codebase writes marked content; this is the inverse of the
// read-side operator tracker in `tagged-pdf-extractor.ts`. Given a page's decoded
// content stream and a set of vertical zone BANDS (device space, bottom-left
// origin), it wraps each text object in `/<Tag> <</MCID n>> BDC … EMC`, assigns a
// unique MCID per contiguous same-zone run, and reports which MCID belongs to
// which zone so the caller can point a StructElem's /K at it.
//
// Scope (Phase-2 spike — simple, single-column PDFs):
//   · Assignment is by the text object's baseline Y falling inside a zone band.
//     Single-column zones stack vertically, so Y alone is robust; X is ignored.
//   · CTM and text matrices are assumed axis-aligned (no rotation/skew) — the
//     common case. Rotated pages are out of scope for the spike.
//   · Only text objects (BT…ET) are tagged. Non-text painting ops are left as-is
//     (fine for text-first documents); a later pass marks images/paths.

export interface ZoneBand {
  zoneIndex: number;
  /** device-space (bottom-left origin) vertical extent; yTop > yBottom. */
  yTop: number;
  yBottom: number;
  /** device-space horizontal extent (X is not Y-flipped): xLeft ≤ xRight. */
  xLeft: number;
  xRight: number;
  /** PDF tag for the BDC (e.g. 'P', 'H1'); artifacts use 'Artifact' with no MCID. */
  tag: string;
  isArtifact?: boolean;
}

export interface McidAssignment {
  mcid: number;
  zoneIndex: number;
}

export interface TagResult {
  content: string;
  assignments: McidAssignment[];
}

interface Token {
  /** number | string | hex | name | op | arr | dict | comment */
  t: 'n' | 's' | 'h' | 'name' | 'op' | '[' | ']' | '<<' | '>>' | 'c';
  v: string;
  start: number;
  end: number;
}

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isWs = (c: string): boolean => WS.has(c);
const isDelimOrWs = (c: string): boolean => c === undefined || WS.has(c) || DELIM.has(c);

/** Tokenize a content stream, preserving each token's source offsets. */
export function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    const start = i;
    if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      tokens.push({ t: 'c', v: s.slice(start, i), start, end: i });
    } else if (c === '(') {
      let depth = 0;
      do {
        const ch = s[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      } while (i < n && depth > 0);
      tokens.push({ t: 's', v: s.slice(start, i), start, end: i });
    } else if (c === '<' && s[i + 1] === '<') {
      i += 2; tokens.push({ t: '<<', v: '<<', start, end: i });
    } else if (c === '>' && s[i + 1] === '>') {
      i += 2; tokens.push({ t: '>>', v: '>>', start, end: i });
    } else if (c === '<') {
      i++; while (i < n && s[i] !== '>') i++; i++;
      tokens.push({ t: 'h', v: s.slice(start, i), start, end: i });
    } else if (c === '[') {
      i++; tokens.push({ t: '[', v: '[', start, end: i });
    } else if (c === ']') {
      i++; tokens.push({ t: ']', v: ']', start, end: i });
    } else if (c === '/') {
      i++; while (i < n && !isDelimOrWs(s[i])) i++;
      tokens.push({ t: 'name', v: s.slice(start, i), start, end: i });
    } else if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      i++; while (i < n && !isDelimOrWs(s[i])) i++;
      const v = s.slice(start, i);
      tokens.push({ t: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v) ? 'n' : 'op', v, start, end: i });
    } else {
      i++; while (i < n && !isDelimOrWs(s[i])) i++;
      tokens.push({ t: 'op', v: s.slice(start, i), start, end: i });
    }
  }
  return tokens;
}

const num = (t: Token | undefined): number => (t && t.t === 'n' ? parseFloat(t.v) : 0);

/**
 * Tag the text objects of a content stream with MCID marked content.
 * @param content decoded content stream text
 * @param bands   device-space vertical zone bands (bottom-left origin)
 * @param startMcid first MCID to allocate (unique per page)
 */
export function tagContentStream(content: string, bands: ZoneBand[], startMcid = 0): TagResult {
  const tokens = tokenize(content);

  // Walk tokens; for each BT…ET object compute the baseline Y of its first shown
  // text, and record the object's [start,end] offsets + assigned zone band.
  interface Unit { start: number; end: number; band: ZoneBand | null; }
  const units: Unit[] = [];

  // graphics + text state (axis-aligned assumption: track x/y scale + translate)
  type Ctm = { a: number; d: number; e: number; f: number };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];
  let inText = false;
  let btStart = -1;
  let tld = 0;               // text leading (TL)
  let tmE = 0;               // text matrix e (x, text space)
  let tmF = 0;               // text matrix f (baseline y, text space)
  let firstX: number | null = null;
  let firstY: number | null = null;
  const operands: Token[] = [];

  const deviceX = (tE: number): number => ctm.a * tE + ctm.e;
  const deviceY = (tF: number): number => ctm.d * tF + ctm.f;

  // Full-bbox assignment: a text object's first-shown anchor (x, baseline y) must
  // fall inside a zone's 2-D box; else the nearest zone within tolerance. The X test
  // separates columns — baseline-Y alone can't tell a left-column line from a
  // right-column line at the same height.
  const NEAREST_TOL = 12;
  const regionFor = (x: number, y: number): ZoneBand | null => {
    for (const b of bands) {
      if (x >= b.xLeft && x <= b.xRight && y <= b.yTop && y >= b.yBottom) return b;
    }
    let best: ZoneBand | null = null;
    let bestDist = Infinity;
    for (const b of bands) {
      const dx = x < b.xLeft ? b.xLeft - x : x > b.xRight ? x - b.xRight : 0;
      const dy = y > b.yTop ? y - b.yTop : y < b.yBottom ? b.yBottom - y : 0;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = b; }
    }
    return bestDist <= NEAREST_TOL ? best : null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;
    switch (op) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = { ...p }; break; }
      case 'cm': {
        // a b c d e f cm — compose (axis-aligned)
        const a = num(operands[operands.length - 6]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        ctm = { a: ctm.a * a, d: ctm.d * d, e: ctm.a * e + ctm.e, f: ctm.d * f + ctm.f };
        break;
      }
      case 'BT': inText = true; btStart = tk.start; tmE = 0; tmF = 0; firstX = null; firstY = null; break;
      case 'TL': tld = num(operands[operands.length - 1]); break;
      case 'Td': case 'TD': {
        const tx = num(operands[operands.length - 2]);
        const ty = num(operands[operands.length - 1]);
        if (op === 'TD') tld = -ty;
        tmE += tx;
        tmF += ty;
        break;
      }
      case 'Tm':                                                   // a b c d e f
        tmE = num(operands[operands.length - 2]);
        tmF = num(operands[operands.length - 1]);
        break;
      case 'T*': tmF -= tld; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        if (op === "'" || op === '"') tmF -= tld;   // these move to the next line first
        if (firstY === null) { firstX = deviceX(tmE); firstY = deviceY(tmF); }
        break;
      }
      case 'ET': {
        if (inText) {
          const band = firstY === null ? null : regionFor(firstX as number, firstY);
          units.push({ start: btStart, end: tk.end, band });
        }
        inText = false; btStart = -1;
        break;
      }
      default: break;
    }
    operands.length = 0;
  }

  // Merge consecutive same-zone units → one MCID per run. Build offset insertions.
  interface Insertion { offset: number; text: string; }
  const insertions: Insertion[] = [];
  const assignments: McidAssignment[] = [];
  let mcid = startMcid;
  let run: { band: ZoneBand; startOffset: number; endOffset: number } | null = null;

  const closeRun = (): void => {
    if (!run) return;
    if (run.band.isArtifact) {
      // BMC (not BDC): a bare tag with no property list. `/Artifact BDC` makes a
      // validator look up /Artifact in /Properties → "Undefined property" (veraPDF).
      insertions.push({ offset: run.startOffset, text: `/Artifact BMC ` });
    } else {
      insertions.push({ offset: run.startOffset, text: `/${run.band.tag} <</MCID ${mcid}>> BDC ` });
      assignments.push({ mcid, zoneIndex: run.band.zoneIndex });
      mcid++;
    }
    insertions.push({ offset: run.endOffset, text: ` EMC ` });
    run = null;
  };

  // Text in no zone is still marked /Artifact — untagged content fails PDF/UA.
  const ARTIFACT: ZoneBand = { zoneIndex: -1, tag: 'Artifact', isArtifact: true, yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
  for (const u of units) {
    const band = u.band ?? ARTIFACT;
    if (run && run.band.zoneIndex === band.zoneIndex && !!run.band.isArtifact === !!band.isArtifact) {
      run.endOffset = u.end;                 // extend current run
    } else {
      closeRun();
      run = { band, startOffset: u.start, endOffset: u.end };
    }
  }
  closeRun();

  // Apply insertions right-to-left so offsets stay valid.
  insertions.sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const ins of insertions) out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);

  return { content: out, assignments };
}
