# Operational Reports — Design Doc

## 1. Scope

Five report groups, internal/operational (not PAC/ACR/VPAT — those stay as-is):

1. **Time / throughput** — stage timing, round duration trends, stuck-job radar, queue utilization
2. **Cost** — spend rollups, cost efficiency, cap-hit frequency
3. **Fix quality / effectiveness** — auto-apply yield by suggestion type, stuck-issue backlog, score-delta trend
4. **Reliability / infra health** — deploy/crash interruption counts, failure-reason breakdown
5. **RBAC / team activity** — Team Review throughput, ownership/completion views

This doc covers backend (schema + services + endpoints) and frontend (pages + hooks + services) for all five. It is a design doc only — no implementation yet. See §7 for sequencing and the one hard constraint on when to deploy.

## 2. What already exists (read this before writing any query)

The single most important existing asset is **`RemediationCycleEvent`** (`prisma/schema.prisma:2716`) — an append-only log already written by *both* the manual remediation flow and the auto-mode loop (`remediation-cycle-history.service.ts`, called from `auto-remediation-loop.service.ts` and the manual apply/reaudit/analyze routes). Today it already captures, per row: `jobId`, `cycleNumber`, `action` (`'apply_fixes' | 'reaudit' | 'ai_analysis' | 'auto_loop_summary'`), `source`, `status`, `appliedCount`, `failedCount`, `resolvedCount`, `remainingCount`, `regressionCount`, `resolutionRate`, `errorMessage`, `triggeredBy`, `startedAt`, `completedAt`. Most of Groups 1 and 3 are pure aggregation over this table plus `Job` — no new schema.

Other existing, reusable data:
- `Job.createdAt/startedAt/completedAt/status/error` — queue wait and total job duration are already there (`startedAt - createdAt`, `completedAt - startedAt`). The PDF pipeline marks a job `COMPLETED` right after the *first* audit; remediation (manual or auto) happens afterward as a separate action, so `completedAt - startedAt` is genuinely "initial audit duration," not the whole remediation lifetime.
- `ComparisonTrial`/`PdfAutoRemediationRun` (the two parallel auto-mode driver tables) — `autoStatus`, `autoStopReason`, `autoRoundsCompleted`, `autoCostSpentUsd` (cumulative, overwritten each round — no history), `autoStartedAt`/`autoStoppedAt`.
- `Job.output.postRemediationAudit` (resolved/remaining/regressions/resolutionRate) — same data as `RemediationCycleEvent`'s `reaudit` rows, just also mirrored onto the job for the UI's own use.
- `Team` / `TeamMembership` / `TeamReview` — fully populated since PRs #668/#673/#707/#724. Zero new schema needed for Group 5.
- `remediation-cycle-lock.service.ts`'s `STALE_LOCK_MS`/`getLockStatus` — already the authoritative "is this job's remediation cycle actually stuck" check; reuse it rather than re-deriving staleness logic.

**Confirmed NOT persisted anywhere today** (verified by reading the actual write sites, not assumed):
- Per-suggestion-type applied/failed counts. `applyApprovedSuggestions` (`ai-analysis.service.ts:3119`) tracks aggregate `applied`/`failed` scalars and an in-memory `errors: {issueId, suggestionType, reason}[]` array, but only the aggregate scalars get written to `RemediationCycleEvent` (`apply_fixes` action) — the per-type breakdown and the error detail array are computed and then discarded.
- Per-round cost delta. Only the cumulative `autoCostSpentUsd` is persisted, overwritten every round.
- Any record of `forceStopForShutdown`/`reconcileIfOrphaned`/`reconcileAllOrphanedRuns` firing — these only `logger.warn()` (CloudWatch only). There is no DB row today for "a deploy killed an in-flight round" or "a stale run got reconciled," despite two real documented incidents (2026-10-13, 2026-10-14) this exact gap caused confusion about.
- Structured failure categorization. `Job.error` is freeform text (e.g. `"PDF file exceeds maximum size of 500MB"`), not a code.
- Any history for `PdfConcurrencyBudget` (tenantId-keyed, current-state-only row: `totalUnits`/`unitsInUse`). No time-series.
- `RemediationChange`/`ComparisonReport` — confirmed (via `prisma.remediationChange.create` grep across `src/`) to have **zero write sites**; they're EPUB/Visual-Comparison-only and read-only elsewhere. Not reusable for PDF reporting.

This inventory drives every schema decision below — each new field exists because a grep confirmed the data is either never computed or computed-then-discarded, not because it was assumed missing.

## 3. Schema changes (additive only, no backfill, no behavior change to existing paths)

```prisma
model RemediationCycleEvent {
  // ...existing fields unchanged...
  costUsd                 Float?   // NEW — this round's AI cost delta (Group 2)
  suggestionTypeBreakdown Json?    // NEW — { [suggestionType]: { applied: number, failed: number } } (Group 3)
  applyErrorsJson         Json?    // NEW — first 50 { issueId, suggestionType, reason }, + a truncated-count marker (Group 3)
}

model Job {
  // ...existing fields unchanged...
  errorCode String?  // NEW — structured failure bucket, see §3.1 (Group 4)
}
```

No new tables. `action`/`source` on `RemediationCycleEvent` are plain strings (not Prisma enums), so two new values need no migration, just new write sites:
- `action: 'force_stopped'`, `source: 'shutdown'` — written from `forceStopForShutdown` (`auto-remediation-loop.service.ts:394`), only on the branch where `updateMany`'s `result.count > 0` (i.e. it actually flipped something, not a no-op).
- `action: 'orphan_reconciled'`, `source: 'watchdog'` — written from `reconcileIfOrphaned`/`reconcileIfOrphanedJobRun`, same "only on the branch that actually flips autoStatus" condition, and from `reconcileAllOrphanedRuns`'s sweep.

### 3.1 `Job.errorCode` categories

Freeform `Job.error` stays as the human-readable message (unchanged, no behavior risk). `errorCode` is populated going forward at known throw sites with a small fixed set: `SIZE_LIMIT_EXCEEDED`, `TIMEOUT`, `PARSE_ERROR`, `VALIDATION_ERROR`, `UNKNOWN` (default fallback — do not spend time exhaustively mapping every throw site up front; let `UNKNOWN`'s volume in the report itself tell us which throw sites are worth categorizing next). OOM kills won't produce a code at all (ECS kills the task with no in-process throw) — those show up as jobs stuck in `PROCESSING` with no terminal state, which is a *different* report (the aging/stuck-job radar in Group 1), not this field. Don't conflate the two.

### 3.2 Where `costUsd`/`suggestionTypeBreakdown`/`applyErrorsJson` get populated

Single write site: the existing `apply_fixes` `logEvent` call in `applyApprovedSuggestions` (`ai-analysis.service.ts:3606` and `:3636`, both branches). `suggestionTypeBreakdown` and `applyErrorsJson` are built from data the function already computes in its existing loop (the `applied`/`failed` scalars and the `errors` array) — just carry a `Map<string, {applied, failed}>` alongside the existing counters, and pass a capped slice of `errors` through. No extra DB round trips, no extra PDF processing.

`costUsd` is the one that needs a genuine new computation: the round's cost delta, not the cumulative total. Compute it in `runRound` (`auto-remediation-loop.service.ts:662`) as `(cost after this round's analyzeJob call) - (cost before it)`, threaded into the `apply_fixes` log call. Confirm `analyzeJob`'s return shape actually exposes a per-call cost figure before assuming this is free — if it doesn't, this is the one place in this doc where a quick source read is still needed before implementing, not just aggregation.

## 4. Backend: services and endpoints

Follow the existing `src/routes/admin/*.routes.ts` convention exactly (`authenticate` + inline `isAdmin(req)` check + `forbidden`/`internalError` helpers, tenant-scoped via `req.user.tenantId` — see `teams.routes.ts:23-40`), and the existing `admin/comparison-study.routes.ts`'s `GET .../aggregate-report` pattern (thin route, delegates to one service function, returns `{ success: true, data: report }`).

New files:
- `src/routes/admin/reports.routes.ts` — ADMIN-only, registered at `/admin/reports`
- `src/services/reports/throughput-report.service.ts` — Group 1
- `src/services/reports/cost-report.service.ts` — Group 2
- `src/services/reports/quality-report.service.ts` — Group 3
- `src/services/reports/reliability-report.service.ts` — Group 4
- `src/services/reports/team-activity-report.service.ts` — Group 5

Every list endpoint takes `from`/`to` (ISO date, default last 30 days) and `groupBy` (`day`|`week`) where a trend is involved.

**Group 1 — `GET /admin/reports/throughput`**
- Stage timing: `Job.startedAt - createdAt` (queue wait), `Job.completedAt - startedAt` (initial audit), then per-cycle `RemediationCycleEvent` rows grouped by `action`, averaged/percentiled, bucketed by `groupBy`.
- Round-duration trend: same table, `GROUP BY cycleNumber, action`.
- Aging/stuck-job radar: `Job` where `status IN (QUEUED, PROCESSING)` and `updatedAt` older than a threshold, cross-checked against `remediationCycleLockService.getLockStatus` for jobs mid-remediation (reuse, don't re-derive).
- Queue/concurrency utilization: current-state-only read of `PdfConcurrencyBudget` (no history — see §6 deferred).

**Group 2 — `GET /admin/reports/cost`**
- Spend rollup by tenant/period: `SUM` of `ComparisonTrial.autoCostSpentUsd` / `PdfAutoRemediationRun.autoCostSpentUsd` (UNION across the two driver tables — same dual-path reality as everywhere else in this codebase), bucketed by `Job.createdAt`.
- Cost-per-page / cost-per-issue-resolved: joins the above against `Job.output.auditReport.metadata.pageCount` and `RemediationCycleEvent.reaudit.resolvedCount`.
- Cap-hit frequency: `GROUP BY autoStopReason` across both driver tables.
- Per-round cost trend (drill-down for one job): `RemediationCycleEvent.costUsd` ordered by `cycleNumber` — needs §3.2's new field.

**Group 3 — `GET /admin/reports/quality/yield-by-type`, `GET /admin/reports/quality/stuck-issues`**
- Yield by type: `RemediationCycleEvent.suggestionTypeBreakdown`, unpacked and summed across rows in the period — needs §3's new field.
- Stuck-issue backlog: latest `Job.output.auditReport.issues` for jobs where auto-mode stopped (`autoStatus != 'running'`), grouped by issue `code`. No new schema, but is a JSON-heavy scan — see §6 note on indexing/cost before shipping at scale.
- Score-delta trend: `RemediationCycleEvent.reaudit` rows' `resolutionRate`, ordered by `cycleNumber` — already fully available, no new field.

**Group 4 — `GET /admin/reports/reliability/interruptions`, `GET /admin/reports/reliability/failures`**
- Interruptions: `COUNT RemediationCycleEvent WHERE action IN ('force_stopped', 'orphan_reconciled')`, bucketed by period — needs §3's new write sites.
- Failures: `GROUP BY Job.errorCode WHERE status = 'FAILED'` — needs §3.1's new field. Flag in the response when `UNKNOWN` is a large share, as a signal to categorize more throw sites.
- Explicitly NOT in this endpoint: ECS CPU/memory. That's CloudWatch Container Insights, not this DB, and this assistant has no AWS CLI access to build or verify that integration — out of scope for this doc (see §6).

**Group 5 — two endpoints, different access scope:**
- `GET /admin/reports/team-activity` (ADMIN, all teams in the tenant) — `TeamReview` grouped by `reviewedBy`/`outcome`/period, joined to `Team`/`TeamMembership` for team names; `Job` grouped by `userId` (owner) for ownership/completion view.
- `GET /jobs/team/review-activity` (TEAM_LEADER/VIEWER, same auth shape as the existing `listTeamJobs` — `authenticate` + the 403 `NOT_TEAM_LEADER_OR_VIEWER` pattern) — same data, scoped to the caller's own team(s) only, for self-service without needing ADMIN. Lives alongside `job.controller.ts`'s `listTeamJobs`, not under `/admin`.

No new schema for Group 5 — pure aggregation over `Team`/`TeamMembership`/`TeamReview`/`Job`.

## 5. Frontend

New files, following the conventions `AdminTeamsPage.tsx`/`MyTeamPage.tsx` just established (PR #360: `src/pages/admin/*.tsx` for ADMIN pages, `src/services/*.service.ts` thin fetch wrappers, `src/hooks/use*.ts` React Query hooks, `src/types/*.types.ts`):

- `src/pages/admin/AdminReportsPage.tsx` — ADMIN-gated hub page, tab layout (Throughput / Cost / Quality / Reliability / Team Activity), one panel per group rendering its 2-4 sub-reports as small charts/tables.
- `src/services/reports.service.ts` — one function per endpoint in §4.
- `src/hooks/useThroughputReport.ts`, `useCostReport.ts`, `useQualityReport.ts`, `useReliabilityReport.ts`, `useTeamActivityReport.ts` — thin React Query wrappers, same shape as `useTeamJobs.ts`.
- `src/types/reports.types.ts` — response shapes matching §4's endpoints exactly.
- Route registration in `App.tsx`: `<Route path="/admin/reports" element={<AdminReportsPage />} />`, nav link alongside the existing `/admin/users`/`/admin/corpus`/`/admin/teams` entries.
- `MyTeamPage.tsx` gets one new section (not a new route) reading `/jobs/team/review-activity`, for the TEAM_LEADER self-service slice of Group 5.

**Open decision, flagged rather than silently chosen:** this frontend has **no charting library today** (checked `package.json` — no recharts/victory/chart.js/d3). Five report groups each with trend lines and breakdowns is enough surface area that hand-rolled SVG/CSS bars would get repetitive and inconsistent. Recommend adding **recharts** (small, Tailwind-friendly, the common choice for this stack) as a new dependency rather than hand-rolling. If the team would rather not add a dependency, the fallback is a small shared `BarRow`/`Sparkline` component pair built in-house — flagging this as a real tradeoff to decide before frontend work starts, not deciding it here.

## 6. Explicitly deferred / out of scope

- **`PdfConcurrencyBudget` time-series.** Today's table is current-state-only. A real utilization-over-time chart needs either a periodic snapshot table (`PdfConcurrencyBudgetSnapshot`, written on the same cadence as `cleanupStalePdfJobs`'s watchdog tick) or an external metrics pipeline. Ship Group 1's live-gauge view first; revisit history only if the live view proves insufficient.
- **ECS CPU/memory correlation with interruptions.** Lives in CloudWatch Container Insights. This assistant has zero AWS CLI/console access this session — building or validating that integration needs the user to pull the data or grant access; not attempted here.
- **Backfilling `errorCode`/`costUsd`/`suggestionTypeBreakdown` on historical rows.** All three are additive/nullable and populate going forward only. A backfill script is possible later (re-deriving `errorCode` from `Job.error` text via regex, for instance) but isn't needed to ship the reports — old rows just show up as "unknown"/absent in trend charts, which is honest, not broken.
- **JSON-scan performance on the stuck-issue backlog report** (Group 3). Scanning `Job.output.auditReport.issues` across many jobs is not index-backed. Fine at today's job volume; if this report gets slow, the fix is a dedicated `issues` table or a materialized summary, not something to build speculatively now.

## 7. Sequencing and the one hard constraint

Order by schema cost (cheapest/zero-schema first) and relevance to current work:

1. **Group 1 (Time)** — zero schema, pure aggregation. Ships fastest, and would have answered "why is FMHE's round 1 taking so long" directly instead of needing ad hoc SSE polling.
2. **Group 5 (Team activity)** — zero schema, direct extension of the RBAC work just shipped in #360/#724.
3. **Group 2 (Cost)** — one additive field (`costUsd`) plus rollups over data that already exists.
4. **Group 4 (Reliability)** — new `RemediationCycleEvent` action/source values (no migration) + one additive `Job.errorCode` column (small migration).
5. **Group 3 (Quality/effectiveness)** — two additive JSON fields, and the write site is `ai-analysis.service.ts`'s `applyApprovedSuggestions` — the exact function currently executing FMHE's live round 1.

**Hard constraint carried over from this session's own finding:** `applyApprovedSuggestions` has no checkpoint — it calls `savePDF` once, after its entire loop finishes, with no interim persistence. Deploying *any* change to `ai-analysis.service.ts` (or anything else that would restart the worker task) while FMHE's round 1 is still `running` would SIGTERM the task via `forceStopForShutdown` and lose all progress made so far, forcing a restart from zero. This applies with extra force to Group 3's instrumentation specifically, since it touches that exact file. Nothing in this doc should be deployed until FMHE's round 1 reports `autoStatus != 'running'`.

## 8. Verification

- Schema: `npx prisma migrate dev` locally, confirm additive-only (no column drops/type changes), `npx prisma generate`.
- Backend: unit tests per new service function (mock Prisma, assert the aggregation shape), following the existing `tests/unit/controllers/job.controller.test.ts`/`pdf-controller.getAuditResult.test.ts` mocking pattern. Standard gate: `npx tsc --noEmit && npx eslint <files> --max-warnings 0 && npx vitest related <files> --run`.
- New write sites (`costUsd`/`suggestionTypeBreakdown`/`applyErrorsJson`/`force_stopped`/`orphan_reconciled`): test that `applyApprovedSuggestions`/`forceStopForShutdown`/`reconcileIfOrphaned` still behave identically on every existing assertion — these are additive logging calls, not logic changes, so existing tests should need zero changes beyond possibly asserting the new fields are present.
- Frontend: component tests per new page/hook following `AdminTeamsPage.test.tsx`/`MyTeamPage.test.tsx`'s MSW-mocked pattern; manual check in a dev server against a tenant with real `RemediationCycleEvent` history (staging, read-only) before calling any panel done.
