FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY export.py main.py ./

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser \
    && chown -R appuser:appuser /app

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s \
  --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8082/health || exit 1

USER appuser

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", "--port", "8082", \
     "--log-level", "info"]
