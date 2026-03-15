"""Core spike implementation: takes a PDF + zone ground truth,
writes a Tagged PDF structure tree using pikepdf."""

import pikepdf
from collections import defaultdict
from zone_to_tags import get_pdf_role, is_artifact, get_heading_level


def write_tagged_pdf(
    input_pdf_path: str,
    zones: list[dict],
    output_path: str,
) -> dict:
    """
    Write Tagged PDF structure tree from zone ground truth.

    zones: list of dicts with fields:
      pageNumber: int (1-indexed)
      bounds: { x, y, w, h }
      type: str (CanonicalZoneType)
      operatorLabel: str | None
      altText: str | None (for figure zones)
      headingLevel: int | None (for section-header)

    Returns: { success, outputPath, zoneCount, errorMessage? }
    """
    try:
        pdf = pikepdf.open(input_pdf_path)

        # Set MarkInfo - required for Tagged PDF
        pdf.Root.MarkInfo = pikepdf.Dictionary(Marked=True)

        # Set document language
        pdf.Root.Lang = pikepdf.String('en-US')

        # Build structure tree
        struct_tree_root = pikepdf.Dictionary(
            Type=pikepdf.Name('/StructTreeRoot'),
        )

        struct_tree_ref = pdf.make_indirect(struct_tree_root)

        # Create document-level structure element
        doc_elem = pikepdf.Dictionary(
            Type=pikepdf.Name('/StructElem'),
            S=pikepdf.Name('/Document'),
            P=struct_tree_ref,
            K=pikepdf.Array(),
        )

        # Group zones by page
        by_page = defaultdict(list)
        for z in zones:
            if not is_artifact(z.get('type', 'paragraph')):
                by_page[z['pageNumber']].append(z)

        zone_count = 0

        for page_num in sorted(by_page.keys()):
            page_zones = by_page[page_num]

            # Get the actual page object (0-indexed)
            page_idx = page_num - 1
            if page_idx >= len(pdf.pages):
                continue
            page_obj = pdf.pages[page_idx].obj

            doc_ref = pdf.make_indirect(doc_elem)

            for zone in page_zones:
                zone_type = zone.get('operatorLabel') \
                    or zone.get('type', 'paragraph')
                role = get_pdf_role(zone_type)

                # Build the tag role - headings use H1-H6
                if zone_type == 'section-header':
                    level = get_heading_level(zone)
                    tag_name = f'/H{level}'
                else:
                    tag_name = role

                # Create structure element
                attrs = {
                    'Type': pikepdf.Name('/StructElem'),
                    'S':    pikepdf.Name(tag_name),
                    'P':    doc_ref,
                    'Pg':   page_obj,
                }

                # Add Alt attribute for figure zones
                if zone_type == 'figure' and zone.get('altText'):
                    attrs['Alt'] = pikepdf.String(zone['altText'])

                struct_elem = pikepdf.Dictionary(**attrs)
                doc_elem.K.append(pdf.make_indirect(struct_elem))
                zone_count += 1

        # Attach structure tree to document
        struct_tree_root.K = pdf.make_indirect(doc_elem)
        pdf.Root.StructTreeRoot = struct_tree_ref

        pdf.save(output_path)
        pdf.close()

        return {
            'success':    True,
            'outputPath': output_path,
            'zoneCount':  zone_count,
        }

    except Exception as e:
        return {
            'success':      False,
            'outputPath':   output_path,
            'zoneCount':    0,
            'errorMessage': str(e),
        }
