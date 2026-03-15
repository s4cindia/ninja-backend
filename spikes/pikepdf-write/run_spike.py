"""Spike runner: processes a ground truth JSON file,
writes a Tagged PDF for each document, runs validation,
and produces a spike report."""

import json
import os
import sys
import subprocess
import time
from pathlib import Path
from write_tagged_pdf import write_tagged_pdf


def run_verapdf(pdf_path: str) -> dict:
    """Run veraPDF PDF/UA-1 validation. Returns pass/fail + failures."""
    try:
        result = subprocess.run(
            ['C:/verapdf/verapdf.bat', '--flavour', 'ua1', pdf_path],
            capture_output=True, text=True, timeout=60
        )
        output = result.stdout + result.stderr
        # Check isCompliant attribute in veraPDF XML output
        passed = 'isCompliant="true"' in output
        # Extract only actual failed rule descriptions
        failures = []
        for line in output.split('\n'):
            if 'status="failed"' in line:
                failures.append(line.strip())
        return {
            'passed':   passed,
            'failures': failures[:10],  # cap at 10
            'raw':      output[:500],
        }
    except FileNotFoundError:
        return {
            'passed':   None,  # veraPDF not available
            'failures': [],
            'raw':      'veraPDF not found - skipping validation',
        }
    except subprocess.TimeoutExpired:
        return {
            'passed':   False,
            'failures': ['Validation timed out'],
            'raw':      '',
        }


def run_spike(ground_truth_path: str, output_dir: str):
    """
    Main spike runner.

    ground_truth_path: path to JSON file with format:
    {
      "documents": [
        {
          "documentId": "...",
          "pdfPath": "path/to/file.pdf",
          "contentType": "table-heavy",
          "publisher": "Pearson",
          "zones": [ ... YOLO format zones ... ]
        }
      ]
    }
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    with open(ground_truth_path) as f:
        data = json.load(f)

    documents = data.get('documents', [])
    results = []

    print(f"\nNinja pikepdf Write Spike")
    print(f"Documents: {len(documents)}")
    print(f"Output:    {output_dir}\n")

    for i, doc in enumerate(documents):
        doc_id      = doc.get('documentId', f'doc-{i}')
        pdf_path    = doc.get('pdfPath', '')
        content_type = doc.get('contentType', 'unknown')
        publisher   = doc.get('publisher', 'unknown')
        zones       = doc.get('zones', [])

        print(f"[{i+1}/{len(documents)}] {doc_id} "
              f"({content_type}, {len(zones)} zones)...")

        if not os.path.exists(pdf_path):
            results.append({
                'documentId':  doc_id,
                'contentType': content_type,
                'publisher':   publisher,
                'status':      'SKIPPED',
                'reason':      f'PDF not found: {pdf_path}',
            })
            print(f"  SKIPPED - PDF not found")
            continue

        output_path = os.path.join(
            output_dir, f'{doc_id}_tagged.pdf'
        )

        start = time.time()
        write_result = write_tagged_pdf(pdf_path, zones, output_path)
        write_ms = int((time.time() - start) * 1000)

        if not write_result['success']:
            results.append({
                'documentId':  doc_id,
                'contentType': content_type,
                'publisher':   publisher,
                'status':      'WRITE_FAILED',
                'error':       write_result.get('errorMessage'),
            })
            print(f"  WRITE FAILED: {write_result.get('errorMessage')}")
            continue

        # Run veraPDF validation
        validation = run_verapdf(output_path)

        status = 'PASS' if validation['passed'] is True \
            else 'FAIL' if validation['passed'] is False \
            else 'NO_VALIDATOR'

        results.append({
            'documentId':   doc_id,
            'contentType':  content_type,
            'publisher':    publisher,
            'status':       status,
            'zoneCount':    write_result['zoneCount'],
            'writeMs':      write_ms,
            'failures':     validation['failures'],
        })

        symbol = '?' if status == 'NO_VALIDATOR' else \
                 'x' if status == 'FAIL' else 'v'
        print(f"  {symbol} {status} - "
              f"{write_result['zoneCount']} zones, {write_ms}ms")

    # Write results JSON
    results_path = os.path.join(output_dir, 'spike_results.json')
    with open(results_path, 'w') as f:
        json.dump({'documents': results}, f, indent=2)

    # Generate report
    generate_report(results, output_dir)
    print(f"\nResults: {results_path}")


def generate_report(results: list, output_dir: str):
    """Generate spike_report.md from results."""

    total      = len(results)
    passed     = sum(1 for r in results if r['status'] == 'PASS')
    failed     = sum(1 for r in results if r['status'] == 'FAIL')
    skipped    = sum(1 for r in results
                     if r['status'] in ('SKIPPED', 'WRITE_FAILED'))
    no_val     = sum(1 for r in results if r['status'] == 'NO_VALIDATOR')

    pass_rate  = passed / (total - skipped - no_val) \
        if (total - skipped - no_val) > 0 else 0

    # Per content type
    ct_stats: dict = {}
    for r in results:
        ct = r['contentType']
        if ct not in ct_stats:
            ct_stats[ct] = {'pass': 0, 'fail': 0, 'total': 0}
        if r['status'] == 'PASS':
            ct_stats[ct]['pass'] += 1
        elif r['status'] == 'FAIL':
            ct_stats[ct]['fail'] += 1
        ct_stats[ct]['total'] += 1

    # Failure categories
    failure_cats: dict = {}
    for r in results:
        for f in r.get('failures', []):
            failure_cats[f] = failure_cats.get(f, 0) + 1

    # Go/No-Go
    go = pass_rate >= 0.95
    recommendation = 'PROCEED to Phase 2 write step migration' \
        if go else \
        'EVALUATE PDFBox fallback - pass rate below 95% threshold'

    lines = [
        '# Ninja pikepdf Write Spike - Report',
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        f'| Total documents | {total} |',
        f'| Passed (PAC/veraPDF) | {passed} |',
        f'| Failed | {failed} |',
        f'| Skipped (PDF not found) | {skipped} |',
        f'| No validator | {no_val} |',
        f'| **Overall pass rate** | **{pass_rate:.1%}** |',
        f'| **Go/No-Go threshold** | **95%** |',
        f'| **Decision** | **{"GO" if go else "NO-GO"}** |',
        '',
        '## Per Content Type',
        '',
        '| Content Type | Pass | Fail | Rate |',
        '|-------------|------|------|------|',
    ]

    for ct, s in ct_stats.items():
        rate = s["pass"] / s["total"] if s["total"] > 0 else 0
        lines.append(
            f'| {ct} | {s["pass"]} | {s["fail"]} '
            f'| {rate:.1%} |'
        )

    lines += [
        '',
        '## Failure Categories',
        '',
    ]

    if failure_cats:
        lines += [
            '| Failure | Count |',
            '|---------|-------|',
        ]
        for f, c in sorted(
            failure_cats.items(), key=lambda x: -x[1]
        ):
            lines.append(f'| {f[:80]} | {c} |')
    else:
        lines.append('No failures recorded.')

    lines += [
        '',
        '## Recommendation',
        '',
        f'**{recommendation}**',
        '',
    ]

    if not go:
        lines += [
            '## PDFBox Feasibility Assessment',
            '',
            'If pikepdf does not meet the 95% threshold:',
            '- PDFBox (Java/Kotlin subprocess) is the approved fallback',
            '- PDFBox has more mature Tagged PDF support than pikepdf',
            '- Integration path: Java subprocess via child_process from Node',
            '- Estimated effort: 1 sprint (ML-6.1 replacement)',
            '',
        ]

    report_path = os.path.join(output_dir, 'spike_report.md')
    with open(report_path, 'w') as f:
        f.write('\n'.join(lines))

    print(f"\n{'='*50}")
    print(f"Go/No-Go: {'GO' if go else 'NO-GO'}")
    print(f"Pass rate: {pass_rate:.1%} "
          f"({'>' if go else '<'} 95% threshold)")
    print(f"Report: {report_path}")
    print(f"{'='*50}\n")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python run_spike.py "
              "<ground_truth.json> <output_dir>")
        sys.exit(1)
    run_spike(sys.argv[1], sys.argv[2])
