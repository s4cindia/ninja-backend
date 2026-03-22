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

# Pre-download Docling models at build time using the SAME config as runtime.
# This ensures the HuggingFace model cache is baked into the image layer,
# since ECS tasks cannot reach huggingface.co at runtime.
# IMPORTANT: We must convert a real PDF to trigger lazy-loaded model downloads
# (layout detection, table structure, etc.) — just instantiating the converter
# is not enough.
ENV HF_HOME=/app/.cache/huggingface
COPY warmup.pdf .
RUN python -c "\
from docling.document_converter import DocumentConverter, PdfFormatOption; \
from docling.datamodel.pipeline_options import PdfPipelineOptions; \
from docling.datamodel.base_models import InputFormat; \
pipeline_options = PdfPipelineOptions(do_ocr=False); \
converter = DocumentConverter( \
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}, \
); \
result = converter.convert('warmup.pdf'); \
print(f'Warmup conversion done: {len(result.document.export_to_dict().get(\"texts\", []))} text items'); \
print('Docling models pre-loaded successfully (OCR disabled)')"

COPY main.py .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--log-level", "info"]
