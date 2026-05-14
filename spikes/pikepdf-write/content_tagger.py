"""Content-stream tagger for the pikepdf write path (Issue #396, the
/MCID linkage increment).

PDF/UA-1 clause 7.1 test 3 requires that all "real content" on a page is
enclosed in marked-content sequences (`/Tag <</MCID n>> BDC … EMC`) whose
MCIDs are referenced from the structure tree. Without this the structure
tree is "orphaned" — it describes structure that points at no content,
and every document fails 7.1.

This module rewrites a page's content stream to wrap each content-drawing
operator in a marked-content sequence, and reports which zone (if any)
each MCID belongs to so the caller can wire the MCIDs into the structure
elements' /K arrays.

Coordinate convention (established empirically 2026-05-15 by cross-
referencing zone bboxes against actual Tm/Td text positions):
  - Zone bbox {x, y, w, h} is TOP-LEFT origin (image-style), same units
    as PDF user space.
  - PDF content-stream space is BOTTOM-LEFT origin.
  - Conversion:  pdf_y_bottom = page_height - zone.y - zone.h
                 pdf_y_top    = page_height - zone.y
                 x maps directly.

Scope / known limitations (tracked in #396):
  - Text position tracking uses the translation component of the text
    and graphics matrices. It does not advance position within a TJ run
    or account for font glyph widths — fine for ZONE assignment (we only
    need the start point of each show op), not for glyph-precise tagging.
  - Assumes input pages are NOT already tagged (true for the corpus).
    Pre-existing marked content would be double-wrapped.
  - Inline images (BI/ID/EI) are passed through untagged-but-artifacted.
"""

import pikepdf

# Operators that draw text.
_TEXT_SHOW_OPS = {'Tj', 'TJ', "'", '"'}
# Operator that paints an external object (image / form XObject).
_XOBJECT_OP = 'Do'
# Path construction operators that *begin* a new path subpath.
_PATH_START_OPS = {'m', 're'}
# Path construction operators that *continue* an open path.
_PATH_CONT_OPS = {'l', 'c', 'v', 'y', 'h', 'W', 'W*'}
# Path-painting operators that *end* a path (and paint marks, except `n`).
_PATH_PAINT_OPS = {'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'}
# Shading paint — a single op that paints marks.
_SHADING_OP = 'sh'


def _mat_mul(m1, m2):
    """Multiply two 2-D affine matrices in PDF's [a b c d e f] form."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply(m, x, y):
    """Apply affine matrix m to point (x, y)."""
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _zone_pdf_box(zone, page_height):
    """Return (x0, y0, x1, y1) of a zone in PDF (bottom-left) space."""
    b = zone['bounds']
    x0 = float(b['x'])
    x1 = x0 + float(b['w'])
    y1 = page_height - float(b['y'])              # top edge
    y0 = page_height - float(b['y']) - float(b['h'])  # bottom edge
    return (x0, y0, x1, y1)


def _find_zone(px, py, zone_boxes):
    """Return the index of the zone whose PDF-space box contains (px, py),
    or the nearest zone by centre distance if none contains it, or None
    when there are no zones. A small tolerance absorbs baseline-vs-bbox
    rounding."""
    if not zone_boxes:
        return None
    tol = 2.0
    for idx, (x0, y0, x1, y1) in zone_boxes:
        if x0 - tol <= px <= x1 + tol and y0 - tol <= py <= y1 + tol:
            return idx
    # No containing zone — fall back to nearest centre. Keeps content
    # "real" (assigned to a structure element) rather than artifacting
    # it away, which would under-tag the document.
    best_idx, best_d2 = None, None
    for idx, (x0, y0, x1, y1) in zone_boxes:
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        d2 = (px - cx) ** 2 + (py - cy) ** 2
        if best_d2 is None or d2 < best_d2:
            best_idx, best_d2 = idx, d2
    return best_idx


def retag_page_content(page, page_zones, page_height):
    """Rewrite a page's content stream so every text/image drawing
    operator is wrapped in a marked-content sequence.

    Args:
        page: pikepdf page object.
        page_zones: list of zone dicts on this page (artifacts already
            excluded by the caller), in structure order.
        page_height: float, page MediaBox height.

    Returns:
        (new_operations, assignments) where
          new_operations is the rewritten operator list ready for
            pikepdf.unparse_content_stream, and
          assignments is a list of (mcid:int, zone_index:int) — zone_index
            indexes into page_zones.
    """
    operations = list(pikepdf.parse_content_stream(page))

    # Precompute each zone's PDF-space box, paired with its index.
    zone_boxes = [
        (idx, _zone_pdf_box(z, page_height))
        for idx, z in enumerate(page_zones)
    ]

    new_ops = []
    assignments = []
    mcid = 0

    # Graphics state stack (CTM) and text state.
    ctm = _IDENTITY
    ctm_stack = []
    text_matrix = _IDENTITY
    line_matrix = _IDENTITY
    leading = 0.0
    in_text = False
    # Path state: between a path-construction op and its painting op, an
    # /Artifact BDC has been opened and is waiting for its EMC.
    in_path = False

    def wrap(operands, operator, zone_idx):
        """Emit a /Span <</MCID n>> BDC … EMC around one drawing op."""
        nonlocal mcid
        mc_dict = pikepdf.Dictionary(MCID=mcid)
        new_ops.append(
            (pikepdf.Array([pikepdf.Name('/Span'), mc_dict]),
             pikepdf.Operator('BDC'))
        )
        new_ops.append((operands, operator))
        new_ops.append((pikepdf.Array([]), pikepdf.Operator('EMC')))
        assignments.append((mcid, zone_idx))
        mcid += 1

    def artifact_wrap(operands, operator):
        """Mark a single drawing op as an artifact (marked, but not real
        content — so it doesn't trip 7.1 test 3 as untagged, and isn't
        expected to appear in the structure tree)."""
        new_ops.append(
            (pikepdf.Array([pikepdf.Name('/Artifact')]),
             pikepdf.Operator('BMC'))
        )
        new_ops.append((operands, operator))
        new_ops.append((pikepdf.Array([]), pikepdf.Operator('EMC')))

    def artifact_open():
        """Open an /Artifact marked-content sequence (paired with a later
        EMC). Used to bracket a multi-operator path."""
        new_ops.append(
            (pikepdf.Array([pikepdf.Name('/Artifact')]),
             pikepdf.Operator('BMC'))
        )

    def emc():
        new_ops.append((pikepdf.Array([]), pikepdf.Operator('EMC')))

    for operands, operator in operations:
        op = str(operator)

        # ----- graphics state -----
        if op == 'q':
            ctm_stack.append(ctm)
            new_ops.append((operands, operator))
            continue
        if op == 'Q':
            if ctm_stack:
                ctm = ctm_stack.pop()
            new_ops.append((operands, operator))
            continue
        if op == 'cm' and len(operands) == 6:
            m = tuple(float(o) for o in operands)
            ctm = _mat_mul(m, ctm)
            new_ops.append((operands, operator))
            continue

        # ----- text object -----
        if op == 'BT':
            in_text = True
            text_matrix = _IDENTITY
            line_matrix = _IDENTITY
            new_ops.append((operands, operator))
            continue
        if op == 'ET':
            in_text = False
            new_ops.append((operands, operator))
            continue
        if op == 'TL' and len(operands) == 1:
            leading = float(operands[0])
            new_ops.append((operands, operator))
            continue
        if op == 'Tm' and len(operands) == 6:
            m = tuple(float(o) for o in operands)
            text_matrix = m
            line_matrix = m
            new_ops.append((operands, operator))
            continue
        if op in ('Td', 'TD') and len(operands) == 2:
            tx, ty = float(operands[0]), float(operands[1])
            if op == 'TD':
                leading = -ty
            line_matrix = _mat_mul((1, 0, 0, 1, tx, ty), line_matrix)
            text_matrix = line_matrix
            new_ops.append((operands, operator))
            continue
        if op == 'T*':
            line_matrix = _mat_mul((1, 0, 0, 1, 0, -leading), line_matrix)
            text_matrix = line_matrix
            new_ops.append((operands, operator))
            continue

        # ----- drawing operators: wrap in marked content -----
        if op in _TEXT_SHOW_OPS and in_text:
            # ' and " implicitly do a T* first.
            if op in ("'", '"'):
                line_matrix = _mat_mul((1, 0, 0, 1, 0, -leading), line_matrix)
                text_matrix = line_matrix
            # Device position = text matrix origin transformed by CTM.
            tx, ty = text_matrix[4], text_matrix[5]
            dx, dy = _apply(ctm, tx, ty)
            zone_idx = _find_zone(dx, dy, zone_boxes)
            if zone_idx is not None:
                wrap(operands, operator, zone_idx)
            else:
                artifact_wrap(operands, operator)
            continue

        if op == _XOBJECT_OP:
            # Image/form XObject — position from CTM origin.
            dx, dy = _apply(ctm, 0.0, 0.0)
            zone_idx = _find_zone(dx, dy, zone_boxes)
            if zone_idx is not None:
                wrap(operands, operator, zone_idx)
            else:
                artifact_wrap(operands, operator)
            continue

        # ----- vector paths: bracket the whole construction→paint run -----
        # PDF/UA-1 7.1 test 3 requires *every* content item to be marked.
        # Path-painting ops (rule lines, boxes, fills) are content too, so
        # an /Artifact BMC … EMC is opened at the first construction op and
        # closed at the painting op.
        if op in _PATH_START_OPS:
            if not in_path:
                artifact_open()
                in_path = True
            new_ops.append((operands, operator))
            continue
        if op in _PATH_CONT_OPS:
            new_ops.append((operands, operator))
            continue
        if op in _PATH_PAINT_OPS:
            new_ops.append((operands, operator))
            if in_path:
                emc()
                in_path = False
            continue

        # ----- shading + inline images: single-op artifacts -----
        if op == _SHADING_OP:
            artifact_wrap(operands, operator)
            continue
        if 'INLINE IMAGE' in op.upper():
            artifact_wrap(operands, operator)
            continue

        # everything else passes through unchanged
        new_ops.append((operands, operator))

    # Safety net: a malformed stream could leave a path unterminated.
    if in_path:
        emc()

    return new_ops, assignments
