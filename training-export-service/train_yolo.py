"""One-shot YOLOv8 training entrypoint for the ECS GPU task.

Downloads the exported YOLO dataset from S3, repairs the dataset.yaml `path`
(the exporter writes a container-local path), fine-tunes a YOLOv8 model on the
GPU, validates on the test split for per-class mAP, and uploads the run
artifacts (weights + metrics + plots) back to S3.

Driven entirely by env vars so the same image/task def serves the smoke run and
the real training runs — only EPOCHS/MODEL/BATCH/RUN_NAME change.

Env:
  DATASET_S3_URI    s3://bucket/yolo-dataset.zip   (images + labels + dataset.yaml)
  OUTPUT_S3_PREFIX  s3://bucket/prefix             (run artifacts uploaded here)
  MODEL             pretrained weights (default yolov8n.pt — smoke; yolov8m.pt for real)
  EPOCHS            training epochs (default 2 — smoke)
  IMGSZ             image size (default 640)
  BATCH             batch size (default 16)
  RUN_NAME          run name / output subfolder (default smoke)
"""
import os
import sys
import zipfile
import traceback


def parse_s3(uri):
    body = uri.replace('s3://', '', 1)
    bucket, _, key = body.partition('/')
    return bucket, key


def main():
    DATASET_S3 = os.environ['DATASET_S3_URI']
    OUTPUT_S3 = os.environ['OUTPUT_S3_PREFIX'].rstrip('/')
    MODEL = os.environ.get('MODEL', 'yolov8n.pt')
    EPOCHS = int(os.environ.get('EPOCHS', '2'))
    IMGSZ = int(os.environ.get('IMGSZ', '640'))
    BATCH = int(os.environ.get('BATCH', '16'))
    PATIENCE = int(os.environ.get('PATIENCE', '100'))  # early-stop after N epochs w/o val gain
    RUN_NAME = os.environ.get('RUN_NAME', 'smoke')

    import boto3
    s3 = boto3.client('s3')

    # 1. Download + extract dataset
    os.makedirs('/data', exist_ok=True)
    bkt, key = parse_s3(DATASET_S3)
    print(f'[train] downloading {DATASET_S3}', flush=True)
    s3.download_file(bkt, key, '/data/ds.zip')
    with zipfile.ZipFile('/data/ds.zip') as zf:
        zf.extractall('/data/ds')
    print('[train] extracted dataset', flush=True)

    # 2. Repair dataset.yaml `path` (exporter wrote a container-local path)
    yaml_path = '/data/ds/dataset.yaml'
    with open(yaml_path) as f:
        lines = f.readlines()
    with open(yaml_path, 'w') as f:
        for ln in lines:
            f.write('path: /data/ds\n' if ln.startswith('path:') else ln)
    print('[train] dataset.yaml:\n' + open(yaml_path).read(), flush=True)

    # 3. GPU sanity
    import torch
    has_cuda = torch.cuda.is_available()
    print(f'[train] torch {torch.__version__} cuda={has_cuda} '
          + (torch.cuda.get_device_name(0) if has_cuda else 'NO GPU'), flush=True)
    device = 0 if has_cuda else 'cpu'

    # 4. Train
    # MODEL may be an s3:// URI (custom checkpoint, e.g. DocLayNet-pretrained)
    # or a plain Ultralytics name (auto-downloaded from their CDN).
    if MODEL.startswith('s3://'):
        m_bkt, m_key = parse_s3(MODEL)
        local_model = '/tmp/' + os.path.basename(m_key)
        print(f'[train] downloading model checkpoint {MODEL}', flush=True)
        s3.download_file(m_bkt, m_key, local_model)
        MODEL = local_model
    from ultralytics import YOLO
    model = YOLO(MODEL)
    model.train(
        data=yaml_path, epochs=EPOCHS, imgsz=IMGSZ, batch=BATCH, patience=PATIENCE,
        project='/runs', name=RUN_NAME, device=device, exist_ok=True, verbose=True,
    )
    print('[train] training complete', flush=True)

    # 5. Evaluate on the held-out test split (per-class mAP)
    try:
        metrics = model.val(
            data=yaml_path, split='test', project='/runs',
            name=f'{RUN_NAME}_test', device=device, exist_ok=True,
        )
        names = metrics.names if hasattr(metrics, 'names') else {}
        per_class = {}
        try:
            for i, c in enumerate(metrics.box.ap_class_index):
                per_class[names.get(int(c), str(c))] = round(float(metrics.box.maps[int(c)]), 4)
        except Exception:
            pass
        print('[train] TEST mAP50:', round(float(metrics.box.map50), 4),
              'mAP50-95:', round(float(metrics.box.map), 4), flush=True)
        print('[train] TEST per-class mAP50-95:', per_class, flush=True)
    except Exception as e:
        print('[train] eval error:', e, flush=True)

    # 6. Upload run artifacts
    out_bkt, out_prefix = parse_s3(OUTPUT_S3)
    uploaded = 0
    for root, _, files in os.walk('/runs'):
        for fn in files:
            fp = os.path.join(root, fn)
            rel = os.path.relpath(fp, '/runs')
            s3.upload_file(fp, out_bkt, f'{out_prefix}/{rel}')
            uploaded += 1
    print(f'[train] uploaded {uploaded} files to {OUTPUT_S3}/', flush=True)
    print('DONE', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
