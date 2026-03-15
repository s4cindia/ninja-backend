# pikepdf Write Spike - ML-3.8

## Purpose

Time-boxed spike to determine whether pikepdf can write
a valid Tagged PDF structure tree from Ninja zone ground
truth data.

**Go/No-Go threshold:** >=95% veraPDF PDF/UA-1 pass rate
across all content types individually.

## Files

| File | Purpose |
|------|---------|
| `zone_to_tags.py` | Ninja zone type -> PDF tag role mapping |
| `write_tagged_pdf.py` | Core pikepdf write implementation |
| `run_spike.py` | Batch runner + report generator |
| `generate_test_fixture.py` | Synthetic test fixture generator |
| `test_zone_to_tags.py` | Unit tests for mapping logic |

## Running the spike

### With real operator ground truth
```bash
pip install -r requirements.txt
python run_spike.py /path/to/ground_truth.json ./output/
```

### With synthetic fixture (no real PDFs needed)
```bash
pip install -r requirements.txt
python generate_test_fixture.py ./fixtures/
python run_spike.py ./fixtures/ground_truth.json ./output/
```

### Run unit tests only
```bash
python -m unittest test_zone_to_tags.py -v
```

## Output

- `output/spike_results.json` - machine-readable results
- `output/spike_report.md` - human-readable go/no-go report
- `output/*_tagged.pdf` - tagged PDF outputs for inspection

## Decision tree

- Pass rate >=95% (all content types) -> **PROCEED**
  Update Phase Gate C5 to GREEN.
- Pass rate <95% on any content type -> **EVALUATE PDFBox**
  Schedule PDFBox feasibility spike.
