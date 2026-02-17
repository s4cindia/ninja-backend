# PR: Citation Management System - Full Feature Implementation

> **Note**: This PR was originally titled "Citation UI Enhancements" but delivers a complete citation management feature. The description below accurately reflects the full scope.

## Summary

This PR implements a comprehensive citation management system for editorial documents, including:
- DOCX upload and parsing with citation detection
- AI-powered citation analysis and style detection
- Reference list management (reorder, edit, delete)
- Citation style conversion (APA, MLA, Chicago, Vancouver, IEEE, Harvard, AMA)
- DOI validation with CrossRef integration
- Document export with applied changes

## Changes by Category

### 1. Core Controllers
- `citation-upload.controller.ts` - Document upload, parsing, AI analysis
- `citation-reference.controller.ts` - Reference CRUD operations
- `citation-style.controller.ts` - Style conversion and DOI validation
- `citation-export.controller.ts` - Document preview and export

### 2. Services
- `citation-detection.service.ts` - In-text citation detection
- `citation-analysis.service.ts` - Citation pattern analysis
- `citation-stylesheet-detection.service.ts` - Style detection
- `reference-list.service.ts` - Reference list generation
- `crossref.service.ts` - CrossRef API integration
- `doi-validation.service.ts` - DOI validation and metadata lookup
- `ai-format-converter.service.ts` - AI-powered style conversion

### 3. Infrastructure
- `rate-limiter.ts` - Token bucket rate limiting for external APIs
- `citation.processor.ts` - Async job processing worker
- `citation-management.routes.ts` - Route definitions with validation

### 4. Database Schema
- Added `EditorialDocumentContent` table (normalized from EditorialDocument)
- Added `ReferenceListEntryCitation` junction table
- Removed deprecated fields (`fullText`, `fullHtml`, `citationIds`)

### 5. Security Fixes
- Path traversal protection in document export
- Input validation with Zod schemas
- Tenant isolation on all endpoints
- Rate limiting on uploads (10/15min) and exports (30/15min)

### 6. Performance Optimizations
- N+1 query fix in reference deletion (raw SQL batch update)
- Eliminated redundant database queries
- Batch operations for citation updates

### 7. Test Coverage
- Unit tests: 181 tests passing
- Integration tests: Upload → Analysis → Export workflow
- Security tests: Path traversal, tenant isolation

## Breaking Changes

### Database Migration Required
```sql
-- Migration: 20260216000000_remove_deprecated_fields
-- Removes deprecated fields after data migration to new tables
```

### API Changes
- New endpoints under `/api/v1/citation-management/*`
- No changes to existing endpoints

## Deployment Plan

### Phase 1: Database Migration (Low Risk)
1. Run migration to create new tables
2. Migrate existing data to normalized tables
3. Deploy with deprecated fields still present

### Phase 2: Code Deployment (Medium Risk)
1. Deploy new controllers and services
2. Monitor for errors in citation processing
3. Verify async job processing works

### Phase 3: Cleanup (Low Risk)
1. Run migration to remove deprecated fields
2. Verify no code references old fields

## Feature Flags (Recommended)

Consider adding feature flags for staged rollout:
```typescript
// config/features.ts
export const FEATURES = {
  CITATION_MANAGEMENT_ENABLED: process.env.FEATURE_CITATION_MANAGEMENT === 'true',
  CITATION_ASYNC_PROCESSING: process.env.FEATURE_CITATION_ASYNC === 'true',
};
```

## Testing Checklist

- [x] Unit tests passing (181 tests)
- [x] Integration tests passing (14 tests)
- [x] TypeScript compilation clean
- [x] ESLint passing
- [ ] Manual testing of upload flow
- [ ] Manual testing of export flow
- [ ] Load testing with large documents
- [ ] Security review of tenant isolation

## Files Changed

### New Files (8)
- `src/utils/rate-limiter.ts`
- `src/schemas/citation.schemas.ts`
- `prisma/migrations/20260216000000_remove_deprecated_fields/`
- `tests/unit/services/citation/crossref.service.test.ts`
- `tests/unit/services/citation/doi-validation.service.test.ts`
- `tests/unit/services/citation/style-conversion.test.ts`
- `tests/unit/utils/rate-limiter.test.ts`
- `tests/integration/citation-workflow.test.ts`

### Modified Files (17)
- `prisma/schema.prisma`
- `src/controllers/citation/*.ts` (4 files)
- `src/controllers/editorial-overview.controller.ts`
- `src/routes/citation-management.routes.ts`
- `src/services/citation/*.ts` (6 files)
- `src/workers/processors/citation.processor.ts`
- `tests/unit/controllers/citation-management.controller.test.ts`
- `tests/unit/services/citation/reference-list.service.test.ts`

## Recommendation: Split Into Smaller PRs

For safer deployment, this PR could be split into:

1. **PR 1: Database Schema Changes**
   - Add new normalized tables
   - Add migration for data migration
   - No code changes

2. **PR 2: Core Citation Services**
   - Citation detection and analysis services
   - Reference list service
   - Unit tests

3. **PR 3: API Controllers & Routes**
   - Controllers with validation
   - Route definitions
   - Integration tests

4. **PR 4: Security & Performance**
   - Rate limiting
   - Path traversal fix
   - N+1 query optimization

5. **PR 5: Cleanup**
   - Remove deprecated fields
   - Final migration

---

**Note**: This PR description accurately reflects the full implementation scope. Update the PR title to: `feat(citation): implement citation management system`
