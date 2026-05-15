"""Unit tests for content_tagger pure helpers.

The coordinate conversion in particular (zone bbox top-left origin ->
PDF content-stream bottom-left origin) was established empirically by
cross-referencing zone bboxes against real Tm/Td text positions. These
tests pin that hard-won fact so a future refactor can't silently break
it. See content_tagger module docstring for the derivation."""

import unittest

from content_tagger import _mat_mul, _apply, _zone_pdf_box, _find_zone, _IDENTITY


class TestMatrixMath(unittest.TestCase):

    def test_identity_is_neutral(self):
        m = (2, 0, 0, 3, 10, 20)
        self.assertEqual(_mat_mul(_IDENTITY, m), m)
        self.assertEqual(_mat_mul(m, _IDENTITY), m)

    def test_translation_compose(self):
        t1 = (1, 0, 0, 1, 5, 7)
        t2 = (1, 0, 0, 1, 10, 20)
        # translations add
        self.assertEqual(_mat_mul(t1, t2), (1, 0, 0, 1, 15, 27))

    def test_scale_then_translate(self):
        scale = (2, 0, 0, 2, 0, 0)
        translate = (1, 0, 0, 1, 100, 50)
        # apply scale first, then translate
        result = _mat_mul(scale, translate)
        self.assertEqual(result, (2, 0, 0, 2, 100, 50))

    def test_apply_identity(self):
        self.assertEqual(_apply(_IDENTITY, 42.0, 17.0), (42.0, 17.0))

    def test_apply_translation(self):
        self.assertEqual(_apply((1, 0, 0, 1, 10, 20), 5.0, 5.0), (15.0, 25.0))

    def test_apply_scale(self):
        self.assertEqual(_apply((2, 0, 0, 3, 0, 0), 4.0, 5.0), (8.0, 15.0))


class TestZonePdfBox(unittest.TestCase):
    """Zone bbox is TOP-LEFT origin; PDF space is BOTTOM-LEFT origin.
       pdf_y_top    = page_height - zone.y
       pdf_y_bottom = page_height - zone.y - zone.h
       x maps directly."""

    def test_basic_conversion(self):
        zone = {'bounds': {'x': 72.0, 'y': 100.0, 'w': 200.0, 'h': 50.0}}
        x0, y0, x1, y1 = _zone_pdf_box(zone, page_height=792.0)
        self.assertEqual(x0, 72.0)
        self.assertEqual(x1, 272.0)              # x + w
        self.assertEqual(y1, 692.0)              # page_height - y  (top edge)
        self.assertEqual(y0, 642.0)              # page_height - y - h (bottom edge)

    def test_matches_empirically_verified_case(self):
        # Nora p3: zone y=549.2 h=45 on a 792-tall page landed text at
        # PDF-y ~200-242 — verified 2026-05-15.
        zone = {'bounds': {'x': 72.0, 'y': 549.2, 'w': 110.7, 'h': 45.0}}
        x0, y0, x1, y1 = _zone_pdf_box(zone, page_height=792.0)
        self.assertAlmostEqual(y0, 197.8, places=1)
        self.assertAlmostEqual(y1, 242.8, places=1)

    def test_top_of_page_zone(self):
        # A zone at the very top (y=0) should reach the page's top edge.
        zone = {'bounds': {'x': 0.0, 'y': 0.0, 'w': 100.0, 'h': 30.0}}
        _, y0, _, y1 = _zone_pdf_box(zone, page_height=792.0)
        self.assertEqual(y1, 792.0)              # top edge == page height
        self.assertEqual(y0, 762.0)


class TestFindZone(unittest.TestCase):

    def _boxes(self):
        # (index, (x0, y0, x1, y1)) in PDF space
        return [
            (0, (72.0, 600.0, 540.0, 700.0)),   # upper band
            (1, (72.0, 400.0, 540.0, 500.0)),   # middle band
            (2, (72.0, 100.0, 540.0, 200.0)),   # lower band
        ]

    def test_point_inside_a_zone(self):
        self.assertEqual(_find_zone(300.0, 650.0, self._boxes()), 0)
        self.assertEqual(_find_zone(300.0, 450.0, self._boxes()), 1)
        self.assertEqual(_find_zone(300.0, 150.0, self._boxes()), 2)

    def test_tolerance_absorbs_baseline_rounding(self):
        # 1.5 pt below a zone's bottom edge still counts (tol = 2.0).
        self.assertEqual(_find_zone(300.0, 598.5, self._boxes()), 0)

    def test_point_outside_all_falls_back_to_nearest(self):
        # A point in the gap between bands snaps to the nearest by centre.
        idx = _find_zone(300.0, 550.0, self._boxes())
        self.assertIn(idx, (0, 1))               # nearest of the two adjacent

    def test_empty_zone_list_returns_none(self):
        self.assertIsNone(_find_zone(100.0, 100.0, []))


if __name__ == '__main__':
    unittest.main()
