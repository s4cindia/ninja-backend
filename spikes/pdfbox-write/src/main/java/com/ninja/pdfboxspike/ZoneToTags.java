package com.ninja.pdfboxspike;

import java.util.Map;
import java.util.Set;

/**
 * Ninja canonical zone type → PDF structure tag role.
 * Mirrors {@code spikes/pikepdf-write/zone_to_tags.py} so the two spikes
 * can be compared cleanly. Both spikes consume the same ground-truth JSON
 * shape ({@code zone.type} drawn from CanonicalZoneType) and emit the same
 * PDF tag roles, so any pass-rate delta is attributable to library
 * differences, not taxonomy.
 *
 * Canonical Zone Type ↔ PDF 1.7 / ISO 32000-1 standard structure type:
 *   paragraph      → P
 *   section-header → H (with H1..H6 based on headingLevel)
 *   table          → Table
 *   figure         → Figure
 *   caption        → Caption
 *   footnote       → Note
 *   header         → Artifact (running head — not in struct tree)
 *   footer         → Artifact (running foot — not in struct tree)
 */
public final class ZoneToTags {

    private ZoneToTags() {}

    /** Default fallback when a zone type isn't in the canonical 8. */
    public static final String DEFAULT_ROLE = "P";

    private static final Map<String, String> ROLE_MAP = Map.of(
        "paragraph",      "P",
        "section-header", "H",
        "table",          "Table",
        "figure",         "Figure",
        "caption",        "Caption",
        "footnote",       "Note",
        "header",         "Artifact",
        "footer",         "Artifact"
    );

    /** Zone types that should be marked as /Artifact and excluded from the struct tree. */
    private static final Set<String> ARTIFACT_TYPES = Set.of("header", "footer");

    /** Returns the PDF structure tag role for a given zone type. */
    public static String getPdfRole(String zoneType) {
        if (zoneType == null) return DEFAULT_ROLE;
        return ROLE_MAP.getOrDefault(zoneType, DEFAULT_ROLE);
    }

    /** True if the zone should be marked /Artifact (not included in the struct tree). */
    public static boolean isArtifact(String zoneType) {
        return zoneType != null && ARTIFACT_TYPES.contains(zoneType);
    }

    /**
     * Heading-level extractor for section-header zones. Defaults to 1 when
     * unspecified or out of range. Mirrors the Python spike's clamp 1..6.
     */
    public static int getHeadingLevel(Integer level) {
        if (level == null) return 1;
        return Math.max(1, Math.min(6, level));
    }

    /** Returns the heading tag (H1..H6) for the given level. */
    public static String getHeadingTag(int level) {
        return "H" + getHeadingLevel(level);
    }
}
