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

        # Set ViewerPreferences with DisplayDocTitle (PDF/UA 7.1 test 10)
        pdf.Root.ViewerPreferences = pikepdf.Dictionary(
            DisplayDocTitle=True,
        )

        # Add XMP metadata stream (PDF/UA 7.1 test 8)
        xmp = (
            '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about=""'
            ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
            ' xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">'
            '<pdfuaid:part>1</pdfuaid:part>'
            '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">'
            'Tagged PDF</rdf:li></rdf:Alt></dc:title>'
            '</rdf:Description>'
            '</rdf:RDF>'
            '</x:xmpmeta>'
            '<?xpacket end="w"?>'
        )
        metadata_stream = pikepdf.Stream(pdf, xmp.encode('utf-8'))
        metadata_stream[pikepdf.Name('/Type')] = pikepdf.Name('/Metadata')
        metadata_stream[pikepdf.Name('/Subtype')] = pikepdf.Name('/XML')
        pdf.Root.Metadata = pdf.make_indirect(metadata_stream)

        # Build structure tree
        struct_tree_root = pikepdf.Dictionary(
            Type=pikepdf.Name('/StructTreeRoot'),
        )

        # RoleMap (PDF/UA-1 7.3 test 1): map every structure type this
        # writer emits to its PDF 1.7 standard type. All of these already
        # ARE standard types, so each maps to itself — but supplying an
        # explicit RoleMap is the conformant practice and removes any
        # ambiguity for the validator. Increment-1 of Issue #396.
        role_map = pikepdf.Dictionary()
        for _role in ('Document', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
                      'Table', 'Figure', 'Caption', 'Note'):
            role_map[pikepdf.Name('/' + _role)] = pikepdf.Name('/' + _role)
        struct_tree_root.RoleMap = role_map

        struct_tree_ref = pdf.make_indirect(struct_tree_root)

        # Create document-level structure element. make_indirect is called
        # exactly once here — the previous code re-ran it inside the page
        # loop, risking duplicate indirect objects for the same dict and a
        # malformed tree. Every StructElem's /P now points at this one ref.
        doc_elem = pikepdf.Dictionary(
            Type=pikepdf.Name('/StructElem'),
            S=pikepdf.Name('/Document'),
            P=struct_tree_ref,
            K=pikepdf.Array(),
        )
        doc_ref = pdf.make_indirect(doc_elem)

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

            # Tab order must follow structure order (PDF/UA-1 7.18.x).
            # /Tabs /S declares structure-order tabbing on every page.
            page_obj[pikepdf.Name('/Tabs')] = pikepdf.Name('/S')

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

                # Note tags require an ID entry (PDF/UA 7.9 test 1)
                if tag_name == '/Note':
                    note_id = f'note-p{zone.get("pageNumber", 0)}-{zone_count}'
                    attrs['ID'] = pikepdf.String(note_id)

                struct_elem = pikepdf.Dictionary(**attrs)
                doc_elem.K.append(pdf.make_indirect(struct_elem))
                zone_count += 1

        # Attach structure tree to document. Reuse the single doc_ref made
        # above rather than calling make_indirect again on doc_elem.
        struct_tree_root.K = doc_ref
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
