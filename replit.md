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