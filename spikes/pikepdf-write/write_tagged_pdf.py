"""Core spike implementation: takes a PDF + zone ground truth,
writes a Tagged PDF structure tree using pikepdf."""

import pikepdf
from collections import defaultdict
from zone_to_tags import get_pdf_role, is_artifact, get_heading_level
from content_tagger import retag_page_content
from font_repair import repair_pdf


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

        # Font repair pass: add missing /ToUnicode CMaps (PDF/UA-1 7.21.7),
        # delete incorrect /CIDSet entries (7.21.4.2 t2), and fix missing
        # /OCProperties /D /Name (7.10 t1). These are metadata defects in
        # the source PDFs that the write step can repair without touching
        # the font programs themselves.
        repair_pdf(pdf)

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
            # Process annotations on this page.
            # Guard against null/deleted annotation entries — some PDFs store
            # null indirect references in the /Annots array which pikepdf
            # yields as None.  Without the `if ann is not None` check the `in`
            # operator raises "argument of type 'NoneType' is not iterable".
            annots = _po.get('/Annots')
            if annots:
                for ann in annots:
                    if ann is None:
                        continue
                    if '/StructParent' in ann:
                        del ann['/StructParent']
                    # PDF/UA-1 7.18.1 t2: every visible Link annotation must
                    # have either a /Contents key (preferred — on the annotation
                    # itself) or an /Alt on its enclosing structure element.
                    # /Contents is simpler: extract the URI/destination from
                    # the annotation's /A action; fall back to "Link".
                    if ann.get('/Subtype') == pikepdf.Name('/Link') \
                            and '/Contents' not in ann:
                        contents = 'Link'
                        _a = ann.get('/A')
                        if _a is not None:
                            if _a.get('/S') == pikepdf.Name('/URI'):
                                _uri = _a.get('/URI')
                                if _uri is not None:
                                    contents = str(_uri)
                            elif _a.get('/S') == pikepdf.Name('/GoTo'):
                                _dest = _a.get('/D')
                                if _dest is not None:
                                    contents = f'Link to {_dest}'
                        ann['/Contents'] = pikepdf.String(contents)

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

        # PDF/UA-1 7.4.2: heading levels must not skip when going deeper.
        # Track the last heading level emitted (0 = no heading yet) so we
        # can clamp each new heading to at most last_heading_level + 1.
        # Ascending (H3 → H1) is always allowed; only descending skips fail.
        last_heading_level = [0]   # list to allow mutation inside inner scope
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

                # Build the tag role - headings use H1-H6.
                # Clamp skipped levels (PDF/UA-1 7.4.2): no jump of >1 in
                # the "descending" direction (increasing level number). The
                # first heading in a document is also constrained — starting
                # at H3 means H1 and H2 were "skipped" per veraPDF, so the
                # `prev > 0` guard from the previous increment is removed.
                # With prev=0, the first heading is clamped to H1.
                # Ascending (H3 → H1) always allowed — `level <= prev` path.
                if zone_type == 'section-header':
                    level = get_heading_level(zone)
                    prev = last_heading_level[0]
                    if level > prev + 1:
                        level = prev + 1      # close the gap (also first heading)
                    last_heading_level[0] = level
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
                # PDF/UA-1 7.3 t1: every Figure element must have a non-empty
                # /Alt (alternative description) or /ActualText. Use the
                # zone's altText when available; fall back to "Figure" as a
                # generic placeholder. veraPDF rejects an empty string ("").
                # In production the AI alt-text generator provides real text.
                if zone_type == 'figure':
                    attrs['Alt'] = pikepdf.String(
                        zone.get('altText') or 'Figure'
                    )
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
            #    Only pages that produce MCID assignments need /StructParents.
            if assignments:
                max_mcid = -1
                for mcid, zone_idx in assignments:
                    if 0 <= zone_idx < len(zone_elems):
                        zone_elems[zone_idx].K.append(mcid)
                        max_mcid = max(max_mcid, mcid)

                mcid_to_elem = pikepdf.Array()
                for mcid in range(max_mcid + 1):
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

            # 4. Wire Link annotations into the structure tree.
            #    Processed unconditionally — a page may have Link annotations
            #    but no operator-verified content zones (e.g. a TOC page where
            #    text lives in form XObjects). Without this, 7.18.5 t1 fires on
            #    those pages even if the same page passes the MCID wiring test.
            #
            #    PDF/UA-1 7.18.5 t1 (ISO 32000-1 §14.8.4.4.2): each Link
            #    annotation must be enclosed in a /Link structure element with
            #    an /OBJR (object reference) in its /K array.  Annotations use
            #    /StructParent (singular integer) — distinct from page MCIDs
            #    which use /StructParents (plural, array).
            annots = page_obj.get('/Annots')
            if annots:
                for ann in annots:
                    if ann is None:          # null indirect reference
                        continue
                    if ann.get('/Subtype') != pikepdf.Name('/Link'):
                        continue
                    ann_ref = pdf.make_indirect(ann)
                    objr = pikepdf.Dictionary(
                        Type=pikepdf.Name('/OBJR'),
                        Obj=ann_ref,
                        Pg=page_obj,
                    )
                    link_elem = pikepdf.Dictionary(
                        Type=pikepdf.Name('/StructElem'),
                        S=pikepdf.Name('/Link'),
                        P=doc_ref,
                        Pg=page_obj,
                        K=pikepdf.Array([pdf.make_indirect(objr)]),
                    )
                    link_elem_ref = pdf.make_indirect(link_elem)
                    doc_elem.K.append(link_elem_ref)
                    ann_sp_idx = next_struct_parent
                    next_struct_parent += 1
                    ann['/StructParent'] = ann_sp_idx
                    parent_tree_nums.append(ann_sp_idx)
                    parent_tree_nums.append(link_elem_ref)

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
