/**
 * pdfa11y rule ID → Matterhorn Protocol 1.1 condition ID mapping table
 *
 * ⚠️  CRITICAL: pdfa11y's own rule IDs (e.g. "UA-14-006", "UA-31-001") look
 * like they might BE Matterhorn condition numbers, but they are NOT --
 * pdfa11y groups its 112 checks into ITS OWN category/number scheme
 * (roughly aligned to ISO 32000 section numbers, not the Matterhorn
 * Protocol's checkpoint/condition numbering). Confirmed by cross-checking
 * every candidate against the REAL Matterhorn 1.1 condition text (not just
 * the ID number) before adding it here -- this caught real, would-have-
 * been-silent mismatches, e.g.:
 *   - pdfa11y's "UA-14-006" ("Heading style is consistent, H or H<n> not
 *     both") is actually Matterhorn's real 14-007. Matterhorn's REAL
 *     14-006 ("a node contains more than one H tag") is a completely
 *     different check that this codebase itself implemented earlier
 *     (see structure-analyzer.service.ts's isHeadingTagType coverage).
 *   - pdfa11y's "UA-06-003" ("XMP declares PDF/UA identifier") is
 *     Matterhorn's real 06-002, not 06-003.
 *   - pdfa11y files its dynamic-XFA check under its own "28" category
 *     (UA-28-028) even though the matching Matterhorn condition (dynamic
 *     XFA rendering) is 25-001, not anything in checkpoint 28.
 *
 * DO NOT add an entry here by matching numbers alone. Every entry below was
 * validated by reading pdfa11y's real JSON output (rule id + finding
 * message, or its PASS/N/A-state message when it never fired) AND the
 * corresponding Matterhorn condition's full description text side by side,
 * confirming they describe the SAME underlying PDF/UA requirement.
 *
 * Two confidence tiers, marked per entry below:
 *   [FIRING]  Directly observed as a real FAIL/WARN on a real document
 *             (the 3 shared fixtures with verapdf-matterhorn.map.ts, or
 *             a real 226-page tagged document) -- the strongest evidence.
 *   [TEXT]    Not yet observed firing on any real document tested so far —
 *             validated only by comparing pdfa11y's real rule definition
 *             (title/category/WCAG mapping, read from its PASS/N/A state)
 *             against Matterhorn's official condition text. Still real
 *             validation, not a number-matching guess, but a fixture that
 *             actually triggers each of these would raise confidence
 *             further — see tests/unit/services/pdf/pdfa11y.service.test.ts.
 *
 * Matterhorn Coverage Plan — Step 6
 */

import type { Pdfa11yFailure } from '../services/pdf/pdfa11y.service';

/**
 * Maps pdfa11y rule IDs to Matterhorn condition IDs.
 *
 * Key:   pdfa11y rule ID, exactly as printed by `pdfa11y --list-rules`,
 *        e.g. "UA-10-004"
 * Value: Matterhorn condition ID, e.g. "31-030"
 */
export const PDFA11Y_MATTERHORN_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  // ── Genuinely NEW Matterhorn coverage (not already found by Ninja's own
  //    validators or by veraPDF) ──────────────────────────────────────────

  // CP11: Natural language -- closes essentially this entire checkpoint's
  // previously-identified gap. Matterhorn 11-001 itself is deliberately
  // NOT mapped: pdfa11y's UA-11-001 ("document declares a primary
  // language") checks a narrower prerequisite (root /Lang presence), not
  // the same "can language be determined for page-content text at all"
  // question Matterhorn 11-001 actually asks (which is satisfied by
  // per-element /Lang too, not just a root declaration) -- UA-11-002 is
  // the real match for that, confirmed via its own N/A logic explicitly
  // deferring to inheritance from a root /Lang.
  ['UA-11-002', '11-001'], // [TEXT] "text-bearing structure elements declare /Lang" == "language for text in page content cannot be determined"
  ['UA-11-004', '11-002'], // [FIRING, PASS state observed] "Alt, ActualText and E have a determinable language" == Matterhorn 11-002 (Alt/ActualText/E)
  ['UA-11-006', '11-003'], // [FIRING, PASS state observed] "outline entries have a determinable language" == Matterhorn 11-003 (Outline entries)
  ['UA-11-005', '11-004'], // [TEXT] "annotation /Contents has a determinable language"
  ['UA-11-009', '11-005'], // [TEXT] "form field /TU has a determinable language"
  ['UA-11-007', '11-006'], // [FIRING, PASS state observed] "document metadata has a determinable language"

  // CP28: Annotations and forms
  ['UA-28-025', '28-004'], // [FIRING] "visible annotations expose a text description" -- real page-5 link on the 226-page trial doc
  ['UA-28-026', '28-005'], // [TEXT] "widget annotations expose a description (/TU or enclosing /Alt)"
  ['UA-28-012', '28-007'], // [TEXT] "no visible TrapNet annotations" == "a TrapNet annotation exists"
  ['UA-28-014', '28-010'], // [TEXT] "widget annotations are nested within a Form structure element"
  ['UA-28-013', '28-011'], // [FIRING] "link annotations are enclosed in a Link structure element" -- same real page-5 link
  ['UA-28-022', '28-014'], // [TEXT] "media clip data dictionaries carry a /CT entry"
  ['UA-28-023', '28-015'], // [TEXT] "media clip data dictionaries carry a default /Alt description"

  // CP31: Fonts
  ['UA-10-004', '31-030'], // [TEXT] "no text-showing operator references the .notdef glyph"

  // ── Cross-validating confirmations (already covered by Ninja's own
  //    validators or by veraPDF -- harmless: mapVeraPdfFailures-style
  //    dedup skips these when alreadyFound already has the condition, kept
  //    here only as a fallback if the primary source ever misses a case) ──
  ['UA-09-001', '31-009'], // [FIRING] font program not embedded (also covered by veraPDF)
  ['UA-10-001', '31-027'], // [FIRING] font missing ToUnicode (also covered by veraPDF)
  ['UA-06-003', '06-002'], // [FIRING] missing PDF/UA identifier (also covered by veraPDF and Ninja-native)
  ['UA-07-001', '07-001'], // [FIRING] ViewerPreferences/DisplayDocTitle (also covered by Ninja-native)
  ['UA-28-028', '25-001'], // [TEXT] dynamic XFA form (also covered by Ninja-native -- filed under
  //                          pdfa11y's OWN "28" category despite being Matterhorn's real 25-001)

  //
  // ── Not yet validated -- pdfa11y has ~90 more rules not reviewed here.
  //    Do NOT add by matching ID numbers alone (see this file's header).
  //    Each new entry needs the same real-output + real-Matterhorn-text
  //    side-by-side check the entries above got. Candidates worth
  //    reviewing next: the remaining CP28 rules (widget label/TU
  //    variants), CP01 (structure/artifact classification -- pdfa11y's
  //    "01 Structure tree" category has ~14 rules, none reviewed yet),
  //    and the many-to-one cases skipped here (UA-10-003 "/ToUnicode
  //    values are valid Unicode" plausibly covers BOTH Matterhorn 31-028
  //    and 31-029, and UA-31-001 plausibly covers both 31-004 and 31-005
  //    -- neither was added because disambiguating which of the two
  //    applies would need inspecting the finding message text, not done
  //    yet).
  //
]);

/**
 * The set of Matterhorn condition IDs that the current mapping table can cover.
 */
export const PDFA11Y_COVERED_CONDITIONS: ReadonlySet<string> = new Set(
  PDFA11Y_MATTERHORN_MAP.values(),
);

/**
 * Map a list of pdfa11y failures to their Matterhorn condition IDs.
 * Unmapped ruleId warnings are logged by Pdfa11yService.validate() before
 * this function is called — no duplicate logging here.
 *
 * Returns a Map of matterhornConditionId → Pdfa11yFailure for the first
 * matching failure per condition (subsequent duplicates are discarded).
 *
 * @param failures      Parsed pdfa11y failures from Pdfa11yService.validate()
 * @param alreadyFound  Set of matterhornCheckpoint values already found by
 *                      Ninja validators or veraPDF; mapped conditions in
 *                      this set are skipped.
 */
export function mapPdfa11yFailures(
  failures: Pdfa11yFailure[],
  alreadyFound: ReadonlySet<string>,
): Map<string, Pdfa11yFailure> {
  const result = new Map<string, Pdfa11yFailure>();

  for (const failure of failures) {
    const conditionId = PDFA11Y_MATTERHORN_MAP.get(failure.ruleId);

    if (conditionId === undefined) {
      continue;
    }

    if (alreadyFound.has(conditionId)) continue;

    if (!result.has(conditionId)) {
      result.set(conditionId, failure);
    }
  }

  return result;
}
