# Ninja Backend - Commit History

## Branch: feat/citation-ui-enhancements

This document tracks all commits for reference and restore points.

---

## Recent Commits

| Commit Hash | Date & Time | Description |
|-------------|-------------|-------------|
| `e28b5b3` | 2026-02-17 20:42:00 | **fix(citation): update fullHtml with citation range support** |
| `b9fcc87` | 2026-02-17 17:53:56 | **Vancouver reference order fixed** |
| `ff2dfc0` | 2026-02-14 23:09:03 | fix: update citation rawText after style conversion and improve orphan detection |
| `abf4f4f` | 2026-02-10 20:55:40 | feat(citation): fix inline citation highlighting and add recent jobs endpoint |
| `f59c6f1` | 2026-02-07 07:56:27 | Improve citation rendering by using highlighted HTML |
| `dbde4f1` | 2026-02-07 07:36:50 | Improve citation parsing to correctly identify all references |
| `8a8aa15` | 2026-02-07 07:23:48 | Saved progress at the end of the loop |
| `8b922f0` | 2026-02-07 07:21:58 | Improve citation number extraction and assignment for better reference matching |
| `936a40e` | 2026-02-07 07:13:38 | Saved progress at the end of the loop |
| `69528ef` | 2026-02-07 07:13:06 | Improve citation highlighting to correctly identify references and avoid false positives |
| `c0730a7` | 2026-02-07 06:55:53 | Improve citation highlighting and linking within the document editor |
| `1d1ea47` | 2026-02-07 06:44:23 | Improve citation highlighting by directly manipulating the DOM |
| `27ba4f2` | 2026-02-07 06:39:17 | Improve citation highlighting to support parenthetical references |
| `0c483e3` | 2026-02-07 06:35:17 | Add HTML content when processing uploaded documents |
| `7d14850` | 2026-02-07 06:18:48 | Saved progress at the end of the loop |
| `a5818a8` | 2026-02-07 06:18:32 | Add interactive tooltips for document references and improve HTML rendering |
| `4791260` | 2026-02-07 05:59:32 | Saved progress at the end of the loop |
| `7a48320` | 2026-02-07 05:58:54 | Add citation validation and reference lookup features for document analysis |
| `6fa3e5b` | 2026-02-07 05:38:11 | Update integration guide to prefer styled HTML for document display |
| `d331c0d` | 2026-02-07 05:32:29 | Saved progress at the end of the loop |
| `604ca15` | 2026-02-07 05:31:41 | Add ability to convert and display documents as formatted HTML |
| `9de70ab` | 2026-02-07 05:22:48 | Add ability to load documents as styled HTML files |
| `0e9b422` | 2026-02-07 05:14:31 | Improve document text retrieval to accept job IDs |
| `5480616` | 2026-02-07 05:03:00 | Add instructions for integrating a citation editor into the existing frontend |
| `10d5c23` | 2026-02-07 04:57:24 | Saved progress at the end of the loop |
| `f2b80b9` | 2026-02-07 04:57:05 | Improve the editorial document view and suggestion handling |
| `8a7f3dd` | 2026-02-06 12:00:57 | Saved progress at the end of the loop |
| `a8d0cb2` | 2026-02-06 12:00:36 | Add direct access to citation analysis via URL and improve user interface |
| `26cf90c` | 2026-02-06 11:49:50 | Saved progress at the end of the loop |
| `3bb9489` | 2026-02-06 11:49:02 | Improve security by sanitizing user-provided text and API data |
| `b9b7185` | 2026-02-06 11:19:44 | Add system to analyze citation stylesheets within documents |
| `9779606` | 2026-02-06 10:20:13 | Saved progress at the end of the loop |
| `d41aada` | 2026-02-06 10:19:27 | Enhance citation processing with style validation and editorial overviews |
| `7c39a2f` | 2026-02-06 08:17:22 | Saved progress at the end of the loop |
| `ad47d63` | 2026-02-06 08:16:24 | Improve citation detection accuracy and document parsing |
| `fa97208` | 2026-02-06 07:55:31 | Saved progress at the end of the loop |
| `e97be53` | 2026-02-06 07:54:44 | Improve the capture rate of document references using chunked processing |
| `f5ecdb6` | 2026-02-06 07:03:14 | Saved progress at the end of the loop |
| `47509c7` | 2026-02-06 07:02:15 | Increase document processing context window and reference section allocation |
| `584fe93` | 2026-02-06 06:43:58 | Saved progress at the end of the loop |
| `f3a38e9` | 2026-02-06 06:43:38 | Improve AI reference generation by fixing JSON parsing and handling invalid entries |
| `827230f` | 2026-02-06 06:30:29 | Saved progress at the end of the loop |
| `85cd2fe` | 2026-02-06 06:29:44 | Improve reference list generation by using AI with full document context |
| `0ff3d04` | 2026-02-06 06:10:41 | Saved progress at the end of the loop |
| `d275399` | 2026-02-06 06:10:17 | Add ability to retrieve and generate formatted reference lists for documents |
| `35d46b2` | 2026-02-05 12:06:10 | Improve author formatting for reference list generation |
| `7027bf1` | 2026-02-05 12:01:40 | Add missing citation details to validation endpoint responses |
| `a974ad6` | 2026-02-05 11:59:43 | Add formatted entry to reference list for better display |
| `071e8c4` | 2026-02-05 11:35:36 | Add automatic citation parsing for reference list generation |
| `c1c2e43` | 2026-02-05 11:30:51 | Fix issue with parsing AI-generated citation validation responses |
| `028c976` | 2026-02-05 10:51:33 | Add comprehensive citation API documentation for frontend use |

---

## Key Restore Points

### Citation Range Support in fullHtml
- **Commit:** `e28b5b3`
- **Date:** 2026-02-17 20:42:00
- **Description:** Fixed fullHtml updates to handle citation ranges like [3-5]
- **Key Changes:**
  - Added `updateCitationNumbersInHtml` helper method that handles all citation formats
  - Supports: `[3]`, `[3-5]`, `[1,2,3]`, `[1, 3-5, 7]` and parenthetical equivalents
  - Fixed `resequenceByAppearance` to properly update fullHtml
  - Fixed `deleteReference` to update fullHtml when renumbering
  - Updated export controller to use `citationStorageService` for S3/local storage
- **Root Cause:** Previous code only matched standalone `[N]` patterns, leaving ranges stale

### Vancouver Reference Order Fix
- **Commit:** `b9fcc87`
- **Date:** 2026-02-17 17:53:56
- **Description:** Fixed Vancouver citation sequencing and reference reordering
- **Key Changes:**
  - Fixed References section detection regex
  - Body/references split works correctly
  - Reference reordering physically reorders paragraphs in exported DOCX
  - In-text citation track changes with ins/del OOXML markup
  - Volume/issue numbers (60(5), 47(4)) protected from modification

### Citation Style Conversion Fix
- **Commit:** `ff2dfc0`
- **Date:** 2026-02-14 23:09:03
- **Description:** Fixed rawText update after style conversion

### Citation Highlighting Fix
- **Commit:** `abf4f4f`
- **Date:** 2026-02-10 20:55:40
- **Description:** Fixed inline citation highlighting and added recent jobs endpoint

---

## How to Restore

```bash
# View commit details
git show <commit-hash>

# Restore to a specific commit (keeps history)
git checkout <commit-hash>

# Hard reset to a commit (discards all changes after)
git reset --hard <commit-hash>

# Create a branch from a restore point
git checkout -b restore-branch <commit-hash>
```

---

## Quick Reference Commands

```bash
# View full commit history
git log --oneline

# View commit with changes
git show <commit-hash> --stat

# Compare two commits
git diff <commit1> <commit2>

# Find commits by message
git log --grep="Vancouver"
```

---

*Last Updated: 2026-02-17 20:42:00*
