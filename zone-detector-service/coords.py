"""Coordinate conversion for the zone detector.

Kept dependency-free (no torch / pdf libs) so the critical points<->pixels
mapping is unit-testable in isolation — a wrong mapping here silently corrupts
every detected zone.
"""


def px_bbox_to_pdf_points(x1, y1, x2, y2, img_w, img_h, pdf_w, pdf_h):
    """Map a YOLO box to PDF points.

    Input:  a box in the RENDERED IMAGE's pixel space (top-left origin), as
            Ultralytics returns it (xyxy).
    Output: corner ``{x, y, w, h}`` in **PDF points, top-left origin** — the
            convention Zone.bounds and the training export use.

    The page render is a uniform downscale of the page, so points-per-pixel is a
    single ratio per axis (``pdf_w/img_w`` == ``pdf_h/img_h`` up to rounding).
    No y-flip is applied: YOLO image coordinates and Zone.bounds are BOTH
    top-left, unlike Docling (bottom-left) which the docling sidecar has to flip.
    """
    if img_w <= 0 or img_h <= 0:
        raise ValueError(f"invalid image size {img_w}x{img_h}")
    sx = pdf_w / img_w
    sy = pdf_h / img_h
    x_lo, x_hi = (x1, x2) if x1 <= x2 else (x2, x1)
    y_lo, y_hi = (y1, y2) if y1 <= y2 else (y2, y1)
    return {
        "x": x_lo * sx,
        "y": y_lo * sy,
        "w": (x_hi - x_lo) * sx,
        "h": (y_hi - y_lo) * sy,
    }
