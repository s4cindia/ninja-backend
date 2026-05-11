import { describe, it, expect } from 'vitest';
import { validatePrhCopyrightContent } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/copyright-content-validator';
import { getImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints';
import type { PrhXhtmlFile } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';
import type { ImprintRules } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/_types';

/** Build the PRH-compliant adult copyright page text (one Penguin example). */
function compliantAdultCopyrightXhtml(): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Copyright</title></head>
<body epub:type="frontmatter">
<section epub:type="copyright-page" class="copyright_page_left">
<p>PENGUIN BOOKS</p>
<p>UK | USA | Canada | Ireland | Australia | New Zealand | India | South Africa</p>
<p>Penguin Books is part of the Penguin Random House group of companies whose addresses can be found at global.penguinrandomhouse.com.</p>
<p><a href="http://www.penguin.co.uk">www.penguin.co.uk</a></p>
<figure class="copyright_logo"><img src="prh_core_assets/images/prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
<p>First published by Penguin Books in 2026</p>
<p>Copyright &#169; Author Name, 2026</p>
<p>The moral right of the author has been asserted</p>
<p>ISBN: 978-1-234-56789-0</p>
<p>Penguin Random House values and supports copyright. Copyright fuels creativity, encourages diverse voices, promotes freedom of expression and supports a vibrant culture. Thank you for purchasing an authorized edition of this book and for respecting intellectual property laws by not reproducing, scanning or distributing any part of it by any means without permission. You are supporting authors and enabling Penguin Random House to continue to publish books for everyone. No part of this book may be used or reproduced in any manner for the purpose of training artificial intelligence technologies or systems. In accordance with Article 4(3) of the DSM Directive 2019/790, Penguin Random House expressly reserves this work from the text and data mining exception.</p>
<p>The authorized representative in the EEA is Penguin Random House Ireland, Morrison Chambers, 32 Nassau Street, Dublin D02 YH68</p>
<p>A CIP catalogue record for this book is available from the British Library</p>
<p>All correspondence to: Penguin Books, Penguin Random House, One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW</p>
</section>
</body>
</html>`;
}

function input(file: PrhXhtmlFile, imprintRules: ImprintRules) {
  return {
    opfContent: '<?xml version="1.0"?><package/>',
    opfPath: 'EPUB/package.opf',
    bookTitle: 'Test Book',
    xhtmlFiles: [file],
    imprintRules,
  };
}

describe('validatePrhCopyrightContent — Penguin (adult template)', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('emits zero issues for a fully compliant Penguin copyright page', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: compliantAdultCopyrightXhtml(),
    };
    expect(validatePrhCopyrightContent(input(file, penguinRules))).toEqual([]);
  });

  it('flags missing TDM-reservation paragraph', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(/Article 4\(3\) of the DSM Directive 2019\/790[^<]*<\/p>/i, '</p>');
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING')).toBeDefined();
  });

  it('flags missing EEA-representative line', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /<p>The authorized representative in the EEA[^<]*<\/p>/i,
      '',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-EEA-LINE-MISSING')).toBeDefined();
  });

  it('flags missing BL CIP statement', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /<p>A CIP catalogue record[^<]*<\/p>/i,
      '',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-BL-CIP-MISSING')).toBeDefined();
  });

  it('flags missing address block', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /One Embassy Gardens[^<]*<\/p>/,
      'Somewhere</p>',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING')).toBeDefined();
  });

  it('flags missing group statement', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /<p>Penguin Books is part of the Penguin Random House group of companies[^<]*<\/p>/i,
      '',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-GROUP-STATEMENT-MISSING')).toBeDefined();
  });

  it('flags missing imprint URL', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /<a href="http:\/\/www\.penguin\.co\.uk">www\.penguin\.co\.uk<\/a>/i,
      '',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-IMPRINT-URL-MISSING')).toBeDefined();
  });

  it('flags missing ISBN', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(/<p>ISBN[^<]*<\/p>/i, '');
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-ISBN-MISSING')).toBeDefined();
  });

  it('flags missing PRH UK logo when neither src nor alt matches', () => {
    const stripped = compliantAdultCopyrightXhtml().replace(
      /<figure class="copyright_logo">[\s\S]*?<\/figure>/i,
      '',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: stripped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-PRH-LOGO-MISSING')).toBeDefined();
  });

  it('accepts the PRH UK logo when only the alt text matches (no prh_uk_logo filename)', () => {
    const swapped = compliantAdultCopyrightXhtml().replace(
      /src="prh_core_assets\/images\/prh_uk_logo\.jpg"/,
      'src="images/some-other-name.jpg"',
    );
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: swapped };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-PRH-LOGO-MISSING')).toBeUndefined();
  });

  it('locates copyright page via filename when no epub:type marker is present', () => {
    const noEpubType = compliantAdultCopyrightXhtml()
      .replace(/epub:type="copyright-page"/g, '')
      .replace(/epub:type="frontmatter"/g, '');
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/copyright.xhtml', content: noEpubType };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    // Validator must still find the page and run checks (zero issues = pass).
    expect(issues).toEqual([]);
  });

  it('returns zero issues when no copyright XHTML can be located (different validator catches missing-copyright)', () => {
    const file: PrhXhtmlFile = { path: 'EPUB/xhtml/chapter001.xhtml', content: '<html><body>Just a chapter</body></html>' };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    expect(issues).toEqual([]);
  });
});

describe('validatePrhCopyrightContent — Vintage (bespoke template)', () => {
  const vintageRules = getImprintRules('vintage')!;

  it('does NOT flag missing TDM paragraph (Vintage doesn\'t use it)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>VINTAGE | 20 Vauxhall Bridge Road, London SW1V 2SA</p>
        <p>Vintage is part of the Penguin Random House group of companies whose addresses can be found at global.penguinrandomhouse.com.</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>ISBN: 978-1-234-56789-0</p>
        <p>Visit penguin.co.uk/vintage for more</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, vintageRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING')).toBeUndefined();
    expect(issues.find((i) => i.code === 'PRH-COPY-EEA-LINE-MISSING')).toBeUndefined();
  });

  it('flags missing Vintage-specific address (20 Vauxhall Bridge Road)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>VINTAGE</p>
        <p>Vintage is part of the Penguin Random House group of companies.</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>ISBN: 978-1-234-56789-0</p>
        <p>Visit penguin.co.uk/vintage for more</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, vintageRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING')).toBeDefined();
  });

  it('flags missing Vintage-specific URL (penguin.co.uk/vintage)', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>VINTAGE | 20 Vauxhall Bridge Road, London SW1V 2SA</p>
        <p>Vintage is part of the Penguin Random House group of companies.</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>ISBN: 978-1-234-56789-0</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, vintageRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-IMPRINT-URL-MISSING')).toBeDefined();
  });
});

describe('validatePrhCopyrightContent — Puffin (children\'s template)', () => {
  const puffinRules = getImprintRules('puffin')!;

  it('flags missing ANY of the three children\'s URLs', () => {
    // Only penguin.co.uk present; puffin.co.uk and ladybird.co.uk missing.
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>PENGUIN RANDOM HOUSE CHILDREN'S</p>
        <p>Part of the Penguin Random House group of companies.</p>
        <p>www.penguin.co.uk</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>First published by Puffin Books in 2026</p>
        <p>Penguin Random House Children's, One Embassy Gardens, London</p>
        <p>Article 4(3) of the DSM Directive 2019/790</p>
        <p>Morrison Chambers, 32 Nassau Street, Dublin D02 YH68</p>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>ISBN: 978-1-234-56789-0</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, puffinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-IMPRINT-URL-MISSING')).toBeDefined();
  });

  it('passes when all three children\'s URLs are present', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>PENGUIN RANDOM HOUSE CHILDREN'S</p>
        <p>Part of the Penguin Random House group of companies.</p>
        <p>www.penguin.co.uk | www.puffin.co.uk | www.ladybird.co.uk</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>Penguin Random House Children's, One Embassy Gardens, London</p>
        <p>Article 4(3) of the DSM Directive 2019/790 — text and data mining exception</p>
        <p>Morrison Chambers, 32 Nassau Street, Dublin D02 YH68</p>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>ISBN: 978-1-234-56789-0</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, puffinRules));
    expect(issues.find((i) => i.code === 'PRH-COPY-IMPRINT-URL-MISSING')).toBeUndefined();
  });
});

describe('validatePrhCopyrightContent — text normalisation', () => {
  const penguinRules = getImprintRules('penguin')!;

  it('matches across HTML tag boundaries (collapsed whitespace)', () => {
    // Wrap the TDM phrase across multiple tags + extra whitespace.
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: `<html><body><section epub:type="copyright-page">
        <p>PENGUIN BOOKS</p>
        <p>Penguin Books is <em>part of the</em> Penguin Random House
          group of companies whose addresses can be found at global.penguinrandomhouse.com.</p>
        <p>www.penguin.co.uk</p>
        <figure class="copyright_logo"><img src="prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>
        <p>... reserves this work from the text and data mining exception.
        <strong>In   accordance with    Article  4(3)
        of the DSM
        Directive 2019/790</strong>, Penguin Random House expressly reserves...</p>
        <p>The authorized representative in the EEA is
        Penguin Random House Ireland, Morrison Chambers, 32 Nassau Street, Dublin D02 YH68</p>
        <p>A CIP catalogue record for this book is available from the British Library</p>
        <p>One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW</p>
        <p>ISBN: 978-1-234-56789-0</p>
      </section></body></html>`,
    };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    // Despite the whitespace + tag noise, all needles should be found.
    expect(issues).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const file: PrhXhtmlFile = {
      path: 'EPUB/xhtml/copyright.xhtml',
      content: compliantAdultCopyrightXhtml().toUpperCase(),
    };
    const issues = validatePrhCopyrightContent(input(file, penguinRules));
    // After uppercasing, the validator must still find every needle.
    // (Note: the cover img alt is now "PENGUIN RANDOM HOUSE UK" — still
    // matches the lowercase "penguin random house uk" needle.)
    expect(issues.filter((i) => i.code.startsWith('PRH-COPY-')).length).toBe(0);
  });
});
