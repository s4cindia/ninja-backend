# veraPDF MRR Output

This directory holds veraPDF Machine Readable Report (MRR) XML output for the
test fixture PDFs used to validate the `verapdf-matterhorn.map.ts` mapping table.

## Fixture sources

All three fixture PDFs were sourced from the veraPDF test corpus:
https://github.com/veraPDF/veraPDF-corpus (Apache 2.0 / veraPDF Project)

| Fixture file | Matterhorn condition |
|---|---|
| `cp31-font-not-embedded.pdf` | 31-009 — font program not embedded |
| `cp31-missing-tounicode.pdf` | 31-027 — font missing ToUnicode entry |
| `cp06-metadata-failures.pdf` | 06-002 — pdfuaid:part missing from XMP metadata |

## Status

veraPDF runs will be executed on staging once `VERAPDF_PATH` is configured.
Output XML files will be committed to this directory after the first staging run.

## Commands

Run these on any environment where `VERAPDF_PATH` points to the veraPDF binary:

```bash
FIXTURES=tests/fixtures/pdf
OUTPUT=tests/fixtures/pdf/verapdf-output

$VERAPDF_PATH --flavour ua1 --format mrr --maxfailuresdisplayed 99999 \
  "$FIXTURES/cp31-font-not-embedded.pdf" > "$OUTPUT/cp31-font-not-embedded.xml"

$VERAPDF_PATH --flavour ua1 --format mrr --maxfailuresdisplayed 99999 \
  "$FIXTURES/cp31-missing-tounicode.pdf" > "$OUTPUT/cp31-missing-tounicode.xml"

$VERAPDF_PATH --flavour ua1 --format mrr --maxfailuresdisplayed 99999 \
  "$FIXTURES/cp06-metadata-failures.pdf" > "$OUTPUT/cp06-metadata-failures.xml"
```

The `<rule>` elements in the XML output contain the veraPDF rule IDs (e.g. `1:6.2-1`)
that need to be mapped to Matterhorn condition IDs in `src/data/verapdf-matterhorn.map.ts`.
Log any unmapped rule IDs so they can be added to the mapping table.
