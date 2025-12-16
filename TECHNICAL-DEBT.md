# Ninja Platform - Technical Debt Tracker

**Last Updated:** December 16, 2025

---

## Priority Levels

| Priority | Fix When | Description |
|----------|----------|-------------|
| P1 | Before Launch | Blocks production deployment |
| P2 | Sprint after MVP | Important for scale/reliability |
| P3 | Post-Launch | Nice to have, low risk |

---

## Active Technical Debt

### TD-001: In-Memory Storage for ACR Versioning
**Priority:** P2  
**Location:** `src/services/acr/acr-versioning.service.ts`  
**Issue:** Version history stored in Map, lost on restart  
**Risk:** Data loss on server restart  
**Fix:** Migrate to Prisma database model with AcrVersion table  
**Effort:** 4 hours  
**Created:** 2025-12-16  

### TD-002: In-Memory Storage for Human Verification
**Priority:** P2  
**Location:** `src/services/acr/human-verification.service.ts`  
**Issue:** Verification queue stored in Map (with Job.output backup)  
**Risk:** Partial data loss if persistToJob fails  
**Fix:** Migrate to Prisma VerificationRecord model  
**Effort:** 4 hours  
**Created:** 2025-12-16  

### TD-003: Race Condition in Version Creation
**Priority:** P2  
**Location:** `src/services/acr/acr-versioning.service.ts:createVersion()`  
**Issue:** Concurrent calls can create duplicate version numbers  
**Risk:** Corrupted version history under high concurrency  
**Fix:** Add optimistic locking or use database transactions  
**Effort:** 2 hours  
**Created:** 2025-12-16  

### TD-004: No Rollback on Verification Persistence Failure
**Priority:** P2  
**Location:** `src/services/acr/human-verification.service.ts:submitVerification()`  
**Issue:** In-memory state updated before persistence; no rollback on failure  
**Risk:** State divergence between memory and database  
**Fix:** Implement transaction-like semantics with rollback  
**Effort:** 3 hours  
**Created:** 2025-12-16  

### TD-005: ESLint Warnings at Threshold (60/60)
**Priority:** P3  
**Location:** Multiple files  
**Issue:** Lint warnings at maximum threshold, no room for new code  
**Risk:** New code may fail CI checks  
**Fix:** Reduce warnings by 10-15 (replace console.log with logger, fix unused vars)  
**Effort:** 2 hours  
**Created:** 2025-12-16  

---

## Resolved Technical Debt

| ID | Description | Resolved Date | Resolution |
|----|-------------|---------------|------------|
| - | - | - | - |

---

## When to Address

### Pre-Launch Checklist (P1)
- [ ] No P1 items currently

### Sprint After MVP (P2)
- [ ] TD-001: Database persistence for versioning
- [ ] TD-002: Database persistence for verification
- [ ] TD-003: Race condition fix
- [ ] TD-004: Rollback logic

### Post-Launch Backlog (P3)
- [ ] TD-005: Reduce ESLint warnings

---

## Database Schema for P2 Fixes

```prisma
// Add to prisma/schema.prisma

model AcrVersion {
  id          String   @id @default(uuid())
  acrId       String
  version     Int
  createdAt   DateTime @default(now())
  createdBy   String
  changeLog   Json
  snapshot    Json

  @@unique([acrId, version])
  @@index([acrId])
}

model VerificationRecord {
  id               String    @id @default(uuid())
  jobId            String
  validationItemId String
  criterionId      String
  status           String
  verifiedBy       String
  verifiedAt       DateTime  @default(now())
  method           String
  notes            String?
  previousStatus   String?

  job              Job       @relation(fields: [jobId], references: [id])

  @@index([jobId])
  @@index([validationItemId])
}
```

---

## Notes

- MVP target: London Book Fair 2026
- P2 items should be addressed 2-4 weeks after MVP launch
- Track in GitHub Issues for better visibility
