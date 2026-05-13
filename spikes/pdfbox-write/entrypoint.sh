#!/usr/bin/env bash
# Entrypoint for the PDFBox spike container.
#
# Three modes:
#   1. Local file mode (default):
#        docker run -v /local/bundle:/work/bundle pdfbox-spike \
#            bundle/ground_truth.json output/
#
#   2. S3-bundle mode (set BUNDLE_S3_URI):
#        docker run -e BUNDLE_S3_URI=s3://bucket/key.zip pdfbox-spike
#      Container downloads + unzips the bundle, runs the spike, exits.
#
#   3. ECS one-shot mode (set BUNDLE_S3_URI + RESULTS_S3_PREFIX):
#        Container downloads bundle, runs spike, uploads spike_report.md +
#        spike_results.json to RESULTS_S3_PREFIX, prints presigned URL.
#
# VERAPDF_PATH defaults to /opt/verapdf/verapdf (set by Dockerfile).
set -euo pipefail

WORK_DIR=${WORK_DIR:-/work}
mkdir -p "$WORK_DIR" && cd "$WORK_DIR"

BUNDLE_DIR=${BUNDLE_DIR:-$WORK_DIR/bundle}
OUTPUT_DIR=${OUTPUT_DIR:-$WORK_DIR/output}
mkdir -p "$OUTPUT_DIR"

# Mode 2/3: pull bundle from S3 if requested.
if [[ -n "${BUNDLE_S3_URI:-}" ]]; then
  echo "[entrypoint] Downloading bundle from $BUNDLE_S3_URI"
  aws s3 cp "$BUNDLE_S3_URI" "$WORK_DIR/bundle.zip"
  rm -rf "$BUNDLE_DIR" && mkdir -p "$BUNDLE_DIR"
  unzip -q "$WORK_DIR/bundle.zip" -d "$BUNDLE_DIR"
  rm "$WORK_DIR/bundle.zip"
fi

# If positional args were passed, honour them; otherwise infer from $BUNDLE_DIR.
if [[ "$#" -ge 2 ]]; then
  GT_PATH="$1"
  OUT_PATH="$2"
else
  GT_PATH="$BUNDLE_DIR/ground_truth.json"
  OUT_PATH="$OUTPUT_DIR"
fi

echo "[entrypoint] ground_truth: $GT_PATH"
echo "[entrypoint] output dir:   $OUT_PATH"
echo "[entrypoint] veraPDF:      ${VERAPDF_PATH:-not set}"

# Run the spike. Java tunings: cap heap to leave room for veraPDF child.
java -Xmx4g -jar /app/pdfbox-write-spike.jar "$GT_PATH" "$OUT_PATH"

# Mode 3: upload artefacts to S3.
if [[ -n "${RESULTS_S3_PREFIX:-}" ]]; then
  DATE_TAG=$(date -u +%Y-%m-%d)
  RESULTS_KEY="${RESULTS_S3_PREFIX%/}/pdfbox-spike-results-${DATE_TAG}"
  echo "[entrypoint] Uploading results to ${RESULTS_KEY}.{md,json}"
  aws s3 cp "$OUT_PATH/spike_report.md"   "${RESULTS_KEY}.md"
  aws s3 cp "$OUT_PATH/spike_results.json" "${RESULTS_KEY}.json"
  # 24-hour presigned URL for the report (read-only convenience).
  aws s3 presign "${RESULTS_KEY}.md" --expires-in 86400
fi

echo "[entrypoint] DONE"
