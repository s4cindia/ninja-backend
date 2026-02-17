# Ninja Quick Fix Panel & Code Editor - Technical Specification

**Document:** Quick Fix Panel and Monaco Code Editor Specification
**Version:** 1.0
**Created:** December 26, 2025
**Status:** Proposal

---

## Executive Summary

This document specifies two complementary features for in-browser EPUB accessibility remediation:

1. **Quick Fix Panel** - Guided, checkbox-based fixes for common issues
2. **Monaco Code Editor** - Full code editing for advanced/complex fixes

**These features are NOT mutually exclusive** - they build on each other to provide a complete remediation experience for users of all skill levels.

---

## 1. Relationship Between Features

### 1.1 Progressive Enhancement Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     USER SKILL PROGRESSION                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   BEGINNER                    INTERMEDIATE                 ADVANCED     │
│   ─────────                   ────────────                 ────────     │
│                                                                         │
│   ┌───────────────┐          ┌───────────────┐          ┌───────────┐ │
│   │  Quick Fix    │   ───▶   │  Quick Fix    │   ───▶   │  Monaco   │ │
│   │  Panel Only   │          │  + Preview    │          │  Editor   │ │
│   └───────────────┘          └───────────────┘          └───────────┘ │
│                                                                         │
│   • Checkboxes               • See code changes          • Full edit   │
│   • One-click apply          • Understand diffs          • Any change  │
│   • No code knowledge        • Learn patterns            • Power user  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 How They Build On Each Other

| Phase | Component | Builds On | User Capability |
|-------|-----------|-----------|-----------------|
| **Phase 1** | Quick Fix Panel | - | Apply predefined fixes via UI |
| **Phase 2** | Code Preview | Phase 1 | See what Quick Fix changes |
| **Phase 3** | Monaco Editor | Phase 1+2 | Edit any code manually |
| **Phase 4** | Integrated | All | Seamless switching between modes |

### 1.3 Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        REMEDIATION INTERFACE                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      ISSUE CARD                                  │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ METADATA-ACCESSMODE (critical)            [Quick Fix ▼] │    │   │
│  │  │ Publications must declare 'schema:accessMode' metadata   │    │   │
│  │  │ Location: content.opf                                    │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                  │   │
│  │  ┌─── TABS ────────────────────────────────────────────────┐    │   │
│  │  │ [Quick Fix] │ [Code Preview] │ [Edit Code]              │    │   │
│  │  ├─────────────────────────────────────────────────────────┤    │   │
│  │  │                                                         │    │   │
│  │  │          << Content based on selected tab >>            │    │   │
│  │  │                                                         │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Quick Fix Panel Specification

### 2.1 Overview

The Quick Fix Panel provides a **guided, form-based interface** for applying common accessibility fixes without requiring users to write or understand code.

### 2.2 User Interface Design

#### 2.2.1 Main Panel Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Quick Fix: Add Access Mode Metadata                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  This EPUB is missing required accessibility metadata.                  │
│  Select the access modes that apply to your content:                    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  📖 Access Modes (how content can be perceived)                   │ │
│  │  ──────────────────────────────────────────────────────────────── │ │
│  │                                                                   │ │
│  │  ☑ textual    - Content includes text that can be read           │ │
│  │  ☑ visual     - Content includes images, charts, or visual elements│ │
│  │  ☐ auditory   - Content includes audio                           │ │
│  │  ☐ tactile    - Content requires touch interaction               │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  ✅ Sufficient Access Mode (minimum needed to consume content)    │ │
│  │  ──────────────────────────────────────────────────────────────── │ │
│  │                                                                   │ │
│  │  ◉ textual    - Text alone is sufficient                         │ │
│  │  ○ visual     - Visual content is required                       │ │
│  │  ○ textual,visual - Both are needed                              │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  📝 Preview Changes                                    [Expand ▼] │ │
│  │  ──────────────────────────────────────────────────────────────── │ │
│  │  + <meta property="schema:accessMode">textual</meta>              │ │
│  │  + <meta property="schema:accessMode">visual</meta>               │ │
│  │  + <meta property="schema:accessModeSufficient">textual</meta>    │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐   │
│  │  Apply Fix     │  │  Edit Manually │  │  Skip                  │   │
│  │  ────────────  │  │  ────────────  │  │  ────                  │   │
│  └────────────────┘  └────────────────┘  └────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 2.2.2 Quick Fix Templates by Issue Type

##### METADATA-ACCESSMODE

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Add Access Mode Metadata                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  How can users perceive your content?                                   │
│                                                                         │
│  Access Modes: (select all that apply)                                  │
│  ☑ textual   - Readable text content                                    │
│  ☑ visual    - Images, diagrams, charts                                 │
│  ☐ auditory  - Audio content                                            │
│                                                                         │
│  Sufficient Mode: (minimum required)                                    │
│  ◉ textual                                                              │
│  ○ visual                                                               │
│  ○ textual,visual                                                       │
│                                                                         │
│  [Apply Fix]                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

##### METADATA-ACCESSIBILITYFEATURE

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Add Accessibility Features                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  What accessibility features does your EPUB include?                    │
│                                                                         │
│  Navigation Features:                                                   │
│  ☑ tableOfContents      - Has table of contents                         │
│  ☑ structuralNavigation - Proper heading structure                      │
│  ☑ readingOrder         - Logical reading sequence                      │
│  ☐ index                - Has searchable index                          │
│                                                                         │
│  Content Features:                                                      │
│  ☐ alternativeText      - Images have alt text                          │
│  ☐ longDescription      - Complex images have descriptions              │
│  ☐ captions             - Videos have captions                          │
│  ☐ transcript           - Audio has transcripts                         │
│                                                                         │
│  [Apply Fix]                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

##### METADATA-ACCESSIBILITYHAZARD

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Declare Accessibility Hazards                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Does your content contain any of these hazards?                        │
│                                                                         │
│  ◉ none          - No hazards (most common)                             │
│  ○ flashing      - Contains flashing/strobing content                   │
│  ○ motion        - Contains motion simulation                           │
│  ○ sound         - Contains sudden loud sounds                          │
│                                                                         │
│  ⚠️ If your content has multiple hazards, select all that apply:        │
│  ☐ flashing                                                             │
│  ☐ motionSimulation                                                     │
│  ☐ sound                                                                │
│                                                                         │
│  [Apply Fix]                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

##### METADATA-ACCESSIBILITYSUMMARY

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Add Accessibility Summary                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Describe the accessibility features of your publication:               │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ This publication includes:                                        │ │
│  │ - Structured navigation with a complete table of contents         │ │
│  │ - Proper heading hierarchy for screen reader navigation           │ │
│  │ - Alternative text for all meaningful images                      │ │
│  │ - Logical reading order throughout                                │ │
│  │                                                                   │ │
│  │ It conforms to WCAG 2.0 Level AA guidelines.                     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  Or use a template:                                                     │
│  [📝 Basic Template]  [📝 Detailed Template]  [📝 WCAG AA Template]    │
│                                                                         │
│  [Apply Fix]                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

##### LANDMARK-UNIQUE

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Fix Duplicate Landmarks                                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Found 2 navigation landmarks without unique labels.                    │
│  Assign a unique label to each:                                         │
│                                                                         │
│  Landmark 1: <nav epub:type="toc">                                      │
│  Label: [Table of Contents_________________]                            │
│                                                                         │
│  Landmark 2: <nav epub:type="landmarks">                                │
│  Label: [Landmarks_________________________]                            │
│                                                                         │
│  Preview:                                                               │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ <nav epub:type="toc" aria-label="Table of Contents">              │ │
│  │ <nav epub:type="landmarks" aria-label="Landmarks">                │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  [Apply Fix]                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

##### COLOR-CONTRAST

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Fix Color Contrast                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Current colors have insufficient contrast (3.92:1, needs 4.5:1)        │
│                                                                         │
│  Current:                           Suggested Fix:                      │
│  ┌─────────────────────────┐       ┌─────────────────────────┐        │
│  │ ████████████████████████│       │ ████████████████████████│        │
│  │ Text: #808080           │  ──▶  │ Text: #595959           │        │
│  │ Background: #fffff5     │       │ Background: #fffff5     │        │
│  │ Ratio: 3.92:1 ❌        │       │ Ratio: 7.0:1 ✅         │        │
│  └─────────────────────────┘       └─────────────────────────┘        │
│                                                                         │
│  Or choose your own colors:                                             │
│  Text Color:       [#595959] 🎨                                         │
│  Background Color: [#fffff5] 🎨                                         │
│  Contrast Ratio:   7.0:1 ✅                                             │
│                                                                         │
│  [Apply Suggested Fix]  [Apply Custom Colors]                           │
└─────────────────────────────────────────────────────────────────────────┘
```

##### IMAGE-ALT (With AI Suggestion)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔧 Add Image Alt Text                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Image: images/chart1.png                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │              [Image Preview]                                    │   │
│  │                                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Is this image decorative (no informational content)?                   │
│  ○ Yes, decorative only  →  Will use alt=""                            │
│  ◉ No, it conveys information                                          │
│                                                                         │
│  Enter alt text:                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Bar chart showing quarterly sales: Q1 $10M, Q2 $12M, Q3 $15M,    │ │
│  │ Q4 $18M, representing 80% year-over-year growth                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  [🤖 Generate with AI]  [Apply Fix]                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Technical Implementation

#### 2.3.1 Component Architecture

```typescript
// Quick Fix Panel Component Structure

interface QuickFixPanelProps {
  issue: AccessibilityIssue;
  epubContent: EpubContent;
  onApplyFix: (fix: QuickFix) => Promise<void>;
  onEditManually: () => void;
  onSkip: () => void;
}

interface QuickFix {
  issueId: string;
  targetFile: string;
  changes: FileChange[];
  metadata?: Record<string, unknown>;
}

interface FileChange {
  type: 'insert' | 'replace' | 'delete';
  path: string;        // XPath or CSS selector
  content: string;     // New content
  oldContent?: string; // For replace
}
```

#### 2.3.2 Quick Fix Templates

```typescript
// src/data/quickFixTemplates.ts

export const quickFixTemplates: Record<string, QuickFixTemplate> = {
  'metadata-accessmode': {
    id: 'metadata-accessmode',
    title: 'Add Access Mode Metadata',
    description: 'Select how users can perceive your content',
    targetFile: 'content.opf',
    inputs: [
      {
        type: 'checkbox-group',
        id: 'accessModes',
        label: 'Access Modes',
        options: [
          { value: 'textual', label: 'Textual', description: 'Readable text content', default: true },
          { value: 'visual', label: 'Visual', description: 'Images, diagrams, charts', default: true },
          { value: 'auditory', label: 'Auditory', description: 'Audio content', default: false },
        ],
      },
      {
        type: 'radio-group',
        id: 'accessModeSufficient',
        label: 'Sufficient Access Mode',
        options: [
          { value: 'textual', label: 'Textual only', default: true },
          { value: 'visual', label: 'Visual only' },
          { value: 'textual,visual', label: 'Both required' },
        ],
      },
    ],
    generateFix: (inputs) => {
      const changes: string[] = [];
      inputs.accessModes.forEach((mode: string) => {
        changes.push(`<meta property="schema:accessMode">${mode}</meta>`);
      });
      changes.push(`<meta property="schema:accessModeSufficient">${inputs.accessModeSufficient}</meta>`);
      return {
        type: 'insert',
        path: '//metadata',
        position: 'before-end',
        content: changes.join('\n'),
      };
    },
  },

  'landmark-unique': {
    id: 'landmark-unique',
    title: 'Fix Duplicate Landmarks',
    description: 'Assign unique labels to navigation landmarks',
    targetFile: 'dynamic', // Determined from issue location
    inputs: [
      {
        type: 'landmark-labels',
        id: 'labels',
        // Dynamically populated from detected landmarks
      },
    ],
    generateFix: (inputs, context) => {
      return context.landmarks.map((landmark, i) => ({
        type: 'attribute',
        selector: landmark.selector,
        attribute: 'aria-label',
        value: inputs.labels[i],
      }));
    },
  },

  'color-contrast': {
    id: 'color-contrast',
    title: 'Fix Color Contrast',
    description: 'Adjust colors to meet WCAG contrast requirements',
    targetFile: 'dynamic',
    inputs: [
      {
        type: 'color-picker',
        id: 'foreground',
        label: 'Text Color',
        suggestCompliant: true,
      },
      {
        type: 'color-picker',
        id: 'background',
        label: 'Background Color',
      },
      {
        type: 'contrast-preview',
        id: 'preview',
        minRatio: 4.5,
      },
    ],
    generateFix: (inputs, context) => ({
      type: 'css-property',
      selector: context.selector,
      properties: {
        color: inputs.foreground,
        'background-color': inputs.background,
      },
    }),
  },
};
```

#### 2.3.3 React Components

```tsx
// src/components/quickfix/QuickFixPanel.tsx

import { useState } from 'react';
import { QuickFixTemplate, AccessibilityIssue } from '@/types';
import { getQuickFixTemplate } from '@/data/quickFixTemplates';
import { generateFixPreview, applyFix } from '@/services/fixService';

export function QuickFixPanel({ issue, onComplete }: QuickFixPanelProps) {
  const template = getQuickFixTemplate(issue.code);
  const [inputs, setInputs] = useState(template.defaultValues);
  const [preview, setPreview] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const handleInputChange = async (id: string, value: any) => {
    const newInputs = { ...inputs, [id]: value };
    setInputs(newInputs);

    // Generate preview
    const fixPreview = await generateFixPreview(template, newInputs, issue);
    setPreview(fixPreview);
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      await applyFix(template, inputs, issue);
      onComplete({ success: true });
    } catch (error) {
      onComplete({ success: false, error });
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="quick-fix-panel">
      <header className="flex items-center gap-2 p-4 border-b">
        <Wrench className="h-5 w-5 text-blue-600" />
        <h3 className="font-semibold">{template.title}</h3>
      </header>

      <div className="p-4 space-y-4">
        <p className="text-gray-600">{template.description}</p>

        {/* Dynamic Input Fields */}
        {template.inputs.map((input) => (
          <QuickFixInput
            key={input.id}
            config={input}
            value={inputs[input.id]}
            onChange={(value) => handleInputChange(input.id, value)}
          />
        ))}

        {/* Preview Section */}
        {preview && (
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-3 py-2 text-sm font-medium">
              Preview Changes
            </div>
            <pre className="p-3 bg-gray-50 text-sm overflow-x-auto">
              <code dangerouslySetInnerHTML={{ __html: preview }} />
            </pre>
          </div>
        )}
      </div>

      <footer className="flex gap-2 p-4 border-t">
        <Button onClick={handleApply} disabled={isApplying}>
          {isApplying ? 'Applying...' : 'Apply Fix'}
        </Button>
        <Button variant="outline" onClick={() => onEditManually()}>
          Edit Manually
        </Button>
        <Button variant="ghost" onClick={() => onSkip()}>
          Skip
        </Button>
      </footer>
    </div>
  );
}
```

---

## 3. Monaco Code Editor Specification

### 3.1 Overview

The Monaco Code Editor provides **full code editing capability** for users who need to make custom changes or handle complex issues that Quick Fix cannot address.

### 3.2 User Interface Design

#### 3.2.1 Editor Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  📝 Edit: content.opf                              [Format] [Save] [✕] │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────┬────────────────────────────────────────────────────────────┐  │
│  │ 1   │ <?xml version="1.0" encoding="UTF-8"?>                     │  │
│  │ 2   │ <package xmlns="http://www.idpf.org/2007/opf" version="3.0">│  │
│  │ 3   │   <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">   │  │
│  │ 4   │     <dc:title>The Waste Land</dc:title>                    │  │
│  │ 5   │     <dc:creator>T.S. Eliot</dc:creator>                    │  │
│  │ 6   │     <dc:language>en</dc:language>                          │  │
│  │ 7 ⚠│     <!-- Missing accessMode metadata -->                    │  │
│  │ 8   │   </metadata>                                              │  │
│  │ 9   │   <manifest>                                               │  │
│  │ 10  │     <item id="nav" href="nav.xhtml"                        │  │
│  │ 11  │           media-type="application/xhtml+xml"               │  │
│  │ 12  │           properties="nav"/>                               │  │
│  │ ... │     ...                                                    │  │
│  └─────┴────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Problems (1)  │  Quick Fixes                                   │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │  ⚠ Line 7: Missing schema:accessMode metadata          [Fix]   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 3.2.2 Features

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      MONACO EDITOR FEATURES                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  CODE EDITING                     NAVIGATION                            │
│  ────────────                     ──────────                            │
│  ✓ Syntax highlighting           ✓ Go to line (Ctrl+G)                 │
│  ✓ Auto-indentation              ✓ Go to definition                    │
│  ✓ Bracket matching              ✓ Find all references                 │
│  ✓ Code folding                  ✓ Breadcrumb navigation               │
│  ✓ Multi-cursor editing          ✓ Minimap                             │
│  ✓ Auto-completion               ✓ Outline view                        │
│                                                                         │
│  SEARCH                           ACCESSIBILITY                         │
│  ──────                           ─────────────                         │
│  ✓ Find (Ctrl+F)                 ✓ Issue markers in gutter             │
│  ✓ Replace (Ctrl+H)              ✓ Hover for issue details             │
│  ✓ Find in files                 ✓ Quick fix suggestions (💡)           │
│  ✓ Regex support                 ✓ Jump to next/prev issue             │
│                                                                         │
│  FORMATTING                       VALIDATION                            │
│  ──────────                       ──────────                            │
│  ✓ Format document               ✓ Real-time XML validation            │
│  ✓ Format selection              ✓ EPUBCheck integration               │
│  ✓ Configurable rules            ✓ Error/warning highlighting          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Technical Implementation

#### 3.3.1 Monaco Configuration

```typescript
// src/components/editor/MonacoEditor.tsx

import Editor, { Monaco } from '@monaco-editor/react';
import { useRef, useEffect } from 'react';

interface MonacoEditorProps {
  file: EpubFile;
  onChange: (content: string) => void;
  onSave: () => void;
  issues: AccessibilityIssue[];
}

export function MonacoEditor({ file, onChange, onSave, issues }: MonacoEditorProps) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const handleEditorMount = (editor: any, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Register custom language features
    registerXMLLanguageFeatures(monaco);

    // Add keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSave();
    });

    // Set up accessibility markers
    updateAccessibilityMarkers(editor, monaco, issues);
  };

  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      updateAccessibilityMarkers(editorRef.current, monacoRef.current, issues);
    }
  }, [issues]);

  return (
    <Editor
      height="100%"
      language={getLanguageFromFile(file.path)}
      value={file.content}
      onChange={(value) => onChange(value || '')}
      onMount={handleEditorMount}
      options={{
        minimap: { enabled: true },
        lineNumbers: 'on',
        folding: true,
        wordWrap: 'on',
        automaticLayout: true,
        formatOnPaste: true,
        formatOnType: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        guides: {
          bracketPairs: true,
          indentation: true,
        },
      }}
      theme="vs-light"
    />
  );
}
```

#### 3.3.2 Accessibility Markers

```typescript
// src/services/editorMarkers.ts

export function updateAccessibilityMarkers(
  editor: any,
  monaco: Monaco,
  issues: AccessibilityIssue[]
) {
  const model = editor.getModel();
  if (!model) return;

  const markers = issues.map((issue) => ({
    severity: getSeverity(monaco, issue.severity),
    startLineNumber: issue.line,
    startColumn: issue.column || 1,
    endLineNumber: issue.line,
    endColumn: issue.endColumn || model.getLineMaxColumn(issue.line),
    message: issue.message,
    code: issue.code,
    source: 'Accessibility',
  }));

  monaco.editor.setModelMarkers(model, 'accessibility', markers);
}

function getSeverity(monaco: Monaco, severity: string) {
  switch (severity) {
    case 'critical':
    case 'serious':
      return monaco.MarkerSeverity.Error;
    case 'moderate':
      return monaco.MarkerSeverity.Warning;
    case 'minor':
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}
```

#### 3.3.3 Quick Fix Code Actions

```typescript
// src/services/codeActions.ts

export function registerCodeActionProvider(monaco: Monaco) {
  monaco.languages.registerCodeActionProvider('xml', {
    provideCodeActions: (model, range, context) => {
      const markers = context.markers.filter(m => m.source === 'Accessibility');

      const actions = markers.flatMap((marker) => {
        const fixes = getQuickFixesForIssue(marker.code);
        return fixes.map((fix) => ({
          title: fix.title,
          kind: 'quickfix',
          diagnostics: [marker],
          edit: {
            edits: [
              {
                resource: model.uri,
                edit: {
                  range: new monaco.Range(
                    marker.startLineNumber,
                    marker.startColumn,
                    marker.endLineNumber,
                    marker.endColumn
                  ),
                  text: fix.replacement,
                },
              },
            ],
          },
        }));
      });

      return { actions, dispose: () => {} };
    },
  });
}
```

#### 3.3.4 File Browser Integration

```typescript
// src/components/editor/FileBrowser.tsx

import { Tree } from 'react-arborist';

interface FileBrowserProps {
  files: EpubFileTree;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  issuesByFile: Map<string, AccessibilityIssue[]>;
}

export function FileBrowser({
  files,
  selectedFile,
  onFileSelect,
  issuesByFile,
}: FileBrowserProps) {
  return (
    <div className="h-full overflow-auto">
      <Tree
        data={files}
        openByDefault={false}
        selection={selectedFile}
        onSelect={(nodes) => {
          if (nodes.length > 0 && !nodes[0].isFolder) {
            onFileSelect(nodes[0].id);
          }
        }}
      >
        {({ node, style, dragHandle }) => (
          <div
            style={style}
            ref={dragHandle}
            className={`flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-gray-100
              ${node.isSelected ? 'bg-blue-100' : ''}`}
          >
            {node.isFolder ? (
              <Folder className="h-4 w-4" />
            ) : (
              <FileIcon extension={getExtension(node.id)} />
            )}
            <span className="truncate">{node.data.name}</span>
            {issuesByFile.get(node.id)?.length > 0 && (
              <IssueIndicator count={issuesByFile.get(node.id)!.length} />
            )}
          </div>
        )}
      </Tree>
    </div>
  );
}
```

---

## 4. Integration: Quick Fix + Monaco Editor

### 4.1 Seamless Switching

```typescript
// src/components/remediation/RemediationPanel.tsx

export function RemediationPanel({ issue }: { issue: AccessibilityIssue }) {
  const [mode, setMode] = useState<'quickfix' | 'preview' | 'editor'>('quickfix');
  const [fileContent, setFileContent] = useState<string>('');

  const template = getQuickFixTemplate(issue.code);

  return (
    <div className="h-full flex flex-col">
      {/* Mode Tabs */}
      <div className="flex border-b">
        <Tab active={mode === 'quickfix'} onClick={() => setMode('quickfix')}>
          Quick Fix
        </Tab>
        <Tab active={mode === 'preview'} onClick={() => setMode('preview')}>
          Code Preview
        </Tab>
        <Tab active={mode === 'editor'} onClick={() => setMode('editor')}>
          Edit Code
        </Tab>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mode === 'quickfix' && template && (
          <QuickFixPanel
            issue={issue}
            template={template}
            onEditManually={() => setMode('editor')}
          />
        )}

        {mode === 'preview' && (
          <DiffPreview
            original={fileContent}
            modified={getPreviewContent()}
          />
        )}

        {mode === 'editor' && (
          <MonacoEditor
            file={getFileForIssue(issue)}
            issues={[issue]}
            onChange={setFileContent}
          />
        )}
      </div>
    </div>
  );
}
```

### 4.2 Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    INTEGRATED REMEDIATION WORKFLOW                       │
└─────────────────────────────────────────────────────────────────────────┘

                         User sees accessibility issue
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │  Quick Fix Template Available? │
                    └────────────────┬───────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼ Yes                             ▼ No
         ┌──────────────────┐              ┌──────────────────┐
         │  Show Quick Fix  │              │  Show Monaco     │
         │  Panel           │              │  Editor directly │
         └────────┬─────────┘              └────────┬─────────┘
                  │                                 │
                  ▼                                 │
         ┌──────────────────┐                      │
         │  User fills form │                      │
         └────────┬─────────┘                      │
                  │                                 │
         ┌────────┴─────────┐                      │
         │                  │                       │
         ▼                  ▼                       │
    ┌─────────┐      ┌──────────────┐              │
    │ Apply   │      │ Edit Manually │─────────────┤
    │ Fix     │      │ (Monaco)      │             │
    └────┬────┘      └──────────────┘              │
         │                                         │
         └─────────────────┬───────────────────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │  Re-audit to     │
                  │  verify fix      │
                  └──────────────────┘
```

---

## 5. Implementation Roadmap

### Phase 1: Quick Fix Panel (4-6 weeks)

| Week | Deliverable |
|------|-------------|
| 1-2 | Quick Fix template system & core components |
| 3 | Metadata issue templates (accessMode, features, hazards, summary) |
| 4 | Landmark & structure issue templates |
| 5 | Color contrast & image alt templates |
| 6 | Testing, refinement, documentation |

### Phase 2: Monaco Editor (4-6 weeks)

| Week | Deliverable |
|------|-------------|
| 1-2 | Monaco integration, file loading, basic editing |
| 3 | Accessibility markers & issue highlighting |
| 4 | Quick fix code actions & suggestions |
| 5 | File browser & multi-file support |
| 6 | Testing, refinement, documentation |

### Phase 3: Integration (2-3 weeks)

| Week | Deliverable |
|------|-------------|
| 1 | Tab-based switching between modes |
| 2 | Diff preview, seamless data flow |
| 3 | Polish, edge cases, documentation |

---

## 6. Technology Summary

| Component | Technology | Purpose |
|-----------|------------|---------|
| Quick Fix UI | React + shadcn/ui | Form-based fix interface |
| Code Editor | Monaco Editor | VS Code-quality editing |
| State Management | Zustand | Shared state between modes |
| Diff View | Monaco Diff Editor | Show before/after changes |
| XML Parsing | fast-xml-parser | Parse & modify EPUB XML |
| Color Picker | react-colorful | Color contrast fixes |
| File Tree | react-arborist | File browser |

---

## 7. Summary

### 7.1 Are Quick Fix and Monaco Editor Mutually Exclusive?

**No.** They are complementary features that build on each other:

| Scenario | Best Tool | Why |
|----------|-----------|-----|
| Common metadata issues | Quick Fix | Checkboxes faster than code |
| Color contrast | Quick Fix | Visual picker + validation |
| Landmark labels | Quick Fix | Form input is cleaner |
| Complex structural issues | Monaco | Need full code control |
| Custom modifications | Monaco | No predefined template |
| Learning how fixes work | Preview | See code changes |

### 7.2 Implementation Recommendation

```
Phase 1: Quick Fix Panel
         ↓
Phase 2: Monaco Editor
         ↓
Phase 3: Integration (tabs, preview, seamless switching)
```

This approach:
1. Delivers value quickly (Quick Fix covers 80% of issues)
2. Builds incrementally (Monaco adds power-user capability)
3. Creates a complete solution (integrated experience)

---

**Document Version:** 1.0
**Author:** Claude Code
**Status:** Ready for Review
