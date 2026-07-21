# YOLOv8 zone-detector inference service.
# Reuse the Ultralytics image — torch + CUDA + ultralytics are already baked
# (the same base the training task uses), so no heavy install here.
FROM ultralytics/ultralytics:latest

# poppler-utils backs pdf2image's page rendering.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY coords.py main.py ./

EXPOSE 8083

# Model load happens at startup and can take ~30–60s (S3 download + warm-up),
# so give the healthcheck a generous start period.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8083/health', timeout=5).status==200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8083", "--log-level", "info"]
