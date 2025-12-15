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