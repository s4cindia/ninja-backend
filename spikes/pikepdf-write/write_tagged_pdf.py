"""Core spike implementation: takes a PDF + zone ground truth,
writes a Tagged PDF structure tree using pikepdf."""

import pikepdf
from collections import defaultdict
from zone_to_tags import get_pdf_role, is_artifact, get_heading_level
from content_tagger import retag_page_content


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

        # Strip any pre-existing structure tree so we write onto a clean
        # canvas regardless of whether the input is publisher-tagged or not.
        # Without this, new marked-content wrapping nests inside the original
        # publisher BDC/EMC sequences → PDF/UA-1 7.1 t1/t2 nesting failures.
        if '/StructTreeRoot' in pdf.Root:
            del pdf.Root.StructTreeRoot
        for _page in pdf.pages:
            _po = _page.obj
            for _k in ('/StructParents', '/StructParent'):
                if _k in _po:
                    del _po[_k]
            # Strip /StructParent from annotations on this page too.
            annots = _po.get('/Annots')
            if annots:
                for ann in annots:
                    if '/StructParent' in ann:
                        del ann['/StructParent']

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

        # Build structure tree.
        #
        # No /RoleMap: every structure type this writer emits (Document, P,
        # H1-H6, Table, Figure, Caption, Note) is already a PDF 1.7 standard
        # type. A RoleMap is ONLY for mapping non-standard custom types to
        # standard ones. Increment 1 wrongly added self-mappings
        # (Document -> Document, …) which veraPDF flags as a *circular*
        # mapping (PDF/UA-1 7.1 test 6). With all-standard types the
        # conformant choice is to omit the RoleMap entirely.
        struct_tree_root = pikepdf.Dictionary(
            Type=pikepdf.Name('/StructTreeRoot'),
        )

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

        # ParentTree (a number tree) maps each page's /StructParents index
        # to the per-MCID array of structure-element references — the
        # content→structure reverse lookup PDF/UA-1 requires alongside the
        # forward /K → MCID links. Nums is [key0, val0, key1, val1, …].
        parent_tree_nums = pikepdf.Array()
        next_struct_parent = 0

        # Shared set across pages so each form XObject is strip+retag'd once.
        processed_forms: set = set()

        # Process EVERY page, not only pages that have zones. PDF/UA-1 7.1
        # test 3 requires *all* content on *every* page to be marked —
        # a cover image on a zoneless page still has to be artifacted, so
        # iterating sorted(by_page) (zone-bearing pages only) under-tags
        # the document.
        for page_idx in range(len(pdf.pages)):
            page_num = page_idx + 1
            page_zones = by_page.get(page_num, [])

            pdf_page = pdf.pages[page_idx]
            page_obj = pdf_page.obj

            # Tab order must follow structure order (PDF/UA-1 7.18.x).
            # /Tabs /S declares structure-order tabbing on every page.
            page_obj[pikepdf.Name('/Tabs')] = pikepdf.Name('/S')

            mb = page_obj.MediaBox
            page_height = float(mb[3]) - float(mb[1])

            # 1. Build one StructElem per zone, in structure order. Each
            #    starts with an empty /K — MCIDs get appended in step 3.
            zone_elems = []      # parallel to page_zones: the dict objects
            zone_elem_refs = []  # the indirect refs (for ParentTree)
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

                attrs = {
                    'Type': pikepdf.Name('/StructElem'),
                    'S':    pikepdf.Name(tag_name),
                    'P':    doc_ref,
                    'Pg':   page_obj,
                    'K':    pikepdf.Array(),
                }
                if zone_type == 'figure' and zone.get('altText'):
                    attrs['Alt'] = pikepdf.String(zone['altText'])
                if tag_name == '/Note':
                    note_id = f'note-p{zone.get("pageNumber", 0)}-{zone_count}'
                    attrs['ID'] = pikepdf.String(note_id)

                struct_elem = pikepdf.Dictionary(**attrs)
                elem_ref = pdf.make_indirect(struct_elem)
                doc_elem.K.append(elem_ref)
                zone_elems.append(struct_elem)
                zone_elem_refs.append(elem_ref)
                zone_count += 1

            # 2. Rewrite the page content stream so every drawing op is
            #    inside a marked-content sequence; get MCID→zone mapping.
            #    processed_forms is shared across pages so each form XObject
            #    is strip+retag'd exactly once.
            new_ops, assignments = retag_page_content(
                pdf_page, page_zones, page_height, processed_forms
            )
            new_stream = pikepdf.Stream(
                pdf, pikepdf.unparse_content_stream(new_ops)
            )
            page_obj.Contents = pdf.make_indirect(new_stream)

            # 3. Wire each MCID into its zone's /K array, and build the
            #    page's ParentTree row (index = MCID, value = elem ref).
            #    A page whose content is entirely artifacts produces no
            #    assignments — it needs no /StructParents and no ParentTree
            #    row (those exist only for content the structure tree
            #    actually references).
            if not assignments:
                continue

            max_mcid = -1
            for mcid, zone_idx in assignments:
                if 0 <= zone_idx < len(zone_elems):
                    zone_elems[zone_idx].K.append(mcid)
                    max_mcid = max(max_mcid, mcid)

            mcid_to_elem = pikepdf.Array()
            for mcid in range(max_mcid + 1):
                # Default: point at the first zone elem so the array has no
                # holes; overwrite with the real owner below.
                mcid_to_elem.append(
                    zone_elem_refs[0] if zone_elem_refs else doc_ref
                )
            for mcid, zone_idx in assignments:
                if 0 <= mcid <= max_mcid and 0 <= zone_idx < len(zone_elem_refs):
                    mcid_to_elem[mcid] = zone_elem_refs[zone_idx]

            struct_parent_idx = next_struct_parent
            next_struct_parent += 1
            page_obj[pikepdf.Name('/StructParents')] = struct_parent_idx
            parent_tree_nums.append(struct_parent_idx)
            parent_tree_nums.append(pdf.make_indirect(mcid_to_elem))

        # Attach the ParentTree + structure tree to the document.
        struct_tree_root.ParentTree = pdf.make_indirect(
            pikepdf.Dictionary(Nums=parent_tree_nums)
        )
        struct_tree_root.ParentTreeNextKey = next_struct_parent
        # Reuse the single doc_ref rather than make_indirect again.
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
