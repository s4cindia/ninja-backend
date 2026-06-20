"""Batch entrypoint for the training export — bundle-in, YOLO-dataset-out.

Unlike main.py (the HTTP service, which downloads only a ground_truth.json
and assumes PDFs are already local), this reads a self-contained bundle ZIP
(ground_truth.json + pdfs/) from S3, runs export_corpus, and uploads the
resulting YOLO dataset ZIP back to S3. Designed to run as a one-shot
ECS/Fargate task.

Env:
  BUNDLE_S3_URI    s3://bucket/key.zip  — input bundle (ground_truth.json + pdfs/)
  OUTPUT_S3_PREFIX s3://bucket/prefix   — where to upload the dataset zip
  EXPORT_ID        output filename stem (default: yolo-dataset-<date>)
"""
import os
import json
import zipfile
import datetime
import boto3
from export import export_corpus


def _parse_s3(uri: str):
    body = uri.replace('s3://', '', 1)
    bucket, _, key = body.partition('/')
    return bucket, key


def main():
    bundle_uri = os.environ['BUNDLE_S3_URI']
    output_prefix = os.environ['OUTPUT_S3_PREFIX'].rstrip('/')
    export_id = os.environ.get(
        'EXPORT_ID',
        f"yolo-dataset-{datetime.date.today().isoformat()}"
    )
    s3 = boto3.client('s3')

    work = '/work'
    os.makedirs(work, exist_ok=True)

    # 1. Download + extract the bundle
    bundle_zip = os.path.join(work, 'bundle.zip')
    bkt, key = _parse_s3(bundle_uri)
    print(f'[export] Downloading {bundle_uri}', flush=True)
    s3.download_file(bkt, key, bundle_zip)
    bundle_dir = os.path.join(work, 'bundle')
    with zipfile.ZipFile(bundle_zip) as zf:
        zf.extractall(bundle_dir)
    print(f'[export] Extracted to {bundle_dir}', flush=True)

    # 2. Load ground truth, resolve pdfPath to absolute extracted paths
    with open(os.path.join(bundle_dir, 'ground_truth.json')) as f:
        data = json.load(f)
    documents = data.get('documents', [])
    if not documents:
        raise SystemExit('[export] No documents in ground_truth.json')
    for d in documents:
        d['pdfPath'] = os.path.join(bundle_dir, d['pdfPath'])
    print(f'[export] {len(documents)} documents', flush=True)

    # 3. Run the export (renders page images, writes YOLO labels + dataset.yaml)
    #    TABLE_NORMALIZE=1 collapses nested per-cell 'table' boxes into the
    #    outermost whole-table box (annotation-quality experiment).
    collapse_tables = os.environ.get('TABLE_NORMALIZE', '0') == '1'
    export_dir = os.path.join(work, 'export')
    stats = export_corpus(documents, export_dir, collapse_table_cells=collapse_tables)
    print('[export] STATS:\n' + json.dumps(stats, indent=2), flush=True)

    # 4. Zip the YOLO dataset
    out_zip = os.path.join(work, f'{export_id}.zip')
    with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(export_dir):
            for fn in files:
                fp = os.path.join(root, fn)
                zf.write(fp, os.path.relpath(fp, export_dir))
    size_mb = os.path.getsize(out_zip) / 1048576
    print(f'[export] Dataset zip: {size_mb:.1f} MB', flush=True)

    # 5. Upload
    out_bkt, out_prefix = _parse_s3(output_prefix)
    out_key = f'{out_prefix}/{export_id}.zip'
    s3.upload_file(out_zip, out_bkt, out_key)
    print(f'[export] Uploaded s3://{out_bkt}/{out_key}', flush=True)
    print('DONE', flush=True)


if __name__ == '__main__':
    main()
