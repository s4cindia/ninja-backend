import os, json, time, zipfile
from pathlib import Path


def _validate_s3_path(s3_path: str) -> tuple[str, str]:
    """Validate and parse an s3:// path. Returns (bucket, key)."""
    if not s3_path.startswith('s3://'):
        raise ValueError(f"S3 path must start with s3://: {s3_path}")
    stripped = s3_path[len('s3://'):]
    if '/' not in stripped or not stripped.split('/', 1)[1]:
        raise ValueError(f"S3 path must contain bucket and key: {s3_path}")
    bucket, key = stripped.split('/', 1)
    if '..' in key:
        raise ValueError(f"S3 key must not contain '..': {s3_path}")
    return bucket, key


def download_from_s3(s3_path: str, local_path: str):
    import boto3
    bucket, key = _validate_s3_path(s3_path)
    s3 = boto3.client('s3')
    s3.download_file(bucket, key, local_path)


def upload_to_s3(local_path: str, s3_path: str):
    import boto3
    bucket, key = _validate_s3_path(s3_path)
    s3 = boto3.client('s3')
    s3.upload_file(local_path, bucket, key)


def main():
    corpus_s3 = os.environ['CORPUS_S3_PATH']
    run_id    = os.environ['TRAINING_RUN_ID']
    output_s3 = os.environ['MODEL_OUTPUT_S3_PATH']
    variant   = os.environ.get('MODEL_VARIANT', 'yolov8m')

    print(f"Training run: {run_id}, variant: {variant}")

    corpus_local = f'/tmp/corpus_{run_id}.zip'
    download_from_s3(corpus_s3, corpus_local)
    extract_dir = f'/tmp/training_{run_id}'
    with zipfile.ZipFile(corpus_local, 'r') as z:
        for member in z.namelist():
            member_path = os.path.realpath(
                os.path.join(extract_dir, member)
            )
            if not member_path.startswith(
                os.path.realpath(extract_dir) + os.sep
            ) and member_path != os.path.realpath(extract_dir):
                raise ValueError(
                    f"Zip path traversal detected: {member}"
                )
        z.extractall(extract_dir)

    dataset_yaml = os.path.join(extract_dir, 'dataset.yaml')
    if not os.path.exists(dataset_yaml):
        raise FileNotFoundError("dataset.yaml not found in corpus ZIP")

    from ultralytics import YOLO
    start = time.time()
    model = YOLO(f'{variant}.pt')
    results = model.train(
        data=dataset_yaml,
        epochs=100, imgsz=1280, batch=8, patience=20,
        project='/tmp/ninja-ml',
        name=f'run_{run_id}',
        exist_ok=True,
    )
    duration_ms = int((time.time() - start) * 1000)

    weights_dir = Path(f'/tmp/ninja-ml/run_{run_id}/weights')
    best_pt = weights_dir / 'best.pt'
    if not best_pt.exists():
        raise FileNotFoundError("best.pt not found after training")

    model_best = YOLO(str(best_pt))
    model_best.export(format='onnx', imgsz=1280)
    best_onnx = weights_dir / 'best.onnx'

    upload_to_s3(str(best_pt),   f'{output_s3}/best.pt')
    upload_to_s3(str(best_onnx), f'{output_s3}/best.onnx')

    metrics = results.results_dict if hasattr(results, 'results_dict') else {}
    map50 = float(metrics.get('metrics/mAP50(B)', 0))
    CLASS_NAMES = ['paragraph', 'section-header', 'table',
                   'figure', 'caption', 'footnote', 'header', 'footer']
    per_class = {}
    if hasattr(results, 'box') and hasattr(results.box, 'ap_class_index'):
        for idx, cls_idx in enumerate(results.box.ap_class_index):
            name = CLASS_NAMES[int(cls_idx)] if int(cls_idx) < 8 else str(cls_idx)
            per_class[name] = float(results.box.ap[idx])

    result_json = {
        'overallMAP': map50,
        'perClassAP': per_class,
        'epochs':     int(results.epoch) if hasattr(results, 'epoch') else 100,
        'durationMs': duration_ms,
        'weightsS3':  f'{output_s3}/best.pt',
        'onnxS3':     f'{output_s3}/best.onnx',
    }
    result_local = f'/tmp/results_{run_id}.json'
    with open(result_local, 'w') as f:
        json.dump(result_json, f, indent=2)
    upload_to_s3(result_local, f'{output_s3}/results.json')
    print(f"Done. mAP50={map50:.4f}")


if __name__ == '__main__':
    main()
