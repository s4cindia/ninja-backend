"""Python unit tests for zone_to_tags.py - pure logic, no PDF I/O."""

import unittest
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from zone_to_tags import get_pdf_role, is_artifact, get_heading_level


class TestZoneToTags(unittest.TestCase):

    def test_paragraph_maps_to_P(self):
        self.assertEqual(get_pdf_role('paragraph'), '/P')

    def test_section_header_maps_to_H(self):
        self.assertEqual(get_pdf_role('section-header'), '/H')

    def test_table_maps_to_Table(self):
        self.assertEqual(get_pdf_role('table'), '/Table')

    def test_figure_maps_to_Figure(self):
        self.assertEqual(get_pdf_role('figure'), '/Figure')

    def test_caption_maps_to_Caption(self):
        self.assertEqual(get_pdf_role('caption'), '/Caption')

    def test_footnote_maps_to_Note(self):
        self.assertEqual(get_pdf_role('footnote'), '/Note')

    def test_header_maps_to_Artifact(self):
        self.assertEqual(get_pdf_role('header'), '/Artifact')

    def test_footer_maps_to_Artifact(self):
        self.assertEqual(get_pdf_role('footer'), '/Artifact')

    def test_unknown_maps_to_P(self):
        self.assertEqual(get_pdf_role('unknown-type'), '/P')

    def test_header_is_artifact(self):
        self.assertTrue(is_artifact('header'))

    def test_footer_is_artifact(self):
        self.assertTrue(is_artifact('footer'))

    def test_paragraph_not_artifact(self):
        self.assertFalse(is_artifact('paragraph'))

    def test_table_not_artifact(self):
        self.assertFalse(is_artifact('table'))

    def test_heading_level_default(self):
        self.assertEqual(get_heading_level({}), 1)

    def test_heading_level_explicit(self):
        self.assertEqual(
            get_heading_level({'headingLevel': 3}), 3
        )

    def test_heading_level_clamped_max(self):
        self.assertEqual(
            get_heading_level({'headingLevel': 99}), 6
        )

    def test_heading_level_clamped_min(self):
        self.assertEqual(
            get_heading_level({'headingLevel': 0}), 1
        )


if __name__ == '__main__':
    unittest.main()
