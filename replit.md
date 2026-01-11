# Ninja Platform Backend

## Overview
Ninja is an accessibility and compliance validation SaaS platform for educational publishers. It validates EPUB, PDF, and HTML content against WCAG 2.1, Section 508, and European Accessibility Act standards. The platform generates VPATs and ACRs to facilitate government and institutional sales, ensuring content meets required accessibility benchmarks.

## User Preferences
1. Use approved Sprint Prompts from docs/sprint-prompts/
2. For debugging, use Claude Code (not Replit Agent)
3. Create feature branches: git checkout -b feat/NINJA-XXX-description
4. Commit with conventional prefixes: feat, fix, docs, chore, etc.
5. NEVER commit secrets to Git
6. NEVER run DROP TABLE or DROP DATABASE
7. NEVER modify schema without approval
8. NEVER use Replit Agent for features - use approved Sprint Prompts only

## System Architecture
The Ninja platform uses a Node.js 20+ runtime with TypeScript 5.x in strict mode, and Express 4.x for its API. PostgreSQL with Prisma ORM handles data, while BullMQ and Redis manage background jobs. Zod schemas are used for input validation.

**Key Technical Implementations:**
-   **AI Integration (Google Gemini):** Utilizes `gemini-2.0-flash-lite` (default) and `gemini-2.5-pro` for various AI-driven tasks, including rate limiting, exponential backoff, token counting, and cost tracking.
-   **PDF Processing:** Extracts structure, metadata, text (with positioning, font, reading order), and images (with alt text from tagged PDFs) using `pdf-lib`, `pdfjs-dist`, and `sharp`.
-   **Accessibility & Compliance Validation:**
    -   **WCAG 2.1 Validation:** Rule-based engine for A, AA, AAA criteria covering text, images, structure, navigation, and forms. Includes alt text quality, color contrast, and table accessibility checks.
    -   **PDF/UA Compliance:** Validates against ISO 14289-1 and Matterhorn Protocol.
    -   **Section 508 Mapping & FPC Validation:** Maps WCAG 2.1 AA to Section 508 Refresh (E205, E205.4, Chapter 3 FPC, Chapter 6 documentation).
-   **ACR/VPAT Generation:**
    -   **Multi-Edition Support:** Generates VPAT 2.5 editions (508, WCAG, EU, INT) with distinct criteria sets.
    -   **Confidence Level Indicators:** Assigns HIGH, MEDIUM, LOW, or MANUAL_REQUIRED confidence to automated checks, guiding human verification.
    -   **Human Verification Workflow:** Provides a complete workflow for manual verification, including queue management, bulk verification, audit trails, and ACR finalization gates.
    -   **Nuanced Compliance Status:** Conformance determination engine enforcing accurate status (Supports, Partially Supports, Does Not Support, Not Applicable) with mandatory remarks and credibility warnings.
    -   **AI Disclaimer and Attribution:** Distinguishes AI-detected findings from human-verified ones with attribution tags (`[AUTOMATED]`, `[AI-SUGGESTED]`, `[HUMAN-VERIFIED]`) and includes a legal disclaimer and assessment methodology in ACRs.
    -   **AI-Assisted Remarks Generation:** Uses Gemini to generate professional, quantitative remarks tailored to conformance levels, with options for suggested edits and manual editing.
    -   **ACR Document Export:** Exports ACRs to Word (.docx), PDF, and HTML formats, retaining attribution, methodology, and supporting branding options.
    -   **ACR Versioning and History:** Tracks ACR versions with timestamps, user attribution, change logs, and snapshots, enabling side-by-side comparisons.
-   **AI Alt Text Generation:**
    -   **Automated Alt Text:** Uses Google Gemini Vision (1.5 Pro) to generate accessible image descriptions, handling length constraints, forbidden prefixes, and detecting content flags (FACE_DETECTED, TEXT_IN_IMAGE).
    -   **Context-Aware Alt Text:** Extracts document context (surrounding text, headings, captions) to generate more relevant descriptions, providing both context-aware and standalone versions.
    -   **Chart/Diagram Descriptions:** Classifies images into types (e.g., BAR_CHART, LINE_CHART) and uses specialized prompts to extract data, analyze trends, and summarize key findings for complex visualizations, generating longer descriptions where needed.
    -   **Human Review Workflow:** Complete workflow for reviewing AI-generated alt text including review queue with filtering by status/confidence/flags, approve/edit/reject actions, regeneration with context, batch approval for high-confidence items (>85%), and audit trail tracking.
    -   **Long Descriptions:** Generates detailed prose descriptions (300-500 words) for complex images with aria-describedby support. Includes trigger detection (COMPLEX_CHART, FLOWCHART, DATA_TABLE, etc.), structured sections, and multiple output formats (HTML, Markdown, plain text).
-   **EPUB Accessibility Auditing:**
    -   **EPUBCheck Integration:** Validates EPUB structural compliance using EPUBCheck 5.1.0 (Java-based), detecting spec violations with original error codes (OPF-xxx, RSC-xxx).
    -   **JS Accessibility Auditor:** Lightweight JavaScript-based auditor that detects auto-fixable accessibility issues without requiring Java. Checks for missing language, accessibility metadata, alt text, table headers, heading hierarchy, and ARIA landmarks.
    -   **Combined Audit Results:** Merges EPUBCheck structural errors (manual fixes) with JS Auditor accessibility issues (auto-fixable) for comprehensive analysis.
    -   **Issue Codes:** EPUB-META-001 (language), EPUB-META-002 (accessibility features), EPUB-META-003 (accessibility summary), EPUB-META-004 (access modes), EPUB-IMG-001 (missing alt), EPUB-STRUCT-002 (table headers), EPUB-SEM-001 (HTML lang attribute).
-   **Issue Classification & Confidence Scoring:**
    -   **IssueClassificationService:** Analyzes EPUB content to determine issue complexity and calculate confidence scores.
    -   **Confidence Calculation:** Returns 0.0-1.0 based on issue type and context (e.g., simple tables: 0.95, complex tables: 0.70, decorative images: 0.98).
    -   **Context Analysis:** Analyzes table structure (simple/complex based on colspan, rowspan, nesting) and image type (decorative/content/chart/diagram).
    -   **Fix Classification:** Classifies issues as `autofix` (confidence ≥0.95, low risk), `quickfix` (confidence ≥0.70), or `manual`.
    -   **Similar Issues Grouping:** Groups quick-fixable tasks by fix type for batch operations.
    -   **Auto-Apply High-Confidence:** Automatically applies fixes for tasks with confidence ≥0.95 during remediation start.
-   **EPUB Auto-Remediation Engine:**
    -   **Supported Auto-Fixes:** 12 handlers for accessibility issues:
        -   EPUB-META-001: Add dc:language declaration
        -   EPUB-META-002: Add accessibility feature metadata
        -   EPUB-META-003: Add accessibility summary
        -   EPUB-META-004: Add access mode metadata
        -   EPUB-SEM-001: Add HTML lang attributes
        -   EPUB-SEM-002: Fix empty links with aria-label
        -   EPUB-IMG-001: Add alt text (specific or decorative)
        -   EPUB-STRUCT-002: Add table headers
        -   EPUB-STRUCT-003: Fix heading hierarchy (no skipped levels)
        -   EPUB-STRUCT-004: Add ARIA landmarks (main, navigation, banner, contentinfo)
        -   EPUB-NAV-001: Add skip navigation links
        -   EPUB-FIG-001: Add figure/figcaption structure
    -   **File-Based Storage:** EPUB files stored at `/tmp/epub-storage/{jobId}/` with remediated files in subdirectory.
    -   **Remediation Workflow:** Upload → Audit → Create Remediation Plan → Auto-Remediate → Download remediated EPUB.
    -   **Manual Fix Endpoint:** POST `/api/v1/epub/job/:jobId/apply-fix` allows applying specific fixes with custom options.
    -   **Quick Fix Endpoint:** POST `/api/v1/epub/job/:jobId/apply-quick-fix` allows applying arbitrary file changes (insert/replace/delete) to text-based EPUB files. Validates that target files are text-based (.opf, .xhtml, .html, .htm, .xml, .ncx, .css, .smil, .svg), ensures content anchors exist for replace/delete operations, and optionally updates remediation task status when complete.
-   **Feedback Collection:**
    -   **Feedback Model:** Dedicated Prisma model with FeedbackType and FeedbackStatus enums for proper type safety.
    -   **Feedback Types:** ACCESSIBILITY_ISSUE, ALT_TEXT_QUALITY, AUDIT_ACCURACY, REMEDIATION_SUGGESTION, GENERAL, BUG_REPORT, FEATURE_REQUEST.
    -   **Status Workflow:** NEW → REVIEWED → IN_PROGRESS → RESOLVED/DISMISSED.
    -   **Quick Ratings:** Thumbs up/down for alt-text, audits, and remediation suggestions.
    -   **Context Tracking:** Links feedback to specific jobs, images, alt-text, or issues.

**UI/UX Decisions:**
-   API Base Path: `/api/v1/`
-   URLs use kebab-case.
-   Standardized error responses with request IDs.

**Project Structure:**
The project follows a modular structure with dedicated directories for configuration (`config/`), routes (`routes/`), controllers (`controllers/`), services (`services/`), middleware (`middleware/`), Prisma models (`models/`), BullMQ queues (`queues/`) and workers (`workers/`), and utilities (`utils/`).

## External Dependencies
-   **Database:** PostgreSQL
-   **ORM:** Prisma
-   **Queue:** BullMQ, Redis
-   **AI:** Google Gemini API
-   **PDF Processing:** `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`
-   **Image Processing:** `sharp`
-   **Input Validation:** Zod
-   **Testing:** Vitest