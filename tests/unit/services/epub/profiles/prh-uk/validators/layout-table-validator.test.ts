import { describe, it, expect } from 'vitest';
import { validatePrhLayoutTables } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/layout-table-validator';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function input(xhtmlFiles: PrhXhtmlFile[]) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test',
    xhtmlFiles,
  };
}

function file(path: string, body: string): PrhXhtmlFile {
  return {
    path,
    content: `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>x</title></head>
<body epub:type="bodymatter">${body}</body>
</html>`,
  };
}

/** Build a <table> with `cells` <td> entries (no <th>). */
function layoutTable(cells: number, openAttrs: string = ''): string {
  const rows: string[] = [];
  for (let i = 0; i < cells; i += 1) rows.push('<td>cell</td>');
  return `<table${openAttrs}><tbody><tr>${rows.join('')}</tr></tbody></table>`;
}

describe('validatePrhLayoutTables', () => {
  it('emits zero issues for a data table with <th>', () => {
    const body = '<table><thead><tr><th scope="col">A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr></tbody></table>';
    const files = [file('ch.xhtml', body)];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });

  it('emits zero issues for a layout table that declares role="presentation"', () => {
    const files = [file('dialogue.xhtml', layoutTable(6, ' role="presentation"'))];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });

  it('emits zero issues for a layout table with role="none" (ARIA synonym)', () => {
    const files = [file('dialogue.xhtml', layoutTable(6, ' role="none"'))];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });

  it('emits PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION for a 6-cell no-<th>, no-role table', () => {
    const files = [file('ch.xhtml', layoutTable(6))];
    const issues = validatePrhLayoutTables(input(files));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION');
    expect(issues[0].location).toBe('ch.xhtml');
    expect(issues[0].message).toMatch(/6 cells/);
  });

  it('does NOT fire on small no-<th> tables (<6 cells — likely intentional)', () => {
    const files = [file('ch.xhtml', layoutTable(3))];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });

  it('detects multiple offending tables in the same file independently', () => {
    const body = layoutTable(6) + '<p>between</p>' + layoutTable(8);
    const files = [file('ch.xhtml', body)];
    const issues = validatePrhLayoutTables(input(files));
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toMatch(/table #1/);
    expect(issues[1].message).toMatch(/table #2/);
  });

  it('handles multi-value role attribute ("presentation region") correctly', () => {
    const files = [file('ch.xhtml', layoutTable(6, ' role="presentation region"'))];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });

  it('uses cell count from <td> only (ignores <th> in case of mixed tables)', () => {
    // A table with <th> AND ≥6 <td> is treated as a data table — we
    // SKIP it because <th> means semantic content is present.
    const body = '<table><tr><th>H</th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr></table>';
    const files = [file('ch.xhtml', body)];
    expect(validatePrhLayoutTables(input(files))).toEqual([]);
  });
});
