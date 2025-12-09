# Ninja Platform Backend

## Project Overview
Ninja is an accessibility and compliance validation SaaS platform for educational publishers. It validates EPUB, PDF, and HTML content against WCAG 2.1, Section 508, and European Accessibility Act standards, generating VPATs and ACRs for government/institutional sales.

## Tech Stack
- Runtime: Node.js 20+
- Language: TypeScript 5.x (strict mode)
- Framework: Express 4.x
- Database: PostgreSQL (Prisma ORM)
- Queue: BullMQ with Redis
- Validation: Zod schemas
- AI: Google Gemini API

## Project Structure
```
src/
├── index.ts              # Application entry point
├── config/               # Environment configuration
├── routes/               # API route definitions
├── controllers/          # Request handlers
├── services/             # Business logic
├── middleware/           # Express middleware
├── models/               # Prisma models
├── queues/               # BullMQ job queues
├── workers/              # Background job processors
└── utils/                # Utility functions
```

## Critical Rules
1. NEVER commit secrets to Git
2. NEVER run DROP TABLE or DROP DATABASE
3. NEVER modify schema without approval
4. NEVER use Replit Agent for features - use approved Sprint Prompts only
5. Use ES Modules (import/export)
6. Use async/await for all async operations
7. Validate all inputs with Zod schemas

## API Conventions
- Base path: /api/v1/
- Use kebab-case for URLs
- Return standardized error responses
- Include request ID in all responses

## AI Integration (Gemini)
- Config: src/config/ai.config.ts
- Service: src/services/ai/gemini.service.ts
- Routes: /api/v1/ai/health (public), /api/v1/ai/test (authenticated)
- Models: gemini-2.0-flash-lite (default), gemini-2.5-pro (complex tasks)
- Features: Rate limiting, exponential backoff retry, text/image/chat generation
- Note: Free tier has strict limits (5-15 RPM). Enable billing for production use.

## Token Counting & Cost Tracking
- Pricing: src/config/pricing.config.ts (current Gemini rates)
- Service: src/services/ai/token-counter.service.ts
- Endpoints:
  - POST /api/v1/ai/estimate - Estimate cost before API call
  - GET /api/v1/ai/usage - Get usage summary for tenant
  - GET /api/v1/ai/usage/recent - Get recent usage records
- Features: Token estimation, cost calculation, per-tenant usage tracking

## PDF Parsing Service
- Config: src/config/pdf.config.ts (size limits, page limits, timeout)
- Service: src/services/pdf/pdf-parser.service.ts
- Libraries: pdf-lib + pdfjs-dist (legacy build for Node.js)
- Canvas: @napi-rs/canvas for Node.js DOM polyfills
- Endpoints:
  - POST /api/v1/pdf/parse - Parse PDF and return structure
  - POST /api/v1/pdf/metadata - Get metadata only
  - POST /api/v1/pdf/validate-basics - Basic accessibility checks
- Features: Metadata extraction, page info, outline/bookmarks, tagged PDF detection
- Security: Path validation with realpath to prevent traversal and symlink attacks

## PDF Text Extraction Service
- Service: src/services/pdf/text-extractor.service.ts
- Endpoints:
  - POST /api/v1/pdf/extract-text - Extract all text with positioning and structure
  - POST /api/v1/pdf/extract-page/:pageNumber - Extract text from specific page
  - POST /api/v1/pdf/text-stats - Get text statistics and structure analysis
- Features:
  - Text extraction with position information (x, y, width, height)
  - Font info extraction (name, size, bold, italic)
  - Line grouping with reading order detection
  - Block grouping (paragraph, heading, list, caption, footer, header)
  - Heading detection based on font size analysis
  - Language detection (en, ru, zh, ja, ko, ar, hi)
  - Reading order detection (left-to-right, right-to-left, mixed)
  - Word and character counting
- Options: includePositions, includeFontInfo, groupIntoLines, groupIntoBlocks, pageRange, normalizeWhitespace

## PDF Image Extraction Service
- Service: src/services/pdf/image-extractor.service.ts
- Libraries: sharp for image processing
- Endpoints:
  - POST /api/v1/pdf/extract-images - Extract all images from PDF
  - POST /api/v1/pdf/image/:imageId - Get single image by ID
  - POST /api/v1/pdf/image-stats - Get image statistics
- Features:
  - Image extraction with position and dimension information
  - Format detection (JPEG, PNG, JBIG2, JPX)
  - Alt text extraction from tagged PDF structure tree
  - Decorative/artifact image detection
  - Base64 encoding with optional resizing
  - Graphics state tracking for accurate image placement
  - OBJR reference resolution for structure tree mapping
- Options: includeBase64, maxImageSize, pageRange, formats, minWidth, minHeight

## PDF Structure Analysis Service
- Service: src/services/pdf/structure-analyzer.service.ts
- Endpoints:
  - POST /api/v1/pdf/analyze-structure - Full accessibility structure analysis
  - POST /api/v1/pdf/analyze-headings - Heading hierarchy analysis only
  - POST /api/v1/pdf/analyze-tables - Table structure analysis only
  - POST /api/v1/pdf/analyze-links - Link accessibility analysis only
- Features:
  - Heading hierarchy validation (H1 presence, proper nesting, skipped levels)
  - Table accessibility checks (header rows/columns, summaries)
  - List detection (ordered, unordered, definition lists)
  - Link analysis (descriptive text, URL extraction)
  - Reading order analysis (column detection, structure tree presence)
  - Language detection and validation (document language, language changes)
  - Form field analysis (labels, field types)
  - Bookmark/outline extraction
  - Accessibility score calculation (0-100 scale)
  - WCAG criterion mapping for issues
- Analysis Options: analyzeHeadings, analyzeTables, analyzeLists, analyzeLinks, analyzeReadingOrder, analyzeLanguage, pageRange
- Issue Severity Levels: critical, major, minor

## Database Commands
- Generate client: npx prisma generate
- Run migrations: npx prisma migrate dev
- View data: npx prisma studio

## Recovery Commands
If the Repl gets stuck:
- Restart: kill 1
- Clear cache: rm -rf node_modules/.cache
- Reinstall: rm -rf node_modules && npm install

## Development Workflow
1. Use approved Sprint Prompts from docs/sprint-prompts/
2. For debugging, use Claude Code (not Replit Agent)
3. Create feature branches: git checkout -b feat/NINJA-XXX-description
4. Commit with conventional prefixes: feat, fix, docs, chore, etc.
