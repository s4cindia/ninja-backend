# Ninja Platform Backend

## Overview
Ninja is an accessibility and compliance validation SaaS platform for educational publishers. It validates EPUB, PDF, and HTML content against WCAG 2.1, Section 508, and European Accessibility Act standards. The platform generates VPATs and ACRs to facilitate government and institutional sales.

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
The Ninja platform is built on a Node.js 20+ runtime using TypeScript 5.x in strict mode, with Express 4.x for the API. PostgreSQL is used as the database with Prisma ORM. Background jobs are managed using BullMQ with Redis. Input validation is enforced with Zod schemas.

**Key Technical Implementations:**
-   **AI Integration (Google Gemini):** Used for various AI-driven tasks, with support for `gemini-2.0-flash-lite` (default) and `gemini-2.5-pro` (complex tasks). Includes features like rate limiting, exponential backoff, token counting, and cost tracking.
-   **PDF Processing:**
    -   **PDF Parsing:** Extracts structure, metadata, page info, outlines, and detects tagged PDFs using `pdf-lib` and `pdfjs-dist`. Employs `@napi-rs/canvas` for Node.js DOM polyfills.
    -   **Text Extraction:** Extracts text with positioning, font information, line/block grouping, reading order detection, heading detection, and language detection.
    -   **Image Extraction:** Extracts images with position, dimensions, format detection, alt text extraction from tagged PDFs, and decorative image detection using `sharp`.
-   **Accessibility & Compliance Validation:**
    -   **WCAG 2.1 Validation:** Implements a rule-based engine against WCAG 2.1 criteria (A, AA, AAA levels) for text, images, structure, navigation, and forms.
    -   **Alt Text Validation:** Checks for presence, quality indicators (e.g., too short, filename as alt), and decorative image handling.
    -   **Color Contrast Validation:** Calculates WCAG luminance-based contrast ratios for text against AA and AAA thresholds, considering large text definitions.
    -   **Table Accessibility Validation:** Detects header cells, validates complex tables (merged cells), and identifies layout vs. data tables.
    -   **PDF/UA Compliance:** Validates against ISO 14289-1 (PDF/UA) and Matterhorn Protocol checkpoints, including identifier detection, structure tree, alt text, table structure, and language declarations.
    -   **Section 508 Mapping:** Maps WCAG 2.1 AA criteria to Section 508 Refresh, including E205 (Electronic Content), E205.4 (PDF/UA), Chapter 3 (Functional Performance Criteria), and Chapter 6 (Support Documentation). Generates "Best Meets" guidance and competitive positioning language.
    -   **Functional Performance Criteria (FPC) Validation:** Validates against Section 508 Chapter 3 FPC criteria (e.g., Without Vision, With Limited Vision), mapping to relevant WCAG criteria.
    -   **Chapter 6 Documentation Validation:** Validates compliance with Section 508 Chapter 6 requirements for support documentation, checking for accessibility statements, contact methods, and alternate formats.
-   **ACR/VPAT Generation:**
    -   **Multi-Edition Support:** Generates Accessibility Conformance Reports (ACRs) in four VPAT 2.5 editions:
        - **VPAT2.5-508:** Section 508 Edition (US Federal procurement)
        - **VPAT2.5-WCAG:** WCAG Edition (WCAG 2.1 A/AA/AAA)
        - **VPAT2.5-EU:** EU Edition (EN 301 549)
        - **VPAT2.5-INT:** International Edition (recommended - combines all standards in one document)
    -   Each edition returns distinct criteria sets with proper deduplication for the International edition.
    -   API endpoints: `POST /api/v1/acr/generate`, `GET /api/v1/acr/editions`, `GET /api/v1/acr/editions/:edition`
    -   **Confidence Level Indicators:** Each automated check includes a confidence assessment to indicate human verification needs:
        - **HIGH (90%+):** Automated verification reliable (e.g., color contrast, parsing, language declaration)
        - **MEDIUM (60-89%):** Automated + spot check recommended
        - **LOW (<60%):** Automated flagging only, human review required
        - **MANUAL_REQUIRED:** Cannot be automated (e.g., alt text quality, keyboard workflows, heading descriptiveness)
    -   API endpoints: `GET /api/v1/jobs/:id/confidence-summary`, `GET /api/v1/confidence/summary`, `GET /api/v1/confidence/criterion/:criterionId`
    -   **Human Verification Workflow:** Complete workflow for manual verification of accessibility criteria:
        - **Verification Queue:** Items sorted by severity (critical > serious > moderate > minor) and confidence level
        - **Verification Submission:** Record verification status (PENDING, VERIFIED_PASS, VERIFIED_FAIL, VERIFIED_PARTIAL, DEFERRED) with method and notes
        - **Bulk Verification:** Process multiple items at once with consistent verification data
        - **Audit Trail:** Complete history of all verification actions with timestamps, user IDs, and method details
        - **ACR Finalization Gate:** Prevents ACR finalization until all critical/serious severity and LOW/MANUAL_REQUIRED confidence items are verified
        - **Persistence:** Verification data stored in Job.output JSON field for durability across server restarts
        - **Item IDs:** Derived from validation result IDs for traceability (format: `resultId_criterionId`)
    -   API endpoints: `GET /api/v1/verification/:jobId/queue`, `POST /api/v1/verification/verify/:itemId`, `POST /api/v1/verification/bulk`, `GET /api/v1/verification/:jobId/audit-log`, `GET /api/v1/acr/:jobId/can-finalize`
    -   **Nuanced Compliance Status:** Conformance determination engine that prevents overstated compliance:
        - **Supports:** Only assigned when human verification confirms (VERIFIED_PASS) - never auto-populated
        - **Partially Supports:** Requires mandatory remarks with "what works" AND "limitations" explained
        - **Does Not Support:** Requires mandatory remarks with "reason" for non-compliance
        - **Not Applicable:** Requires justification for why criterion doesn't apply
        - **Credibility Warnings:** Warns if >95% of criteria marked 'Supports' (red flag for procurement teams)
        - **Quantitative Data:** All remarks include specific counts (e.g., "387 of 412 items passed")
        - **Remarks Validation:** Enforces minimum length and required keywords per conformance level
    -   API endpoints: `POST /api/v1/acr/:jobId/validate-credibility`, `GET /api/v1/acr/remarks-requirements`
    -   **AI Disclaimer and Attribution (US-3.3.5):** Legal protection system distinguishing AI-detected findings from human-verified ones:
        - **Attribution Tags:** Each finding tagged with `[AUTOMATED]`, `[AI-SUGGESTED]`, or `[HUMAN-VERIFIED]` markers in `attributedRemarks` field
        - **Assessment Methodology:** Every ACR includes methodology section with `toolVersion` (Ninja Platform v1.0), `aiModelInfo` (Google Gemini), and `disclaimer`
        - **Legal Disclaimer:** Footer disclaimer clarifies automated testing detects 30-57% of barriers and recommends professional review
        - **Alt Text Suggestions:** Criterion 1.1.1 receives special handling with "AI-Suggested - Requires Review" prefix for AI-generated alt text
        - **Integration Points:** Attribution system consumes verification data from human verification workflow; ready for full job pipeline integration
    -   API endpoints: `GET /api/v1/acr/:jobId/methodology`
    -   **AI-Assisted Remarks Generation (US-3.3.6):** Generates detailed remarks with quantitative data:
        - **Gemini AI Integration:** Uses Gemini to generate professional accessibility conformance remarks
        - **Quantitative Data:** Includes specific counts (e.g., "387 of 412 images have appropriate alt text")
        - **Conformance-Specific:** Adapts remarks based on conformance level (Supports, Partially Supports, Does Not Support, Not Applicable)
        - **Suggested Edits:** Provides AI suggestions for improving remarks
        - **Fallback Support:** Falls back to template-based generation if AI unavailable
        - **Manual Editing:** All AI-generated remarks can be edited by users before finalizing
    -   API endpoints: `POST /api/v1/acr/generate-remarks`

**UI/UX Decisions:**
- API Base Path: `/api/v1/`
- URLs use kebab-case.
- Standardized error responses with request IDs.

**Project Structure:**
- `src/index.ts`: Application entry point
- `src/config/`: Environment configuration
- `src/routes/`: API route definitions
- `src/controllers/`: Request handlers
- `src/services/`: Business logic
- `src/middleware/`: Express middleware
- `src/models/`: Prisma models
- `src/queues/`: BullMQ job queues
- `src/workers/`: Background job processors
- `src/utils/`: Utility functions

## External Dependencies
-   **Database:** PostgreSQL
-   **ORM:** Prisma
-   **Queue:** BullMQ, Redis
-   **AI:** Google Gemini API
-   **PDF Processing:** `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`
-   **Image Processing:** `sharp`
-   **Input Validation:** Zod
-   **Testing:** Vitest