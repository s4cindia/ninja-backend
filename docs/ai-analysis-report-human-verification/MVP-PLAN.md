# AI Analysis Report + Human Verification Integration - MVP Plan

**Version:** 1.0 - MVP
**Timeline:** 10 weeks (3 phases)
**Approach:** Multi-terminal parallel development
**Status:** Ready for implementation

---

## Table of Contents

1. [MVP Overview](#mvp-overview)
2. [MVP Scope](#mvp-scope)
3. [Development Approach](#development-approach)
4. [Phase Breakdown](#phase-breakdown)
5. [Parallel Work Streams](#parallel-work-streams)
6. [Dependencies & Sequencing](#dependencies--sequencing)
7. [Testing Strategy](#testing-strategy)
8. [Success Metrics](#success-metrics)

---

## MVP Overview

### Goal
Deliver a **minimum viable integration** that provides:
1. ✅ Basic AI Analysis Report with Gemini insights
2. ✅ Seamless flow from Report → Human Verification
3. ✅ Enhanced verification queue with AI context
4. ✅ Simple progress tracking

### Timeline
- **Phase 1:** Basic AI Report (4 weeks)
- **Phase 2:** Basic Integration (4 weeks)
- **Phase 3:** Progress Tracking (2 weeks)
- **Total:** 10 weeks

### Team Structure
- **4 parallel development streams** using separate git worktrees
- **2 Backend terminals** (BE-T1, BE-T2)
- **2 Frontend terminals** (FE-T1, FE-T2)
- Work designed to minimize file conflicts

---

## MVP Scope

### ✅ In Scope (MVP)

#### AI Analysis Report (Basic)
- Executive Summary with overall confidence
- AI-generated insights (Gemini)
- Action Plan with manual testing items
- Basic styling (no advanced charts)
- Simple export (JSON only)

#### Integration (Basic)
- "Start Manual Testing" button in Action Plan
- Initialize verification from AI Report
- Enhanced verification queue with AI context
- Basic testing guide per criterion
- Priority badges and time estimates

#### Progress Tracking (Simple)
- Progress bar in both interfaces
- Basic sync when verification completed
- "Back to Report" navigation
- Status updates in Action Plan

### ❌ Out of Scope (Post-MVP)

- Advanced visualizations (6 charts)
- Interactive guided wizard
- Real-time WebSocket updates
- Evidence upload
- PDF/CSV export
- Advanced filters
- Bulk verification enhancements
- Email notifications
- Team collaboration features

---

## Development Approach

### Multi-Terminal Development with Git Worktrees

#### Why Worktrees?
- 4 developers can work in parallel without conflicts
- Each terminal works in isolated directory
- Changes can be reviewed independently
- Easy to merge when ready

#### Setup

```bash
# Main repo
cd /c/Users/avrve/projects/ninja-workspace/ninja-backend

# Create worktrees for parallel development
git worktree add ../ninja-backend-be-t1 -b feature/ai-report-backend-1
git worktree add ../ninja-backend-be-t2 -b feature/ai-report-backend-2

cd /c/Users/avrve/projects/ninja-workspace/ninja-frontend

# Create worktrees for frontend
git worktree add ../ninja-frontend-fe-t1 -b feature/ai-report-frontend-1
git worktree add ../ninja-frontend-fe-t2 -b feature/ai-report-frontend-2
```

#### Work Isolation

| Terminal | Branch | Primary Files | Conflicts? |
|----------|--------|---------------|------------|
| **BE-T1** | `feature/ai-report-backend-1` | Services, Gemini integration | ❌ No |
| **BE-T2** | `feature/ai-report-backend-2` | Routes, controllers, types | ❌ No |
| **FE-T1** | `feature/ai-report-frontend-1` | Report page, components | ❌ No |
| **FE-T2** | `feature/ai-report-frontend-2` | Verification enhancements | ❌ No |

---

## Phase Breakdown

### Phase 1: Basic AI Report (Weeks 1-4)

**Goal:** Users can view AI Analysis Report with Gemini insights

**Backend:**
- BE-T1: Report generator service + Gemini integration
- BE-T2: API routes + response types

**Frontend:**
- FE-T1: Report page + Executive Summary
- FE-T2: Action Plan section + navigation

**Deliverable:** `/acr/reports/:jobId/analysis` shows basic report

---

### Phase 2: Basic Integration (Weeks 5-8)

**Goal:** Users can click "Start Manual Testing" and see enhanced queue

**Backend:**
- BE-T1: Init-from-report endpoint + AI context enricher
- BE-T2: Enhanced queue endpoint + testing guide templates

**Frontend:**
- FE-T1: "Start Manual Testing" button + integration logic
- FE-T2: Enhanced verification queue UI + testing guides display

**Deliverable:** Seamless flow Report → Verification with AI context

---

### Phase 3: Progress Tracking (Weeks 9-10)

**Goal:** Progress visible in both interfaces

**Backend:**
- BE-T1: Progress tracker service + progress API
- BE-T2: Cache invalidation + event handling

**Frontend:**
- FE-T1: Progress bar component + sync logic
- FE-T2: "Back to Report" navigation + status updates

**Deliverable:** Real-time progress tracking

---

## Parallel Work Streams

### Phase 1 - Week 1-2: Foundation

```
┌─────────────────────────┬─────────────────────────┐
│ BE-T1                   │ BE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • ACRReportGenerator    │ • API route skeleton    │
│   Service (new file)    │   /api/v1/acr/reports   │
│ • GeminiService wrapper │ • ReportController      │
│   enhancements          │   (new file)            │
│ • AIInsights schema     │ • Response types        │
│   (Zod)                 │   (interfaces)          │
│ • Statistics calculator │ • Error handlers        │
└─────────────────────────┴─────────────────────────┘

┌─────────────────────────┬─────────────────────────┐
│ FE-T1                   │ FE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • ACRAnalysisReport     │ • ActionPlanSection     │
│   Page component        │   component             │
│ • ExecutiveSummary      │ • ManualTestingCard     │
│   Section component     │   component             │
│ • API client methods    │ • Navigation from ACR   │
│ • Loading states        │   results page          │
│ • Error boundaries      │ • Route configuration   │
└─────────────────────────┴─────────────────────────┘

Dependencies: None - All parallel
```

---

### Phase 1 - Week 3-4: AI Integration

```
┌─────────────────────────┬─────────────────────────┐
│ BE-T1                   │ BE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • Gemini prompt for     │ • Caching layer (Redis) │
│   insights generation   │ • Job ID validation     │
│ • Top priorities logic  │ • ACR data fetching     │
│ • Risk assessment       │ • Response formatting   │
│ • Time estimation       │ • API endpoint tests    │
│ • Token counting        │                         │
└─────────────────────────┴─────────────────────────┘

┌─────────────────────────┬─────────────────────────┐
│ FE-T1                   │ FE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • AIInsights display    │ • Action Plan task list │
│ • Key findings cards    │ • Time estimates UI     │
│ • Styling & layout      │ • Priority badges       │
│ • Mobile responsive     │ • "Start Testing" btn   │
│ • Loading skeleton      │   (placeholder)         │
└─────────────────────────┴─────────────────────────┘

Dependencies: BE-T1 → FE-T1 (AI insights schema)
              BE-T2 → FE-T2 (API response format)
```

---

### Phase 2 - Week 5-6: Integration Foundation

```
┌─────────────────────────┬─────────────────────────┐
│ BE-T1                   │ BE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • POST /init-from-      │ • GET /queue/enhanced   │
│   report endpoint       │   endpoint              │
│ • AIContextEnricher     │ • Testing guide         │
│   Service               │   templates (JSON)      │
│ • Priority calculation  │ • Pass criteria         │
│ • Risk scoring logic    │   definitions           │
│ • Integration tests     │ • Response enrichment   │
└─────────────────────────┴─────────────────────────┘

┌─────────────────────────┬─────────────────────────┐
│ FE-T1                   │ FE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • "Start Manual         │ • Enhanced queue view   │
│   Testing" button logic │   component             │
│ • Redirect handling     │ • AI context cards      │
│ • Session management    │ • Priority badges UI    │
│ • Error handling        │ • Time estimates        │
│ • Success confirmation  │ • Risk score display    │
└─────────────────────────┴─────────────────────────┘

Dependencies: BE-T1 must complete before FE-T1
              BE-T2 must complete before FE-T2
```

---

### Phase 2 - Week 7-8: Enhanced Verification

```
┌─────────────────────────┬─────────────────────────┐
│ BE-T1                   │ BE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • Queue enrichment      │ • Testing guide         │
│   with ACR data         │   rendering endpoint    │
│ • Issue mapping         │ • GET /testing-guide/   │
│ • Fixed issues tracking │   :criterionId          │
│ • Confidence updates    │ • Markdown formatting   │
│ • Validation            │ • Resource links        │
└─────────────────────────┴─────────────────────────┘

┌─────────────────────────┬─────────────────────────┐
│ FE-T1                   │ FE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • Integration testing   │ • Testing guide modal   │
│ • E2E flow validation   │ • Expandable details    │
│ • Navigation polish     │ • Tool recommendations  │
│ • Loading states        │ • WCAG links            │
│ • Error boundaries      │ • Steps display         │
└─────────────────────────┴─────────────────────────┘

Dependencies: Parallel within phase
```

---

### Phase 3 - Week 9-10: Progress Tracking

```
┌─────────────────────────┬─────────────────────────┐
│ BE-T1                   │ BE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • ProgressTracker       │ • Cache invalidation    │
│   Service               │   on verification       │
│ • GET /progress         │ • Event emitter setup   │
│   endpoint              │ • Report regeneration   │
│ • Progress calculation  │ • Timestamp tracking    │
│ • Integration tests     │ • API tests             │
└─────────────────────────┴─────────────────────────┘

┌─────────────────────────┬─────────────────────────┐
│ FE-T1                   │ FE-T2                   │
├─────────────────────────┼─────────────────────────┤
│ • ProgressBar component │ • "Back to Report" link │
│ • Polling logic (5s)    │ • Status checkmarks     │
│ • Percentage display    │ • Completion messages   │
│ • Remaining time calc   │ • Navigation state      │
│ • Animation             │ • Toast notifications   │
└─────────────────────────┴─────────────────────────┘

Dependencies: BE-T1 → FE-T1 (progress API)
              FE-T2 needs FE-T1 progress component
```

---

## Dependencies & Sequencing

### Critical Path

```
Phase 1:
  BE-T1 (Gemini service) → FE-T1 (AI insights display)
  BE-T2 (API routes) → FE-T2 (Action Plan UI)

  ✓ No blockers between BE-T1/BE-T2
  ✓ No blockers between FE-T1/FE-T2

Phase 2:
  BE-T1 (init endpoint) → FE-T1 (Start button)
  BE-T2 (enhanced queue) → FE-T2 (Queue UI)

  ⚠️ BE-T1 must finish before FE-T1 can integrate
  ⚠️ BE-T2 must finish before FE-T2 can display queue

Phase 3:
  BE-T1 (progress API) → FE-T1 (progress bar)
  BE-T2 (cache logic) → FE-T2 (status updates)

  ⚠️ BE-T1 must finish before FE-T1 can poll
  ⚠️ FE-T2 depends on FE-T1 progress component
```

### Merge Strategy

**Per Phase:**
1. Complete all 4 terminals' work
2. Run local integration tests
3. Merge in order: BE-T2 → BE-T1 → FE-T2 → FE-T1
4. Resolve conflicts (should be minimal with proper isolation)
5. Run full E2E tests
6. Deploy to staging
7. QA validation before next phase

---

## File Ownership Matrix

### Backend

| File/Module | BE-T1 | BE-T2 | Shared? |
|-------------|-------|-------|---------|
| `services/acr/report-generator.service.ts` | ✅ Owner | ❌ | No |
| `services/acr/ai-context-enricher.service.ts` | ✅ Owner | ❌ | No |
| `services/acr/progress-tracker.service.ts` | ✅ Owner | ❌ | No |
| `services/ai/gemini.service.ts` | ✅ Owner | ❌ | No |
| `controllers/report.controller.ts` | ❌ | ✅ Owner | No |
| `controllers/verification.controller.ts` | ❌ | ✅ Owner | No |
| `routes/acr.routes.ts` | ❌ | ✅ Owner | No |
| `routes/verification.routes.ts` | ❌ | ✅ Owner | No |
| `types/acr-report.types.ts` | ❌ | ✅ Owner | No |
| `schemas/ai-insights.schema.ts` | ✅ Owner | ❌ | No |
| `utils/testing-guides.ts` | ❌ | ✅ Owner | No |

### Frontend

| File/Module | FE-T1 | FE-T2 | Shared? |
|-------------|-------|-------|---------|
| `pages/ACRAnalysisReport.tsx` | ✅ Owner | ❌ | No |
| `components/ExecutiveSummary.tsx` | ✅ Owner | ❌ | No |
| `components/AIInsights.tsx` | ✅ Owner | ❌ | No |
| `components/ProgressBar.tsx` | ✅ Owner | ❌ | No |
| `components/ActionPlanSection.tsx` | ❌ | ✅ Owner | No |
| `components/ManualTestingCard.tsx` | ❌ | ✅ Owner | No |
| `components/EnhancedVerificationQueue.tsx` | ❌ | ✅ Owner | No |
| `components/TestingGuideModal.tsx` | ❌ | ✅ Owner | No |
| `api/acr-report.api.ts` | ✅ Owner | ❌ | No |
| `api/verification.api.ts` | ❌ | ✅ Owner | No |
| `types/acr-report.types.ts` | ⚠️ | ⚠️ | Yes* |
| `hooks/useVerificationProgress.ts` | ✅ Owner | ❌ | No |

*Shared types should be coordinated - BE-T2 creates, FE-T1 & FE-T2 import

---

## Testing Strategy

### Unit Tests
- Each terminal writes unit tests for their files
- Target: 80% coverage minimum
- Run before committing

### Integration Tests
- BE-T1 & BE-T2: Test API endpoints together
- FE-T1 & FE-T2: Test page flow together
- Run at end of each phase

### E2E Tests
- Full flow: ACR Results → AI Report → Start Testing → Verify → Progress
- Run before merging phases
- Use Playwright or Cypress

### Manual QA Checklist
Per phase, verify:
- [ ] AI Report loads with correct data
- [ ] Gemini insights display properly
- [ ] "Start Manual Testing" button works
- [ ] Queue shows AI context
- [ ] Testing guides are helpful
- [ ] Progress updates correctly
- [ ] Navigation works both ways
- [ ] No console errors
- [ ] Mobile responsive
- [ ] Accessible (screen reader test)

---

## Success Metrics

### Phase 1 Success Criteria
- ✅ AI Report page renders without errors
- ✅ Executive Summary shows overall confidence
- ✅ AI insights from Gemini display correctly
- ✅ Action Plan lists 7 manual criteria
- ✅ Page loads in <3 seconds
- ✅ Mobile responsive
- ✅ No accessibility violations

### Phase 2 Success Criteria
- ✅ "Start Manual Testing" button visible
- ✅ Button click initializes verification queue
- ✅ Queue shows AI context (priority, risk, time)
- ✅ Testing guides accessible per criterion
- ✅ Navigation Report → Verification works
- ✅ No data loss during transition
- ✅ 0 file conflicts during merge

### Phase 3 Success Criteria
- ✅ Progress bar shows in both interfaces
- ✅ Completing verification updates progress
- ✅ "3/7 completed" displays correctly
- ✅ "Back to Report" navigation works
- ✅ Report shows updated status
- ✅ Sync happens within 10 seconds (polling)
- ✅ All E2E tests pass

### Overall MVP Success
- ✅ Complete flow works end-to-end
- ✅ 70%+ users who view report click "Start Testing"
- ✅ Time to start verification: <2 minutes
- ✅ 0 critical bugs in staging
- ✅ NPS score: 40+
- ✅ All documentation complete

---

## Risk Mitigation

### Risk 1: File Conflicts During Merge
**Mitigation:**
- Clear file ownership (matrix above)
- Daily sync meetings
- Review prompt files before starting
- Merge frequently (end of each week)

### Risk 2: Gemini API Rate Limits
**Mitigation:**
- Cache AI insights for 1 hour
- Implement exponential backoff
- Fallback to basic insights if Gemini fails
- Monitor usage in Phase 1

### Risk 3: Integration Points Misaligned
**Mitigation:**
- Define API contracts upfront (Week 1)
- BE-T2 creates TypeScript interfaces first
- Mock API responses for frontend dev
- Integration tests at end of each phase

### Risk 4: Scope Creep
**Mitigation:**
- Strict MVP scope (documented above)
- "Post-MVP" parking lot for nice-to-haves
- Product owner approval required for additions
- Weekly scope review

---

## Communication Plan

### Daily Standups (15 min)
- What did you complete yesterday?
- What are you working on today?
- Any blockers?
- Any file conflicts anticipated?

### Weekly Sync (30 min)
- Demo progress from all 4 terminals
- Review integration points
- Plan merge strategy
- Adjust timeline if needed

### Phase Completion Review (1 hour)
- Full demo of phase deliverables
- Run E2E tests together
- Merge all branches
- QA validation
- Go/No-Go for next phase

---

## Prompt Files

Each terminal has a dedicated prompt file with:
- Detailed instructions
- Code examples
- File locations
- Testing requirements
- Definition of done

**Prompt Files:**
1. `BE-T1.md` - Backend Terminal 1 (Services & Gemini)
2. `BE-T2.md` - Backend Terminal 2 (Routes & Controllers)
3. `FE-T1.md` - Frontend Terminal 1 (Report Page & Components)
4. `FE-T2.md` - Frontend Terminal 2 (Verification Enhancements)

---

## Getting Started

### For Backend Developer 1 (BE-T1):
```bash
cd /c/Users/avrve/projects/ninja-workspace
git worktree add ninja-backend-be-t1 -b feature/ai-report-backend-1
cd ninja-backend-be-t1
# Follow prompts/BE-T1.md
```

### For Backend Developer 2 (BE-T2):
```bash
cd /c/Users/avrve/projects/ninja-workspace
git worktree add ninja-backend-be-t2 -b feature/ai-report-backend-2
cd ninja-backend-be-t2
# Follow prompts/BE-T2.md
```

### For Frontend Developer 1 (FE-T1):
```bash
cd /c/Users/avrve/projects/ninja-workspace
git worktree add ninja-frontend-fe-t1 -b feature/ai-report-frontend-1
cd ninja-frontend-fe-t1
# Follow prompts/FE-T1.md
```

### For Frontend Developer 2 (FE-T2):
```bash
cd /c/Users/avrve/projects/ninja-workspace
git worktree add ninja-frontend-fe-t2 -b feature/ai-report-frontend-2
cd ninja-frontend-fe-t2
# Follow prompts/FE-T2.md
```

---

## Timeline Visualization

```
Week 1-2: Phase 1 Foundation
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Service │ Routes  │ Report  │ Action  │
│ Gemini  │ Types   │ Summary │ Plan    │
└─────────┴─────────┴─────────┴─────────┘
        ↓ Merge & Test ↓

Week 3-4: Phase 1 AI Integration
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Insights│ Cache   │ Display │ Tasks   │
│ Logic   │ API     │ UI      │ Button  │
└─────────┴─────────┴─────────┴─────────┘
        ↓ Merge & Test ↓

Week 5-6: Phase 2 Foundation
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Init    │ Enhanced│ Button  │ Queue   │
│ Enrich  │ Queue   │ Logic   │ UI      │
└─────────┴─────────┴─────────┴─────────┘
        ↓ Merge & Test ↓

Week 7-8: Phase 2 Enhancement
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Mapping │ Guides  │ E2E     │ Guide   │
│ Issues  │ API     │ Tests   │ Modal   │
└─────────┴─────────┴─────────┴─────────┘
        ↓ Merge & Test ↓

Week 9-10: Phase 3 Progress
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Progress│ Cache   │ Bar     │ Back    │
│ API     │ Events  │ Poll    │ Status  │
└─────────┴─────────┴─────────┴─────────┘
        ↓ Final Merge & QA ↓

        🎉 MVP COMPLETE 🎉
```

---

## Next Steps

1. **Review this plan** with the team
2. **Set up git worktrees** for all 4 terminals
3. **Read your assigned prompt file** (BE-T1.md, BE-T2.md, FE-T1.md, or FE-T2.md)
4. **Start Phase 1 Week 1** work in parallel
5. **Daily standups** at 9 AM
6. **Weekly sync** every Friday at 2 PM

---

**Document Status:** ✅ Ready for Implementation
**Owner:** Project Lead
**Last Updated:** 2026-02-05
