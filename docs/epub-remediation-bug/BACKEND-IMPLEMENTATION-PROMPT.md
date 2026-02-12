# EPUB Remediation Validation Gap - Backend Fix

**Branch:** `fix/remediation-validation-gap-backend`
**Priority:** 🔴 CRITICAL
**Estimated Time:** 7-10 days (4 phases)

---

## Context

**Problem:** After EPUB remediation fixes all detected issues, the remediated EPUB still shows remaining issues because:
1. Only modified files are validated post-remediation (not the entire EPUB)
2. Initial audit has incomplete scope (misses cover pages, TOC, etc.)
3. Directory restructuring during remediation may introduce new issues

**Impact:** Users receive "100% issues fixed" messages when accessibility issues remain.

**Solution:** Implement full re-audit after remediation and expand initial audit scope to ALL files.

---

## 4-Phase Implementation Plan

### PHASE 1: Backend Critical Fix - Full Re-Audit (Days 1-3)
**Priority:** 🔴 CRITICAL

#### 1.1 Update Remediation Workflow Service

**File:** `src/services/epub/remediation-workflow.service.ts`

**Current Problem:**
```typescript
async completeRemediation(jobId: string) {
  const modifiedFiles = await this.getModifiedFiles(jobId);
  const validationResults = await this.validateFiles(modifiedFiles); // Only validates modified files!

  if (validationResults.allPassed) {
    return { success: true, message: "All issues fixed" }; // MISLEADING!
  }
}
```

**Required Changes:**

```typescript
async completeRemediation(jobId: string): Promise<RemediationResult> {
  try {
    // 1. Get original issues detected before remediation
    const originalIssues = await this.getOriginalIssues(jobId);
    logger.info(`Original issues count: ${originalIssues.length}`);

    // 2. Validate modified files (quick check)
    const modifiedFiles = await this.getModifiedFiles(jobId);
    const modifiedValidation = await this.validateFiles(modifiedFiles);
    logger.info(`Modified files validation: ${modifiedValidation.passed}/${modifiedValidation.total}`);

    // 3. CRITICAL: Perform full re-audit of entire EPUB
    logger.info('Starting full re-audit of entire EPUB...');
    const fullAudit = await this.auditService.runFullAudit(jobId);
    logger.info(`Full re-audit complete: ${fullAudit.issues.length} issues found`);

    // 4. Compare results
    const comparison = this.compareAuditResults(originalIssues, fullAudit.issues);

    // 5. Update job status with accurate information
    await this.updateJobStatus(jobId, {
      remediationComplete: true,
      originalIssuesCount: originalIssues.length,
      originalIssuesFixed: comparison.fixedCount,
      newIssuesFound: comparison.newIssues.length,
      totalRemainingIssues: fullAudit.issues.length,
      fullReAuditPerformed: true,
      auditCoverage: fullAudit.coverage
    });

    // 6. Return accurate status
    if (fullAudit.issues.length === 0) {
      return {
        success: true,
        message: 'All issues fixed - EPUB is fully compliant',
        details: {
          originalIssues: originalIssues.length,
          fixedIssues: comparison.fixedCount,
          newIssues: 0,
          remainingIssues: 0,
          auditCoverage: fullAudit.coverage
        }
      };
    } else {
      return {
        success: false,
        message: `Remediation incomplete: ${fullAudit.issues.length} issue(s) remain`,
        details: {
          originalIssues: originalIssues.length,
          fixedIssues: comparison.fixedCount,
          newIssues: comparison.newIssues.length,
          remainingIssues: fullAudit.issues.length,
          auditCoverage: fullAudit.coverage
        },
        remainingIssues: fullAudit.issues
      };
    }
  } catch (error) {
    logger.error('Error completing remediation:', error);
    throw new RemediationError('Failed to complete remediation', error);
  }
}

/**
 * Compare original issues with post-remediation audit results
 */
private compareAuditResults(
  originalIssues: Issue[],
  currentIssues: Issue[]
): ComparisonResult {
  // Track which original issues were fixed
  const fixedIssues: Issue[] = [];
  const unfixedIssues: Issue[] = [];

  for (const originalIssue of originalIssues) {
    const stillExists = currentIssues.some(current =>
      this.isSameIssue(originalIssue, current)
    );

    if (stillExists) {
      unfixedIssues.push(originalIssue);
    } else {
      fixedIssues.push(originalIssue);
    }
  }

  // Identify new issues not in original audit
  const newIssues = currentIssues.filter(current =>
    !originalIssues.some(original => this.isSameIssue(original, current))
  );

  return {
    fixedCount: fixedIssues.length,
    fixedIssues,
    unfixedCount: unfixedIssues.length,
    unfixedIssues,
    newIssues,
    totalRemaining: currentIssues.length
  };
}

/**
 * Check if two issues are the same (same file, same code, same location)
 */
private isSameIssue(issue1: Issue, issue2: Issue): boolean {
  return (
    issue1.code === issue2.code &&
    issue1.filePath === issue2.filePath &&
    issue1.location === issue2.location
  );
}

/**
 * Get original issues from job metadata
 */
private async getOriginalIssues(jobId: string): Promise<Issue[]> {
  const job = await this.jobRepository.findById(jobId);
  if (!job || !job.auditResults) {
    throw new Error(`No original audit results found for job ${jobId}`);
  }
  return job.auditResults.issues || [];
}
```

**Add TypeScript Interfaces:**

```typescript
interface RemediationResult {
  success: boolean;
  message: string;
  details: {
    originalIssues: number;
    fixedIssues: number;
    newIssues: number;
    remainingIssues: number;
    auditCoverage: AuditCoverage;
  };
  remainingIssues?: Issue[];
}

interface ComparisonResult {
  fixedCount: number;
  fixedIssues: Issue[];
  unfixedCount: number;
  unfixedIssues: Issue[];
  newIssues: Issue[];
  totalRemaining: number;
}

interface AuditCoverage {
  totalFiles: number;
  filesScanned: number;
  percentage: number;
  fileCategories: {
    frontMatter: number;
    chapters: number;
    backMatter: number;
  };
}
```

---

#### 1.2 Expand Audit Scope to All Files

**File:** `src/services/epub/audit.service.ts`

**Current Problem:** Only chapters are scanned, missing cover pages, TOC, etc.

**Required Changes:**

```typescript
/**
 * Audit entire EPUB - ALL XHTML files
 */
async auditEpub(epubPath: string): Promise<AuditResult> {
  try {
    // 1. Extract EPUB if needed
    const extractedPath = await this.extractEpub(epubPath);

    // 2. Get ALL content files (not just chapters!)
    const allFiles = await this.getAllContentFiles(extractedPath);
    logger.info(`Found ${allFiles.length} content files to audit`);

    // 3. Categorize files for reporting
    const categorized = this.categorizeFiles(allFiles);
    logger.info('File categories:', categorized);

    // 4. Scan all files
    const issues: Issue[] = [];
    for (const file of allFiles) {
      const fileIssues = await this.scanFile(file);
      issues.push(...fileIssues);
    }

    // 5. Calculate coverage
    const coverage: AuditCoverage = {
      totalFiles: allFiles.length,
      filesScanned: allFiles.length,
      percentage: 100,
      fileCategories: {
        frontMatter: categorized.frontMatter.length,
        chapters: categorized.chapters.length,
        backMatter: categorized.backMatter.length
      }
    };

    logger.info(`Audit complete: ${issues.length} issues found in ${allFiles.length} files`);

    return {
      issues,
      coverage,
      scannedFiles: allFiles.map(f => f.path)
    };
  } catch (error) {
    logger.error('Error auditing EPUB:', error);
    throw new AuditError('Failed to audit EPUB', error);
  }
}

/**
 * Get ALL XHTML/HTML content files in EPUB
 */
private async getAllContentFiles(epubPath: string): Promise<ContentFile[]> {
  const files: ContentFile[] = [];

  // Read OPF manifest to get all content files
  const opfPath = await this.findOpfFile(epubPath);
  const opfContent = await fs.readFile(opfPath, 'utf-8');
  const manifest = this.parseManifest(opfContent);

  // Get all XHTML/HTML files from manifest
  for (const item of manifest.items) {
    if (this.isContentFile(item.mediaType)) {
      const filePath = path.join(path.dirname(opfPath), item.href);
      files.push({
        path: filePath,
        id: item.id,
        type: this.getFileType(item.id, item.href),
        mediaType: item.mediaType
      });
    }
  }

  return files;
}

/**
 * Categorize files by type for reporting
 */
private categorizeFiles(files: ContentFile[]): CategorizedFiles {
  const result: CategorizedFiles = {
    frontMatter: [],
    chapters: [],
    backMatter: []
  };

  for (const file of files) {
    const fileName = path.basename(file.path).toLowerCase();

    // Front matter: cover, title, copyright, TOC, etc.
    if (
      fileName.includes('cover') ||
      fileName.includes('title') ||
      fileName.includes('copyright') ||
      fileName.includes('toc') ||
      fileName.startsWith('00_') ||
      fileName.startsWith('front')
    ) {
      result.frontMatter.push(file);
    }
    // Back matter: acknowledgments, appendix, glossary, etc.
    else if (
      fileName.includes('ack') ||
      fileName.includes('appendix') ||
      fileName.includes('glossary') ||
      fileName.includes('back') ||
      fileName.includes('endnotes')
    ) {
      result.backMatter.push(file);
    }
    // Chapters
    else {
      result.chapters.push(file);
    }
  }

  return result;
}

/**
 * Check if file is content (XHTML/HTML)
 */
private isContentFile(mediaType: string): boolean {
  return (
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'text/html' ||
    mediaType === 'application/html+xml'
  );
}

/**
 * Determine file type from ID and path
 */
private getFileType(id: string, href: string): string {
  const lower = (id + href).toLowerCase();

  if (lower.includes('cover')) return 'cover';
  if (lower.includes('toc')) return 'toc';
  if (lower.includes('title')) return 'title';
  if (lower.includes('chapter')) return 'chapter';
  if (lower.includes('ack')) return 'acknowledgment';

  return 'content';
}
```

**Add TypeScript Interfaces:**

```typescript
interface ContentFile {
  path: string;
  id: string;
  type: string;
  mediaType: string;
}

interface CategorizedFiles {
  frontMatter: ContentFile[];
  chapters: ContentFile[];
  backMatter: ContentFile[];
}

interface AuditResult {
  issues: Issue[];
  coverage: AuditCoverage;
  scannedFiles: string[];
}
```

---

#### 1.3 Add runFullAudit Method

**File:** `src/services/epub/audit.service.ts`

```typescript
/**
 * Run full audit on an existing job's EPUB
 */
async runFullAudit(jobId: string): Promise<AuditResult> {
  const job = await this.jobRepository.findById(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const epubPath = job.remediatedEpubPath || job.originalEpubPath;
  if (!epubPath) {
    throw new Error(`No EPUB path found for job ${jobId}`);
  }

  logger.info(`Running full audit for job ${jobId}`);
  return this.auditEpub(epubPath);
}
```

---

#### 1.4 Update API Endpoints

**File:** `src/controllers/remediation.controller.ts`

```typescript
/**
 * Get remediation results with full audit details
 */
@Get(':jobId/results')
async getRemediationResults(@Param('jobId') jobId: string) {
  const results = await this.remediationService.getRemediationResults(jobId);

  return {
    success: results.success,
    message: results.message,
    data: {
      originalIssues: results.details.originalIssues,
      fixedIssues: results.details.fixedIssues,
      newIssues: results.details.newIssues,
      remainingIssues: results.details.remainingIssues,
      auditCoverage: results.details.auditCoverage,
      remainingIssuesList: results.remainingIssues || []
    }
  };
}

/**
 * Trigger manual re-audit
 */
@Post(':jobId/re-audit')
async triggerReAudit(@Param('jobId') jobId: string) {
  const audit = await this.auditService.runFullAudit(jobId);

  return {
    success: true,
    message: `Re-audit complete: ${audit.issues.length} issues found`,
    data: {
      issuesFound: audit.issues.length,
      coverage: audit.coverage,
      issues: audit.issues
    }
  };
}
```

---

### PHASE 2: Structure Handler Enhancement (Days 4-5)
**Priority:** 🟡 MEDIUM

#### 2.1 Post-Restructuring Validation

**File:** `src/services/epub/structure-handler.service.ts`

**Add validation after directory restructuring:**

```typescript
async restructureEpub(jobId: string): Promise<void> {
  try {
    logger.info(`Starting EPUB restructuring for job ${jobId}`);

    // 1. Move files to new structure
    await this.moveFiles(jobId);
    logger.info('Files moved successfully');

    // 2. Update all internal references (links, images, etc.)
    await this.updateInternalLinks(jobId);
    logger.info('Internal links updated');

    // 3. Update OPF manifest with new paths
    await this.updateManifest(jobId);
    logger.info('Manifest updated');

    // 4. CRITICAL: Validate landmarks after restructuring
    await this.validateAndFixLandmarks(jobId);
    logger.info('Landmarks validated');

    // 5. Run quick audit to catch restructuring issues
    const postRestructureAudit = await this.auditService.runFullAudit(jobId);

    if (postRestructureAudit.issues.length > 0) {
      logger.warn(
        `Restructuring introduced ${postRestructureAudit.issues.length} issues`
      );

      // Attempt to fix common restructuring issues
      await this.fixRestructuringIssues(jobId, postRestructureAudit.issues);

      // Re-audit after fixes
      const reAudit = await this.auditService.runFullAudit(jobId);
      if (reAudit.issues.length > 0) {
        logger.error(`Unable to fix all restructuring issues: ${reAudit.issues.length} remain`);
      }
    }

    logger.info('EPUB restructuring complete');
  } catch (error) {
    logger.error('Error restructuring EPUB:', error);
    throw new StructureError('Failed to restructure EPUB', error);
  }
}

/**
 * Ensure all files maintain required landmarks after restructuring
 */
private async validateAndFixLandmarks(jobId: string): Promise<void> {
  const job = await this.jobRepository.findById(jobId);
  const files = await this.getAllContentFiles(job.epubPath);

  for (const file of files) {
    const content = await fs.readFile(file.path, 'utf-8');
    const hasLandmark = this.checkForLandmark(content);

    if (!hasLandmark && this.requiresLandmark(file)) {
      logger.info(`Adding missing landmark to ${file.path}`);
      await this.addLandmark(file.path, file.type);
    }
  }
}

/**
 * Check if file requires a landmark
 */
private requiresLandmark(file: ContentFile): boolean {
  // All content files should have landmarks
  return file.type !== 'toc' && file.type !== 'nav';
}

/**
 * Fix common issues introduced by restructuring
 */
private async fixRestructuringIssues(
  jobId: string,
  issues: Issue[]
): Promise<void> {
  const landmarkIssues = issues.filter(i => i.code === 'EPUB-STRUCT-004');

  for (const issue of landmarkIssues) {
    try {
      await this.addLandmark(issue.filePath, 'main');
      logger.info(`Fixed landmark issue in ${issue.filePath}`);
    } catch (error) {
      logger.error(`Failed to fix landmark in ${issue.filePath}:`, error);
    }
  }
}
```

---

### PHASE 3: Testing & Validation (Days 6-7)
**Priority:** 🟢 HIGH

#### 3.1 Unit Tests

**File:** `test/services/remediation-workflow.service.spec.ts`

```typescript
describe('RemediationWorkflowService', () => {
  describe('completeRemediation', () => {
    it('should perform full re-audit after remediation', async () => {
      // Arrange
      const jobId = 'test-job';
      jest.spyOn(service, 'getOriginalIssues').mockResolvedValue([
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter01.xhtml', severity: 'serious' }
      ]);
      jest.spyOn(auditService, 'runFullAudit').mockResolvedValue({
        issues: [],
        coverage: { totalFiles: 81, filesScanned: 81, percentage: 100 }
      });

      // Act
      const result = await service.completeRemediation(jobId);

      // Assert
      expect(auditService.runFullAudit).toHaveBeenCalledWith(jobId);
      expect(result.success).toBe(true);
      expect(result.details.auditCoverage.percentage).toBe(100);
    });

    it('should detect new issues not in original audit', async () => {
      // Arrange
      jest.spyOn(service, 'getOriginalIssues').mockResolvedValue([
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter01.xhtml' }
      ]);
      jest.spyOn(auditService, 'runFullAudit').mockResolvedValue({
        issues: [
          { code: 'EPUB-STRUCT-004', filePath: '00_cover.xhtml' }
        ],
        coverage: { totalFiles: 81, filesScanned: 81, percentage: 100 }
      });

      // Act
      const result = await service.completeRemediation(jobId);

      // Assert
      expect(result.success).toBe(false);
      expect(result.details.newIssues).toBe(1);
      expect(result.details.remainingIssues).toBe(1);
      expect(result.message).toContain('issue(s) remain');
    });

    it('should return success only when NO issues remain', async () => {
      // Arrange
      jest.spyOn(service, 'getOriginalIssues').mockResolvedValue([
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter01.xhtml' }
      ]);
      jest.spyOn(auditService, 'runFullAudit').mockResolvedValue({
        issues: [],
        coverage: { totalFiles: 81, filesScanned: 81, percentage: 100 }
      });

      // Act
      const result = await service.completeRemediation(jobId);

      // Assert
      expect(result.success).toBe(true);
      expect(result.message).toContain('fully compliant');
      expect(result.details.remainingIssues).toBe(0);
    });

    it('should correctly identify fixed vs unfixed issues', async () => {
      // Arrange
      const originalIssues = [
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter01.xhtml', location: 'line 10' },
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter02.xhtml', location: 'line 20' }
      ];
      const currentIssues = [
        { code: 'EPUB-STRUCT-002', filePath: 'Chapter02.xhtml', location: 'line 20' } // Only one remains
      ];

      jest.spyOn(service, 'getOriginalIssues').mockResolvedValue(originalIssues);
      jest.spyOn(auditService, 'runFullAudit').mockResolvedValue({
        issues: currentIssues,
        coverage: { totalFiles: 81, filesScanned: 81, percentage: 100 }
      });

      // Act
      const result = await service.completeRemediation(jobId);

      // Assert
      expect(result.details.fixedIssues).toBe(1); // Chapter01 fixed
      expect(result.details.remainingIssues).toBe(1); // Chapter02 remains
    });
  });
});
```

#### 3.2 Integration Tests

**File:** `test/integration/epub-remediation.e2e.spec.ts`

```typescript
describe('EPUB Remediation E2E', () => {
  it('should detect all issues including cover page', async () => {
    // Upload test EPUB with cover page issue
    const epubPath = path.join(__dirname, 'fixtures', 'test-epub-with-cover-issue.epub');
    const job = await uploadEpub(epubPath);

    // Run audit
    const audit = await auditService.auditEpub(job.epubPath);

    // Should scan ALL files
    expect(audit.coverage.percentage).toBe(100);

    // Should detect cover page issue
    const coverIssue = audit.issues.find(i => i.filePath.includes('cover'));
    expect(coverIssue).toBeDefined();
    expect(coverIssue.code).toBe('EPUB-STRUCT-004');
  });

  it('should report accurate results after remediation', async () => {
    // Upload and remediate
    const epubPath = path.join(__dirname, 'fixtures', 'test-epub.epub');
    const job = await uploadEpub(epubPath);

    // Run remediation
    const result = await remediationService.completeRemediation(job.id);

    // Should perform full re-audit
    expect(result.details.auditCoverage.percentage).toBe(100);

    // Should report accurate status
    if (result.details.remainingIssues > 0) {
      expect(result.success).toBe(false);
      expect(result.message).toContain('issue(s) remain');
      expect(result.remainingIssues).toBeDefined();
      expect(result.remainingIssues.length).toBeGreaterThan(0);
    } else {
      expect(result.success).toBe(true);
      expect(result.message).toContain('fully compliant');
    }
  });

  it('should handle directory restructuring correctly', async () => {
    // Upload EPUB that will be restructured
    const job = await uploadAndRemediateEpub('test-epub-restructure.epub');

    // Run full re-audit
    const audit = await auditService.runFullAudit(job.id);

    // All files should maintain landmarks after restructuring
    const landmarkIssues = audit.issues.filter(i => i.code === 'EPUB-STRUCT-004');
    expect(landmarkIssues.length).toBe(0);
  });
});
```

---

### PHASE 4: Performance & Monitoring (Days 8-10)
**Priority:** 🟡 MEDIUM

#### 4.1 Add Performance Monitoring

**File:** `src/services/epub/audit.service.ts`

```typescript
async auditEpub(epubPath: string): Promise<AuditResult> {
  const startTime = Date.now();

  try {
    // ... existing audit logic ...

    const duration = Date.now() - startTime;
    logger.info(`Audit completed in ${duration}ms for ${allFiles.length} files`);

    // Track metrics
    await this.metricsService.recordAudit({
      jobId: this.currentJobId,
      filesScanned: allFiles.length,
      issuesFound: issues.length,
      duration,
      coverage: coverage.percentage
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`Audit failed after ${duration}ms:`, error);
    throw error;
  }
}
```

#### 4.2 Add Caching for Performance

**File:** `src/services/epub/audit.service.ts`

```typescript
/**
 * Cache audit results to avoid re-scanning unchanged files
 */
private auditCache = new Map<string, CachedAuditResult>();

async auditEpub(epubPath: string): Promise<AuditResult> {
  // Check cache
  const cacheKey = await this.getFileHash(epubPath);
  const cached = this.auditCache.get(cacheKey);

  if (cached && !this.isCacheExpired(cached)) {
    logger.info('Returning cached audit results');
    return cached.result;
  }

  // Perform audit
  const result = await this.performAudit(epubPath);

  // Cache result
  this.auditCache.set(cacheKey, {
    result,
    timestamp: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes
  });

  return result;
}
```

---

## Testing Checklist

### Unit Tests
- [ ] `completeRemediation()` performs full re-audit
- [ ] `compareAuditResults()` correctly identifies fixed/unfixed/new issues
- [ ] `getAllContentFiles()` returns all XHTML files
- [ ] `categorizeFiles()` correctly categorizes front/back matter
- [ ] `validateAndFixLandmarks()` adds missing landmarks

### Integration Tests
- [ ] Full re-audit detects issues in all 81 files
- [ ] Cover page issues are detected
- [ ] New issues are reported separately from fixed issues
- [ ] Restructuring maintains landmarks
- [ ] API endpoints return accurate results

### Manual Testing
- [ ] Upload EPUB with cover page issue → Should detect
- [ ] Remediate EPUB → Should perform full re-audit
- [ ] Check results → Should show accurate remaining issues
- [ ] Verify no false "100% fixed" messages

---

## Success Criteria

### Phase 1 Complete When:
- [ ] Full re-audit implemented in `completeRemediation()`
- [ ] Audit scope expanded to all files
- [ ] All unit tests passing
- [ ] API returns accurate remaining issues

### Phase 2 Complete When:
- [ ] Restructuring validates landmarks
- [ ] Post-restructure audit implemented
- [ ] Common issues auto-fixed

### Phase 3 Complete When:
- [ ] All tests passing (unit + integration)
- [ ] Manual testing confirms accuracy
- [ ] No false completion messages

### Phase 4 Complete When:
- [ ] Performance monitoring added
- [ ] Caching implemented
- [ ] Metrics tracking in place

---

## Commands for Testing

```bash
# Run unit tests
npm test -- remediation-workflow.service.spec.ts

# Run integration tests
npm run test:e2e -- epub-remediation.e2e.spec.ts

# Test specific EPUB
npm run test:epub -- path/to/test.epub

# Check coverage
npm run test:coverage
```

---

## Files Modified Summary

1. `src/services/epub/remediation-workflow.service.ts` - Full re-audit logic
2. `src/services/epub/audit.service.ts` - Expanded audit scope
3. `src/services/epub/structure-handler.service.ts` - Post-restructuring validation
4. `src/controllers/remediation.controller.ts` - Updated API endpoints
5. `test/services/remediation-workflow.service.spec.ts` - Unit tests
6. `test/integration/epub-remediation.e2e.spec.ts` - Integration tests

---

## Notes

- **Performance:** Full re-audit may take 2-3x longer than partial validation. Implement caching in Phase 4.
- **Backwards Compatibility:** Existing jobs won't have full audit data. Handle gracefully.
- **Error Handling:** Ensure robust error handling for large EPUBs (1000+ files).
- **Logging:** Add detailed logging for debugging audit scope issues.

---

**Ready to implement? Start with Phase 1, Task 1.1. Good luck! 🚀**
