/**
 * veraPDF rule ID → Matterhorn Protocol 1.1 condition ID mapping table
 *
 * Maps veraPDF MRR rule IDs (format: "{specPart}:{clause}-{testNumber}")
 * to Matterhorn Protocol 1.1 condition IDs (format: "CC-NNN").
 *
 * ⚠️  VALIDATION REQUIRED
 * The entries below are best-guess mappings derived from the ISO 14289-1
 * clause structure. They MUST be validated against actual veraPDF MRR output
 * from the 3 fixture PDFs in tests/fixtures/pdf/ before relying on them
 * in production PAC reports.
 *
 * To generate the validation XML:
 *   See tests/fixtures/pdf/verapdf-output/README.md
 *
 * After staging generates XML output:
 *   1. Collect all unique ruleIds from the XML files
 *   2. Cross-check against this map
 *   3. Fill in any missing entries and remove UNVALIDATED comments
 *   4. Run the unit tests to confirm round-trip coverage
 *
 * Matterhorn Coverage Plan — Step 4c
 */

import { logger } from '../lib/logger';
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
  // ── CP01: Real content tagged ─────────────────────────────────────────────
  // ISO 14289-1 §7.1 — Artefacts inside tagged content and vice versa
  // UNVALIDATED: ruleId format needs confirmation from staging MRR output
  // ['1:7.1-1', '01-003'],
  // ['1:7.1-2', '01-004'],
  // ['1:7.1-3', '01-005'],

  // ── CP06: Metadata ────────────────────────────────────────────────────────
  // ISO 14289-1 §6.2 — pdfuaid:part entry in XMP metadata
  // UNVALIDATED: most likely candidate based on ISO clause numbering
  // ['1:6.2-1', '06-002'],

  // ── CP07: Dictionary entries ──────────────────────────────────────────────
  // ISO 14289-1 §7.3 — ViewerPreferences/DisplayDocTitle
  // UNVALIDATED
  // ['1:7.3-1', '07-001'],
  // ['1:7.3-2', '07-002'],

  // ── CP31: Fonts ───────────────────────────────────────────────────────────
  // ISO 14289-1 §7.21.3 — Font program embedding
  // ISO 14289-1 §7.21.4 — Character encoding / ToUnicode
  // UNVALIDATED: fixture PDFs cp31-font-not-embedded.pdf and
  //              cp31-missing-tounicode.pdf should confirm these
  // ['1:7.21.3.1-1', '31-009'],   // font program not embedded
  // ['1:7.21.4.1-1', '31-027'],   // font missing ToUnicode

  //
  // TODO: Uncomment and validate after running veraPDF on staging fixture PDFs.
  //       See tests/fixtures/pdf/verapdf-output/README.md for commands.
  //
]);

/**
 * The set of Matterhorn condition IDs that the current mapping table can cover.
 * Used to compute TESTABLE_CONDITIONS in the PAC report service.
 */
export const VERAPDF_COVERED_CONDITIONS: ReadonlySet<string> = new Set(
  VERAPDF_MATTERHORN_MAP.values(),
);

/**
 * Map a list of veraPDF MRR failures to their Matterhorn condition IDs,
 * logging a warning for any ruleId absent from the mapping table.
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
      logger.warn(
        `[veraPDF] Unmapped ruleId: ${failure.ruleId} — description: ${failure.description}`,
      );
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
