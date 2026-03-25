import os
import re
import time
import tempfile
import logging
import threading
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Ensure HuggingFace cache matches the build-time pre-download location
os.environ.setdefault("HF_HOME", "/app/.cache/huggingface")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("docling-service")

app = FastAPI(title="Ninja Docling Service", version="1.0.0")

# Initialise converter once at startup — model loading is expensive
# OCR is disabled: zone detection doesn't need it, and the RapidOCR model
# download from modelscope.cn fails in ECS (network timeout)
try:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.base_models import InputFormat

    pipeline_options = PdfPipelineOptions(do_ocr=False)
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)},
    )
    logger.info("Docling DocumentConverter initialised successfully (OCR disabled)")
except Exception as e:
    logger.error(f"Failed to initialise DocumentConverter: {e}")
    converter = None

# Lazy-init S3 client (only created on first S3 request)
_s3_client = None

S3_URI_PATTERN = re.compile(r"^s3://([^/]+)/(.+)$")


def get_s3_client():
    global _s3_client
    if _s3_client is None:
        import boto3
        _s3_client = boto3.client("s3")
        logger.info("S3 client initialised")
    return _s3_client


def download_from_s3(s3_uri: str) -> str:
    """Download an S3 object to a temp file and return the local path."""
    match = S3_URI_PATTERN.match(s3_uri)
    if not match:
        raise ValueError(f"Invalid S3 URI: {s3_uri}")

    bucket, key = match.group(1), match.group(2)
    suffix = os.path.splitext(key)[1] or ".pdf"

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.close()
    try:
        get_s3_client().download_file(bucket, key, tmp.name)
        logger.info(f"Downloaded s3://{bucket}/{key} -> {tmp.name}")
        return tmp.name
    except Exception:
        os.unlink(tmp.name)
        raise


class DetectRequest(BaseModel):
    pdfPath: str
    jobId:   str

# In-flight request deduplication: prevents duplicate Docling conversions
# when BullMQ retries arrive while the first request is still processing.
# Key = pdfPath, value = threading.Event + result/error.
_inflight_lock = threading.Lock()
_inflight: dict[str, dict] = {}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": "loaded" if converter else "failed"
    }

@app.post("/detect")
def detect(req: DetectRequest):
    if converter is None:
        raise HTTPException(
            status_code=503,
            detail="Docling model not initialised"
        )

    # Dedup: if the same pdfPath is already being processed, wait for it
    with _inflight_lock:
        if req.pdfPath in _inflight:
            entry = _inflight[req.pdfPath]
            logger.info(f"Job {req.jobId}: dedup — waiting for in-flight conversion of {req.pdfPath}")

    # Check outside lock to avoid holding it during wait
    with _inflight_lock:
        existing = _inflight.get(req.pdfPath)
    if existing is not None:
        existing["event"].wait(timeout=20 * 60)  # wait up to 20 min
        if existing.get("error"):
            raise HTTPException(status_code=500, detail=existing["error"])
        if existing.get("result"):
            logger.info(f"Job {req.jobId}: returning cached result for {req.pdfPath}")
            return {**existing["result"], "jobId": req.jobId}
        raise HTTPException(status_code=500, detail="In-flight conversion timed out")

    # Register this request as in-flight
    flight_entry: dict = {"event": threading.Event(), "result": None, "error": None}
    with _inflight_lock:
        _inflight[req.pdfPath] = flight_entry

    # Resolve path: download from S3 if needed, otherwise use local path
    local_path = None
    is_temp = False

    if S3_URI_PATTERN.match(req.pdfPath):
        try:
            local_path = download_from_s3(req.pdfPath)
            is_temp = True
        except Exception as e:
            logger.error(f"S3 download failed for {req.pdfPath}: {e}")
            raise HTTPException(
                status_code=422,
                detail=f"Failed to download from S3: {e}"
            )
    else:
        local_path = req.pdfPath

    if not os.path.exists(local_path):
        raise HTTPException(
            status_code=422,
            detail=f"File not found: {req.pdfPath}"
        )

    start = time.time()

    try:
        result = converter.convert(local_path)
    except Exception as e:
        logger.error(f"Docling conversion error for {req.pdfPath}: {e}")
        # Signal waiting dedup requests about the failure
        flight_entry["error"] = str(e)
        flight_entry["event"].set()
        with _inflight_lock:
            _inflight.pop(req.pdfPath, None)
        raise HTTPException(
            status_code=500,
            detail=f"Docling processing error: {str(e)}"
        )
    finally:
        if is_temp and local_path:
            os.unlink(local_path)

    # Log the document dict keys on first call to aid debugging
    doc_dict = result.document.export_to_dict()
    logger.info(f"Docling export_to_dict keys: {list(doc_dict.keys())}")

    # Build page-number and page-height lookups from pages dict
    # (Docling v2: {hash: {size: {width, height}, page_no, ...}})
    pages_dict = doc_dict.get("pages", {})
    page_no_map = {}
    page_height_map = {}  # page_no → height (for coordinate flip)
    if isinstance(pages_dict, dict):
        for page_hash, page_info in pages_dict.items():
            if isinstance(page_info, dict):
                page_no = page_info.get("page_no", 0)
                page_no_map[page_hash] = page_no
                size = page_info.get("size", {})
                if isinstance(size, dict):
                    page_height_map[page_no] = float(size.get("height", 792))

    zones = []

    # Docling v2 stores document items in body.children (refs) AND in
    # top-level texts/pictures/tables (full data).  body.children are
    # lightweight refs that duplicate the top-level items, so we ONLY
    # use the categorised top-level lists to avoid double-counting.
    items = []
    for key in ("texts", "pictures", "tables"):
        extra = doc_dict.get(key, [])
        if isinstance(extra, list):
            items.extend(extra)

    # Fallback: if none of the top-level lists exist, use body.children
    if not items:
        body = doc_dict.get("body", {})
        items = body.get("children", []) if isinstance(body, dict) else []

    for item in items:
        if not isinstance(item, dict):
            continue

        label = item.get("label", item.get("type", "Text"))
        prov_list = item.get("prov", [])

        for prov in prov_list:
            if not isinstance(prov, dict):
                continue

            page_ref = prov.get("page_no", 0)
            # If page_no is a hash reference, resolve it
            if isinstance(page_ref, str) and page_ref in page_no_map:
                page_ref = page_no_map[page_ref]

            raw_bbox = prov.get("bbox", {})
            if isinstance(raw_bbox, dict):
                # Docling uses PDF coords (y=0 at bottom, t > b).
                l = float(raw_bbox.get("l", raw_bbox.get("x", 0)))
                t = float(raw_bbox.get("t", raw_bbox.get("y", 0)))
                r = float(raw_bbox.get("r", l + raw_bbox.get("w", 0)))
                b = float(raw_bbox.get("b", t + raw_bbox.get("h", 0)))
                bbox = {
                    "x": min(l, r),
                    "y": min(t, b),
                    "w": abs(r - l),
                    "h": abs(t - b),
                }
            elif isinstance(raw_bbox, list) and len(raw_bbox) == 4:
                bbox = {
                    "x": float(min(raw_bbox[0], raw_bbox[2])),
                    "y": float(min(raw_bbox[1], raw_bbox[3])),
                    "w": float(abs(raw_bbox[2] - raw_bbox[0])),
                    "h": float(abs(raw_bbox[3] - raw_bbox[1])),
                }
            else:
                continue

            # Flip y from PDF coords (y=0 at bottom) to screen coords
            # (y=0 at top) so Docling and pdfxt zones use the same system.
            page_no_int = int(page_ref) if isinstance(page_ref, (int, float)) else 0
            page_h = page_height_map.get(page_no_int, 792.0)
            bbox["y"] = page_h - bbox["y"] - bbox["h"]

            # Docling v2 export_to_dict() does NOT expose per-item confidence.
            # Return None (not a fake fallback) so the frontend can show "N/A".
            confidence = item.get("confidence") or item.get("score") or None

            zones.append({
                "page":       int(page_ref) if isinstance(page_ref, (int, float)) else 0,
                "bbox":       bbox,
                "label":      label,
                "confidence": float(confidence) if confidence is not None else None,
            })

    processing_time_ms = int((time.time() - start) * 1000)

    # Log a sample of raw Docling output (first item) once per run for debugging
    if items:
        sample = items[0] if isinstance(items[0], dict) else str(items[0])
        logger.info(f"Job {req.jobId}: Docling sample item keys={list(sample.keys()) if isinstance(sample, dict) else 'N/A'}, sample={str(sample)[:500]}")

    logger.info(
        f"Job {req.jobId}: {len(zones)} zones detected "
        f"in {processing_time_ms}ms"
    )

    response = {
        "jobId":            req.jobId,
        "zones":            zones,
        "processingTimeMs": processing_time_ms,
    }

    # Signal waiting dedup requests and cache result briefly
    flight_entry["result"] = response
    flight_entry["event"].set()

    # Clean up after a short delay to allow waiting threads to read the result
    def _cleanup():
        time.sleep(5)
        with _inflight_lock:
            _inflight.pop(req.pdfPath, None)
    threading.Thread(target=_cleanup, daemon=True).start()

    return response
