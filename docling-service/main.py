import os
import time
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

    if not os.path.exists(req.pdfPath):
        raise HTTPException(
            status_code=422,
            detail=f"File not found: {req.pdfPath}"
        )

    start = time.time()

    try:
        result = converter.convert(req.pdfPath)
    except Exception as e:
        logger.error(f"Docling conversion error for {req.pdfPath}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Docling processing error: {str(e)}"
        )

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
