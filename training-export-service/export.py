import os, json, re, zipfile, math, tempfile
from pathlib import Path
from typing import Optional
from PIL import Image

CLASS_MAP = {
    'paragraph': 0, 'section-header': 1, 'table': 2,
    'figure': 3, 'caption': 4, 'footnote': 5,
    'header': 6, 'footer': 7, 'list-item': 8,
    'toci': 9, 'formula': 10,
    # Map heading levels → section-header for YOLO
    'h1': 1, 'h2': 1, 'h3': 1, 'h4': 1, 'h5': 1, 'h6': 1,
    # Map UI dropdown abbreviations (stored as operatorLabel)
    'p': 0, 'hdr': 6, 'ftr': 7, 'li': 8,
    'fn': 5, 'fig': 3, 'tbl': 2, 'cap': 4,
}
ARTIFACT_TYPES = {'header', 'footer'}
ARTIFACT_CLASS_INDICES = {CLASS_MAP['header'], CLASS_MAP['footer']}

# Classes that must be EVALUABLE — present in val AND test, not merely trainable.
# The publisher-stratified split sends every doc from a 1-2-doc publisher to
# train, so a class concentrated in small publishers (notably formula) can be
# absent from val/test and therefore impossible to measure. A coverage-repair
# pass in stratified_split() relocates the minimum number of carrier docs to fix
# this while keeping the largest carrier in train.
EVAL_REQUIRED_CLASSES = (CLASS_MAP['formula'], CLASS_MAP['table'])  # 10, 2


def resolve_label(zone: dict) -> str | None:
    """Return the zone label ONLY if a human operator verified it.
    Returns None for zones without human review — these are
    excluded from training export to prevent unverified labels
    from corrupting ground truth."""
    if zone.get('operatorLabel'):
        return zone['operatorLabel']
    return None


def resolve_class_index(label: Optional[str]) -> Optional[int]:
    """Map a free-text operatorLabel to a CLASS_MAP class index.

    Case-insensitive and whitespace-tolerant. Returns None when the
    label is not in CLASS_MAP so the caller can skip the zone (with
    a stat) instead of silently misclassifying it as class 0
    (paragraph) — which is what `CLASS_MAP.get(label, 0)` used to do.

    Operators in the corpus today emit at least two label conventions:
      - PDF-tag style (uppercase): LI, HDR, TOCI, FTR
      - HTML-semantic (lowercase): h1..h6, list-item, toci
    CLASS_MAP keys are lowercase, so the uppercase convention used to
    silently fall through to class 0. Lowercasing here closes that gap
    without expanding CLASS_MAP (which the test suite asserts covers
    exactly the 11 YOLO classes)."""
    if not label:
        return None
    key = label.strip().lower()
    if not key:
        return None
    return CLASS_MAP.get(key)


def render_page_to_jpg(
    pdf_path: str,
    page_num: int,
    output_path: str,
    dpi: int = 150,
) -> tuple[int, int]:
    """Render a single PDF page to JPG.
    Returns (actual_width, actual_height) in pixels."""
    from pdf2image import convert_from_path
    pages = convert_from_path(
        pdf_path,
        dpi=dpi,
        first_page=page_num,
        last_page=page_num,
    )
    if not pages:
        raise ValueError(
            f"Could not render page {page_num} of {pdf_path}"
        )
    img = pages[0]

    # Letterbox resize to max 1280px on longest edge
    max_size = 1280
    w, h = img.size
    scale = min(max_size / w, max_size / h, 1.0)
    if scale < 1.0:
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)

    img.save(output_path, 'JPEG', quality=85)
    return img.size  # (width, height)


def bbox_to_yolo(
    bbox: dict,
    page_w: float,
    page_h: float,
) -> tuple[float, float, float, float]:
    """Convert Ninja bbox {x,y,w,h} in points to YOLO
    normalised format (cx, cy, w, h) all in [0, 1].
    PDF origin is top-left."""
    if page_w <= 0 or page_h <= 0:
        raise ValueError(
            f"Invalid page dimensions: width={page_w}, height={page_h}"
        )
    cx = (bbox['x'] + bbox['w'] / 2) / page_w
    cy = (bbox['y'] + bbox['h'] / 2) / page_h
    w  = bbox['w'] / page_w
    h  = bbox['h'] / page_h
    # Clamp to valid range
    cx = max(0.0, min(1.0, cx))
    cy = max(0.0, min(1.0, cy))
    w  = max(0.001, min(1.0, w))
    h  = max(0.001, min(1.0, h))
    return (cx, cy, w, h)


def _class_doc_counts(documents: list[dict], class_idx: int) -> dict[str, int]:
    """{documentId: number of non-rejected, human-verified zones whose resolved
    class index == class_idx}. Used to find which docs 'carry' a rare class."""
    counts: dict[str, int] = {}
    for doc in documents:
        n = 0
        for z in doc.get('zones', []):
            if z.get('decision') == 'REJECTED':
                continue
            label = resolve_label(z)
            if label is None:
                continue
            if resolve_class_index(label) == class_idx:
                n += 1
        counts[doc['documentId']] = n
    return counts


def _ensure_class_in_eval_splits(
    documents: list[dict],
    splits: dict[str, str],
    class_idx: int,
    eval_min: int = 30,
) -> None:
    """Guarantee a class appears in BOTH val and test (when the data allows),
    without stripping it from train. Mutates `splits` in place.

    Relocates the minimum number of 'carrier' docs (those containing the class)
    out of train, always keeping the single largest carrier in train so the
    training signal is preserved. A no-op when the class is already present in
    val/test, or when there are too few carriers to populate all three splits."""
    counts = _class_doc_counts(documents, class_idx)
    carriers = [doc_id for doc_id, n in counts.items() if n > 0]
    if len(carriers) < 3:
        return  # too few carriers to populate train+val+test; leave as-is

    def carriers_in(split_name: str) -> list[str]:
        return [c for c in carriers if splits.get(c) == split_name]

    for target in ('val', 'test'):
        if carriers_in(target):
            continue  # class already evaluable in this split
        train_carriers = carriers_in('train')
        if len(train_carriers) <= 1:
            return  # keep >=1 carrier in train; don't strip the training signal
        largest = max(train_carriers, key=lambda c: counts[c])
        candidates = [c for c in train_carriers if c != largest]
        substantial = [c for c in candidates if counts[c] >= eval_min]
        pool = substantial if substantial else candidates
        mover = min(pool, key=lambda c: counts[c])  # smallest eligible carrier
        splits[mover] = target


def stratified_split(
    documents: list[dict],
    ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
) -> dict[str, str]:
    """Stratified split by publisher, with a rare-class coverage-repair pass.
    Returns {documentId: 'train'|'val'|'test'}"""
    by_publisher: dict[str, list] = {}
    for doc in documents:
        pub = doc.get('publisher') or 'unknown'
        by_publisher.setdefault(pub, []).append(
            doc['documentId']
        )

    splits: dict[str, str] = {}
    for pub, ids in by_publisher.items():
        n = len(ids)
        n_val  = max(1, math.floor(n * ratios[1]))
        n_test = max(1, math.floor(n * ratios[2]))
        n_train = n - n_val - n_test
        if n_train < 1:
            # Not enough docs — put all in train
            for doc_id in ids:
                splits[doc_id] = 'train'
            continue
        for i, doc_id in enumerate(ids):
            if i < n_train:
                splits[doc_id] = 'train'
            elif i < n_train + n_val:
                splits[doc_id] = 'val'
            else:
                splits[doc_id] = 'test'

    # Repair pass: ensure rare-but-required classes (formula, table) are present
    # in val AND test, not just train. Without this, formula — concentrated in
    # 1-2-doc publishers — stays train-only and cannot be measured.
    for class_idx in EVAL_REQUIRED_CLASSES:
        _ensure_class_in_eval_splits(documents, splits, class_idx)

    return splits


def _bounds_xywh(zone: dict) -> tuple[float, float, float, float]:
    b = zone.get('bounds') or {}
    x = float(b.get('x', 0) or 0)
    y = float(b.get('y', 0) or 0)
    w = float(b.get('w', b.get('width', 0)) or 0)
    h = float(b.get('h', b.get('height', 0)) or 0)
    return x, y, w, h


def merge_table_cells_into_tables(
    table_zones: list[dict],
    gap: float = 20.0,
) -> list[dict]:
    """Cluster the 'table' boxes on a page by spatial proximity and return ONE
    synthesised whole-table box (the union) per cluster.

    Operators annotated tables inconsistently: in several documents the whole
    table is boxed AND every cell/row is ALSO boxed as 'table'; in others the
    table is boxed ONLY as cells (no enclosing box). Both produce dozens of tiny
    fragments that look identical to paragraph text, so the detector misses 89%
    of test tables. Merging fixes both cases without any manual drawing:

    - whole-table-box + cells → the cells overlap the whole box → one cluster →
      union = the whole-table box.
    - cells only (e.g. Nikitopoulos, Patton) → the cells of a table are adjacent
      → one cluster per table → union = a synthesised whole-table box.

    Two boxes join the same cluster when their rectangles, expanded by `gap`
    points on every side, overlap (connected components). Each returned dict has
    only `bounds` — that's all the export's bbox writer needs.
    """
    boxes = [_bounds_xywh(z) for z in table_zones]
    n = len(boxes)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def near(a, b) -> bool:
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        # NOT separated on either axis once each box is grown by `gap`.
        return not (
            ax - gap > bx + bw or bx - gap > ax + aw
            or ay - gap > by + bh or by - gap > ay + ah
        )

    for i in range(n):
        for j in range(i + 1, n):
            if near(boxes[i], boxes[j]):
                parent[find(i)] = find(j)

    clusters: dict[int, list[tuple[float, float, float, float]]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(boxes[i])

    merged: list[dict] = []
    for group in clusters.values():
        x0 = min(b[0] for b in group)
        y0 = min(b[1] for b in group)
        x1 = max(b[0] + b[2] for b in group)
        y1 = max(b[1] + b[3] for b in group)
        merged.append({'bounds': {'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0}})
    return merged


def export_corpus(
    documents: list[dict],
    output_dir: str,
    collapse_table_cells: bool = False,
) -> dict:
    """
    Export corpus to YOLO training format.

    documents: list of {
      documentId, pdfPath, publisher, contentType,
      zones: [{ pageNumber, bounds:{x,y,w,h},
               type, operatorLabel, decision,
               aiLabel, aiConfidence, aiDecision }]
    }

    Label source: operatorLabel only (human-verified ground truth)

    Returns stats dict.
    """
    out = Path(output_dir)
    for split in ('train', 'val', 'test'):
        (out / 'images' / split).mkdir(parents=True, exist_ok=True)
        (out / 'labels' / split).mkdir(parents=True, exist_ok=True)

    splits = stratified_split(documents)
    total_images = 0
    total_labels = 0
    skipped_pages = 0
    skipped_no_human_review = 0
    # Per-label counts for operatorLabel values that aren't in CLASS_MAP.
    # Previously these were silently coerced to class 0 (paragraph) — surfacing
    # them lets the ML team spot annotation-vocabulary drift before retraining.
    unknown_labels: dict[str, int] = {}
    split_sizes = {'train': 0, 'val': 0, 'test': 0}
    # Per-split per-class instance counts — proves rare classes (formula, table)
    # actually reach val/test, the whole point of the corpus expansion.
    split_class_counts: dict[str, dict[int, int]] = {'train': {}, 'val': {}, 'test': {}}
    collapsed_table_cells = 0  # nested per-cell 'table' boxes dropped (when enabled)

    for doc in documents:
        raw_id   = doc['documentId']
        doc_id   = re.sub(r'[^a-zA-Z0-9_\-]', '_', raw_id)
        pdf_path = doc['pdfPath']
        split    = splits.get(raw_id, 'train')
        zones    = doc.get('zones', [])

        # Group zones by page
        by_page: dict[int, list] = {}
        for z in zones:
            pn = z['pageNumber']
            by_page.setdefault(pn, []).append(z)

        for page_num, page_zones in by_page.items():
            # Only include zones with human-verified labels.
            # Skip rejected, unreviewed, artefact, and unknown-label zones.
            # Each retained zone carries its resolved class index so the bbox
            # writing loop doesn't have to re-resolve.
            content_zones: list[tuple[dict, int]] = []
            for z in page_zones:
                if z.get('decision') == 'REJECTED':
                    continue
                label = resolve_label(z)
                if label is None:
                    continue  # No human review — skip
                cls_idx = resolve_class_index(label)
                if cls_idx is None:
                    unknown_labels[label] = unknown_labels.get(label, 0) + 1
                    continue
                if cls_idx in ARTIFACT_CLASS_INDICES:
                    continue  # Headers/footers are artefacts, not training content
                content_zones.append((z, cls_idx))

            # Optional table normalisation: merge per-cell 'table' fragments into
            # one synthesised whole-table box per table (annotation-quality fix).
            if collapse_table_cells:
                table_idx = CLASS_MAP['table']
                tbls = [z for z, c in content_zones if c == table_idx]
                if len(tbls) > 1:
                    merged = merge_table_cells_into_tables(tbls)
                    non_table = [(z, c) for z, c in content_zones if c != table_idx]
                    content_zones = non_table + [(mz, table_idx) for mz in merged]
                    collapsed_table_cells += len(tbls) - len(merged)

            if not content_zones:
                # Check if skip is because no zones had human review
                has_any_human = any(z.get('operatorLabel') for z in page_zones)
                if not has_any_human:
                    skipped_no_human_review += 1
                skipped_pages += 1
                continue

            page_id = f"{doc_id}_p{page_num}"
            img_path = str(
                out / 'images' / split / f"{page_id}.jpg"
            )
            lbl_path = str(
                out / 'labels' / split / f"{page_id}.txt"
            )

            try:
                _img_w, _img_h = render_page_to_jpg(
                    pdf_path, page_num, img_path
                )
            except Exception as e:
                print(f"  Render error page {page_num}: {e}")
                continue

            # Get PDF page dimensions for normalisation
            try:
                import pikepdf
                with pikepdf.open(pdf_path) as pdf:
                    page = pdf.pages[page_num - 1]
                    mb = page.MediaBox
                    pdf_w = float(mb[2]) - float(mb[0])
                    pdf_h = float(mb[3]) - float(mb[1])
            except Exception as e:
                print(f"  Cannot read page dims for page {page_num}: {e}, skipping")
                skipped_pages += 1
                continue

            lines = []
            for z, cls_idx in content_zones:
                bounds = z.get('bounds', {})
                if not bounds:
                    continue
                cx, cy, bw, bh = bbox_to_yolo(
                    bounds, pdf_w, pdf_h
                )
                lines.append(
                    f"{cls_idx} {cx:.6f} {cy:.6f}"
                    f" {bw:.6f} {bh:.6f}"
                )
                split_class_counts[split][cls_idx] = (
                    split_class_counts[split].get(cls_idx, 0) + 1
                )

            if lines:
                with open(lbl_path, 'w') as f:
                    f.write('\n'.join(lines))
                total_labels += 1

            total_images += 1
            split_sizes[split] += 1

    # Write dataset.yaml
    names = [
        'paragraph', 'section-header', 'table', 'figure',
        'caption', 'footnote', 'header', 'footer',
        'list-item', 'toci', 'formula',
    ]
    yaml_content = (
        f"path: {out.absolute()}\n"
        f"train: images/train\n"
        f"val:   images/val\n"
        f"test:  images/test\n"
        f"nc: {len(names)}\n"
        f"names: {names}\n"
    )
    with open(out / 'dataset.yaml', 'w') as f:
        f.write(yaml_content)

    return {
        'totalImages':  total_images,
        'totalLabels':  total_labels,
        'skippedPages': skipped_pages,
        'skippedNoHumanReview': skipped_no_human_review,
        'unknownLabels': unknown_labels,
        'splitSizes':   split_sizes,
        'splitClassCounts': split_class_counts,
        'collapsedTableCells': collapsed_table_cells,
        'datasetYaml':  str(out / 'dataset.yaml'),
    }
