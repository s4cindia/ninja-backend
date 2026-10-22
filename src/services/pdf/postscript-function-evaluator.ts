/**
 * PostScript Calculator Function Evaluator (PDF Function Type 4)
 *
 * PDF32000-1:2008 §7.10.5 -- used by DeviceN/Separation colorspaces' own
 * tint-transform functions to map a tint value (or N tint values, for
 * DeviceN) to the colorspace's alternate space (e.g. DeviceCMYK). Needed by
 * pdf-contrast-writer.service.ts's resolveSourceColor to determine the real
 * color a `scn` operator sets when the active colorspace is Separation or
 * DeviceN with a Type 4 tint-transform -- confirmed the dominant real-world
 * case on Math_Olszewski_PDF.pdf (377 DeviceN colorspace occurrences, all
 * Type 4), traced directly from the real color-contrast apply failures:
 * "Could not determine the color to restore after this fix (nearest
 * preceding color op has an untracked colorspace)".
 *
 * Strict by design, same "bail rather than guess" discipline as the rest of
 * the color-contrast fix pipeline: returns null (never throws) on anything
 * malformed or unsupported -- unbalanced braces, an unrecognized operator, a
 * stack underflow/type mismatch, a non-finite result. A wrong color is worse
 * than no fix at all (confirmed live, Math_Weir_PDF.pdf: a bad restore color
 * silently leaked into unrelated later text and registered as brand-new
 * contrast regressions).
 */

type StackVal = number | boolean | Tok[];
type Tok =
  | { kind: 'num'; value: number }
  | { kind: 'op'; name: string }
  | { kind: 'proc'; body: Tok[] };

const MAX_STEPS = 10_000;

/**
 * Tokenizes a Type 4 function's program text into a flat stream, including
 * `{`/`}` as their own tokens -- parseBody below turns nested `{...}` into
 * proc literals.
 */
function tokenize(program: string): string[] {
  return program.match(/[{}]|[^\s{}]+/g) ?? [];
}

/**
 * Parses a brace-delimited body into a Tok[] -- a nested `{...}` becomes a
 * single 'proc' token (not executed immediately; if/ifelse later pop and
 * run it), consistent with how PostScript procedures are pushed as values.
 * `pos` is mutated via the returned index so the caller can continue past
 * this body's closing brace. Returns null on unbalanced braces or an
 * unparseable number-looking token.
 */
function parseBody(tokens: string[], pos: number): { body: Tok[]; next: number } | null {
  const body: Tok[] = [];
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t === '}') {
      return { body, next: pos + 1 };
    }
    if (t === '{') {
      const inner = parseBody(tokens, pos + 1);
      if (!inner) return null;
      body.push({ kind: 'proc', body: inner.body });
      pos = inner.next;
      continue;
    }
    const num = Number(t);
    if (t !== '' && !Number.isNaN(num) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) {
      body.push({ kind: 'num', value: num });
    } else {
      body.push({ kind: 'op', name: t });
    }
    pos++;
  }
  // Ran off the end without a closing '}' for this body.
  return null;
}

/** Parses the whole program (expects a single outer `{ ... }`). */
function parseProgram(program: string): Tok[] | null {
  const tokens = tokenize(program);
  if (tokens.length === 0 || tokens[0] !== '{') return null;
  const parsed = parseBody(tokens, 1);
  if (!parsed) return null;
  // Tolerate (ignore) anything after the outer closing brace -- some
  // generators emit trailing whitespace/garbage past it.
  return parsed.body;
}

function popNum(stack: StackVal[]): number | null {
  const v = stack.pop();
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function popBool(stack: StackVal[]): boolean | null {
  const v = stack.pop();
  return typeof v === 'boolean' ? v : null;
}
function popProc(stack: StackVal[]): Tok[] | null {
  const v = stack.pop();
  return Array.isArray(v) ? v : null;
}
function popInt(stack: StackVal[]): number | null {
  const n = popNum(stack);
  return n === null ? null : Math.trunc(n);
}

function rollStack(stack: StackVal[], n: number, j: number): boolean {
  if (n < 0 || n > stack.length) return false;
  if (n === 0) return true;
  const slice = stack.splice(stack.length - n, n);
  const jNorm = ((j % n) + n) % n;
  const rotated = slice.map((_, i) => slice[(i - jNorm + n) % n]);
  stack.push(...rotated);
  return true;
}

/** True if run() can continue; false signals a failure the caller should bail on. */
function runOp(name: string, stack: StackVal[], steps: { n: number }): boolean {
  steps.n++;
  if (steps.n > MAX_STEPS) return false;

  switch (name) {
    case 'add': case 'sub': case 'mul': case 'div': {
      const b = popNum(stack); const a = popNum(stack);
      if (a === null || b === null) return false;
      if (name === 'div' && b === 0) return false;
      const r = name === 'add' ? a + b : name === 'sub' ? a - b : name === 'mul' ? a * b : a / b;
      stack.push(r);
      return true;
    }
    case 'idiv': case 'mod': {
      const b = popInt(stack); const a = popInt(stack);
      if (a === null || b === null || b === 0) return false;
      stack.push(name === 'idiv' ? Math.trunc(a / b) : a % b);
      return true;
    }
    case 'neg': { const a = popNum(stack); if (a === null) return false; stack.push(-a); return true; }
    case 'abs': { const a = popNum(stack); if (a === null) return false; stack.push(Math.abs(a)); return true; }
    case 'sqrt': { const a = popNum(stack); if (a === null || a < 0) return false; stack.push(Math.sqrt(a)); return true; }
    case 'ceiling': { const a = popNum(stack); if (a === null) return false; stack.push(Math.ceil(a)); return true; }
    case 'floor': { const a = popNum(stack); if (a === null) return false; stack.push(Math.floor(a)); return true; }
    case 'round': { const a = popNum(stack); if (a === null) return false; stack.push(Math.sign(a) * Math.round(Math.abs(a))); return true; }
    case 'truncate': case 'cvi': { const a = popNum(stack); if (a === null) return false; stack.push(Math.trunc(a)); return true; }
    case 'cvr': { const a = popNum(stack); if (a === null) return false; stack.push(a); return true; }
    case 'exp': {
      const exponent = popNum(stack); const base = popNum(stack);
      if (base === null || exponent === null) return false;
      const r = Math.pow(base, exponent);
      if (!Number.isFinite(r)) return false;
      stack.push(r);
      return true;
    }
    case 'ln': { const a = popNum(stack); if (a === null || a <= 0) return false; stack.push(Math.log(a)); return true; }
    case 'log': { const a = popNum(stack); if (a === null || a <= 0) return false; stack.push(Math.log10(a)); return true; }
    case 'sin': { const a = popNum(stack); if (a === null) return false; stack.push(Math.sin(a * Math.PI / 180)); return true; }
    case 'cos': { const a = popNum(stack); if (a === null) return false; stack.push(Math.cos(a * Math.PI / 180)); return true; }
    case 'atan': {
      const den = popNum(stack); const num = popNum(stack);
      if (num === null || den === null) return false;
      let deg = Math.atan2(num, den) * 180 / Math.PI;
      if (deg < 0) deg += 360;
      stack.push(deg);
      return true;
    }
    case 'eq': case 'ne': case 'gt': case 'ge': case 'lt': case 'le': {
      const b = popNum(stack); const a = popNum(stack);
      if (a === null || b === null) return false;
      const r = name === 'eq' ? a === b : name === 'ne' ? a !== b
        : name === 'gt' ? a > b : name === 'ge' ? a >= b
          : name === 'lt' ? a < b : a <= b;
      stack.push(r);
      return true;
    }
    case 'and': case 'or': case 'xor': {
      const top = stack[stack.length - 1];
      if (typeof top === 'boolean') {
        const b = popBool(stack); const a = popBool(stack);
        if (a === null || b === null) return false;
        stack.push(name === 'and' ? (a && b) : name === 'or' ? (a || b) : (a !== b));
      } else {
        const b = popInt(stack); const a = popInt(stack);
        if (a === null || b === null) return false;
         
        stack.push(name === 'and' ? (a & b) : name === 'or' ? (a | b) : (a ^ b));
      }
      return true;
    }
    case 'not': {
      const top = stack[stack.length - 1];
      if (typeof top === 'boolean') {
        const a = popBool(stack); if (a === null) return false;
        stack.push(!a);
      } else {
        const a = popInt(stack); if (a === null) return false;
         
        stack.push(~a);
      }
      return true;
    }
    case 'bitshift': {
      const shift = popInt(stack); const a = popInt(stack);
      if (a === null || shift === null) return false;
       
      stack.push(shift >= 0 ? (a << shift) : (a >> -shift));
      return true;
    }
    case 'true': stack.push(true); return true;
    case 'false': stack.push(false); return true;
    case 'pop': return stack.pop() !== undefined;
    case 'exch': {
      if (stack.length < 2) return false;
      const b = stack.pop()!; const a = stack.pop()!;
      stack.push(b, a);
      return true;
    }
    case 'dup': {
      if (stack.length < 1) return false;
      stack.push(stack[stack.length - 1]);
      return true;
    }
    case 'copy': {
      const n = popInt(stack);
      if (n === null || n < 0 || n > stack.length) return false;
      stack.push(...stack.slice(stack.length - n));
      return true;
    }
    case 'index': {
      const n = popInt(stack);
      if (n === null || n < 0 || n >= stack.length) return false;
      stack.push(stack[stack.length - 1 - n]);
      return true;
    }
    case 'roll': {
      const j = popInt(stack); const n = popInt(stack);
      if (j === null || n === null) return false;
      return rollStack(stack, n, j);
    }
    case 'if': {
      const proc = popProc(stack); const cond = popBool(stack);
      if (proc === null || cond === null) return false;
      return cond ? run(proc, stack, steps) : true;
    }
    case 'ifelse': {
      const proc2 = popProc(stack); const proc1 = popProc(stack); const cond = popBool(stack);
      if (proc1 === null || proc2 === null || cond === null) return false;
      return run(cond ? proc1 : proc2, stack, steps);
    }
    default:
      return false;
  }
}

function run(body: Tok[], stack: StackVal[], steps: { n: number }): boolean {
  for (const tok of body) {
    if (tok.kind === 'num') {
      stack.push(tok.value);
    } else if (tok.kind === 'proc') {
      stack.push(tok.body);
    } else {
      if (!runOp(tok.name, stack, steps)) return false;
    }
  }
  return true;
}

/**
 * Evaluates a PDF Type 4 (PostScript calculator) function. `program` is the
 * function stream's own decoded text (the outer `{ ... }` included).
 * `domain`/`range` are the function dict's own /Domain and /Range arrays
 * (flat [min0, max0, min1, max1, ...] pairs). Inputs are clipped to domain
 * before running; outputs are clipped to range after. Returns null (not a
 * throw) for a malformed program, a domain/input length mismatch, a runtime
 * stack error, or an output count that doesn't match range's own arity.
 */
export function evaluatePostScriptFunction(
  program: string,
  inputs: number[],
  domain: number[],
  range: number[]
): number[] | null {
  if (domain.length !== inputs.length * 2 || range.length % 2 !== 0) return null;

  const body = parseProgram(program);
  if (!body) return null;

  const clippedInputs = inputs.map((v, i) => {
    const lo = domain[2 * i]; const hi = domain[2 * i + 1];
    return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi));
  });

  const stack: StackVal[] = [...clippedInputs];
  const steps = { n: 0 };
  if (!run(body, stack, steps)) return null;

  const outputCount = range.length / 2;
  if (stack.length < outputCount) return null;
  const outputs = stack.slice(stack.length - outputCount);
  if (!outputs.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) return null;

  return outputs.map((v, i) => {
    const lo = range[2 * i]; const hi = range[2 * i + 1];
    return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi));
  });
}
