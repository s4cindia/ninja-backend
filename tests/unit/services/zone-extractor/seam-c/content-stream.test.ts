import { describe, it, expect } from 'vitest';
import { tokenize, tagContentStream, type ZoneBand } from '../../../../../src/services/zone-extractor/seam-c/content-stream';

// The exact shape pdf-lib emits (verified via PoC): each drawText → q BT … Tm … Tj … ET Q
const twoLineStream = `q
BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 150 Tm
<48656C6C6F> Tj
T*
ET
Q
q
BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 120 Tm
<5365636F6E64> Tj
T*
ET
Q
`;

describe('tokenize', () => {
  it('classifies numbers, names, hex strings and operators with offsets', () => {
    const toks = tokenize('1 0 0 1 50 150 Tm\n<48> Tj');
    expect(toks.filter((t) => t.t === 'n').map((t) => t.v)).toEqual(['1', '0', '0', '1', '50', '150']);
    expect(toks.find((t) => t.t === 'op' && t.v === 'Tm')).toBeTruthy();
    expect(toks.find((t) => t.t === 'h')?.v).toBe('<48>');
    const tj = toks.find((t) => t.v === 'Tj')!;
    expect('1 0 0 1 50 150 Tm\n<48> Tj'.slice(tj.start, tj.end)).toBe('Tj');
  });

  it('handles string literals with nested parens and escapes', () => {
    const toks = tokenize('(a\\(b) Tj');
    expect(toks[0].t).toBe('s');
    expect(toks[0].v).toBe('(a\\(b)');
  });

  it('distinguishes negative numbers from operators', () => {
    const toks = tokenize('-12.5 0 Td');
    expect(toks[0]).toMatchObject({ t: 'n', v: '-12.5' });
    expect(toks[2]).toMatchObject({ t: 'op', v: 'Td' });
  });
});

describe('tagContentStream', () => {
  // page height 200; two zones stacked. Line 1 baseline y=150, line 2 y=120.
  const bands: ZoneBand[] = [
    { zoneIndex: 0, yTop: 165, yBottom: 140, xLeft: 0, xRight: 1000, tag: 'H1' },   // contains y=150
    { zoneIndex: 1, yTop: 135, yBottom: 100, xLeft: 0, xRight: 1000, tag: 'P' },    // contains y=120
  ];

  it('wraps each text object in its zone tag with a unique MCID', () => {
    const { content, assignments } = tagContentStream(twoLineStream, bands);
    expect(content).toContain('/H1 <</MCID 0>> BDC');
    expect(content).toContain('/P <</MCID 1>> BDC');
    expect((content.match(/EMC/g) || []).length).toBe(2);
    expect(assignments).toEqual([
      { mcid: 0, zoneIndex: 0 },
      { mcid: 1, zoneIndex: 1 },
    ]);
  });

  it('keeps the original text content intact', () => {
    const { content } = tagContentStream(twoLineStream, bands);
    expect(content).toContain('<48656C6C6F> Tj');
    expect(content).toContain('<5365636F6E64> Tj');
    // BDC precedes the BT it wraps
    expect(content.indexOf('/H1 <</MCID 0>> BDC')).toBeLessThan(content.indexOf('<48656C6C6F>'));
  });

  it('merges consecutive same-zone text objects under one MCID', () => {
    // both lines fall in one wide band
    const oneBand: ZoneBand[] = [{ zoneIndex: 0, yTop: 165, yBottom: 100, xLeft: 0, xRight: 1000, tag: 'P' }];
    const { content, assignments } = tagContentStream(twoLineStream, oneBand);
    expect(assignments).toEqual([{ mcid: 0, zoneIndex: 0 }]);
    expect((content.match(/BDC/g) || []).length).toBe(1);
    expect((content.match(/EMC/g) || []).length).toBe(1);
  });

  it('marks text with no matching zone as Artifact (no MCID)', () => {
    const { content, assignments } = tagContentStream(twoLineStream, [
      { zoneIndex: 0, yTop: 999, yBottom: 900, xLeft: 0, xRight: 1000, tag: 'P' }, // matches neither line
    ]);
    expect(assignments).toEqual([]);
    expect(content).toContain('/Artifact BMC');
    expect(content).not.toContain('MCID');
  });

  it('allocates MCIDs from startMcid', () => {
    const { assignments } = tagContentStream(twoLineStream, bands, 5);
    expect(assignments.map((a) => a.mcid)).toEqual([5, 6]);
  });

  it('respects an artifact band (header/footer) with no MCID', () => {
    const { content, assignments } = tagContentStream(twoLineStream, [
      { zoneIndex: 0, yTop: 165, yBottom: 140, xLeft: 0, xRight: 1000, tag: 'Artifact', isArtifact: true },
      { zoneIndex: 1, yTop: 135, yBottom: 100, xLeft: 0, xRight: 1000, tag: 'P' },
    ]);
    expect(content).toContain('/Artifact BMC');
    expect(content).toContain('/P <</MCID 0>> BDC');
    expect(assignments).toEqual([{ mcid: 0, zoneIndex: 1 }]);
  });

  it('separates columns by X — two lines at the same Y go to different zones', () => {
    // left line at x=50, right line at x=350, both baseline y=150
    const twoCol = 'q BT 1 0 0 1 50 150 Tm <4C> Tj ET Q\nq BT 1 0 0 1 350 150 Tm <52> Tj ET Q\n';
    const colBands: ZoneBand[] = [
      { zoneIndex: 0, yTop: 160, yBottom: 140, xLeft: 30, xRight: 250, tag: 'P' },   // left column
      { zoneIndex: 1, yTop: 160, yBottom: 140, xLeft: 300, xRight: 520, tag: 'P' },  // right column, same Y
    ];
    const { assignments } = tagContentStream(twoCol, colBands);
    // baseline-Y alone would put both in zone 0; the X test splits them
    expect(assignments).toEqual([
      { mcid: 0, zoneIndex: 0 },
      { mcid: 1, zoneIndex: 1 },
    ]);
  });
});
