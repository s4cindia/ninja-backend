import { describe, it, expect, beforeEach } from 'vitest';
import { epubJSAuditor } from '../../../../src/services/epub/epub-js-auditor.service';
import JSZip from 'jszip';

describe('EPUBJSAuditorService - Issue Location Tracking', () => {
  let zip: JSZip;

  beforeEach(() => {
    zip = new JSZip();
  });

  describe('EPUB-STRUCT-004 - Missing Main Landmark', () => {
    it('should detect specific file for EPUB-STRUCT-004', async () => {
      // Create a test EPUB with META-INF and OPF
      zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`);

      // Add a content file without main landmark
      zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter 1</title></head>
<body>
  <section>
    <h1>Chapter 1</h1>
    <p>Content without main landmark</p>
  </section>
</body>
</html>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const result = await epubJSAuditor.audit(buffer);

      const structIssue = result.issues.find(i => i.code === 'EPUB-STRUCT-004');

      expect(structIssue).toBeDefined();
      expect(structIssue?.location).not.toBe('EPUB');
      expect(structIssue?.location).toMatch(/\.x?html$/);
      expect(structIssue?.location).toBe('OEBPS/chapter1.xhtml');
      expect(structIssue?.affectedFiles).toBeDefined();
      expect(structIssue?.affectedFiles).toContain('OEBPS/chapter1.xhtml');
    });

    it('should track multiple files missing main landmark', async () => {
      zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`);

      // Add multiple content files without main landmark
      zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter 1</title></head>
<body><section><h1>Chapter 1</h1></section></body>
</html>`);

      zip.file('OEBPS/chapter2.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter 2</title></head>
<body><section><h1>Chapter 2</h1></section></body>
</html>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const result = await epubJSAuditor.audit(buffer);

      const structIssue = result.issues.find(i => i.code === 'EPUB-STRUCT-004');

      expect(structIssue).toBeDefined();
      expect(structIssue?.affectedFiles).toHaveLength(2);
      expect(structIssue?.affectedFiles).toContain('OEBPS/chapter1.xhtml');
      expect(structIssue?.affectedFiles).toContain('OEBPS/chapter2.xhtml');
      expect(structIssue?.location).toBe('OEBPS/chapter1.xhtml');
    });

    it('should skip navigation documents when detecting missing main landmark', async () => {
      zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`);

      // Add nav file (should be skipped)
      zip.file('OEBPS/nav.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Navigation</title></head>
<body><nav><ol><li>Chapter 1</li></ol></nav></body>
</html>`);

      // Add content file without main landmark
      zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter 1</title></head>
<body><section><h1>Chapter 1</h1></section></body>
</html>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const result = await epubJSAuditor.audit(buffer);

      const structIssue = result.issues.find(i => i.code === 'EPUB-STRUCT-004');

      expect(structIssue).toBeDefined();
      expect(structIssue?.affectedFiles).toHaveLength(1);
      expect(structIssue?.affectedFiles).not.toContain('OEBPS/nav.xhtml');
      expect(structIssue?.affectedFiles).toContain('OEBPS/chapter1.xhtml');
    });

    it('should not report issue if main landmark exists', async () => {
      zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`);

      // Add content file with main landmark
      zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter 1</title></head>
<body>
  <main role="main">
    <h1>Chapter 1</h1>
    <p>Content with main landmark</p>
  </main>
</body>
</html>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const result = await epubJSAuditor.audit(buffer);

      const structIssue = result.issues.find(i => i.code === 'EPUB-STRUCT-004');

      expect(structIssue).toBeUndefined();
    });

    it('should recognize epub:type="bodymatter" as main landmark', async () => {
      zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest></manifest>
  <spine></spine>
</package>`);

      // Add content file with epub:type="bodymatter"
      zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>Chapter 1</title></head>
<body>
  <section epub:type="bodymatter">
    <h1>Chapter 1</h1>
    <p>Content with epub:type bodymatter</p>
  </section>
</body>
</html>`);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const result = await epubJSAuditor.audit(buffer);

      const structIssue = result.issues.find(i => i.code === 'EPUB-STRUCT-004');

      expect(structIssue).toBeUndefined();
    });
  });
});
