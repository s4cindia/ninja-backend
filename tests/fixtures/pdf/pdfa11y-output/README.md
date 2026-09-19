# pdfa11y JSON Output

This directory holds pdfa11y (https://github.com/speedata/pdfa11y) JSON
report output for the same 3 fixture PDFs already used to validate
`verapdf-matterhorn.map.ts` (see `tests/fixtures/pdf/verapdf-output/README.md`).
Reusing the same fixtures lets both mapping tables be cross-checked against
identical real documents.

## Status

DONE. pdfa11y v0.0.11 (the Windows release binary) was installed locally and
run against all 3 fixture PDFs. The JSON output files in this directory are
real captured output, used by `tests/unit/services/pdf/pdfa11y.service.test.ts`
to validate `parseJsonReport`.

## Commands

Run these on any environment where `PDFA11Y_PATH` points to the pdfa11y binary:

```bash
FIXTURES=tests/fixtures/pdf
OUTPUT=tests/fixtures/pdf/pdfa11y-output

$PDFA11Y_PATH --format=json --spec=pdfua1 \
  "$FIXTURES/cp31-font-not-embedded.pdf" > "$OUTPUT/cp31-font-not-embedded.json"

$PDFA11Y_PATH --format=json --spec=pdfua1 \
  "$FIXTURES/cp31-missing-tounicode.pdf" > "$OUTPUT/cp31-missing-tounicode.json"

$PDFA11Y_PATH --format=json --spec=pdfua1 \
  "$FIXTURES/cp06-metadata-failures.pdf" > "$OUTPUT/cp06-metadata-failures.json"
```

## Important: pdfa11y's rule IDs are NOT Matterhorn condition numbers

See `src/data/pdfa11y-matterhorn.map.ts`'s own header for the full
explanation and concrete examples of numbers that coincidentally look like
a match but describe a completely different requirement. Never add a new
mapping entry by matching ID numbers alone -- always compare the real
finding/rule text against the actual Matterhorn 1.1 condition description.
