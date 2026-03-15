"""Generates a synthetic test fixture for the spike
when real operator ground truth is not yet available.
Creates a minimal valid PDF using pikepdf and a
matching ground truth JSON."""

import pikepdf
import json
import os
import sys
from pathlib import Path


def generate_fixture(output_dir: str):
    """
    Generate a minimal test fixture:
    - A 2-page PDF with basic content
    - A ground_truth.json with synthetic zones
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Create a minimal PDF
    pdf_path = os.path.join(output_dir, 'test_fixture.pdf')
    pdf = pikepdf.new()

    # Add 2 pages
    for i in range(2):
        page_dict = pikepdf.Dictionary(
            Type=pikepdf.Name('/Page'),
            MediaBox=pikepdf.Array([0, 0, 595, 842]),
        )
        pdf.pages.append(pikepdf.Page(page_dict))

    pdf.save(pdf_path)
    pdf.close()

    # Generate synthetic ground truth zones
    zones = [
        # Page 1
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 750, 'w': 495, 'h': 40},
         'type': 'section-header', 'operatorLabel': 'section-header',
         'headingLevel': 1, 'altText': None},
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 680, 'w': 495, 'h': 60},
         'type': 'paragraph', 'operatorLabel': 'paragraph',
         'altText': None},
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 500, 'w': 495, 'h': 170},
         'type': 'table', 'operatorLabel': 'table', 'altText': None},
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 450, 'w': 495, 'h': 40},
         'type': 'figure', 'operatorLabel': 'figure',
         'altText': 'A chart showing data distribution'},
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 420, 'w': 495, 'h': 25},
         'type': 'caption', 'operatorLabel': 'caption', 'altText': None},
        # Page 2
        {'pageNumber': 2, 'bounds': {'x': 50, 'y': 750, 'w': 495, 'h': 40},
         'type': 'section-header', 'operatorLabel': 'section-header',
         'headingLevel': 2, 'altText': None},
        {'pageNumber': 2, 'bounds': {'x': 50, 'y': 680, 'w': 495, 'h': 60},
         'type': 'paragraph', 'operatorLabel': 'paragraph',
         'altText': None},
        {'pageNumber': 2, 'bounds': {'x': 50, 'y': 50, 'w': 495, 'h': 20},
         'type': 'footnote', 'operatorLabel': 'footnote',
         'altText': None},
        # These should be artifacts (not in tag tree)
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 810, 'w': 495, 'h': 25},
         'type': 'header', 'operatorLabel': 'header', 'altText': None},
        {'pageNumber': 1, 'bounds': {'x': 50, 'y': 10, 'w': 495, 'h': 25},
         'type': 'footer', 'operatorLabel': 'footer', 'altText': None},
    ]

    # Build ground truth JSON
    gt = {
        'documents': [{
            'documentId':  'test-fixture-001',
            'pdfPath':     os.path.abspath(pdf_path),
            'contentType': 'mixed',
            'publisher':   'TestPublisher',
            'zones':       zones,
        }]
    }

    gt_path = os.path.join(output_dir, 'ground_truth.json')
    with open(gt_path, 'w') as f:
        json.dump(gt, f, indent=2)

    print(f"Generated fixture PDF:         {pdf_path}")
    print(f"Generated ground truth JSON:   {gt_path}")
    tagged = len([z for z in zones if z['type'] not in ('header', 'footer')])
    print(f"Zones: {len(zones)} ({tagged} tagged + 2 artifacts)")
    print(f"\nTo run the spike:")
    print(f"  python run_spike.py {gt_path} "
          f"{os.path.join(output_dir, 'output')}")


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 \
        else 'spikes/pikepdf-write/fixtures'
    generate_fixture(out)
