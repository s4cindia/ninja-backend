import os
import re
import time
import tempfile
import logging
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("docling-service")

app = FastAPI(title="Ninja Docling Service", version="1.0.0")

# Initialise converter once at startup — model loading is expensive
try:
    from docling.document_converter import DocumentConverter
    converter = DocumentConverter()
    logger.info("Docling DocumentConverter initialised successfully")
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

    zones = []
    pages = doc_dict.get("pages", [])

    for page in pages:
        page_num = page.get("page_no", page.get("pageNumber", 0))

        # Docling may use 'cells', 'blocks', or 'body' depending on version
        elements = (
            page.get("cells") or
            page.get("blocks") or
            page.get("body", {}).get("children", []) or
            []
        )

        for el in elements:
            # Extract label — Docling uses 'label' or 'type'
            label = el.get("label") or el.get("type") or "Text"

            # Extract bounding box — Docling uses 'bbox' or 'bounding_box'
            raw_bbox = el.get("bbox") or el.get("bounding_box") or {}
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

            confidence = el.get("confidence") or el.get("score") or None

            zones.append({
                "page":       int(page_num),
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
