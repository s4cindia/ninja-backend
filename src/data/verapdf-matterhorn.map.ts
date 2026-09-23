/**
 * veraPDF rule ID → Matterhorn Protocol 1.1 condition ID mapping table
 *
 * Maps veraPDF MRR rule IDs (format: "{specPart}:{clause}-{testNumber}")
 * to Matterhorn Protocol 1.1 condition IDs (format: "CC-NNN").
 *
 * VALIDATED entries below were confirmed by running veraPDF 1.30.2 locally
 * (`--flavour ua1 --format mrr`) against the 3 fixture PDFs in
 * tests/fixtures/pdf/ and reading the real ruleId off each failing <rule>.
 * Two of the original best-guess placeholders were WRONG once checked
 * against real output (31-009 and 31-027's clauses were swapped, and
 * 06-002 guessed clause 6.2 instead of the real clause 5) — this is why
 * every entry here must be validated against real MRR XML, not derived
 * from the Matterhorn `section` field alone. See
 * tests/unit/services/pdf/verapdf.service.test.ts for the fixture XML this
 * was validated against.
 *
 * Any NEW entry must go through the same process:
 *   1. Get (or build) a fixture PDF that triggers the target condition
 *   2. Run: verapdf --flavour ua1 --format mrr --maxfailuresdisplayed 99999 <file>
 *      (see tests/fixtures/pdf/verapdf-output/README.md)
 *   3. Read the real clause/testNumber/specification off the failing <rule>
 *   4. Add the entry here and a matching parseMrrXml test case
 *
 * Matterhorn Coverage Plan — Step 4c
 */

import type { VeraPdfFailure } from '../services/pdf/verapdf.service';

/**
 * Maps veraPDF rule IDs to Matterhorn condition IDs.
 *
 * Key:   veraPDF rule ID  e.g. "1:6.2-1"
 * Value: Matterhorn condition ID  e.g. "06-002"
 *
 * All entries are UNVALIDATED until the staging XML run confirms them.
 * Each entry carries a comment with the ISO 14289-1 clause it corresponds to.
 */
export const VERAPDF_MATTERHORN_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  // ── CP06: Metadata ────────────────────────────────────────────────────────
  // VALIDATED against real veraPDF 1.30.2 MRR output (cp06-metadata-failures.pdf):
  // clause="5" testNumber="1" — "doesn't contain PDF/UA Identification Schema".
  // Note: Ninja's own pdf-structure.validator.ts already detects this
  // natively (matterhornCheckpoint: '06-002'), so mapVeraPdfFailures() will
  // normally dedupe this away via `alreadyFound`. Kept as a fallback for
  // cases the native XMP check misses.
  ['1:5-1', '06-002'],

  // ── CP31: Fonts ───────────────────────────────────────────────────────────
  // VALIDATED against real veraPDF 1.30.2 MRR output:
  // cp31-font-not-embedded.pdf   → clause="7.21.4.1" testNumber="1"
  // cp31-missing-tounicode.pdf   → clause="7.21.7"   testNumber="1"
  // (The original placeholders for these two had the clauses swapped and
  // didn't match either real value — see file header note.)
  ['1:7.21.4.1-1', '31-009'],   // font program not embedded
  ['1:7.21.7-1', '31-027'],     // font missing ToUnicode

  // VALIDATED against real veraPDF 1.30.2 MRR output, captured live against
  // Math_Weir_PDF.pdf (132 real failing checks) and trimmed into
  // tests/fixtures/pdf/verapdf-output/cp31-charset-incomplete.xml — see
  // that file's own note on provenance (derived from a real document's
  // real output, not a purpose-built minimal fixture PDF, since no ready
  // corpus fixture for this specific condition was found). Real
  // description text: "If the FontDescriptor dictionary of an embedded
  // Type 1 font contains a CharSet string, then it shall list the
  // character names of all glyphs present in the font program" — this is
  // Matterhorn 31-012 exactly ("at least one of the glyphs present in the
  // font program is not listed in the CharSet string"), not to be confused
  // with 31-013 (the INVERSE case: a glyph listed in CharSet that's NOT
  // present in the font program — a real, separate veraPDF rule, clause
  // "7.21.4.2" testNumber "2", not yet validated/added here).
  ['1:7.21.4.2-1', '31-012'],   // Type1 font CharSet omits a glyph present in the font program

  //
  // ── Not yet validated — no fixture PDF built for these yet ────────────────
  // CP01 (§7.1 Artefacts), CP07 (§7.3 ViewerPreferences/DisplayDocTitle):
  // do NOT add without running real veraPDF output first — the Matterhorn
  // `section` field alone is not reliable (confirmed: 07-001 and 07-002
  // share the same section value, so it can't disambiguate them; the CP06
  // guess above was also wrong until checked against real output).
  //
  // Real findings observed live against Math_Weir_PDF.pdf, deliberately
  // NOT added below without more research (see this session's own
  // reconnaissance notes):
  //   - clause="7.3" testNumber="1" (real text: Figure tags need Alt/
  //     replacement text) shares its section with BOTH Matterhorn 13-001
  //     and 13-002 (same "07-001/07-002 can't disambiguate" trap) — likely
  //     13-001, but would only be a redundant fallback (Ninja's own
  //     alt-text validator already reports 13-001), not new coverage, so
  //     not worth the disambiguation work yet.
  //   - clause="7.1" testNumber="9" (real text: "Metadata stream... shall
  //     contain a dc:title entry") shares its section with 07-001/07-002,
  //     but its real subject (XMP dc:title) doesn't semantically match
  //     either (both are about the DisplayDocTitle viewer-preference flag,
  //     not the metadata title itself) — needs real research into which
  //     Matterhorn condition (likely a CP06 metadata one) actually covers
  //     dc:title presence before adding anything.
  //   - clause="7.2" testNumber="20" ("LI element may contain only Lbl and
  //     LBody elements") and testNumber="42" ("Table rows shall have the
  //     same number of columns") only correspond to Matterhorn conditions
  //     marked HUMAN-only (16-003's neighbors, 15-004) in matterhorn-1.1.
  //     data.ts — mapping to a HUMAN condition wouldn't add machine
  //     coverage under the TESTABLE_CONDITIONS framework, so these aren't
  //     candidates for this table at all, regardless of text match quality.
]);

/**
 * The set of Matterhorn condition IDs that the current mapping table can cover.
 * Used to compute TESTABLE_CONDITIONS in the PAC report service.
 */
export const VERAPDF_COVERED_CONDITIONS: ReadonlySet<string> = new Set(
  VERAPDF_MATTERHORN_MAP.values(),
);

/**
 * Map a list of veraPDF MRR failures to their Matterhorn condition IDs.
 * Unmapped ruleId warnings are logged by VeraPdfService.validate() before
 * this function is called — no duplicate logging here.
 *
 * Returns a Map of matterhornConditionId → VeraPdfFailure for the first
 * matching failure per condition (subsequent duplicates are discarded —
 * the Ninja-sourced issue always takes precedence in deduplication).
 *
 * @param failures    Parsed veraPDF failures from VeraPdfService.validate()
 * @param alreadyFound  Set of matterhornCheckpoint values already found by
 *                    Ninja validators; mapped conditions in this set are skipped.
 */
export function mapVeraPdfFailures(
  failures: VeraPdfFailure[],
  alreadyFound: ReadonlySet<string>,
): Map<string, VeraPdfFailure> {
  const result = new Map<string, VeraPdfFailure>();

  for (const failure of failures) {
    const conditionId = VERAPDF_MATTERHORN_MAP.get(failure.ruleId);

    if (conditionId === undefined) {
      // Warning already logged by VeraPdfService.validate() — skip silently here.
      continue;
    }

    // Skip if Ninja already found an issue for this Matterhorn condition
    // (Ninja issues carry better context: pageNumber, element, boundingBox).
    if (alreadyFound.has(conditionId)) continue;

    // Keep the first failure per condition only.
    if (!result.has(conditionId)) {
      result.set(conditionId, failure);
    }
  }

  return result;
}
