/**
 * computeTimingSummary rolls up every timing signal already scattered
 * across Job.input (validatorProgress, totalPages, altTextImageProgress,
 * autoTagProgress) into one flat record, written once at job completion.
 *
 * Why this exists (user direction, 2026-09-26): with enough of these
 * accumulated across real titles, the goal is to eventually estimate audit
 * time for a new upload from its page/image count before running it. Kept
 * as a pure function (no Prisma) so the rollup logic itself is directly
 * testable without mocking the DB.
 */
import { describe, it, expect } from 'vitest';
import { computeTimingSummary } from '../../../src/workers/processors/accessibility.processor';

describe('computeTimingSummary', () => {
  it('computes per-validator durations, extraction time, and totals from a fully-populated job.input', () => {
    const jobStartedAt = new Date('2026-09-26T05:11:48.767Z');
    const input = {
      size: 87045167,
      totalPages: 529,
      autoTagProgress: {
        startedAt: '2026-09-26T05:11:49.000Z',
        completedAt: '2026-09-26T05:11:55.000Z', // 6s auto-tag
      },
      validatorProgress: [
        { label: 'Structure & Tags', startedAt: '2026-09-26T05:22:24.115Z', completedAt: '2026-09-26T05:22:41.750Z', issuesFound: 526 },
        { label: 'Alt Text', startedAt: '2026-09-26T05:22:41.750Z', completedAt: '2026-09-26T05:58:10.000Z', issuesFound: 12 },
      ],
      altTextImageProgress: { completed: 3843, total: 3843 },
    };

    const summary = computeTimingSummary(input, jobStartedAt);

    expect(summary.autoTagMs).toBe(6000);
    // extraction = first validator's start (05:22:24.115) minus auto-tag's
    // completion (05:11:55.000) -- NOT job.startedAt, since auto-tag ran first.
    expect(summary.extractionMs).toBe(new Date('2026-09-26T05:22:24.115Z').getTime() - new Date('2026-09-26T05:11:55.000Z').getTime());
    expect(summary.validators['Structure & Tags']).toBe(17635); // 22:41.750 - 22:24.115
    expect(summary.validators['Alt Text']).toBe(
      new Date('2026-09-26T05:58:10.000Z').getTime() - new Date('2026-09-26T05:22:41.750Z').getTime()
    );
    expect(summary.totalPages).toBe(529);
    expect(summary.totalImages).toBe(3843);
    expect(summary.fileSizeBytes).toBe(87045167);
    expect(summary.totalMs).toBeGreaterThan(0);
  });

  it('anchors extraction time on job.startedAt (not autoTagProgress) when auto-tagging was skipped', () => {
    const jobStartedAt = new Date('2026-09-26T05:11:48.767Z');
    const input = {
      totalPages: 10,
      validatorProgress: [
        { label: 'Structure & Tags', startedAt: '2026-09-26T05:12:00.000Z', completedAt: '2026-09-26T05:12:05.000Z', issuesFound: 3 },
      ],
    };

    const summary = computeTimingSummary(input, jobStartedAt);

    expect(summary.autoTagMs).toBeNull();
    expect(summary.extractionMs).toBe(
      new Date('2026-09-26T05:12:00.000Z').getTime() - jobStartedAt.getTime()
    );
  });

  it('degrades to nulls (never throws) for a job with no timing data collected at all', () => {
    const summary = computeTimingSummary({}, null);

    expect(summary.totalMs).toBeNull();
    expect(summary.autoTagMs).toBeNull();
    expect(summary.extractionMs).toBeNull();
    expect(summary.validators).toEqual({});
    expect(summary.totalPages).toBeNull();
    expect(summary.totalImages).toBeNull();
    expect(summary.fileSizeBytes).toBeNull();
  });

  it('captures totalImages even when the job died before any validator completed (only altTextImageProgress exists)', () => {
    // The real gap this covers: a job that crashes mid-image-validation
    // previously left no record of the document's image count anywhere.
    const summary = computeTimingSummary(
      { totalPages: 529, altTextImageProgress: { completed: 0, total: 3843 } },
      new Date('2026-09-26T05:11:48.767Z')
    );

    expect(summary.totalImages).toBe(3843);
    expect(summary.validators).toEqual({});
  });
});
