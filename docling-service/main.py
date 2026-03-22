import os
import re
import time
import tempfile
import logging
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

    # Build page-number lookup from pages dict (Docling v2: {hash: {size, page_no, ...}})
    pages_dict = doc_dict.get("pages", {})
    page_no_map = {}
    if isinstance(pages_dict, dict):
        for page_hash, page_info in pages_dict.items():
            if isinstance(page_info, dict):
                page_no_map[page_hash] = page_info.get("page_no", 0)

    zones = []

    # Docling v2 stores document items in body.children, texts, pictures, tables
    # Each item has 'label' and 'prov' (provenance with bbox + page ref)
    body = doc_dict.get("body", {})
    items = body.get("children", []) if isinstance(body, dict) else []

    # Also include texts, pictures, tables as additional items
    for key in ("texts", "pictures", "tables"):
        extra = doc_dict.get(key, [])
        if isinstance(extra, list):
            items.extend(extra)

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
                bbox = {
                    "x": float(raw_bbox.get("l", raw_bbox.get("x", 0))),
                    "y": float(raw_bbox.get("t", raw_bbox.get("y", 0))),
                    "w": float(raw_bbox.get("r", raw_bbox.get("w", 0)) -
                               raw_bbox.get("l", raw_bbox.get("x", 0)))
                         if "r" in raw_bbox else float(raw_bbox.get("w", 0)),
                    "h": float(raw_bbox.get("b", raw_bbox.get("h", 0)) -
                               raw_bbox.get("t", raw_bbox.get("y", 0)))
                         if "b" in raw_bbox else float(raw_bbox.get("h", 0)),
                }
            elif isinstance(raw_bbox, list) and len(raw_bbox) == 4:
                bbox = {
                    "x": float(raw_bbox[0]),
                    "y": float(raw_bbox[1]),
                    "w": float(raw_bbox[2] - raw_bbox[0]),
                    "h": float(raw_bbox[3] - raw_bbox[1]),
                }
            else:
                continue

            confidence = item.get("confidence") or item.get("score") or None

            zones.append({
                "page":       int(page_ref) if isinstance(page_ref, (int, float)) else 0,
                "bbox":       bbox,
                "label":      label,
                "confidence": confidence,
            })

    processing_time_ms = int((time.time() - start) * 1000)
    logger.info(
        f"Job {req.jobId}: {len(zones)} zones detected "
        f"in {processing_time_ms}ms"
    )

    return {
        "jobId":            req.jobId,
        "zones":            zones,
        "processingTimeMs": processing_time_ms,
    }
