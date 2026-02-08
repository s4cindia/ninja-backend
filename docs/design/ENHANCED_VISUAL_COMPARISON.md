# Enhanced Visual Comparison Implementation Plan

## Overview
Transform the current text-based comparison view into a rich, interactive side-by-side EPUB page rendering with visual change highlighting.

**Current State:**
- Text-based diffs with syntax highlighting
- "No preview available" placeholders
- Change descriptions like "h5 → h4, h5 → h4..."
- Good data infrastructure but poor visual presentation

**Target State:**
- Side-by-side rendered EPUB pages (before/after)
- Visual highlighting of changed elements
- Interactive comparison controls (zoom, sync scroll, view modes)
- PDF export with screenshots

**Timeline:** 2-3 weeks
**Complexity:** Medium-High

---

## Architecture Analysis

### What You Already Have ✅

**Frontend:**
- ✅ ComparisonPanel component with BEFORE/AFTER sections
- ✅ Syntax highlighting (react-syntax-highlighter, PrismJS)
- ✅ Filter and navigation controls
- ✅ Change tracking and status management
- ✅ API integration via React Query

**Backend:**
- ✅ Comprehensive comparison API (`/jobs/:jobId/comparison`)
- ✅ RemediationChange database model with before/after content
- ✅ EPUB content extraction service (`epub-content.service.ts`)
- ✅ JSZip + Cheerio for EPUB parsing
- ✅ File storage (local disk + S3 support)
- ✅ Change logging and tracking

### What's Missing ❌

**Frontend:**
- ❌ EPUB HTML rendering (currently just syntax highlighting raw code)
- ❌ Visual change highlighting overlays
- ❌ Interactive controls (zoom, scroll sync, view modes)
- ❌ PDF export functionality
- ❌ Iframe sandboxing for EPUB content

**Backend:**
- ❌ Spine item extraction API (currently only extracts by path)
- ❌ Change location coordinates (XPath → visual coordinates)
- ❌ Before/after HTML snippets for changed spine items
- ❌ CSS extraction and bundling
- ❌ Screenshot generation for PDF export

---

## Implementation Plan

### Phase 1: Backend - EPUB Spine Rendering API (Week 1)

**Goal:** Create API endpoints that return rendered HTML for specific spine items with change metadata.

#### Step 1.1: Spine Item Extraction Service
**File:** `src/services/epub/epub-spine.service.ts` (new)

```typescript
class EPUBSpineService {
  // Extract spine items in reading order
  async getSpineItems(jobId: string): Promise<SpineItem[]>

  // Get specific spine item with content
  async getSpineItemContent(
    jobId: string,
    spineItemId: string,
    version: 'original' | 'remediated'
  ): Promise<SpineItemContent>

  // Get spine item containing a specific change
  async getSpineItemForChange(
    jobId: string,
    changeId: string
  ): Promise<SpineItemWithChange>
}

interface SpineItem {
  id: string              // spine item id from OPF
  href: string            // path in EPUB
  mediaType: string       // usually application/xhtml+xml
  order: number           // reading order
  title?: string          // from nav/ncx if available
}

interface SpineItemContent {
  spineItem: SpineItem
  html: string            // extracted XHTML content
  css: string[]           // array of CSS file contents
  baseHref: string        // base path for resolving resources
}

interface SpineItemWithChange {
  spineItem: SpineItem
  beforeContent: SpineItemContent
  afterContent: SpineItemContent
  change: RemediationChange
  highlightData: ChangeHighlight
}

interface ChangeHighlight {
  xpath: string
  cssSelector?: string    // converted from XPath for easier DOM targeting
  boundingBox?: {         // if we can calculate it
    top: number
    left: number
    width: number
    height: number
  }
}
```

**Implementation:**
1. Parse OPF package document to extract spine
2. Resolve spine item paths relative to OPF location
3. Extract HTML content for each spine item
4. Collect all referenced CSS files
5. Map RemediationChange.filePath to spine items
6. Convert XPath to CSS selectors where possible

**Estimated Time:** 2-3 days

---

#### Step 1.2: Visual Comparison API Endpoints
**File:** `src/routes/comparison.routes.ts` (update)
**File:** `src/controllers/comparison.controller.ts` (update)

**New Endpoints:**
```typescript
// Get spine items for a job
GET /api/v1/jobs/:jobId/comparison/spine
Response: SpineItem[]

// Get rendered content for a change
GET /api/v1/jobs/:jobId/comparison/changes/:changeId/visual
Response: SpineItemWithChange

// Get spine item content (before/after)
GET /api/v1/jobs/:jobId/comparison/spine/:spineItemId?version=original|remediated
Response: SpineItemContent
```

**Controller Methods:**
```typescript
async getSpineItems(req, res) {
  const spineItems = await epubSpineService.getSpineItems(jobId);
  res.json(spineItems);
}

async getVisualComparison(req, res) {
  const { jobId, changeId } = req.params;
  const visualData = await epubSpineService.getSpineItemForChange(jobId, changeId);
  res.json(visualData);
}

async getSpineItemContent(req, res) {
  const { jobId, spineItemId } = req.params;
  const { version } = req.query;
  const content = await epubSpineService.getSpineItemContent(jobId, spineItemId, version);
  res.json(content);
}
```

**Estimated Time:** 1-2 days

---

#### Step 1.3: CSS Bundling and Resource Resolution
**File:** `src/services/epub/epub-spine.service.ts` (update)

**Challenge:** EPUB HTML references CSS with relative paths. We need to:
1. Extract all CSS files referenced in HTML
2. Bundle them into inline `<style>` tags or return as array
3. Resolve image/font paths to be accessible from frontend

**Approach:**
```typescript
async extractStyles(zip: JSZip, htmlPath: string, html: string): Promise<string[]> {
  const $ = cheerio.load(html);
  const cssFiles: string[] = [];

  // Find all <link rel="stylesheet">
  $('link[rel="stylesheet"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      const cssPath = resolvePath(htmlPath, href);
      const cssContent = await zip.file(cssPath)?.async('text');
      if (cssContent) {
        cssFiles.push(cssContent);
      }
    }
  });

  // Also check for <style> tags
  $('style').each((_, elem) => {
    cssFiles.push($(elem).html() || '');
  });

  return cssFiles;
}
```

**Resource Path Rewriting:**
- Option A: Convert all resource paths to API endpoints (e.g., `/api/v1/jobs/:jobId/content?path=images/cover.jpg`)
- Option B: Extract resources and serve via blob URLs
- **Recommended:** Option A (simpler, uses existing content API)

**Estimated Time:** 1 day

---

### Phase 2: Frontend - EPUB Renderer Component (Week 1-2)

**Goal:** Create a component that renders EPUB HTML content with proper styling and sandboxing.

#### Step 2.1: EPUB Renderer Component
**File:** `src/components/epub/EPUBRenderer.tsx` (new)

```typescript
interface EPUBRendererProps {
  html: string
  css: string[]
  baseUrl: string          // For resolving relative paths
  highlights?: ChangeHighlight[]
  version: 'before' | 'after'
  onLoad?: () => void
  className?: string
}

function EPUBRenderer({ html, css, baseUrl, highlights, version, onLoad }: EPUBRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    const doc = iframe.contentDocument;
    if (!doc) return;

    // Build complete HTML document
    const fullHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <base href="${baseUrl}">
          ${css.map(styles => `<style>${styles}</style>`).join('\n')}
          <style>
            /* Highlight styles */
            .change-highlight-before {
              outline: 3px solid #ef4444;
              outline-offset: 2px;
              background-color: rgba(239, 68, 68, 0.1);
            }
            .change-highlight-after {
              outline: 3px solid #22c55e;
              outline-offset: 2px;
              background-color: rgba(34, 197, 94, 0.1);
            }
            .change-tooltip {
              /* Tooltip styles */
            }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `;

    // Write to iframe
    doc.open();
    doc.write(fullHtml);
    doc.close();

    // Apply highlights after content loads
    iframe.onload = () => {
      applyHighlights(doc, highlights, version);
      setIsLoaded(true);
      onLoad?.();
    };
  }, [html, css, baseUrl, highlights, version]);

  return (
    <div className={`epub-renderer ${className}`}>
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"  // No scripts for security
        className="w-full h-full border-0"
        title={`EPUB ${version}`}
      />
    </div>
  );
}

function applyHighlights(doc: Document, highlights: ChangeHighlight[], version: 'before' | 'after') {
  if (!highlights) return;

  highlights.forEach(highlight => {
    const elements = highlight.cssSelector
      ? doc.querySelectorAll(highlight.cssSelector)
      : findByXPath(doc, highlight.xpath);

    elements.forEach(el => {
      el.classList.add(`change-highlight-${version}`);

      // Add tooltip
      const tooltip = doc.createElement('div');
      tooltip.className = 'change-tooltip';
      tooltip.textContent = highlight.description || 'Changed';
      el.appendChild(tooltip);
    });
  });
}
```

**Security Considerations:**
- Use iframe sandbox to prevent script execution
- Sanitize HTML to remove `<script>` tags
- Set Content-Security-Policy headers
- Use `sandbox="allow-same-origin"` only (no allow-scripts)

**Estimated Time:** 2-3 days

---

#### Step 2.2: Visual Comparison Container
**File:** `src/components/comparison/VisualComparisonPanel.tsx` (new)

```typescript
function VisualComparisonPanel({ change }: { change: RemediationChange }) {
  const { data: visualData, isLoading } = useQuery({
    queryKey: ['visual-comparison', change.jobId, change.id],
    queryFn: () => comparisonService.getVisualComparison(change.jobId, change.id),
  });

  const [viewMode, setViewMode] = useState<'side-by-side' | 'overlay' | 'slider'>('side-by-side');
  const [zoom, setZoom] = useState(100);
  const [syncScroll, setSyncScroll] = useState(true);

  if (isLoading) return <Spinner />;
  if (!visualData) return <p>No visual preview available</p>;

  return (
    <div className="visual-comparison-panel">
      <ComparisonControls
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        zoom={zoom}
        onZoomChange={setZoom}
        syncScroll={syncScroll}
        onSyncScrollChange={setSyncScroll}
      />

      {viewMode === 'side-by-side' && (
        <SideBySideView
          beforeContent={visualData.beforeContent}
          afterContent={visualData.afterContent}
          highlights={visualData.highlightData}
          zoom={zoom}
          syncScroll={syncScroll}
        />
      )}

      {viewMode === 'overlay' && (
        <OverlayView
          beforeContent={visualData.beforeContent}
          afterContent={visualData.afterContent}
          highlights={visualData.highlightData}
          zoom={zoom}
        />
      )}

      {viewMode === 'slider' && (
        <SliderView
          beforeContent={visualData.beforeContent}
          afterContent={visualData.afterContent}
          highlights={visualData.highlightData}
          zoom={zoom}
        />
      )}
    </div>
  );
}
```

**View Modes:**
1. **Side-by-side:** Two iframes, synchronized scrolling
2. **Overlay:** Stacked with opacity slider (before → after fade)
3. **Slider:** Split view with draggable divider

**Estimated Time:** 2-3 days

---

#### Step 2.3: Comparison Controls
**File:** `src/components/comparison/ComparisonControls.tsx` (new)

```typescript
function ComparisonControls({
  viewMode,
  onViewModeChange,
  zoom,
  onZoomChange,
  syncScroll,
  onSyncScrollChange,
}: ComparisonControlsProps) {
  return (
    <div className="flex items-center gap-4 p-4 bg-gray-50 border-b">
      {/* View Mode Selector */}
      <Select value={viewMode} onValueChange={onViewModeChange}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="side-by-side">
            <Columns className="inline mr-2" size={16} />
            Side-by-side
          </SelectItem>
          <SelectItem value="overlay">
            <Layers className="inline mr-2" size={16} />
            Overlay
          </SelectItem>
          <SelectItem value="slider">
            <SplitSquareHorizontal className="inline mr-2" size={16} />
            Slider
          </SelectItem>
        </SelectContent>
      </Select>

      {/* Zoom Controls */}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => onZoomChange(Math.max(50, zoom - 10))}>
          <ZoomOut size={16} />
        </Button>
        <span className="text-sm font-medium w-16 text-center">{zoom}%</span>
        <Button size="sm" variant="outline" onClick={() => onZoomChange(Math.min(200, zoom + 10))}>
          <ZoomIn size={16} />
        </Button>
        <Button size="sm" variant="outline" onClick={() => onZoomChange(100)}>
          Reset
        </Button>
      </div>

      {/* Sync Scroll Toggle */}
      {viewMode === 'side-by-side' && (
        <div className="flex items-center gap-2">
          <Switch checked={syncScroll} onCheckedChange={onSyncScrollChange} />
          <label className="text-sm">Sync Scroll</label>
        </div>
      )}

      {/* Highlight Toggle */}
      <div className="flex items-center gap-2">
        <Switch checked={true} />
        <label className="text-sm">Show Changes</label>
      </div>
    </div>
  );
}
```

**Estimated Time:** 1 day

---

### Phase 3: Interactive Features (Week 2)

#### Step 3.1: Synchronized Scrolling
**File:** `src/components/comparison/SideBySideView.tsx` (new)

```typescript
function SideBySideView({
  beforeContent,
  afterContent,
  highlights,
  zoom,
  syncScroll,
}: SideBySideViewProps) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const [isScrolling, setIsScrolling] = useState(false);

  const handleScroll = useCallback((source: 'before' | 'after') => {
    if (!syncScroll || isScrolling) return;

    setIsScrolling(true);

    const sourceEl = source === 'before' ? beforeRef.current : afterRef.current;
    const targetEl = source === 'before' ? afterRef.current : beforeRef.current;

    if (sourceEl && targetEl) {
      const scrollPercentage = sourceEl.scrollTop / (sourceEl.scrollHeight - sourceEl.clientHeight);
      targetEl.scrollTop = scrollPercentage * (targetEl.scrollHeight - targetEl.clientHeight);
    }

    setTimeout(() => setIsScrolling(false), 50);
  }, [syncScroll, isScrolling]);

  return (
    <div className="grid grid-cols-2 gap-0 h-full">
      <div
        ref={beforeRef}
        className="overflow-auto border-r"
        onScroll={() => handleScroll('before')}
        style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
      >
        <div className="bg-red-50 px-4 py-2 sticky top-0 z-10">
          <span className="font-semibold text-red-700">BEFORE</span>
        </div>
        <EPUBRenderer
          html={beforeContent.html}
          css={beforeContent.css}
          baseUrl={beforeContent.baseHref}
          highlights={highlights}
          version="before"
        />
      </div>

      <div
        ref={afterRef}
        className="overflow-auto"
        onScroll={() => handleScroll('after')}
        style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
      >
        <div className="bg-green-50 px-4 py-2 sticky top-0 z-10">
          <span className="font-semibold text-green-700">AFTER</span>
        </div>
        <EPUBRenderer
          html={afterContent.html}
          css={afterContent.css}
          baseUrl={afterContent.baseHref}
          highlights={highlights}
          version="after"
        />
      </div>
    </div>
  );
}
```

**Estimated Time:** 1 day

---

#### Step 3.2: Change Navigation
**File:** `src/components/comparison/ChangeNavigator.tsx` (update)

Add "Jump to Change" feature that scrolls highlighted element into view:

```typescript
function jumpToChange(iframeRef: React.RefObject<HTMLIFrameElement>, cssSelector: string) {
  const doc = iframeRef.current?.contentDocument;
  if (!doc) return;

  const element = doc.querySelector(cssSelector);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Flash animation
    element.classList.add('flash-highlight');
    setTimeout(() => element.classList.remove('flash-highlight'), 1000);
  }
}
```

**Estimated Time:** 1 day

---

### Phase 4: PDF Export (Week 3)

#### Step 4.1: Screenshot Generation Backend
**File:** `src/services/comparison/screenshot.service.ts` (new)

**Approach:** Use Playwright to render EPUB pages and capture screenshots

```typescript
import { chromium } from 'playwright';

class ScreenshotService {
  async captureComparison(
    jobId: string,
    changeId: string
  ): Promise<{ beforeImage: Buffer; afterImage: Buffer }> {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Get visual data
    const visualData = await epubSpineService.getSpineItemForChange(jobId, changeId);

    // Render before version
    await page.setContent(buildFullHTML(visualData.beforeContent, visualData.highlightData, 'before'));
    const beforeImage = await page.screenshot({ fullPage: true });

    // Render after version
    await page.setContent(buildFullHTML(visualData.afterContent, visualData.highlightData, 'after'));
    const afterImage = await page.screenshot({ fullPage: true });

    await browser.close();

    return { beforeImage, afterImage };
  }
}
```

**Dependencies to Add:**
- `playwright` (npm install playwright)
- `pdfkit` or `puppeteer-pdf` for PDF generation

**Estimated Time:** 2 days

---

#### Step 4.2: PDF Report Generation
**File:** `src/services/comparison/pdf-report.service.ts` (new)

```typescript
import PDFDocument from 'pdfkit';

class PDFReportService {
  async generateComparisonReport(
    jobId: string,
    changeIds?: string[]
  ): Promise<Buffer> {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];

    doc.on('data', chunk => chunks.push(chunk));

    // Title page
    doc.fontSize(20).text('EPUB Accessibility Remediation Report', { align: 'center' });
    doc.moveDown();

    // Get changes
    const comparison = await comparisonService.getComparison(jobId);
    const changes = changeIds
      ? comparison.changes.filter(c => changeIds.includes(c.id))
      : comparison.changes;

    // For each change
    for (const change of changes) {
      doc.addPage();

      // Change description
      doc.fontSize(14).text(`Change ${change.changeNumber}: ${change.description}`);
      doc.fontSize(10).text(`Type: ${change.changeType} | Severity: ${change.severity}`);
      doc.moveDown();

      // Screenshots
      const { beforeImage, afterImage } = await screenshotService.captureComparison(jobId, change.id);

      doc.text('Before:', { underline: true });
      doc.image(beforeImage, { fit: [500, 300] });
      doc.moveDown();

      doc.text('After:', { underline: true });
      doc.image(afterImage, { fit: [500, 300] });
    }

    doc.end();

    return new Promise(resolve => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
```

**Endpoint:**
```typescript
GET /api/v1/jobs/:jobId/comparison/export/pdf?changes=id1,id2,id3
Response: PDF file download
```

**Estimated Time:** 2 days

---

#### Step 4.3: Frontend Export Button
**File:** `src/components/comparison/ComparisonHeader.tsx` (update)

```typescript
function ExportButton({ jobId, selectedChanges }: { jobId: string; selectedChanges: string[] }) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);

    try {
      const blob = await comparisonService.exportToPDF(jobId, selectedChanges);
      const url = URL.createObjectURL(blob);

      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = `comparison-report-${jobId}.pdf`;
      a.click();

      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Button onClick={handleExport} disabled={isExporting}>
      {isExporting ? (
        <>
          <Spinner className="mr-2" size="sm" />
          Generating PDF...
        </>
      ) : (
        <>
          <Download className="mr-2" size={16} />
          Export to PDF
        </>
      )}
    </Button>
  );
}
```

**Estimated Time:** 1 day

---

## Integration Points

### Updating ComparisonPage.tsx

Replace the current `ComparisonPanel` with toggle between code view and visual view:

```typescript
function ComparisonPage() {
  const [viewType, setViewType] = useState<'code' | 'visual'>('visual');

  return (
    <div>
      <ComparisonHeader>
        <ToggleGroup value={viewType} onValueChange={setViewType}>
          <ToggleGroupItem value="visual">
            <Eye className="mr-2" />
            Visual
          </ToggleGroupItem>
          <ToggleGroupItem value="code">
            <Code className="mr-2" />
            Code
          </ToggleGroupItem>
        </ToggleGroup>
      </ComparisonHeader>

      {viewType === 'visual' ? (
        <VisualComparisonPanel change={currentChange} />
      ) : (
        <ComparisonPanel change={currentChange} />  {/* Keep existing code view */}
      )}
    </div>
  );
}
```

---

## Testing Strategy

### Backend Tests
1. **Spine extraction tests** - Verify spine items extracted in correct order
2. **Content extraction tests** - Ensure HTML and CSS properly extracted
3. **Change location tests** - Verify XPath to CSS selector conversion
4. **Screenshot tests** - Ensure screenshots captured correctly

### Frontend Tests
1. **Renderer tests** - Verify iframe rendering with proper sandbox
2. **Highlight tests** - Ensure highlights applied to correct elements
3. **Scroll sync tests** - Verify synchronized scrolling works
4. **View mode tests** - Test all three view modes (side-by-side, overlay, slider)

### Integration Tests
1. **End-to-end visual comparison** - Load real EPUB, verify rendering
2. **PDF export** - Generate PDF and verify content
3. **Change navigation** - Navigate through multiple changes

---

## Dependencies to Add

### Backend
```bash
npm install playwright          # For screenshots
npm install pdfkit              # For PDF generation
npm install @types/pdfkit --save-dev
```

### Frontend
No new major dependencies needed! Uses existing:
- React (existing)
- TailwindCSS (existing)
- React Query (existing)
- Lucide icons (existing)

---

## File Structure Summary

### New Backend Files
```
src/services/epub/
  └── epub-spine.service.ts          # Spine extraction and content serving
src/services/comparison/
  ├── screenshot.service.ts          # Playwright screenshot generation
  └── pdf-report.service.ts          # PDF report generation
```

### New Frontend Files
```
src/components/epub/
  └── EPUBRenderer.tsx               # Iframe-based EPUB renderer
src/components/comparison/
  ├── VisualComparisonPanel.tsx      # Main visual comparison container
  ├── SideBySideView.tsx             # Side-by-side view mode
  ├── OverlayView.tsx                # Overlay view mode
  ├── SliderView.tsx                 # Slider view mode
  ├── ComparisonControls.tsx         # View mode, zoom, sync controls
  └── ChangeNavigator.tsx            # Update with jump-to-change
src/services/
  └── comparison.service.ts          # Update with new API endpoints
```

### Files to Update
```
Backend:
  src/routes/comparison.routes.ts    # Add visual comparison routes
  src/controllers/comparison.controller.ts  # Add visual comparison controller methods

Frontend:
  src/pages/ComparisonPage.tsx       # Add view type toggle
  src/components/comparison/ComparisonHeader.tsx  # Add export button
```

---

## Risks and Mitigation

### Risk 1: EPUB CSS Conflicts
**Issue:** EPUB CSS may conflict with app CSS or break layout
**Mitigation:**
- Use iframe sandbox to isolate styles
- Set explicit width/height on iframe
- Add CSS reset in iframe head

### Risk 2: Large EPUBs Performance
**Issue:** Large EPUBs may be slow to render or export
**Mitigation:**
- Lazy load spine items (only load current change's spine item)
- Use pagination for PDF export
- Add loading indicators
- Consider caching rendered content

### Risk 3: XPath to CSS Selector Conversion
**Issue:** Not all XPath expressions can be converted to CSS selectors
**Mitigation:**
- Implement XPath evaluation in iframe using `document.evaluate()`
- Fall back to XPath if CSS selector conversion fails
- Store both XPath and CSS selector in database

### Risk 4: Resource Path Resolution
**Issue:** Images/fonts may not load due to incorrect paths
**Mitigation:**
- Use existing content API: `/api/v1/jobs/:jobId/content?path={path}`
- Rewrite all resource URLs in HTML to use API endpoints
- Set proper `<base>` tag in iframe

### Risk 5: Screenshot Generation Load
**Issue:** Playwright screenshots may be resource-intensive
**Mitigation:**
- Implement job queue for screenshot generation
- Add rate limiting
- Consider using headless browser pool
- Cache generated screenshots

---

## Success Criteria

**Must Have (Week 1-2):**
- ✅ Side-by-side EPUB page rendering
- ✅ Visual change highlighting (before = red, after = green)
- ✅ Basic controls (zoom, view mode toggle)
- ✅ Synchronized scrolling

**Should Have (Week 2-3):**
- ✅ All three view modes (side-by-side, overlay, slider)
- ✅ Jump to change navigation
- ✅ PDF export with screenshots

**Nice to Have (Optional):**
- ⭐ Comparison diff slider with opacity
- ⭐ Keyboard shortcuts for navigation
- ⭐ Fullscreen mode
- ⭐ Screenshot caching

---

## Implementation Order (Recommended)

**Week 1:**
1. Backend spine extraction service (2-3 days)
2. Backend visual comparison endpoints (1-2 days)
3. Frontend EPUB renderer component (2-3 days)

**Week 2:**
4. Frontend visual comparison panel (2-3 days)
5. Interactive controls and scroll sync (1-2 days)
6. Change highlighting and navigation (1 day)

**Week 3:**
7. Screenshot service (2 days)
8. PDF export service (2 days)
9. Frontend export integration (1 day)
10. Testing and polish (2 days)

**Total: 15-18 days (2-3 weeks)**

---

## Branching Strategy

**Answer:** Yes, continue developing on the current `feature/visual-comparison` branch in both repos.

**Rationale:**
- Branch already exists with some visual comparison groundwork
- Keeps all related work in one branch
- Can merge to main when complete
- Both frontend and backend are already on this branch

**Git Command:**
```bash
# Already on feature/visual-comparison branch - no action needed
git status  # Verify you're on the correct branch
```

---

## Replit Implementation Prompts

**Date:** January 10, 2026
**Purpose:** Implement Enhanced Visual Comparison with EPUB page rendering
**Development Environment:** Replit
**Branches:** feature/visual-comparison (both frontend and backend)

---

### BACKEND PROMPTS (Replit)

---

#### Backend Prompt 1: Create EPUB Spine Service - Part 1 (Interfaces & Basic Structure)

**File:** `src/services/epub/epub-spine.service.ts` (new file)

```
Create a new file src/services/epub/epub-spine.service.ts with the following TypeScript interfaces and class structure:

```typescript
import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import path from 'path';
import prisma from '../../lib/prisma';
import { fileService } from '../file.service';

// ============= INTERFACES =============

export interface SpineItem {
  id: string;              // spine item id from OPF
  href: string;            // path in EPUB
  mediaType: string;       // usually application/xhtml+xml
  order: number;           // reading order
  title?: string;          // from nav/ncx if available
}

export interface SpineItemContent {
  spineItem: SpineItem;
  html: string;            // extracted XHTML content
  css: string[];           // array of CSS file contents
  baseHref: string;        // base path for resolving resources
}

export interface ChangeHighlight {
  xpath: string;
  cssSelector?: string;    // converted from XPath for easier DOM targeting
  description?: string;
}

export interface SpineItemWithChange {
  spineItem: SpineItem;
  beforeContent: SpineItemContent;
  afterContent: SpineItemContent;
  change: {
    id: string;
    changeNumber: number;
    description: string;
    changeType: string;
    severity: string | null;
  };
  highlightData: ChangeHighlight;
}

// ============= SERVICE CLASS =============

class EPUBSpineService {
  // Helper: Load EPUB from storage
  private async loadEPUB(jobId: string, version: 'original' | 'remediated'): Promise<JSZip> {
    // Implementation in next prompt
  }

  // Helper: Find OPF file path
  private async findOPFPath(zip: JSZip): Promise<string> {
    // Implementation in next prompt
  }

  // Helper: Extract spine items from OPF
  private extractSpineFromOPF(opfContent: string, opfPath: string): SpineItem[] {
    // Implementation in next prompt
  }

  // Helper: Extract CSS files
  private async extractStyles(zip: JSZip, htmlPath: string, html: string): Promise<string[]> {
    // Implementation in next prompt
  }

  // Helper: Resolve relative paths
  private resolvePath(from: string, to: string): string {
    const dir = path.dirname(from);
    return path.posix.normalize(path.posix.join(dir, to));
  }

  // Helper: Convert XPath to CSS selector (basic)
  private xpathToCssSelector(xpath: string): string | undefined {
    // Implementation in next prompt
  }

  // ============= PUBLIC METHODS =============

  // Get all spine items for a job
  async getSpineItems(jobId: string): Promise<SpineItem[]> {
    // Implementation in next prompt
  }

  // Get spine item content (before or after)
  async getSpineItemContent(
    jobId: string,
    spineItemId: string,
    version: 'original' | 'remediated'
  ): Promise<SpineItemContent> {
    // Implementation in next prompt
  }

  // Get spine item for a specific change
  async getSpineItemForChange(
    jobId: string,
    changeId: string
  ): Promise<SpineItemWithChange> {
    // Implementation in next prompt
  }
}

export const epubSpineService = new EPUBSpineService();
```

This creates the foundation. Save the file and confirm it compiles without errors.
```

---

#### Backend Prompt 2: Implement EPUB Spine Service Helper Methods

**File:** `src/services/epub/epub-spine.service.ts` (update)

```
In src/services/epub/epub-spine.service.ts, implement the helper methods. Replace the empty method bodies with the following implementations:

1. Implement loadEPUB method:
```typescript
private async loadEPUB(jobId: string, version: 'original' | 'remediated'): Promise<JSZip> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { originalFile: true, remediatedFile: true }
  });

  if (!job) {
    throw new Error('Job not found');
  }

  const file = version === 'original' ? job.originalFile : job.remediatedFile;
  if (!file) {
    throw new Error(`${version} file not found`);
  }

  const buffer = await fileService.getFileBuffer(file.storageKey);
  return await JSZip.loadAsync(buffer);
}
```

2. Implement findOPFPath method:
```typescript
private async findOPFPath(zip: JSZip): Promise<string> {
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('container.xml not found in EPUB');
  }

  const containerContent = await containerFile.async('text');
  const $ = cheerio.load(containerContent, { xmlMode: true });
  const opfPath = $('rootfile').attr('full-path');

  if (!opfPath) {
    throw new Error('OPF path not found in container.xml');
  }

  return opfPath;
}
```

3. Implement extractSpineFromOPF method:
```typescript
private extractSpineFromOPF(opfContent: string, opfPath: string): SpineItem[] {
  const $ = cheerio.load(opfContent, { xmlMode: true });
  const spineItems: SpineItem[] = [];

  // Build manifest lookup
  const manifest: Record<string, { href: string; mediaType: string }> = {};
  $('manifest item').each((_, elem) => {
    const id = $(elem).attr('id');
    const href = $(elem).attr('href');
    const mediaType = $(elem).attr('media-type');
    if (id && href) {
      manifest[id] = { href, mediaType: mediaType || '' };
    }
  });

  // Extract spine items in order
  $('spine itemref').each((index, elem) => {
    const idref = $(elem).attr('idref');
    if (idref && manifest[idref]) {
      const manifestItem = manifest[idref];
      spineItems.push({
        id: idref,
        href: this.resolvePath(opfPath, manifestItem.href),
        mediaType: manifestItem.mediaType,
        order: index
      });
    }
  });

  return spineItems;
}
```

4. Implement extractStyles method:
```typescript
private async extractStyles(zip: JSZip, htmlPath: string, html: string): Promise<string[]> {
  const $ = cheerio.load(html);
  const cssFiles: string[] = [];

  // Find all <link rel="stylesheet">
  const linkPromises: Promise<void>[] = [];
  $('link[rel="stylesheet"]').each((_, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      const cssPath = this.resolvePath(htmlPath, href);
      const promise = (async () => {
        const cssFile = zip.file(cssPath);
        if (cssFile) {
          const cssContent = await cssFile.async('text');
          cssFiles.push(cssContent);
        }
      })();
      linkPromises.push(promise);
    }
  });

  await Promise.all(linkPromises);

  // Also check for inline <style> tags
  $('style').each((_, elem) => {
    const styleContent = $(elem).html();
    if (styleContent) {
      cssFiles.push(styleContent);
    }
  });

  return cssFiles;
}
```

5. Implement xpathToCssSelector method (basic conversion):
```typescript
private xpathToCssSelector(xpath: string): string | undefined {
  // Basic XPath to CSS conversion
  // This handles simple cases like /html/body/div[1]/p[2]

  if (!xpath.startsWith('/')) return undefined;

  try {
    const parts = xpath.split('/').filter(p => p);
    const cssPath = parts.map(part => {
      // Extract element name and index
      const match = part.match(/^(\w+)(?:\[(\d+)\])?$/);
      if (!match) return null;

      const [, element, index] = match;
      if (index) {
        // CSS uses nth-of-type (1-based like XPath)
        return `${element}:nth-of-type(${index})`;
      }
      return element;
    }).filter(Boolean);

    if (cssPath.length === 0) return undefined;
    return cssPath.join(' > ');
  } catch {
    return undefined;
  }
}
```

Save the file and verify no compilation errors.
```

---

#### Backend Prompt 3: Implement EPUB Spine Service Public Methods

**File:** `src/services/epub/epub-spine.service.ts` (update)

```
In src/services/epub/epub-spine.service.ts, implement the three public methods:

1. Implement getSpineItems:
```typescript
async getSpineItems(jobId: string): Promise<SpineItem[]> {
  const zip = await this.loadEPUB(jobId, 'remediated');
  const opfPath = await this.findOPFPath(zip);
  const opfFile = zip.file(opfPath);

  if (!opfFile) {
    throw new Error('OPF file not found');
  }

  const opfContent = await opfFile.async('text');
  return this.extractSpineFromOPF(opfContent, opfPath);
}
```

2. Implement getSpineItemContent:
```typescript
async getSpineItemContent(
  jobId: string,
  spineItemId: string,
  version: 'original' | 'remediated'
): Promise<SpineItemContent> {
  const zip = await this.loadEPUB(jobId, version);
  const spineItems = await this.getSpineItems(jobId);

  const spineItem = spineItems.find(item => item.id === spineItemId);
  if (!spineItem) {
    throw new Error(`Spine item ${spineItemId} not found`);
  }

  const htmlFile = zip.file(spineItem.href);
  if (!htmlFile) {
    throw new Error(`HTML file not found: ${spineItem.href}`);
  }

  const html = await htmlFile.async('text');
  const css = await this.extractStyles(zip, spineItem.href, html);

  return {
    spineItem,
    html,
    css,
    baseHref: path.posix.dirname(spineItem.href)
  };
}
```

3. Implement getSpineItemForChange:
```typescript
async getSpineItemForChange(
  jobId: string,
  changeId: string
): Promise<SpineItemWithChange> {
  // Get the change from database
  const change = await prisma.remediationChange.findUnique({
    where: { id: changeId }
  });

  if (!change || change.jobId !== jobId) {
    throw new Error('Change not found');
  }

  // Get spine items to find which one contains this file
  const spineItems = await this.getSpineItems(jobId);

  // Match change.filePath to spine item href
  const spineItem = spineItems.find(item =>
    item.href === change.filePath ||
    item.href.endsWith(change.filePath)
  );

  if (!spineItem) {
    throw new Error(`Spine item not found for file: ${change.filePath}`);
  }

  // Get before and after content
  const beforeContent = await this.getSpineItemContent(jobId, spineItem.id, 'original');
  const afterContent = await this.getSpineItemContent(jobId, spineItem.id, 'remediated');

  // Build highlight data
  const highlightData: ChangeHighlight = {
    xpath: change.elementXPath || '',
    cssSelector: change.elementXPath ? this.xpathToCssSelector(change.elementXPath) : undefined,
    description: change.description
  };

  return {
    spineItem,
    beforeContent,
    afterContent,
    change: {
      id: change.id,
      changeNumber: change.changeNumber,
      description: change.description,
      changeType: change.changeType,
      severity: change.severity
    },
    highlightData
  };
}
```

Save and verify the service compiles successfully.
```

---

#### Backend Prompt 4: Add Visual Comparison Routes

**File:** `src/routes/comparison.routes.ts` (update)

```
In src/routes/comparison.routes.ts, add three new routes for visual comparison. Add these routes BEFORE the existing routes (or in a logical position):

Import the spine service at the top:
```typescript
import { epubSpineService } from '../services/epub/epub-spine.service';
```

Add these three new route handlers:

```typescript
// Get spine items for a job
router.get(
  '/jobs/:jobId/comparison/spine',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const userId = (req as any).user?.id;

    // Verify job belongs to user's tenant
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const spineItems = await epubSpineService.getSpineItems(jobId);
    res.json(spineItems);
  })
);

// Get visual comparison for a specific change
router.get(
  '/jobs/:jobId/comparison/changes/:changeId/visual',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, changeId } = req.params;
    const userId = (req as any).user?.id;

    // Verify job belongs to user's tenant
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const visualData = await epubSpineService.getSpineItemForChange(jobId, changeId);
    res.json(visualData);
  })
);

// Get spine item content (before or after)
router.get(
  '/jobs/:jobId/comparison/spine/:spineItemId',
  authenticateToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, spineItemId } = req.params;
    const { version } = req.query;
    const userId = (req as any).user?.id;

    if (version !== 'original' && version !== 'remediated') {
      return res.status(400).json({ error: 'version must be "original" or "remediated"' });
    }

    // Verify job belongs to user's tenant
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        tenant: { users: { some: { id: userId } } }
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const content = await epubSpineService.getSpineItemContent(
      jobId,
      spineItemId,
      version as 'original' | 'remediated'
    );
    res.json(content);
  })
);
```

Also add these imports at the top if not present:
```typescript
import { Request, Response } from 'express';
import prisma from '../lib/prisma';
```

Save the file and test the backend routes are accessible.
```

---

### FRONTEND PROMPTS (Replit)

---

#### Frontend Prompt 1: Create EPUB Renderer Component

**File:** `src/components/epub/EPUBRenderer.tsx` (new file)

```
Create a new file src/components/epub/EPUBRenderer.tsx with an iframe-based EPUB renderer:

```typescript
import React, { useEffect, useRef, useState } from 'react';

interface ChangeHighlight {
  xpath: string;
  cssSelector?: string;
  description?: string;
}

interface EPUBRendererProps {
  html: string;
  css: string[];
  baseUrl: string;
  highlights?: ChangeHighlight[];
  version: 'before' | 'after';
  onLoad?: () => void;
  className?: string;
}

function findByXPath(doc: Document, xpath: string): Element[] {
  const result: Element[] = [];
  try {
    const xpathResult = doc.evaluate(
      xpath,
      doc,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    for (let i = 0; i < xpathResult.snapshotLength; i++) {
      const node = xpathResult.snapshotItem(i);
      if (node instanceof Element) {
        result.push(node);
      }
    }
  } catch (error) {
    console.warn('XPath evaluation failed:', error);
  }
  return result;
}

function applyHighlights(
  doc: Document,
  highlights: ChangeHighlight[] | undefined,
  version: 'before' | 'after'
) {
  if (!highlights || highlights.length === 0) return;

  highlights.forEach(highlight => {
    let elements: Element[] = [];

    // Try CSS selector first
    if (highlight.cssSelector) {
      try {
        elements = Array.from(doc.querySelectorAll(highlight.cssSelector));
      } catch (error) {
        console.warn('CSS selector failed:', error);
      }
    }

    // Fall back to XPath if CSS selector didn't work
    if (elements.length === 0 && highlight.xpath) {
      elements = findByXPath(doc, highlight.xpath);
    }

    // Apply highlight styles
    elements.forEach(el => {
      el.classList.add(`change-highlight-${version}`);

      // Add tooltip
      const tooltip = doc.createElement('div');
      tooltip.className = 'change-tooltip';
      tooltip.textContent = highlight.description || 'Changed';
      tooltip.style.cssText = `
        position: absolute;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        pointer-events: none;
        z-index: 1000;
        display: none;
      `;

      el.style.position = 'relative';
      el.appendChild(tooltip);

      // Show tooltip on hover
      el.addEventListener('mouseenter', () => {
        tooltip.style.display = 'block';
      });
      el.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });
    });
  });
}

export function EPUBRenderer({
  html,
  css,
  baseUrl,
  highlights,
  version,
  onLoad,
  className = ''
}: EPUBRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    // Build complete HTML document
    const fullHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <base href="${baseUrl}/">
          ${css.map(styles => `<style>${styles}</style>`).join('\n')}
          <style>
            /* Reset and base styles */
            body {
              margin: 20px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }

            /* Highlight styles */
            .change-highlight-before {
              outline: 3px solid #ef4444 !important;
              outline-offset: 2px;
              background-color: rgba(239, 68, 68, 0.1) !important;
            }
            .change-highlight-after {
              outline: 3px solid #22c55e !important;
              outline-offset: 2px;
              background-color: rgba(34, 197, 94, 0.1) !important;
            }

            /* Flash animation for jump-to-change */
            @keyframes flash {
              0%, 100% { background-color: transparent; }
              50% { background-color: rgba(59, 130, 246, 0.3); }
            }
            .flash-highlight {
              animation: flash 1s ease-in-out;
            }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `;

    // Write to iframe
    doc.open();
    doc.write(fullHtml);
    doc.close();

    // Apply highlights after content loads
    const handleLoad = () => {
      applyHighlights(doc, highlights, version);
      setIsLoaded(true);
      onLoad?.();
    };

    iframe.addEventListener('load', handleLoad);

    return () => {
      iframe.removeEventListener('load', handleLoad);
    };
  }, [html, css, baseUrl, highlights, version, onLoad]);

  return (
    <div className={`epub-renderer ${className}`}>
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        className="w-full h-full border-0"
        title={`EPUB ${version}`}
      />
    </div>
  );
}
```

Create the directory src/components/epub/ if it doesn't exist, then save this file.
```

---

#### Frontend Prompt 2: Update Comparison Service with New API Endpoints

**File:** `src/services/comparison.service.ts` (update)

```
In src/services/comparison.service.ts, add three new methods for visual comparison API calls.

Add these type definitions at the top of the file (after existing interfaces):

```typescript
export interface SpineItem {
  id: string;
  href: string;
  mediaType: string;
  order: number;
  title?: string;
}

export interface SpineItemContent {
  spineItem: SpineItem;
  html: string;
  css: string[];
  baseHref: string;
}

export interface ChangeHighlight {
  xpath: string;
  cssSelector?: string;
  description?: string;
}

export interface SpineItemWithChange {
  spineItem: SpineItem;
  beforeContent: SpineItemContent;
  afterContent: SpineItemContent;
  change: {
    id: string;
    changeNumber: number;
    description: string;
    changeType: string;
    severity: string | null;
  };
  highlightData: ChangeHighlight;
}
```

Add these three new methods to the ComparisonService class:

```typescript
// Get spine items for a job
async getSpineItems(jobId: string): Promise<SpineItem[]> {
  const response = await apiClient.get(`/jobs/${jobId}/comparison/spine`);
  return response.data;
}

// Get visual comparison for a specific change
async getVisualComparison(jobId: string, changeId: string): Promise<SpineItemWithChange> {
  const response = await apiClient.get(`/jobs/${jobId}/comparison/changes/${changeId}/visual`);
  return response.data;
}

// Get spine item content
async getSpineItemContent(
  jobId: string,
  spineItemId: string,
  version: 'original' | 'remediated'
): Promise<SpineItemContent> {
  const response = await apiClient.get(`/jobs/${jobId}/comparison/spine/${spineItemId}`, {
    params: { version }
  });
  return response.data;
}
```

Save the file.
```

---

#### Frontend Prompt 3: Create Visual Comparison Panel Component

**File:** `src/components/comparison/VisualComparisonPanel.tsx` (new file)

```
Create a new file src/components/comparison/VisualComparisonPanel.tsx for the main visual comparison container:

```typescript
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { comparisonService } from '../../services/comparison.service';
import { EPUBRenderer } from '../epub/EPUBRenderer';
import { Loader2 } from 'lucide-react';

interface VisualComparisonPanelProps {
  jobId: string;
  changeId: string;
}

export function VisualComparisonPanel({ jobId, changeId }: VisualComparisonPanelProps) {
  const [zoom, setZoom] = useState(100);
  const [syncScroll, setSyncScroll] = useState(true);

  const { data: visualData, isLoading, error } = useQuery({
    queryKey: ['visual-comparison', jobId, changeId],
    queryFn: () => comparisonService.getVisualComparison(jobId, changeId),
    enabled: !!jobId && !!changeId
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-600">Loading visual comparison...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-red-600">Error loading visual comparison: {String(error)}</p>
      </div>
    );
  }

  if (!visualData) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-gray-500 italic">No visual preview available</p>
      </div>
    );
  }

  return (
    <div className="visual-comparison-panel h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-4 p-4 bg-gray-50 border-b">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom(Math.max(50, zoom - 10))}
            className="px-3 py-1 border rounded hover:bg-gray-100"
          >
            -
          </button>
          <span className="text-sm font-medium w-16 text-center">{zoom}%</span>
          <button
            onClick={() => setZoom(Math.min(200, zoom + 10))}
            className="px-3 py-1 border rounded hover:bg-gray-100"
          >
            +
          </button>
          <button
            onClick={() => setZoom(100)}
            className="px-3 py-1 border rounded hover:bg-gray-100 text-sm"
          >
            Reset
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="sync-scroll"
            checked={syncScroll}
            onChange={(e) => setSyncScroll(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="sync-scroll" className="text-sm">Sync Scroll</label>
        </div>
      </div>

      {/* Side-by-side view */}
      <div className="grid grid-cols-2 gap-0 flex-1 overflow-hidden">
        {/* BEFORE */}
        <div
          className="overflow-auto border-r"
          style={{
            transform: `scale(${zoom / 100})`,
            transformOrigin: 'top left',
            width: `${100 / (zoom / 100)}%`,
            height: `${100 / (zoom / 100)}%`
          }}
        >
          <div className="bg-red-50 px-4 py-2 sticky top-0 z-10 border-b border-red-200">
            <span className="font-semibold text-red-700">BEFORE</span>
          </div>
          <EPUBRenderer
            html={visualData.beforeContent.html}
            css={visualData.beforeContent.css}
            baseUrl={visualData.beforeContent.baseHref}
            highlights={[visualData.highlightData]}
            version="before"
          />
        </div>

        {/* AFTER */}
        <div
          className="overflow-auto"
          style={{
            transform: `scale(${zoom / 100})`,
            transformOrigin: 'top left',
            width: `${100 / (zoom / 100)}%`,
            height: `${100 / (zoom / 100)}%`
          }}
        >
          <div className="bg-green-50 px-4 py-2 sticky top-0 z-10 border-b border-green-200">
            <span className="font-semibold text-green-700">AFTER</span>
          </div>
          <EPUBRenderer
            html={visualData.afterContent.html}
            css={visualData.afterContent.css}
            baseUrl={visualData.afterContent.baseHref}
            highlights={[visualData.highlightData]}
            version="after"
          />
        </div>
      </div>
    </div>
  );
}
```

Save the file.
```

---

#### Frontend Prompt 4: Update ComparisonPage to Add View Toggle

**File:** `src/pages/ComparisonPage.tsx` (update)

```
In src/pages/ComparisonPage.tsx, add a toggle between visual and code views.

First, add these imports at the top:
```typescript
import { VisualComparisonPanel } from '../components/comparison/VisualComparisonPanel';
import { Eye, Code } from 'lucide-react';
```

Then, add state for view type near the top of the component (after other useState declarations):
```typescript
const [viewType, setViewType] = useState<'visual' | 'code'>('visual');
```

Find the section where ComparisonPanel is rendered, and replace it with a toggle and conditional rendering:

Replace this (approximately):
```typescript
<ComparisonPanel change={currentChange} />
```

With this:
```typescript
{/* View Type Toggle */}
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setViewType('visual')}
    className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
      viewType === 'visual'
        ? 'bg-blue-500 text-white border-blue-500'
        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
    }`}
  >
    <Eye size={16} />
    Visual
  </button>
  <button
    onClick={() => setViewType('code')}
    className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
      viewType === 'code'
        ? 'bg-blue-500 text-white border-blue-500'
        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
    }`}
  >
    <Code size={16} />
    Code
  </button>
</div>

{/* Conditional View Rendering */}
{viewType === 'visual' ? (
  <VisualComparisonPanel
    jobId={currentChange.jobId}
    changeId={currentChange.id}
  />
) : (
  <ComparisonPanel change={currentChange} />
)}
```

Save the file and test the toggle between visual and code views.
```

---

### Testing Prompts

---

#### Testing Prompt 1: Test Backend API Endpoints

```
Test the new backend visual comparison endpoints:

1. Start the backend server in Replit
2. Use the API testing tool or curl to test:

```bash
# Get spine items for a job (replace JOB_ID and TOKEN)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/v1/jobs/JOB_ID/comparison/spine

# Get visual comparison for a change
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/v1/jobs/JOB_ID/comparison/changes/CHANGE_ID/visual

# Get spine item content
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3000/api/v1/jobs/JOB_ID/comparison/spine/SPINE_ITEM_ID?version=original"
```

Expected responses:
- Spine items: Array of spine items with id, href, order
- Visual comparison: Object with beforeContent, afterContent, highlightData
- Spine content: Object with html, css array, baseHref

If any endpoints fail, check:
1. Job exists in database
2. Job has originalFile and remediatedFile
3. EPUB files are valid and accessible
4. OPF file exists in META-INF/container.xml
```

---

#### Testing Prompt 2: Test Frontend Visual Comparison

```
Test the frontend visual comparison feature:

1. Start the frontend dev server in Replit
2. Navigate to a job with completed remediation
3. Click on "View Comparison" or navigate to comparison page
4. Test the following:

**View Toggle:**
- Click "Visual" button - should show side-by-side EPUB pages
- Click "Code" button - should show syntax-highlighted code view
- Toggle back and forth - should switch smoothly

**Visual View Controls:**
- Click + button - zoom should increase to 110%, 120%, etc.
- Click - button - zoom should decrease to 90%, 80%, etc.
- Click Reset - zoom should return to 100%
- Check "Sync Scroll" checkbox - scrolling one side should scroll the other
- Uncheck "Sync Scroll" - sides should scroll independently

**EPUB Rendering:**
- BEFORE panel should show original EPUB content
- AFTER panel should show remediated EPUB content
- Changed elements should have red outline (BEFORE) or green outline (AFTER)
- Hovering over highlighted element should show tooltip with change description
- CSS styles from EPUB should be applied correctly

**Troubleshooting:**
- If "Loading..." never completes: Check browser console for API errors
- If "No visual preview available": Check that change has valid filePath
- If EPUB doesn't render: Check baseHref and CSS extraction
- If highlights don't appear: Check XPath and CSS selector conversion

Report any issues with specific error messages from browser console.
```

---

### Summary: Next Steps After All Prompts

After completing all prompts:

1. **Backend:**
   - New service: `epub-spine.service.ts` with spine extraction
   - Updated routes: `comparison.routes.ts` with 3 new endpoints

2. **Frontend:**
   - New component: `EPUBRenderer.tsx` for iframe rendering
   - New component: `VisualComparisonPanel.tsx` for visual comparison
   - Updated service: `comparison.service.ts` with new API methods
   - Updated page: `ComparisonPage.tsx` with view toggle

3. **Testing:**
   - Test all 3 backend endpoints
   - Test visual view rendering
   - Test zoom and scroll sync controls
   - Test highlight overlays

4. **Future Enhancements (Week 2-3):**
   - Add overlay and slider view modes
   - Implement PDF export with Playwright screenshots
   - Add change navigation with jump-to-change
   - Improve XPath to CSS selector conversion

---

This plan builds on your existing excellent foundation and transforms the comparison view from "underwhelming" to a production-ready, industry-standard visual diff tool.
