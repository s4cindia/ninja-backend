FROM python:3.11-slim

# System deps required by Docling / PyTorch / PDF rendering
RUN apt-get update && apt-get install -y \
    libgomp1 \
    curl \
    libxcb1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Docling models at build time
# || true: if download fails (no internet in CI), build still succeeds
# Models will download at first request instead
RUN python -c "\
from docling.document_converter import DocumentConverter; \
DocumentConverter(); \
print('Docling models pre-loaded successfully')" \
|| echo "Warning: Docling model pre-load failed — will download at runtime"

COPY main.py .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--log-level", "info"]
