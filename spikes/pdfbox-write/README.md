# PDFBox Write Spike — ML-3.9 (Issue #388)

## Purpose

Time-boxed spike to determine whether **Apache PDFBox** can write a valid
PDF/UA-1 Tagged PDF structure tree from Ninja zone ground-truth data.
Parallels `spikes/pikepdf-write/`; the two spikes consume the same
`ground_truth.json` shape, run the same veraPDF validation, and emit
reports in the same format so the pass-rates are directly comparable.

**Go/No-Go threshold:** ≥ 95% veraPDF PDF/UA-1 pass rate across all
content types individually.

| | pikepdf spike | PDFBox spike |
|---|---|---|
| Language | Python | Java |
| Library | `pikepdf` (qpdf bindings) | `org.apache.pdfbox:pdfbox` 3.x |
| Validator | veraPDF | veraPDF |
| Inputs | identical ground_truth.json | identical ground_truth.json |
| Reports | `spike_report.md` + `spike_results.json` | same shape |

## Files

| File | Purpose |
|------|---------|
| `pom.xml` | Maven build (Java 17, shaded uber-jar) |
| `Dockerfile` | Multi-stage: Maven build → JRE + veraPDF + jar |
| `entrypoint.sh` | Container entry: optional S3 bundle pull + run + S3 results upload |
| `src/main/java/.../ZoneToTags.java` | Zone-type → PDF tag role mapping (mirrors `zone_to_tags.py`) |
| `src/main/java/.../WriteTaggedPdf.java` | Core PDFBox write impl |
| `src/main/java/.../RunSpike.java` | Batch runner + report generator |
| `src/test/java/.../ZoneToTagsTest.java` | JUnit 5 tests mirroring `test_zone_to_tags.py` |

## Local build & run

```bash
# Requires JDK 17+ and Maven 3.9+.
mvn -B -DskipTests package

# Spike runner — same args as pikepdf's run_spike.py.
export VERAPDF_PATH=/path/to/verapdf   # or .bat on Windows
java -jar target/pdfbox-write-spike.jar \
     /path/to/bundle/ground_truth.json \
     ./output/

# spike_report.md + spike_results.json land in ./output/.
```

## Docker run (preferred — no local JDK / Maven / veraPDF setup)

```bash
docker build -t ninja-pdfbox-spike .

# Mode A — local bundle:
docker run --rm \
    -v /local/spike-bundle:/work/bundle \
    -v /local/output:/work/output \
    ninja-pdfbox-spike

# Mode B — bundle from S3 (one-shot, results stay in container):
docker run --rm \
    -e BUNDLE_S3_URI=s3://ninja-epub-staging/admin-scripts/pikepdf-spike-bundle-2026-05-13.zip \
    -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... -e AWS_DEFAULT_REGION=ap-south-1 \
    ninja-pdfbox-spike

# Mode C — full end-to-end (results uploaded to S3 + presigned URL printed):
docker run --rm \
    -e BUNDLE_S3_URI=s3://ninja-epub-staging/admin-scripts/pikepdf-spike-bundle-2026-05-13.zip \
    -e RESULTS_S3_PREFIX=s3://ninja-epub-staging/admin-scripts/ \
    -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... -e AWS_DEFAULT_REGION=ap-south-1 \
    ninja-pdfbox-spike
```

## ECS one-shot (same pattern the pikepdf export used)

After this image is pushed to ECR, run via Fargate:

```bash
aws ecs run-task \
  --cluster ninja-cluster \
  --task-definition ninja-pdfbox-spike \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[…],securityGroups=[…],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "pdfbox-spike",
      "environment": [
        {"name": "BUNDLE_S3_URI",      "value": "s3://ninja-epub-staging/admin-scripts/pikepdf-spike-bundle-2026-05-13.zip"},
        {"name": "RESULTS_S3_PREFIX",  "value": "s3://ninja-epub-staging/admin-scripts/"}
      ]
    }]
  }'
```

(Task definition + ECR push are separate infra steps — see Issue #388 acceptance criteria.)

## Output decision tree

| Result | Action |
|---|---|
| Pass rate ≥ 95% (all content types) | **PROCEED with PDFBox** for Phase 2 write step. Update phase-gate criterion C5 → GREEN. |
| Pass rate < 95% on any content type | **EVALUATE next alternatives** — manual pikepdf completion (1-2 sprints) vs commercial library vs combined approach. |

## Comparison baseline

The pikepdf spike ran 2026-05-13 and produced **0.0% pass rate** (10
distinct PDF/UA-1 clauses failing across 20 docs — see
`spikes/pikepdf-write/` and `CalibrationRun cmp4gp95a0001c92mznflwkve`).
Any PDFBox result substantially higher than 0% confirms the spike's
hypothesis that PDFBox's more mature Tagged-PDF support is the right
fallback. Even a non-passing result that fails fewer clauses informs
the effort estimate for completing the implementation.
