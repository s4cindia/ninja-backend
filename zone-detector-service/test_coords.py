import unittest
from coords import px_bbox_to_pdf_points


class TestPxBboxToPdfPoints(unittest.TestCase):
    # A US-Letter page (612x792 pt) rendered to a 1280x1656 px image
    # (612:792 == 1280:1656, a uniform downscale — the export's render shape).
    IMG_W, IMG_H = 1280, 1656
    PDF_W, PDF_H = 612.0, 792.0

    def test_full_image_maps_to_full_page(self):
        b = px_bbox_to_pdf_points(0, 0, self.IMG_W, self.IMG_H, self.IMG_W, self.IMG_H, self.PDF_W, self.PDF_H)
        self.assertAlmostEqual(b["x"], 0.0)
        self.assertAlmostEqual(b["y"], 0.0)
        self.assertAlmostEqual(b["w"], 612.0)
        self.assertAlmostEqual(b["h"], 792.0)

    def test_top_left_quadrant(self):
        b = px_bbox_to_pdf_points(0, 0, 640, 828, self.IMG_W, self.IMG_H, self.PDF_W, self.PDF_H)
        self.assertAlmostEqual(b["x"], 0.0)
        self.assertAlmostEqual(b["y"], 0.0)
        self.assertAlmostEqual(b["w"], 306.0)
        self.assertAlmostEqual(b["h"], 396.0)

    def test_lower_right_box_keeps_top_left_origin(self):
        # y must NOT be flipped: a box in the lower-right of the image has a
        # LARGE y in points (top-left origin), not a small one.
        b = px_bbox_to_pdf_points(640, 828, self.IMG_W, self.IMG_H, self.IMG_W, self.IMG_H, self.PDF_W, self.PDF_H)
        self.assertAlmostEqual(b["x"], 306.0)
        self.assertAlmostEqual(b["y"], 396.0)
        self.assertAlmostEqual(b["w"], 306.0)
        self.assertAlmostEqual(b["h"], 396.0)

    def test_reversed_corners_are_normalised(self):
        b = px_bbox_to_pdf_points(self.IMG_W, self.IMG_H, 0, 0, self.IMG_W, self.IMG_H, self.PDF_W, self.PDF_H)
        self.assertAlmostEqual(b["x"], 0.0)
        self.assertAlmostEqual(b["y"], 0.0)
        self.assertAlmostEqual(b["w"], 612.0)
        self.assertAlmostEqual(b["h"], 792.0)

    def test_non_square_downscale_ratio(self):
        # 1240x1754 image from an A4 page (595x842 pt)
        b = px_bbox_to_pdf_points(620, 877, 1240, 1754, 1240, 1754, 595.0, 842.0)
        self.assertAlmostEqual(b["x"], 297.5, places=3)
        self.assertAlmostEqual(b["y"], 421.0, places=3)
        self.assertAlmostEqual(b["w"], 297.5, places=3)
        self.assertAlmostEqual(b["h"], 421.0, places=3)

    def test_rejects_zero_image_dimension(self):
        with self.assertRaises(ValueError):
            px_bbox_to_pdf_points(0, 0, 1, 1, 0, 100, 612.0, 792.0)


if __name__ == "__main__":
    unittest.main()
