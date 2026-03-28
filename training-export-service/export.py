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
}
ARTIFACT_TYPES = {'header', 'footer'}

# Minimum AI confidence to use aiLabel in training export
AI_CONFIDENCE_THRESHOLD = 0.95


def resolve_label(zone: dict, ai_threshold: float = AI_CONFIDENCE_THRESHOLD) -> str:
    """Resolve the best label for a zone using priority:
    operatorLabel > aiLabel (if high confidence) > type.
    Zones with decision=REJECTED are excluded upstream."""
    # 1. Human-verified label (highest trust)
    if zone.get('operatorLabel'):
        return zone['operatorLabel']

    # 2. AI label if confidence meets threshold
    ai_label = zone.get('aiLabel')
    ai_conf = zone.get('aiConfidence', 0) or 0
    ai_decision = zone.get('aiDecision')
    if ai_label and ai_conf >= ai_threshold and ai_decision != 'REJECTED':
        return ai_label

    # 3. Fall back to extraction type
    return zone.get('type', 'paragraph')


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


def stratified_split(
    documents: list[dict],
    ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
) -> dict[str, str]:
    """Stratified split by publisher.
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

    return splits


def export_corpus(
    documents: list[dict],
    output_dir: str,
) -> dict:
    """
    Export corpus to YOLO training format.

    documents: list of {
      documentId, pdfPath, publisher, contentType,
      zones: [{ pageNumber, bounds:{x,y,w,h},
               type, operatorLabel, decision,
               aiLabel, aiConfidence, aiDecision }]
    }

    Label priority: operatorLabel > aiLabel (conf >= 0.95) > type

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
    split_sizes = {'train': 0, 'val': 0, 'test': 0}

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
            # Filter out rejected zones and artifact-only pages
            content_zones = [
                z for z in page_zones
                if z.get('decision') != 'REJECTED'
                and z.get('aiDecision') != 'REJECTED'
                and resolve_label(z) not in ARTIFACT_TYPES
            ]
            if not content_zones:
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
            for z in content_zones:
                zone_type = resolve_label(z)
                cls_idx = CLASS_MAP.get(zone_type, 0)
                bounds  = z.get('bounds', {})
                if not bounds:
                    continue
                cx, cy, bw, bh = bbox_to_yolo(
                    bounds, pdf_w, pdf_h
                )
                lines.append(
                    f"{cls_idx} {cx:.6f} {cy:.6f}"
                    f" {bw:.6f} {bh:.6f}"
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
        'splitSizes':   split_sizes,
        'datasetYaml':  str(out / 'dataset.yaml'),
    }
