import os, json, zipfile, tempfile, shutil
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import boto3
from export import export_corpus

app = FastAPI(title="Ninja Training Export Service")


class ExportRequest(BaseModel):
    groundTruthS3Path: str
    outputS3Path:      str
    exportId:          str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/export")
def export(req: ExportRequest):
    s3 = boto3.client('s3')

    # Download ground truth JSON from S3
    tmp_dir = tempfile.mkdtemp()
    try:
        gt_local = os.path.join(tmp_dir, 'ground_truth.json')
        try:
            parts = req.groundTruthS3Path.replace(
                's3://', ''
            ).split('/', 1)
            s3.download_file(parts[0], parts[1], gt_local)
        except Exception as e:
            raise HTTPException(422,
                f"Could not download ground truth: {e}")

        with open(gt_local) as f:
            data = json.load(f)
        documents = data.get('documents', [])
        if not documents:
            raise HTTPException(422, "No documents in ground truth")

        # Export corpus
        export_dir = os.path.join(tmp_dir, 'export')
        try:
            stats = export_corpus(documents, export_dir)
        except Exception as e:
            raise HTTPException(500, f"Export error: {e}")

        # ZIP the export directory
        zip_path = os.path.join(tmp_dir, f'{req.exportId}.zip')
        with zipfile.ZipFile(zip_path, 'w',
                zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(export_dir):
                for file in files:
                    fp = os.path.join(root, file)
                    arcname = os.path.relpath(fp, export_dir)
                    zf.write(fp, arcname)

        # Upload ZIP to S3
        zip_s3_path = f"{req.outputS3Path}/{req.exportId}.zip"
        parts = zip_s3_path.replace('s3://', '').split('/', 1)
        try:
            s3.upload_file(zip_path, parts[0], parts[1])
        except Exception as e:
            raise HTTPException(500,
                f"S3 upload failed: {e}")

        return {
            "success":   True,
            "zipS3Path": zip_s3_path,
            "exportId":  req.exportId,
            "stats":     stats,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
