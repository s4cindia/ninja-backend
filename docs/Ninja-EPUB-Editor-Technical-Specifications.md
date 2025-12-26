# Ninja EPUB Editor - Technical Specification

**Document:** Full EPUB Editor Feature Specification
**Version:** 1.0
**Created:** December 25, 2025
**Status:** Proposal

---

## Executive Summary

This document outlines the technical specification for a web-based EPUB editor integrated into the Ninja platform. The editor will enable users to fix accessibility issues directly within the browser without requiring external tools like Sigil.

---

## 1. Feature Specification

### 1.1 Core Features

| Feature | Priority | Description |
|---------|----------|-------------|
| File Browser | P0 | Tree view of EPUB contents |
| Code Editor | P0 | Syntax-highlighted XML/XHTML/CSS editing |
| Live Preview | P1 | Real-time EPUB rendering |
| Search & Replace | P0 | Global find/replace across files |
| Validation | P0 | EPUBCheck integration |
| Save/Export | P0 | Download modified EPUB |
| Undo/Redo | P0 | Full history support |
| Auto-complete | P1 | XML/HTML tag completion |
| Accessibility Checker | P0 | Integrated ACE audit |

### 1.2 Detailed Feature Breakdown

#### 1.2.1 File Browser Panel

```
┌─────────────────────────────────┐
│ 📖 wasteland.epub              │
│ ├── 📁 META-INF                │
│ │   └── 📄 container.xml       │
│ ├── 📁 EPUB                    │
│ │   ├── 📄 content.opf     ★   │
│ │   ├── 📄 nav.xhtml       ⚠   │
│ │   ├── 📁 text                │
│ │   │   ├── 📄 chapter1.xhtml  │
│ │   │   ├── 📄 chapter2.xhtml  │
│ │   │   └── 📄 chapter3.xhtml  │
│ │   ├── 📁 styles              │
│ │   │   └── 📄 stylesheet.css  │
│ │   └── 📁 images              │
│ │       ├── 🖼 cover.jpg       │
│ │       └── 🖼 figure1.png     │
│ └── 📄 mimetype                │
└─────────────────────────────────┘
 ★ = Has issues  ⚠ = Warning
```

**Features:**
- Expandable/collapsible folder tree
- File type icons (XHTML, CSS, images, OPF)
- Issue indicators on files with problems
- Right-click context menu (rename, delete, duplicate)
- Drag-and-drop file reorganization
- Add new file/folder
- File search filter

#### 1.2.2 Code Editor Panel

**Based on:** Monaco Editor (VS Code's editor)

**Features:**
| Feature | Description |
|---------|-------------|
| Syntax Highlighting | XML, XHTML, HTML, CSS, JavaScript |
| Line Numbers | Clickable for selection |
| Code Folding | Collapse/expand sections |
| Auto-indent | Smart indentation |
| Bracket Matching | Highlight matching tags |
| Error Highlighting | Red underline for syntax errors |
| Auto-complete | Tag names, attributes, CSS properties |
| Multi-cursor | Edit multiple locations |
| Minimap | Code overview sidebar |
| Go to Line | Ctrl+G navigation |
| Find/Replace | Ctrl+F / Ctrl+H |
| Format Document | Auto-format XML/HTML |

**Accessibility-Specific Features:**
| Feature | Description |
|---------|-------------|
| Issue Markers | Gutter icons for accessibility issues |
| Quick Fix | Lightbulb icon with suggested fixes |
| Hover Info | Issue details on hover |
| Jump to Issue | Navigate between issues |

#### 1.2.3 Live Preview Panel

**Based on:** epub.js or Readium

```
┌──────────────────────────────────────────────────────────────┐
│  Preview                              📱 💻 🖥  │ ↻ Refresh │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│           ┌────────────────────────────────┐                │
│           │                                │                │
│           │    THE WASTE LAND              │                │
│           │                                │                │
│           │    By T.S. Eliot               │                │
│           │                                │                │
│           │    Chapter 1: The Burial       │                │
│           │    of the Dead                 │                │
│           │                                │                │
│           │    April is the cruellest      │                │
│           │    month, breeding             │                │
│           │    Lilacs out of the dead      │                │
│           │    land...                     │                │
│           │                                │                │
│           └────────────────────────────────┘                │
│                                                              │
│  ◀ Prev    Page 1 of 42    Next ▶                           │
└──────────────────────────────────────────────────────────────┘
```

**Features:**
- Real-time preview updates
- Responsive device simulation (mobile, tablet, desktop)
- Page navigation
- Zoom controls
- Night mode toggle
- Reading system simulation
- Click-to-locate (click preview → jump to code)
- Accessibility overlay (show landmarks, headings structure)

#### 1.2.4 Integrated Accessibility Panel

```
┌──────────────────────────────────────────────────────────────┐
│  Accessibility Issues (9)                    🔄 Re-audit    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ❌ Critical (3)                                             │
│  ├── METADATA-ACCESSMODE         content.opf:12    [Fix]   │
│  ├── COLOR-CONTRAST              chapter1.xhtml:45 [Fix]   │
│  └── LANDMARK-UNIQUE             nav.xhtml:8       [Fix]   │
│                                                              │
│  ⚠️ Moderate (4)                                             │
│  ├── EPUB-TYPE-MATCHING-ROLE     chapter1.xhtml:22 [Fix]   │
│  └── ...                                                    │
│                                                              │
│  ℹ️ Minor (2)                                                │
│  └── ...                                                    │
│                                                              │
│  ────────────────────────────────────────────────────────── │
│  [Apply All Auto-Fixes]  [Export Report]                    │
└──────────────────────────────────────────────────────────────┘
```

**Features:**
- Issue list grouped by severity
- Click to navigate to issue location
- One-click fixes for auto-fixable issues
- Apply all fixes button
- Re-audit after changes
- Export accessibility report

#### 1.2.5 Metadata Editor (Visual)

```
┌──────────────────────────────────────────────────────────────┐
│  Metadata Editor                                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  📚 Basic Information                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Title:        [The Waste Land                        ] │ │
│  │ Author:       [T.S. Eliot                            ] │ │
│  │ Language:     [en ▼                                  ] │ │
│  │ Publisher:    [                                      ] │ │
│  │ Date:         [1922-01-01                           ] │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ♿ Accessibility Metadata                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Access Modes:                                          │ │
│  │   ☑ textual  ☑ visual  ☐ auditory                     │ │
│  │                                                        │ │
│  │ Access Mode Sufficient:                                │ │
│  │   ☑ textual  ☐ visual                                 │ │
│  │                                                        │ │
│  │ Accessibility Features:                                │ │
│  │   ☑ structuralNavigation  ☑ tableOfContents          │ │
│  │   ☑ readingOrder          ☐ alternativeText          │ │
│  │   ☐ longDescription       ☐ captions                 │ │
│  │                                                        │ │
│  │ Accessibility Hazards:                                 │ │
│  │   ◉ none  ○ flashing  ○ motion  ○ sound              │ │
│  │                                                        │ │
│  │ Accessibility Summary:                                 │ │
│  │   [This publication includes structured navigation,  ] │ │
│  │   [table of contents, and follows reading order...   ] │ │
│  │                                                        │ │
│  │ Conformance:                                           │ │
│  │   [EPUB Accessibility 1.0 ▼                          ] │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  [Apply to OPF]  [Reset]                                    │
└──────────────────────────────────────────────────────────────┘
```

#### 1.2.6 Table of Contents Editor

```
┌──────────────────────────────────────────────────────────────┐
│  Table of Contents Editor                      [+ Add Item] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ⋮⋮ Chapter 1: The Burial of the Dead                       │
│     └── Target: text/chapter1.xhtml                    [✎] │
│                                                              │
│  ⋮⋮ Chapter 2: A Game of Chess                              │
│     └── Target: text/chapter2.xhtml                    [✎] │
│        ⋮⋮ Section 2.1: The Chair                            │
│           └── Target: text/chapter2.xhtml#section2-1   [✎] │
│                                                              │
│  ⋮⋮ Chapter 3: The Fire Sermon                              │
│     └── Target: text/chapter3.xhtml                    [✎] │
│                                                              │
│  ──────────────────────────────────────────────────────────  │
│  ⋮⋮ = Drag to reorder                                       │
│  [Generate from Headings]  [Validate Links]                 │
└──────────────────────────────────────────────────────────────┘
```

#### 1.2.7 Image Manager

```
┌──────────────────────────────────────────────────────────────┐
│  Image Manager                               [+ Add Image]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ 🖼      │  │ 🖼      │  │ 🖼  ⚠  │  │ 🖼      │        │
│  │ cover   │  │ figure1 │  │ chart1  │  │ photo1  │        │
│  │ .jpg    │  │ .png    │  │ .png    │  │ .jpg    │        │
│  │ ✓ Alt   │  │ ✓ Alt   │  │ ✗ Alt   │  │ ✓ Alt   │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│                                                              │
│  ──────────────────────────────────────────────────────────  │
│  Selected: chart1.png                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Alt Text: [                                           ] │ │
│  │                                                        │ │
│  │ Long Description:                                      │ │
│  │ [                                                     ] │ │
│  │ [                                                     ] │ │
│  │                                                        │ │
│  │ [🤖 Generate with AI]  [Apply]                        │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Architecture

### 2.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │ React/Next  │  │ Monaco      │  │ epub.js     │  │ JSZip       │   │
│  │ UI Layer    │  │ Editor      │  │ Preview     │  │ Client ZIP  │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │
│         │                │                │                │           │
│         └────────────────┴────────────────┴────────────────┘           │
│                                    │                                    │
│                           State Management                              │
│                          (Zustand/Redux)                                │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              BACKEND API                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │ EPUB        │  │ Validation  │  │ ACE         │  │ Storage     │   │
│  │ Processing  │  │ (EPUBCheck) │  │ Integration │  │ Service     │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Frontend Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| UI Framework | React 18 / Next.js 14 | Component-based UI |
| Code Editor | Monaco Editor | VS Code-quality editing |
| EPUB Preview | epub.js / Readium | Render EPUB content |
| ZIP Handling | JSZip | Client-side EPUB manipulation |
| State Management | Zustand | Lightweight state |
| UI Components | shadcn/ui + Tailwind | Consistent design |
| File Tree | react-arborist | Tree view component |
| Drag & Drop | @dnd-kit | Drag and drop support |
| XML Parser | fast-xml-parser | Parse/modify XML |

### 2.3 Backend Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 20 | Server runtime |
| Framework | NestJS / Express | API framework |
| Validation | EPUBCheck (Java) | EPUB validation |
| Accessibility | ACE Microservice | Accessibility audit |
| Storage | S3 / Local | EPUB file storage |
| Database | PostgreSQL | Project metadata |

### 2.4 Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         EPUB EDITING WORKFLOW                         │
└──────────────────────────────────────────────────────────────────────┘

  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
  │ Upload  │ ──▶ │ Extract │ ──▶ │ Load in │ ──▶ │ Edit    │
  │ EPUB    │     │ (JSZip) │     │ Editor  │     │ Files   │
  └─────────┘     └─────────┘     └─────────┘     └─────────┘
                                                       │
                                                       ▼
  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
  │Download │ ◀── │Repackage│ ◀── │Validate │ ◀── │ Save    │
  │ EPUB    │     │ (JSZip) │     │(EPUBChk)│     │ Changes │
  └─────────┘     └─────────┘     └─────────┘     └─────────┘
```

### 2.5 Component Architecture

```typescript
// Core Editor Component Structure

<EpubEditorProvider epub={epubData}>
  <EditorLayout>

    {/* Left Panel - File Browser */}
    <Panel defaultSize={20} minSize={15}>
      <FileBrowser
        files={epub.files}
        onFileSelect={handleFileSelect}
        onFileCreate={handleFileCreate}
        onFileDelete={handleFileDelete}
        onFileRename={handleFileRename}
      />
    </Panel>

    {/* Center Panel - Code Editor */}
    <Panel defaultSize={50}>
      <MonacoEditor
        file={selectedFile}
        language={getLanguage(selectedFile)}
        onChange={handleFileChange}
        onSave={handleSave}
        markers={accessibilityMarkers}
      />
    </Panel>

    {/* Right Panel - Preview & Tools */}
    <Panel defaultSize={30}>
      <Tabs>
        <Tab label="Preview">
          <EpubPreview epub={epub} currentFile={selectedFile} />
        </Tab>
        <Tab label="Accessibility">
          <AccessibilityPanel
            issues={auditResults}
            onIssueClick={navigateToIssue}
            onApplyFix={applyFix}
          />
        </Tab>
        <Tab label="Metadata">
          <MetadataEditor
            metadata={epub.metadata}
            onChange={handleMetadataChange}
          />
        </Tab>
      </Tabs>
    </Panel>

  </EditorLayout>
</EpubEditorProvider>
```

### 2.6 State Management

```typescript
// Zustand Store for EPUB Editor

interface EpubEditorState {
  // EPUB Data
  epub: EpubDocument | null;
  files: Map<string, EpubFile>;
  modifiedFiles: Set<string>;

  // Editor State
  selectedFile: string | null;
  openFiles: string[];

  // Audit Results
  auditResults: AuditResult | null;

  // History
  undoStack: EditorAction[];
  redoStack: EditorAction[];

  // Actions
  loadEpub: (file: File) => Promise<void>;
  saveFile: (path: string, content: string) => void;
  createFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;
  exportEpub: () => Promise<Blob>;
  runAudit: () => Promise<void>;
  applyFix: (issueId: string, fix: Fix) => void;
  undo: () => void;
  redo: () => void;
}
```

---

## 3. API Specification

### 3.1 Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/epub/upload | Upload EPUB for editing |
| GET | /api/epub/:id/files | Get file tree |
| GET | /api/epub/:id/file/:path | Get file content |
| PUT | /api/epub/:id/file/:path | Update file content |
| POST | /api/epub/:id/file | Create new file |
| DELETE | /api/epub/:id/file/:path | Delete file |
| POST | /api/epub/:id/validate | Run EPUBCheck |
| POST | /api/epub/:id/audit | Run ACE audit |
| GET | /api/epub/:id/export | Download EPUB |
| POST | /api/epub/:id/auto-fix | Apply auto-fixes |

### 3.2 WebSocket Events (Real-time)

| Event | Direction | Description |
|-------|-----------|-------------|
| file:change | Client→Server | File content changed |
| file:save | Client→Server | Save file |
| validation:result | Server→Client | Validation complete |
| audit:result | Server→Client | Audit complete |
| session:sync | Bidirectional | Multi-user sync |

---

## 4. Manual Issue Coverage

### 4.1 Issues Fully Addressable in Web Editor

| Issue Type | Editor Feature | Coverage |
|------------|----------------|----------|
| METADATA-ACCESSMODE | Metadata Editor + Code | ✅ Full |
| METADATA-ACCESSIBILITYFEATURE | Metadata Editor + Code | ✅ Full |
| METADATA-ACCESSIBILITYHAZARD | Metadata Editor + Code | ✅ Full |
| METADATA-ACCESSIBILITYSUMMARY | Metadata Editor + Code | ✅ Full |
| LANDMARK-UNIQUE | Code Editor | ✅ Full |
| HEADING-ORDER | Code Editor | ✅ Full |
| COLOR-CONTRAST | CSS Editor | ✅ Full |
| IMAGE-ALT | Image Manager + Code | ✅ Full |
| LANGUAGE | Code Editor | ✅ Full |
| TABLE-STRUCTURE | Code Editor | ✅ Full |
| LINK-PURPOSE | Code Editor | ✅ Full |
| EPUB-TYPE-MATCHING-ROLE | Code Editor | ✅ Full |
| PAGEBREAK-LABEL | Code Editor | ✅ Full |

### 4.2 Issue Resolution Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ACCESSIBILITY ISSUE WORKFLOW                          │
└─────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐
  │ View Issue   │
  │ in Panel     │
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐     ┌──────────────┐
  │ Click Issue  │ ──▶ │ Editor jumps │
  │              │     │ to location  │
  └──────────────┘     └──────┬───────┘
                              │
         ┌────────────────────┴────────────────────┐
         │                                         │
         ▼                                         ▼
  ┌──────────────┐                         ┌──────────────┐
  │ Auto-fix     │                         │ Manual Edit  │
  │ Available?   │                         │ in Monaco    │
  └──────┬───────┘                         └──────┬───────┘
         │ Yes                                    │
         ▼                                        │
  ┌──────────────┐                                │
  │ Click [Fix]  │                                │
  │ Button       │                                │
  └──────┬───────┘                                │
         │                                        │
         └────────────────────┬───────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │ Re-audit to  │
                       │ Verify Fix   │
                       └──────────────┘
```

---

## 5. Gap Analysis: Web Editor vs Sigil

### 5.1 Feature Comparison

| Feature | Ninja Web Editor | Sigil | Gap |
|---------|------------------|-------|-----|
| **File Editing** |
| XHTML Editing | ✅ Monaco | ✅ Native | None |
| CSS Editing | ✅ Monaco | ✅ Native | None |
| OPF Editing | ✅ Monaco | ✅ Native | None |
| XML Validation | ✅ Real-time | ✅ Real-time | None |
| Code Formatting | ✅ Prettier | ✅ Built-in | None |
| **Preview** |
| Book Preview | ✅ epub.js | ✅ Native Qt | Minor |
| Preview Sync | ✅ Click-to-code | ✅ Click-to-code | None |
| **Navigation** |
| TOC Editor | ✅ Visual | ✅ Visual | None |
| Spine Editor | ✅ Visual | ✅ Visual | None |
| **Search** |
| Find/Replace | ✅ Monaco | ✅ Native | None |
| Regex Search | ✅ Monaco | ✅ PCRE | None |
| Search All Files | ✅ Implement | ✅ Native | Minor |
| **Validation** |
| EPUBCheck | ✅ Integrated | ✅ Integrated | None |
| Accessibility (ACE) | ✅ Integrated | ⚠️ Plugin | Better |
| **Advanced** |
| Plugins/Extensions | ❌ No | ✅ Python | Gap |
| Regex Replace All | ✅ Implement | ✅ Native | None |
| Book Splitting | ⚠️ Manual | ✅ Automated | Gap |
| EPUB Import | ✅ Yes | ✅ Yes | None |
| Generate TOC | ✅ From headings | ✅ From headings | None |
| Spell Check | ✅ Browser | ✅ Hunspell | Minor |
| **Media** |
| Image Insert | ✅ Upload | ✅ Insert | None |
| Audio/Video | ✅ Upload | ✅ Insert | None |
| Cover Image | ✅ Visual | ✅ Visual | None |
| **Accessibility** |
| Alt Text Editor | ✅ Visual | ⚠️ Manual | Better |
| ARIA Editor | ✅ Guided | ⚠️ Manual | Better |
| Metadata Editor | ✅ Visual | ⚠️ Manual | Better |
| Quick Fixes | ✅ One-click | ❌ No | Better |

### 5.2 Features Where Web Editor is BETTER

| Feature | Web Editor Advantage |
|---------|---------------------|
| Accessibility Integration | Native ACE integration with one-click fixes |
| Guided Remediation | Step-by-step fix guidance |
| Visual Metadata Editor | Checkbox-based accessibility metadata |
| Cloud-Based | No installation, access anywhere |
| Collaboration | Multi-user editing possible |
| Audit History | Track accessibility improvements over time |
| AI Integration | Alt-text generation, suggestions |

### 5.3 Features Where Sigil is BETTER

| Feature | Sigil Advantage | Mitigation Strategy |
|---------|-----------------|---------------------|
| Plugin System | Python extensibility | Build common plugins as features |
| Book Splitting | Auto-split by markers | Add split feature |
| Offline Mode | Works without internet | PWA with offline support |
| Performance | Large files faster | Web Workers, streaming |
| Regex Power | Advanced PCRE regex | Monaco regex is sufficient |
| Native Feel | Desktop experience | Progressive enhancement |

### 5.4 Gap Summary

| Gap Category | Impact | Addressable |
|--------------|--------|-------------|
| Plugin System | Medium | Partial - build common features in |
| Book Splitting | Low | Yes - can implement |
| Offline Mode | Medium | Yes - PWA |
| Large File Performance | Medium | Yes - Web Workers |
| Advanced Regex | Low | Monaco is sufficient |

---

## 6. Implementation Roadmap

### Phase 1: Core Editor (MVP)
- File browser
- Monaco code editor
- Basic preview
- Save/export EPUB
- EPUBCheck validation

### Phase 2: Accessibility Integration
- ACE audit integration
- Issue navigation
- Auto-fix application
- Visual metadata editor

### Phase 3: Advanced Features
- TOC editor
- Image manager with alt-text
- Search across files
- Undo/redo history

### Phase 4: Polish
- Keyboard shortcuts
- Themes (light/dark)
- Performance optimization
- PWA offline support

---

## 7. Conclusion

### 7.1 Can the Web Editor Handle All Manual Issues?

**Yes.** A fully-featured web EPUB editor can handle 100% of manual accessibility issues because:

1. All issues require editing XML/XHTML/CSS files
2. Monaco Editor provides full code editing capability
3. Visual editors (metadata, images) simplify common fixes
4. Integrated audit makes verification immediate

### 7.2 Remaining Gaps with Sigil

| Gap | Severity | User Impact |
|-----|----------|-------------|
| No plugin system | Low | Most users don't use plugins |
| No book splitting | Low | Rare use case |
| Offline mode | Medium | PWA can mitigate |
| Large file handling | Medium | Edge case, can optimize |

### 7.3 Web Editor Advantages Over Sigil

1. **Zero installation** - Works in any browser
2. **Accessibility-first** - Built for accessibility workflow
3. **Guided fixes** - Users don't need to know where to edit
4. **Visual editors** - Metadata/images without touching code
5. **Cloud storage** - Access projects anywhere
6. **Integration** - Part of complete Ninja workflow

---

**Document Version:** 1.0
**Author:** Claude Code
**Status:** Ready for Review
