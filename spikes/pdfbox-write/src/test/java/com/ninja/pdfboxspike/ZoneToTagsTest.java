package com.ninja.pdfboxspike;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * JUnit 5 mirror of {@code spikes/pikepdf-write/test_zone_to_tags.py}.
 * Every behaviour the Python tests pin should be testable here so the
 * two spikes have the same contract.
 */
class ZoneToTagsTest {

    @Test @DisplayName("paragraph maps to /P")
    void paragraph_maps_to_P() {
        assertEquals("P", ZoneToTags.getPdfRole("paragraph"));
    }

    @Test @DisplayName("section-header maps to /H")
    void section_header_maps_to_H() {
        assertEquals("H", ZoneToTags.getPdfRole("section-header"));
    }

    @Test @DisplayName("table maps to /Table")
    void table_maps_to_Table() {
        assertEquals("Table", ZoneToTags.getPdfRole("table"));
    }

    @Test @DisplayName("figure maps to /Figure")
    void figure_maps_to_Figure() {
        assertEquals("Figure", ZoneToTags.getPdfRole("figure"));
    }

    @Test @DisplayName("caption maps to /Caption")
    void caption_maps_to_Caption() {
        assertEquals("Caption", ZoneToTags.getPdfRole("caption"));
    }

    @Test @DisplayName("footnote maps to /Note")
    void footnote_maps_to_Note() {
        assertEquals("Note", ZoneToTags.getPdfRole("footnote"));
    }

    @Test @DisplayName("running header/footer map to /Artifact role")
    void artifact_roles() {
        assertEquals("Artifact", ZoneToTags.getPdfRole("header"));
        assertEquals("Artifact", ZoneToTags.getPdfRole("footer"));
    }

    @Test @DisplayName("unknown zone type falls back to /P")
    void unknown_maps_to_P() {
        assertEquals("P", ZoneToTags.getPdfRole("totally-bogus"));
        assertEquals("P", ZoneToTags.getPdfRole(null));
    }

    @Test @DisplayName("isArtifact true for header/footer only")
    void isArtifact_true_for_artefacts() {
        assertTrue(ZoneToTags.isArtifact("header"));
        assertTrue(ZoneToTags.isArtifact("footer"));
        assertFalse(ZoneToTags.isArtifact("paragraph"));
        assertFalse(ZoneToTags.isArtifact("table"));
        assertFalse(ZoneToTags.isArtifact(null));
    }

    @Test @DisplayName("heading level clamps to 1..6")
    void heading_level_clamps() {
        assertEquals(1, ZoneToTags.getHeadingLevel(null));
        assertEquals(1, ZoneToTags.getHeadingLevel(0));
        assertEquals(1, ZoneToTags.getHeadingLevel(-3));
        assertEquals(1, ZoneToTags.getHeadingLevel(1));
        assertEquals(3, ZoneToTags.getHeadingLevel(3));
        assertEquals(6, ZoneToTags.getHeadingLevel(6));
        assertEquals(6, ZoneToTags.getHeadingLevel(7));
        assertEquals(6, ZoneToTags.getHeadingLevel(99));
    }

    @Test @DisplayName("heading tags use H1..H6")
    void heading_tag_format() {
        assertEquals("H1", ZoneToTags.getHeadingTag(1));
        assertEquals("H2", ZoneToTags.getHeadingTag(2));
        assertEquals("H3", ZoneToTags.getHeadingTag(3));
        assertEquals("H4", ZoneToTags.getHeadingTag(4));
        assertEquals("H5", ZoneToTags.getHeadingTag(5));
        assertEquals("H6", ZoneToTags.getHeadingTag(6));
        // out-of-range clamps before formatting
        assertEquals("H6", ZoneToTags.getHeadingTag(9));
        assertEquals("H1", ZoneToTags.getHeadingTag(0));
    }
}
