#!/usr/bin/env python3
"""
Ninja QC measurer: independent structural metrics for a remediated PDF.

Reads only the PDF files (no Ninja code, no database, no network) and reports
counts that track the QC findings: alt text coverage and quality signals,
figure content, tables, lists, headings, running heads, reading order and
document-level settings.

Usage:
  python measure.py --output remediated.pdf [--source source.pdf] --json out.json
                    [--metrics-only]

JSON layout:
  "metrics"         flat numeric counts for the output PDF (safe to commit:
                    no extracted text)
  "source_metrics"  the same counts for the source PDF, when --source is given
  "delta"           output minus source for selected metrics
  "details"         page numbers and alt-text samples (contains document
                    content: keep outside git; omitted with --metrics-only)

Exit code 0 on success, 2 on bad arguments, 1 on a file that cannot be read.
"""
import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict

import pikepdf

VERSION = "0.3.0"

STANDARD_TYPES = {
    "Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI",
    "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6",
    "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot",
    "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link", "Annot",
    "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure", "Formula", "Form",
    "Artifact",
}

# Words that describe image damage or decoding noise rather than content.
NOISE_PATTERNS = [
    r"scan ?lines?", r"\bnoise\b", r"\bnoisy\b", r"\bstatic\b", r"pixelat", r"glitch",
    r"corrupt", r"distorted", r"\bstripe[sd]?\b", r"\bstriped\b",
    r"horizontal (?:lines|bands|stripes)", r"vertical (?:lines|bands|stripes)",
    r"random (?:pattern|lines|dots)", r"abstract pattern", r"blank image",
    r"\bblurry\b", r"\bgarbled\b",
]
NOISE_RE = re.compile("|".join(NOISE_PATTERNS), re.I)
GENERIC_RE = re.compile(
    r"^\s*(?:an?\s+)?(?:image|figure|picture|graphic|photo|photograph|diagram|chart|"
    r"illustration|icon|logo|img)(?:\s*[\d.]+)?\s*\.?\s*$", re.I)
FILENAME_RE = re.compile(r"\.(?:png|jpe?g|gif|tiff?|bmp|eps|ai|psd)\b", re.I)

MARGIN_BAND = 0.10          # top/bottom fraction of the page treated as header/footer
RUNNING_HEAD_MIN_PAGES = 4  # a margin string repeated on this many pages is a running head
FLOAT_SHARE = 0.05          # top-level block smaller than this share of the tree is a float
PAGE_NUM_RE = re.compile(rb"^\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*$", re.I)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mat_mul(a, b):
    return [
        a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
    ]


def nums(ops):
    return [float(x) for x in ops]


def norm_margin(b):
    """Normalise header/footer text for repetition matching: drop digits and spaces."""
    return re.sub(rb"[\d\s]+", b"", b.lower())


def string_bytes(operands):
    out = b""
    for a in operands:
        if isinstance(a, pikepdf.String):
            out += bytes(a)
        elif isinstance(a, pikepdf.Array):
            for x in a:
                if isinstance(x, pikepdf.String):
                    out += bytes(x)
                else:
                    try:
                        if float(x) < -200:
                            out += b" "
                    except (TypeError, ValueError):
                        pass
    return out


class PageScan:
    """One pass over a page content stream: marked content, text, images, paths."""

    def __init__(self, page, pageno):
        self.pageno = pageno
        self.mcid = defaultdict(lambda: {"text": b"", "image": 0, "vector": 0, "form": 0})
        self.text_ops = Counter()        # tagged / artifact / untagged
        self.image_draws = 0
        self._margin_raw = []            # (y, state, bytes) per text show in the margin bands
        self.margin = []                 # (state, line bytes) per header/footer line
        box = page.obj.get("/CropBox", page.obj.get("/MediaBox", [0, 0, 612, 792]))
        try:
            x0, y0, x1, y1 = [float(v) for v in box]
        except Exception:
            x0, y0, x1, y1 = 0, 0, 612, 792
        self.y0, self.h = min(y0, y1), abs(y1 - y0) or 792
        self._scan(page)
        lines = {}
        for y, state, b in self._margin_raw:
            key = next((k for k in lines if abs(k - y) <= 2), y)
            st, txt = lines.get(key, (None, b""))
            # a line counts as tagged if any of its pieces is tagged content
            if st != "tagged":
                st = state if st in (None, "artifact") or state == "tagged" else st
            lines[key] = (st, txt + b)
        self.margin = [lines[k] for k in sorted(lines)]

    def _state(self, stack):
        if any(s == "artifact" for s in stack):
            return "artifact", None
        for s in reversed(stack):
            if isinstance(s, int):
                return "tagged", s
        return "untagged", None

    def _scan(self, page):
        try:
            ops = pikepdf.parse_content_stream(page)
        except Exception:
            return
        resources = page.obj.get("/Resources", pikepdf.Dictionary())
        xobjs = resources.get("/XObject", pikepdf.Dictionary())
        props = resources.get("/Properties", pikepdf.Dictionary())
        stack = []
        ctm = [1, 0, 0, 1, 0, 0]
        gs = []
        tm = tlm = [1, 0, 0, 1, 0, 0]
        leading = 0.0
        for operands, op in ops:
            o = str(op)
            if o == "BDC":
                tag = str(operands[0]) if operands else ""
                p = operands[1] if len(operands) > 1 else None
                if isinstance(p, pikepdf.Name):
                    p = props.get(p)
                m = None
                if isinstance(p, pikepdf.Dictionary) and "/MCID" in p:
                    try:
                        m = int(p.MCID)
                    except Exception:
                        m = None
                if tag == "/Artifact":
                    stack.append("artifact")
                else:
                    stack.append(m if m is not None else "other")
            elif o == "BMC":
                stack.append("artifact" if operands and str(operands[0]) == "/Artifact" else "other")
            elif o == "EMC":
                if stack:
                    stack.pop()
            elif o == "q":
                gs.append(list(ctm))
            elif o == "Q":
                if gs:
                    ctm = gs.pop()
            elif o == "cm":
                try:
                    ctm = mat_mul(nums(operands), ctm)
                except Exception:
                    pass
            elif o == "BT":
                tm = tlm = [1, 0, 0, 1, 0, 0]
            elif o == "Tm":
                try:
                    tm = tlm = nums(operands)
                except Exception:
                    pass
            elif o in ("Td", "TD"):
                try:
                    tx, ty = nums(operands)
                    if o == "TD":
                        leading = -ty
                    tm = tlm = mat_mul([1, 0, 0, 1, tx, ty], tlm)
                except Exception:
                    pass
            elif o == "TL":
                try:
                    leading = float(operands[0])
                except Exception:
                    pass
            elif o in ("T*", "'", '"'):
                tm = tlm = mat_mul([1, 0, 0, 1, 0, -leading], tlm)
            if o in ("Tj", "TJ", "'", '"'):
                state, m = self._state(stack)
                self.text_ops[state] += 1
                s = string_bytes(operands)
                if m is not None:
                    self.mcid[m]["text"] += s
                y = mat_mul(tm, ctm)[5]
                rel = (y - self.y0) / self.h
                if (rel < MARGIN_BAND or rel > 1 - MARGIN_BAND) and s.strip():
                    self._margin_raw.append((round(y), state, s))
            elif o == "Do":
                state, m = self._state(stack)
                xo = xobjs.get(operands[0]) if operands else None
                sub = str(xo.get("/Subtype")) if xo is not None else ""
                if sub == "/Image":
                    self.image_draws += 1
                    if m is not None:
                        self.mcid[m]["image"] += 1
                elif sub == "/Form" and m is not None:
                    self.mcid[m]["form"] += 1
            elif o == "INLINE IMAGE":
                self.image_draws += 1
                state, m = self._state(stack)
                if m is not None:
                    self.mcid[m]["image"] += 1
            elif o in ("f", "F", "f*", "B", "B*", "b", "b*", "S", "s"):
                state, m = self._state(stack)
                if m is not None:
                    self.mcid[m]["vector"] += 1


class Doc:
    def __init__(self, path):
        self.path = path
        self.pdf = pikepdf.open(path)
        self.pages = list(self.pdf.pages)
        self.pg = {p.obj.objgen: i + 1 for i, p in enumerate(self.pages)}
        self._scans = {}
        root = self.pdf.Root
        self.str_root = root.get("/StructTreeRoot")
        self.rolemap = {}
        if self.str_root is not None:
            rm = self.str_root.get("/RoleMap", pikepdf.Dictionary())
            self.rolemap = {str(k)[1:]: str(v)[1:] for k, v in rm.items()}
        self.mcid_page = self._parent_tree_pages()

    def _parent_tree_pages(self):
        """Map (element objgen, mcid) -> page number via the ParentTree, so content
        under elements with no /Pg anywhere in their ancestry can still be found."""
        res = {}
        if self.str_root is None or "/ParentTree" not in self.str_root:
            return res
        nums = {}

        def collect(node, depth=0):
            if depth > 30 or not isinstance(node, pikepdf.Dictionary):
                return
            if "/Nums" in node:
                arr = node.Nums
                for i in range(0, len(arr) - 1, 2):
                    try:
                        nums[int(arr[i])] = arr[i + 1]
                    except Exception:
                        pass
            for k in node.get("/Kids", []) or []:
                collect(k, depth + 1)

        collect(self.str_root.ParentTree)
        for i, p in enumerate(self.pages):
            sp = p.obj.get("/StructParents")
            if sp is None:
                continue
            arr = nums.get(int(sp))
            if not isinstance(arr, pikepdf.Array):
                continue
            for mcid, el in enumerate(arr):
                if isinstance(el, pikepdf.Dictionary) and el.objgen != (0, 0):
                    res[(el.objgen, mcid)] = i + 1
        return res

    def scan(self, pageno):
        if pageno not in self._scans:
            self._scans[pageno] = PageScan(self.pages[pageno - 1], pageno)
        return self._scans[pageno]

    def role(self, s):
        seen = set()
        while s in self.rolemap and s not in seen and s not in STANDARD_TYPES:
            seen.add(s)
            s = self.rolemap[s]
        return s

    # ---- structure tree walk -------------------------------------------------
    def walk(self):
        """Yield element records in document (tree) order."""
        out = []
        self.unresolved_pg = 0
        self.pg_from_parent_tree = 0
        if self.str_root is None:
            self.elements = out
            return out
        visited = set()

        def kids_of(n):
            k = n.get("/K")
            if k is None:
                return []
            return list(k) if isinstance(k, pikepdf.Array) else [k]

        def rec(n, parent_role, inherited_pg, depth):
            if not isinstance(n, pikepdf.Dictionary) or "/S" not in n:
                return None
            og = n.objgen
            if og != (0, 0):
                if og in visited:
                    return None
                visited.add(og)
            raw = str(n.S)[1:]
            r = self.role(raw)
            pgref = n.get("/Pg")
            pg = self.pg.get(pgref.objgen) if pgref is not None else inherited_pg
            e = {"raw": raw, "role": r, "parent": parent_role, "page": pg, "depth": depth,
                 "alt": str(n.Alt) if "/Alt" in n else None,
                 "actual": str(n.ActualText) if "/ActualText" in n else None,
                 "scope": str(n.A.get("/Scope")) if isinstance(n.get("/A"), pikepdf.Dictionary) and "/Scope" in n.A else None,
                 "mcrs": [], "objr": 0, "children": [], "size": 1, "index": len(out)}
            out.append(e)
            for k in kids_of(n):
                if isinstance(k, pikepdf.Dictionary):
                    if "/S" in k:
                        c = rec(k, r, pg, depth + 1)
                        if c is not None:
                            e["children"].append(c)
                            e["size"] += c["size"]
                    elif "/MCID" in k:
                        kp = k.get("/Pg")
                        kpg = self.pg.get(kp.objgen) if kp is not None else pg
                        mc = int(k.MCID)
                        if kpg is None:
                            kpg = self.mcid_page.get((og, mc))
                            self.unresolved_pg += kpg is None
                            self.pg_from_parent_tree += kpg is not None
                        e["mcrs"].append((kpg, mc))
                    elif str(k.get("/Type", "")) == "/OBJR":
                        e["objr"] += 1
                else:
                    try:
                        mc = int(k)
                    except Exception:
                        continue
                    kpg = pg
                    if kpg is None:
                        kpg = self.mcid_page.get((og, mc))
                        self.unresolved_pg += kpg is None
                        self.pg_from_parent_tree += kpg is not None
                    e["mcrs"].append((kpg, mc))
            return e

        for k in kids_of(self.str_root):
            rec(k, None, None, 0)
        self.elements = out
        return out

    def mcids_under(self, e):
        res = list(e["mcrs"])
        for c in e["children"]:
            res += self.mcids_under(c)
        return res

    def first_page(self, e):
        for p, _ in self.mcids_under(e):
            if p:
                return p
        return e["page"]


def measure(path, source_doc=None):
    d = Doc(path)
    els = d.walk()
    m = {}
    det = {}
    root = d.pdf.Root

    # ---- document level ------------------------------------------------------
    m["pages"] = len(d.pages)
    m["has_struct_tree"] = int(d.str_root is not None)
    m["struct_elements"] = len(els)
    m["mcrs_page_from_parent_tree_only"] = d.pg_from_parent_tree
    m["mcrs_page_unresolved"] = d.unresolved_pg
    m["nonstandard_roles_unmapped"] = sum(1 for e in els if e["role"] not in STANDARD_TYPES)
    info_title = ""
    try:
        meta = d.pdf.open_metadata()
        info_title = str(meta.get("dc:title", "") or "")
        xmp = str(meta)
    except Exception:
        xmp = ""
    if not info_title and "/Info" in d.pdf.trailer and "/Title" in d.pdf.trailer.Info:
        info_title = str(d.pdf.trailer.Info.Title)
    m["has_title"] = int(bool(info_title.strip()))
    m["title_looks_like_filename"] = int(bool(re.search(r"\.(?:pdf|indd|docx?)\b|_\d{5,}", info_title, re.I)))
    vp = root.get("/ViewerPreferences", pikepdf.Dictionary())
    m["display_doc_title"] = int(bool(vp.get("/DisplayDocTitle", False)))
    m["has_lang"] = int(bool(str(root.get("/Lang", "")).strip()))
    mi = root.get("/MarkInfo", pikepdf.Dictionary())
    m["marked"] = int(bool(mi.get("/Marked", False)))
    m["pdfua_identifier"] = int("pdfuaid" in xmp)
    m["pages_without_tabs_s"] = sum(1 for p in d.pages if str(p.obj.get("/Tabs", "")) != "/S")
    m["has_page_labels"] = int("/PageLabels" in root)
    outline_count = 0
    try:
        with d.pdf.open_outline() as ol:
            stack = list(ol.root)
            while stack:
                it = stack.pop()
                outline_count += 1
                stack.extend(it.children)
    except Exception:
        pass
    m["bookmarks"] = outline_count

    # ---- content tagging (page scans) ----------------------------------------
    text_ops = Counter()
    image_draws = 0
    margin_by_page = {}
    for i in range(1, len(d.pages) + 1):
        sc = d.scan(i)
        text_ops.update(sc.text_ops)
        image_draws += sc.image_draws
        margin_by_page[i] = sc.margin
    m["text_ops_tagged"] = text_ops["tagged"]
    m["text_ops_artifact"] = text_ops["artifact"]
    m["text_ops_untagged"] = text_ops["untagged"]
    m["image_draws"] = image_draws
    annots = 0
    annots_untagged = 0
    for p in d.pages:
        for a in p.obj.get("/Annots", []) or []:
            try:
                if str(a.get("/Subtype")) in ("/Popup",):
                    continue
                annots += 1
                if "/StructParent" not in a:
                    annots_untagged += 1
            except Exception:
                pass
    m["annotations"] = annots
    m["annotations_without_struct_parent"] = annots_untagged

    # ---- running heads and page numbers --------------------------------------
    pages_for = defaultdict(set)
    for pno, items in margin_by_page.items():
        for state, s in items:
            key = norm_margin(s)
            if len(key) >= 3:
                pages_for[key].add(pno)
    heads = {k for k, v in pages_for.items() if len(v) >= RUNNING_HEAD_MIN_PAGES}
    rh_tagged_pages, pn_tagged_pages, rh_untagged_pages = set(), set(), set()
    for pno, items in margin_by_page.items():
        for state, s in items:
            if state == "artifact":
                continue
            if norm_margin(s) in heads:
                (rh_tagged_pages if state == "tagged" else rh_untagged_pages).add(pno)
            elif PAGE_NUM_RE.match(s):
                if state == "tagged":
                    pn_tagged_pages.add(pno)
    m["running_head_strings"] = len(heads)
    m["pages_running_head_tagged_as_content"] = len(rh_tagged_pages)
    m["pages_running_head_untagged"] = len(rh_untagged_pages)
    m["pages_page_number_tagged_as_content"] = len(pn_tagged_pages)
    det["pages_running_head_tagged_as_content"] = sorted(rh_tagged_pages)
    det["pages_page_number_tagged_as_content"] = sorted(pn_tagged_pages)

    # ---- figures -------------------------------------------------------------
    figs = [e for e in els if e["role"] == "Figure"]
    m["figures"] = len(figs)
    fig_rows = []
    content_kinds = Counter()
    alt_norm = Counter()
    for e in figs:
        mc = d.mcids_under(e)
        img = vec = frm = 0
        txt = b""
        for p, mcid in mc:
            if not p:
                continue
            r = d.scan(p).mcid.get(mcid)
            if r:
                img += r["image"]
                vec += r["vector"]
                frm += r["form"]
                txt += r["text"]
        if img:
            kind = "image"
        elif frm:
            kind = "form"
        elif vec:
            kind = "vector"
        elif txt.strip():
            kind = "text_only"
        elif e["objr"]:
            kind = "annotation"
        else:
            kind = "empty"
        content_kinds[kind] += 1
        alt = (e["alt"] or "").strip()
        if alt:
            alt_norm[re.sub(r"\W+", " ", alt.lower()).strip()] += 1
        fig_rows.append({"page": d.first_page(e), "kind": kind, "alt": alt,
                         "alt_len": len(alt), "has_actual_text": e["actual"] is not None})
    with_alt = [r for r in fig_rows if r["alt"]]
    m["figures_with_alt"] = len(with_alt)
    m["figures_without_alt"] = len(fig_rows) - len(with_alt)
    for k in ("image", "form", "vector", "text_only", "annotation", "empty"):
        m[f"figures_content_{k}"] = content_kinds[k]
    noise = [r for r in with_alt if NOISE_RE.search(r["alt"])]
    generic = [r for r in with_alt if GENERIC_RE.match(r["alt"]) or FILENAME_RE.search(r["alt"]) or len(r["alt"]) < 5]
    dups = [r for r in with_alt if alt_norm[re.sub(r"\W+", " ", r["alt"].lower()).strip()] > 1]
    m["alt_noise_words"] = len(noise)
    m["alt_generic"] = len(generic)
    m["alt_duplicate"] = len(dups)
    m["alt_over_250_chars"] = sum(1 for r in with_alt if r["alt_len"] > 250)
    lens = sorted(r["alt_len"] for r in with_alt)
    m["alt_median_chars"] = lens[len(lens) // 2] if lens else 0
    det["figures"] = fig_rows
    det["alt_noise_words"] = [{"page": r["page"], "alt": r["alt"][:200]} for r in noise]
    det["alt_generic"] = [{"page": r["page"], "alt": r["alt"][:200]} for r in generic]
    det["alt_duplicate"] = [{"page": r["page"], "alt": r["alt"][:200]} for r in dups]
    det["figures_without_alt"] = [{"page": r["page"], "kind": r["kind"]} for r in fig_rows if not r["alt"]]
    det["figures_empty_or_text_only"] = [{"page": r["page"], "kind": r["kind"], "alt": r["alt"][:120]}
                                         for r in fig_rows if r["kind"] in ("empty", "text_only")]
    figs_per_page = Counter(r["page"] for r in fig_rows)
    imgs_per_page = {i: d.scan(i).image_draws for i in range(1, len(d.pages) + 1)}

    # ---- formulas ------------------------------------------------------------
    forms = [e for e in els if e["role"] == "Formula"]
    m["formulas"] = len(forms)
    m["formulas_without_alt"] = sum(1 for e in forms if not (e["alt"] or "").strip() and not e["actual"])

    # ---- tables --------------------------------------------------------------
    def has_desc(e, role):
        return any(c["role"] == role or has_desc(c, role) for c in e["children"])

    tables = [e for e in els if e["role"] == "Table"]
    m["tables"] = len(tables)
    m["tables_without_th"] = sum(1 for t in tables if not has_desc(t, "TH"))
    m["tables_without_tr"] = sum(1 for t in tables if not has_desc(t, "TR"))
    ths = [e for e in els if e["role"] == "TH"]
    m["th_without_scope"] = sum(1 for e in ths if not e["scope"])
    det["tables_without_th"] = [d.first_page(t) for t in tables if not has_desc(t, "TH")]

    # ---- lists ---------------------------------------------------------------
    lis = [e for e in els if e["role"] == "LI"]
    m["lists"] = sum(1 for e in els if e["role"] == "L")
    m["list_items"] = len(lis)
    m["li_not_in_l"] = sum(1 for e in lis if e["parent"] != "L")
    m["lists_without_li"] = sum(1 for e in els if e["role"] == "L" and not any(c["role"] in ("LI", "L") for c in e["children"]))
    det["li_not_in_l_pages"] = sorted({e["page"] or d.first_page(e) or 0 for e in lis if e["parent"] != "L"})

    # ---- headings ------------------------------------------------------------
    levels = []
    for e in els:
        r = e["role"]
        if re.fullmatch(r"H[1-6]", r):
            levels.append((int(r[1]), d.first_page(e)))
    for i in range(1, 7):
        m[f"h{i}"] = sum(1 for lv, _ in levels if lv == i)
    m["h_generic"] = sum(1 for e in els if e["role"] == "H")
    skips = []
    prev = 0
    for lv, p in levels:
        if lv > prev + 1:
            skips.append({"page": p, "from": prev, "to": lv})
        prev = lv
    m["heading_level_skips"] = len(skips)
    det["heading_level_skips"] = skips[:50]

    # ---- reading order -------------------------------------------------------
    # Main-flow level: descend from the root while there is a single wrapper element.
    tops = [e for e in els if e["depth"] == 0]
    while len(tops) == 1 and tops[0]["children"]:
        tops = tops[0]["children"]
    total = sum(t["size"] for t in tops) or 1
    floats = [t for t in tops if t["size"] < FLOAT_SHARE * total]
    m["top_level_blocks"] = len(tops)
    m["top_level_floats"] = len(floats)
    det["top_level_floats"] = [{"role": t["raw"], "page": d.first_page(t), "elements": t["size"]} for t in floats]
    seq = []
    for e in els:
        for p, _ in e["mcrs"]:
            if p:
                seq.append(p)
                break
    back = 0
    back_pages = []
    hi = 0
    for p in seq:
        if p < hi - 1:          # allow page-boundary spill of one page
            back += 1
            if len(back_pages) < 50:
                back_pages.append({"page": p, "after_page": hi})
        hi = max(hi, p)
    m["reading_order_backward_jumps"] = back
    det["reading_order_backward_jumps"] = back_pages

    # ---- comparison with source ----------------------------------------------
    if source_doc is not None:
        src_figs = source_doc["_figs_per_page"]
        src_imgs = source_doc["_imgs_per_page"]
        src_tagged = source_doc["_has_tree"]
        extra = []
        for p, n in figs_per_page.items():
            ref = src_figs.get(p, 0) if src_tagged else src_imgs.get(p, 0)
            if p and n > max(ref, 1 if not src_tagged and src_imgs.get(p, 0) else ref):
                extra.append({"page": p, "output_figures": n, "source_reference": ref})
        m["pages_more_figures_than_source"] = len(extra)
        # Existing (e.g. publisher-written) alt text: did the output keep it?
        def nz(t):
            return re.sub(r"\W+", " ", t.lower()).strip()
        src_alts = source_doc["_alts"]
        out_alts = {nz(r["alt"]) for r in with_alt}
        lost = [a for a in src_alts if a not in out_alts]
        m["source_alt_texts"] = len(src_alts)
        m["source_alt_lost"] = len(lost)
        det["source_alt_lost"] = [a[:200] for a in lost[:100]]
        # Noise words only in alt text the source did not already have
        new_noise = [r for r in noise if nz(r["alt"]) not in src_alts]
        m["alt_noise_words_new"] = len(new_noise)
        det["alt_noise_words_new"] = [{"page": r["page"], "alt": r["alt"][:200]} for r in new_noise]
        det["pages_more_figures_than_source"] = sorted(extra, key=lambda x: x["page"])

    internal = {"_figs_per_page": dict(figs_per_page), "_imgs_per_page": imgs_per_page,
                "_has_tree": d.str_root is not None,
                "_alts": {re.sub(r"\W+", " ", r["alt"].lower()).strip() for r in with_alt}}
    return m, det, internal


DELTA_KEYS = ["figures", "figures_with_alt", "figures_without_alt", "tables_without_th", "li_not_in_l",
              "top_level_floats", "reading_order_backward_jumps", "pages_running_head_tagged_as_content",
              "text_ops_untagged", "bookmarks", "heading_level_skips", "alt_noise_words"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--output", required=True, help="remediated PDF to measure")
    ap.add_argument("--source", help="source PDF (optional, enables comparisons)")
    ap.add_argument("--json", required=True, help="where to write the JSON result")
    ap.add_argument("--metrics-only", action="store_true", help="omit the details object")
    a = ap.parse_args()
    try:
        result = {"tool": "ninja-qc-measure", "version": VERSION}
        src_internal = None
        if a.source:
            sm, sdet, src_internal = measure(a.source)
            result["source"] = {"sha256": sha256(a.source), "pages": sm["pages"]}
            result["source_metrics"] = sm
        om, odet, _ = measure(a.output, src_internal)
        result["output"] = {"sha256": sha256(a.output), "pages": om["pages"]}
        result["metrics"] = om
        if a.source:
            result["delta"] = {k: om[k] - sm[k] for k in DELTA_KEYS if k in om and k in sm}
        if not a.metrics_only:
            result["details"] = odet
    except (pikepdf.PdfError, OSError) as ex:
        print(f"cannot read PDF: {ex}", file=sys.stderr)
        return 1
    with open(a.json, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
