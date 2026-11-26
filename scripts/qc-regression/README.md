# QC regression corpus

Catches heuristic regressions in the PDF accessibility pipeline that synthetic
unit-test fixtures can't -- the kind of bug a PR can only introduce on a real
document (a real DeviceN JPEG's actual channel count, a real shared-MCID
composite figure, a real vision hallucination). Grew directly out of three
real regressions found this way on one title; see the QC regression report
for the full writeup (kept outside this repo -- see "Hygiene" below).

## How it works

1. Each corpus title is driven through the **real product path**: upload,
   start Full Auto Mode, poll to completion, download the remediated PDF.
   No bypass of the job/queue/DB-coupled pipeline -- the point is to test
   exactly what a user's document goes through.
2. `measure.py` (standalone, Python 3 + pikepdf, no Ninja code imported)
   independently measures both the source and the output PDF and reports
   flat structural counts. It never trusts Ninja's own validators or logs
   for these numbers -- deliberately, since Ninja's own self-report has
   been wrong before.
3. `run-corpus.ts` drives the upload/auto-mode/download cycle, invokes
   `measure.py`, and diffs the result against a saved baseline.

## Hygiene -- read before touching this directory

**Nothing with a real title, ISBN, or filename is ever committed.** Every
corpus title is referred to only by an anonymous id (`T1`-`T6`) in this
repo, in `manifest.example.json`, in this README, and in any CLAUDE.md
note. The real id-to-filename mapping lives in `manifest.json` inside
`QC_CORPUS_DIR` -- a local directory **outside both repo clones** -- and is
never committed. Every baseline and run-result JSON also lives there, not
here, even though `measure.py`'s own `metrics` object is just flat numbers
with no extracted text -- keeping it all in one place avoids the mapping
leaking indirectly through a committed baseline's filename or path.

If you ever paste a run's output somewhere outside this tooling (a PR
description, a Slack message), scrub it down to the `T<n>` ids and the
numbers -- never the real title.

## Setup

1. Pick a local directory **outside both repo clones**, e.g.
   `C:\Users\<you>\ninja-qc-corpus\`. Set `QC_CORPUS_DIR` to it.
2. Put the real PDF files there, and write `QC_CORPUS_DIR\manifest.json`
   following `manifest.example.json`'s shape, with real filenames instead
   of `t1.pdf` etc.
3. Install the measurer's one dependency: `pip install pikepdf`.
4. Get a bearer token for the environment you're testing against (same
   shape as any other API client) and set `QC_AUTH_TOKEN`. Treat it as a
   secret -- never commit it, never put it in `manifest.json`.
5. Optional: `QC_API_BASE` (defaults to the staging API), `QC_PYTHON`
   (defaults to `python` -- set if your pikepdf install is under `python3`
   or a venv).

## Usage

```bash
# Quick iteration while developing the runner/measurer themselves --
# 2-3 titles, not the full gate.
npx tsx scripts/qc-regression/run-corpus.ts run --titles T1,T2

# Establish a baseline: capture twice, back to back. Structural metrics
# must match exactly between the two captures -- if they don't, that's
# nondeterminism in the pipeline or the runner itself, not noise, and
# finalize-baseline will refuse to proceed until it's investigated.
npx tsx scripts/qc-regression/run-corpus.ts capture --run 1 --titles T1,T2,T3,T4,T5,T6
npx tsx scripts/qc-regression/run-corpus.ts capture --run 2 --titles T1,T2,T3,T4,T5,T6
npx tsx scripts/qc-regression/run-corpus.ts finalize-baseline --titles T1,T2,T3,T4,T5,T6

# Before merging a theme PR: full set is the real gate.
npx tsx scripts/qc-regression/run-corpus.ts check --titles T1,T2,T3,T4,T5,T6
```

`check` prints a clear PASS/FAIL per title and exits nonzero if anything
exceeded its tolerance. **This is currently a required, documented manual
step** (run it, paste the output into the PR description), not an
automated CI gate -- real AI-API cost per run and some inherent noise in
vision-derived metrics mean the tolerances need to prove out over a few
real theme PRs before an automatic block is trustworthy. Promote later
once that's shown out.

## What gets a tolerance vs. an exact match

Structure-tree-shape metrics (tables, lists, headings, bookmarks, etc. as
raw counts) are expected to be **exactly** reproducible between two runs of
the same code -- `finalize-baseline` enforces this and refuses to proceed
otherwise. The subset of metrics that can genuinely vary run to run because
they depend on fresh AI output (`figures_without_alt`, `tables_without_th`,
`li_not_in_l`, `top_level_floats`, `reading_order_backward_jumps`,
`pages_running_head_tagged_as_content`, `text_ops_untagged`,
`heading_level_skips`, `alt_noise_words`, `alt_generic`, `alt_duplicate`,
`figures_content_empty`, `pages_more_figures_than_source`,
`source_alt_lost` -- see `REGRESSION_METRICS` in `run-corpus.ts`) gets a
tolerance derived from the *observed* spread between the two baseline
captures, never a guessed number. All of these are higher-is-worse
counts, so `check` only flags a regression when a title's number goes up
beyond its own tolerance.

`source_alt_lost` (measure.py v0.2+) matters specifically because at
least two corpus titles already carry publisher-written alt text before
Ninja ever touches them -- this is the metric that catches Ninja
overwriting or losing good existing alt text, which none of the other
metrics would see (they only look at the output in isolation).
`alt_noise_words_new` and `source_alt_texts` are also available (same
v0.2+, only computed when `--source` is given) but are informational
only for now, not gated.

## `alt_cross_run_divergent` -- catching ungrounded fabrication

Real bug, 2026-11-26: `draftComplexImageBaseline` (`ai-analysis.service.ts`)
called Gemini's text-only generation method for a "describe this image"
prompt with no image attached at all -- a different, confidently-worded,
completely unrelated fabrication every run, since nothing grounded it (T4:
"AWS architecture diagram showing a VPC with public and private subnets,
ECS Fargate..." for an actual conception/implantation diagram). Two earlier
designs (whole-book and same-page literal word-overlap against the PDF's
own prose) were tried and rejected: most photo alt text legitimately shares
no vocabulary with surrounding prose at all (it describes a visual scene,
not a paraphrase of the page), so neither design separated real
fabrications from normal variety.

`compare` and `finalize-baseline` instead match each Figure's alt text
ACROSS the two independent runs being compared (same page, greedy
highest-Jaccard pairing -- no MCID/struct-position data needed; validated
that identical/near-identical text always self-selects its own true
counterpart even on a page with several short labels, e.g. T4's
"Chemistry"/"Closeness"/"Commitment"). A genuinely accurate description's
key nouns stay stable even when reworded; an ungrounded fabrication has no
reason to agree with itself at all. Validated directly against the real
capture pairs that found this bug (T1, T4, T5): every known-real
fabrication scored **exactly 0.00** stopword-filtered, lightly-stemmed
content-word Jaccard similarity; the lowest score among legitimate
(reworded-but-accurate) pairs was 0.04 across all three documents --
`ALT_CROSS_RUN_JACCARD_THRESHOLD` (0.02) sits well inside that gap.

Pairs where either side has a short but NONZERO content-word count (1-2
words, e.g. a single label like "Chemistry") are reported separately as
`alt_cross_run_short_pairs` and excluded from the gated count -- a short
label's Jaccard score is dominated by chance, not a meaningful signal. A
side with ZERO content words (empty alt) is deliberately NOT treated as
"short" and stays in the gated metric -- that's the unambiguous, fully
deterministic signal of one run drafting nothing where the other drafted
something real (confirmed real on T1 p82 and T4 p50).

Must-not-increase, like `REGRESSION_METRICS`, but computed differently:
there's no single-capture value to diff, since the check is inherently a
comparison between two runs. `finalize-baseline` records the count in
`<id>.baseline.json`'s own `altCrossRunDivergence` field and refuses to
finalize a NEW baseline whose count exceeds whatever the EXISTING baseline
recorded (the pairs themselves are written to
`<id>.alt-cross-run.details.json`, same outside-git hygiene as everything
else here). `compare` only reports it (that command never gates on
anything).

**Refuses outright (an explicit error line, never a silent 0)** if either
capture was served from an AI response cache (`RunnerResult.aiResponseCache`,
not populated by anything today -- the separately-planned AI response
cache doesn't exist yet) -- a cache hit means that run never independently
re-asked the model at all, so agreement between the two captures would
prove nothing.

**Known blind spot, by design**: this only catches a fabrication that
DISAGREES with itself across two runs. A model that confidently, visually
plausibly, and *consistently* describes the wrong thing the same way every
single time would score a perfect Jaccard match and sail through untouched
-- cross-run divergence is evidence of ungroundedness, not proof of
correctness, and the inverse doesn't hold either. Closing this gap needs an
actual judge that can compare the image against its own alt text, which is
out of scope for this corpus's two-independent-samples design. Planned (not
built): an optional judge tier at baseline-capture time -- a sample of
Figure crops + their drafted alt text sent to a different model family
(Claude) asking whether the description actually matches the image. Until
that exists, a consistent-but-wrong description is a human-sampling
problem, not a corpus-tooling one.

## Acceptance test for this tooling itself

Before trusting a baseline from this runner, confirm it actually catches
known-real regressions. On this corpus, `T1`'s own QC regression report
(see the measurer's delivery notes, kept outside this repo) already
confirmed `measure.py` flags all three known regressions comparing two
real prior runs. As a determinism smoke test, running `T1` once through
this runner should reproduce those same known structural numbers -- a
mismatch means investigate the runner/pipeline before baselining anything.

## Corpus size

The full 6-title set is the real gate for a theme PR. A 2-3 title subset
(`--titles T1,T2`) is fine while iterating on the runner or measurer
themselves, but isn't a substitute for the full set before merging.

Two real titles already known in this codebase's own history (one ~330MB
with ~5900 images, one ~1.4GB) are deliberately excluded from this corpus
-- too large for a routine run. Worth a separate, periodic "stress tier"
later if ever wanted; out of scope here.
