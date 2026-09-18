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

DONE. veraPDF 1.30.2 was installed locally (via the official IzPack silent
installer) and run against all 3 fixture PDFs. The XML output files in this
directory are real captured output, used by
`tests/unit/services/pdf/verapdf.service.test.ts` to validate `parseMrrXml`.

Validating this real output against the assumed MRR shape in
`verapdf.service.ts`'s `parseMrrXml` found two real parsing bugs (fixed):
the `specMajor` regex matched the wrong trailing digits on specification
strings that include a year, e.g. "ISO 14289-1:2014" (`/\d+$/` matched
"2014" instead of "1"), and `<check>` elements are direct children of
`<rule>` — there is no wrapping `<checks>` element as the original code
assumed. It also found that 2 of the 3 original placeholder mappings in
`verapdf-matterhorn.map.ts` had the wrong clause/testNumber.

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
