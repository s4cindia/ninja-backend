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
corpus title is referred to only by an anonymous id (`T1`-`T7`) in this
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
npx tsx scripts/qc-regression/run-corpus.ts capture --run 1 --titles T1,T2,T3,T4,T5,T6,T7
npx tsx scripts/qc-regression/run-corpus.ts capture --run 2 --titles T1,T2,T3,T4,T5,T6,T7
npx tsx scripts/qc-regression/run-corpus.ts finalize-baseline --titles T1,T2,T3,T4,T5,T6,T7

# Before merging a theme PR: full set is the real gate.
npx tsx scripts/qc-regression/run-corpus.ts check --titles T1,T2,T3,T4,T5,T6,T7
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

## Acceptance test for this tooling itself

Before trusting a baseline from this runner, confirm it actually catches
known-real regressions. On this corpus, `T1`'s own QC regression report
(see the measurer's delivery notes, kept outside this repo) already
confirmed `measure.py` flags all three known regressions comparing two
real prior runs. As a determinism smoke test, running `T1` once through
this runner should reproduce those same known structural numbers -- a
mismatch means investigate the runner/pipeline before baselining anything.

## Corpus size

The full 7-title set is the real gate for a theme PR. A 2-3 title subset
(`--titles T1,T2`) is fine while iterating on the runner or measurer
themselves, but isn't a substitute for the full set before merging.

Two real titles already known in this codebase's own history (one ~330MB
with ~5900 images, one ~1.4GB) are deliberately excluded from this corpus
-- too large for a routine run. Worth a separate, periodic "stress tier"
later if ever wanted; out of scope here.
