"""Ninja Zone Detector — YOLOv8 page-layout inference service.

Mirrors the docling-service HTTP contract (so it plugs into the same
submit-and-poll client pattern) but runs the fine-tuned YOLOv8 zone detector
(baseline-v7) instead of Docling:

  GET  /health          → { status, model }
  POST /detect          → sync   { jobId, zones, processingTimeMs }
  POST /detect-async    → { asyncJobId, status: "PROCESSING" }
  GET  /jobs/{id}        → { asyncJobId, status, result?, error? }

Response zone shape matches the rest of the pipeline exactly:
  { page, bbox: {x, y, w, h}, label, confidence }
where bbox is in **PDF points, top-left origin** (the same convention the
docling sidecar flips to and that Zone.bounds / the training export use).

Weights: a YOLO .pt is loaded at startup from the SSM parameter
`/ninja/zone-extractor/model-weights-path` (the promotion contract that
evaluation.service.ts already writes), or from the MODEL_WEIGHTS_S3 env var.
"""
import os
import re
import time
import uuid
import logging
import tempfile
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from coords import px_bbox_to_pdf_points

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("zone-detector-service")

# The 11 YOLO classes, in the exact index order the training export writes
# (training-export-service/export.py CLASS_MAP). Used as a fallback if the
# checkpoint doesn't carry names; a correctly-trained .pt carries them itself.
CLASS_NAMES = [
    "paragraph", "section-header", "table", "figure", "caption",
    "footnote", "header", "footer", "list-item", "toci", "formula",
]

RENDER_DPI = int(os.environ.get("RENDER_DPI", "150"))      # match the training export
MAX_EDGE = int(os.environ.get("MAX_EDGE", "1280"))          # match the training export letterbox
IMGSZ = int(os.environ.get("IMGSZ", "1024"))               # match the training imgsz
CONF = float(os.environ.get("CONF", "0.25"))               # detection confidence floor
WEIGHTS_SSM_PARAM = os.environ.get(
    "WEIGHTS_SSM_PARAM", "/ninja/zone-extractor/model-weights-path"
)
# boto3 clients need an explicit region — in the ECS container neither the
# AWS_REGION env var nor IMDS reliably supplies one, which fails the SSM/S3
# weights load at startup. Pass region_name explicitly.
REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "ap-south-1"

S3_URI_PATTERN = re.compile(r"^s3://([^/]+)/(.+)$")
app = FastAPI(title="Ninja Zone Detector", version="1.0.0")

_s3_client = None


def get_s3_client():
    global _s3_client
    if _s3_client is None:
        import boto3
        _s3_client = boto3.client("s3", region_name=REGION)
    return _s3_client


def download_from_s3(s3_uri: str) -> str:
    """Download an S3 object to a temp file; return the local path."""
    m = S3_URI_PATTERN.match(s3_uri)
    if not m:
        raise ValueError(f"Invalid S3 URI: {s3_uri}")
    bucket, key = m.group(1), m.group(2)
    suffix = os.path.splitext(key)[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.close()
    try:
        get_s3_client().download_file(bucket, key, tmp.name)
        logger.info(f"Downloaded s3://{bucket}/{key} -> {tmp.name}")
        return tmp.name
    except Exception:
        os.unlink(tmp.name)
        raise


def _resolve_weights_uri() -> str:
    """Weights S3 URI: prefer the SSM promotion parameter, fall back to env."""
    env_uri = os.environ.get("MODEL_WEIGHTS_S3")
    try:
        import boto3
        ssm = boto3.client("ssm", region_name=REGION)
        val = ssm.get_parameter(Name=WEIGHTS_SSM_PARAM)["Parameter"]["Value"]
        if val:
            logger.info(f"Weights from SSM {WEIGHTS_SSM_PARAM}: {val}")
            return val
    except Exception as e:
        logger.warning(f"SSM weights lookup failed ({e}); falling back to MODEL_WEIGHTS_S3")
    if not env_uri:
        raise RuntimeError(
            f"No weights: SSM {WEIGHTS_SSM_PARAM} unset/unreadable and MODEL_WEIGHTS_S3 not provided"
        )
    return env_uri


def _load_model():
    """Download the .pt and load it with Ultralytics. Runs once at startup."""
    import torch
    from ultralytics import YOLO

    uri = _resolve_weights_uri()
    local = download_from_s3(uri) if S3_URI_PATTERN.match(uri) else uri
    model = YOLO(local)
    dev = 0 if torch.cuda.is_available() else "cpu"
    logger.info(
        f"Model loaded from {uri} on device={dev} "
        f"(cuda={torch.cuda.is_available()}); classes={model.names}"
    )
    return model, dev


try:
    MODEL, DEVICE = _load_model()
except Exception as e:  # keep the container up so /health can report the failure
    logger.error(f"Model load failed at startup: {e}")
    MODEL, DEVICE = None, "cpu"

# GPU inference is serialized: one PDF at a time avoids VRAM contention.
_infer_semaphore = threading.Semaphore(1)


def _resize_max_edge(img, max_edge: int):
    """Downscale so the longest edge <= max_edge, preserving aspect ratio.
    Identical to the training export's render step, so inference sees the same
    image distribution it trained on. No padding — the scale stays uniform,
    which keeps the points<->pixels mapping a single per-axis ratio."""
    from PIL import Image
    w, h = img.size
    scale = min(max_edge / w, max_edge / h, 1.0)
    if scale < 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return img


def _page_sizes_pts(pdf_path: str):
    """(width_pt, height_pt) per page from the MediaBox — the PDF-point space
    that Zone.bounds live in (same source the export uses)."""
    import pikepdf
    sizes = []
    with pikepdf.open(pdf_path) as pdf:
        for page in pdf.pages:
            mb = page.MediaBox
            w = float(mb[2]) - float(mb[0])
            h = float(mb[3]) - float(mb[1])
            sizes.append((w, h))
    return sizes


def detect_pdf(pdf_path: str, job_id: str) -> dict:
    """Render each page, run YOLO, and map every box back to PDF points."""
    from pdf2image import convert_from_path

    start = time.time()
    page_sizes = _page_sizes_pts(pdf_path)
    zones = []

    for page_no, (pdf_w, pdf_h) in enumerate(page_sizes, start=1):
        if pdf_w <= 0 or pdf_h <= 0:
            continue
        imgs = convert_from_path(pdf_path, dpi=RENDER_DPI, first_page=page_no, last_page=page_no)
        if not imgs:
            continue
        img = _resize_max_edge(imgs[0], MAX_EDGE)
        img_w, img_h = img.size

        result = MODEL.predict(img, imgsz=IMGSZ, conf=CONF, device=DEVICE, verbose=False)[0]
        names = result.names if hasattr(result, "names") else {}

        # YOLO returns xyxy in the INPUT image's pixel space (top-left origin);
        # px_bbox_to_pdf_points maps each box back to top-left PDF points.
        for box in result.boxes:
            cls_idx = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            label = names.get(cls_idx) if isinstance(names, dict) else None
            if label is None:
                label = CLASS_NAMES[cls_idx] if 0 <= cls_idx < len(CLASS_NAMES) else str(cls_idx)
            zones.append({
                "page": page_no,
                "bbox": px_bbox_to_pdf_points(x1, y1, x2, y2, img_w, img_h, pdf_w, pdf_h),
                "label": label,
                "confidence": conf,
            })

    processing_time_ms = int((time.time() - start) * 1000)
    logger.info(f"Job {job_id}: {len(zones)} zones over {len(page_sizes)} pages in {processing_time_ms}ms")
    return {"jobId": job_id, "zones": zones, "processingTimeMs": processing_time_ms}


def _run_detection(pdf_path: str, job_id: str) -> dict:
    """Resolve the PDF (S3 or local), run detection, clean up. Serialized on the GPU."""
    local_path, is_temp = pdf_path, False
    if S3_URI_PATTERN.match(pdf_path):
        local_path = download_from_s3(pdf_path)
        is_temp = True
    elif not os.path.exists(pdf_path):
        raise FileNotFoundError(f"File not found: {pdf_path}")

    _infer_semaphore.acquire()
    try:
        return detect_pdf(local_path, job_id)
    finally:
        _infer_semaphore.release()
        if is_temp:
            try:
                os.unlink(local_path)
            except OSError:
                pass


class DetectRequest(BaseModel):
    pdfPath: str
    jobId: str


@app.get("/health")
def health():
    # Real readiness probe: fail (503) when the model didn't load, so the ECS /
    # container health check reflects actual readiness instead of just "process up".
    if MODEL is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {"status": "ok", "model": "loaded"}


@app.post("/detect")
def detect(req: DetectRequest):
    if MODEL is None:
        raise HTTPException(status_code=503, detail="Zone-detector model not initialised")
    try:
        return _run_detection(req.pdfPath, req.jobId)
    except FileNotFoundError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Job {req.jobId}: detection error: {e}")
        raise HTTPException(status_code=500, detail=f"Zone-detector error: {e}")


# ── Async endpoints (submit + poll) — mirror docling so long PDFs don't hold a
#    connection open across the NAT idle timeout. ─────────────────────────────
_async_jobs_lock = threading.Lock()
_async_jobs: dict[str, dict] = {}
_ASYNC_JOB_TTL = 10 * 60


def _cleanup_async_job(job_id: str):
    time.sleep(_ASYNC_JOB_TTL)
    with _async_jobs_lock:
        _async_jobs.pop(job_id, None)


def _run_async(async_job_id: str, req: DetectRequest):
    try:
        result = _run_detection(req.pdfPath, req.jobId)
        with _async_jobs_lock:
            _async_jobs[async_job_id] = {"status": "COMPLETED", "result": result, "error": None}
    except Exception as e:
        logger.error(f"Job {req.jobId}: async detection failed: {e}")
        with _async_jobs_lock:
            _async_jobs[async_job_id] = {"status": "FAILED", "result": None, "error": str(e)}
    finally:
        threading.Thread(target=_cleanup_async_job, args=(async_job_id,), daemon=True).start()


@app.post("/detect-async")
def detect_async(req: DetectRequest):
    if MODEL is None:
        raise HTTPException(status_code=503, detail="Zone-detector model not initialised")
    async_job_id = str(uuid.uuid4())
    with _async_jobs_lock:
        _async_jobs[async_job_id] = {"status": "PROCESSING", "result": None, "error": None}
    threading.Thread(target=_run_async, args=(async_job_id, req), daemon=True).start()
    logger.info(f"Job {req.jobId}: async detect started as {async_job_id}")
    return {"asyncJobId": async_job_id, "status": "PROCESSING"}


@app.get("/jobs/{async_job_id}")
def get_async_job(async_job_id: str):
    with _async_jobs_lock:
        job = _async_jobs.get(async_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found or expired")
    response = {"asyncJobId": async_job_id, "status": job["status"]}
    if job["status"] == "COMPLETED":
        response["result"] = job["result"]
    elif job["status"] == "FAILED":
        response["error"] = job["error"]
    return response
