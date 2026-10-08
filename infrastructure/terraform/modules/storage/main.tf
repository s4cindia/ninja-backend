# Production file storage -- mirrors staging's ninja-epub-staging bucket
# (same purpose: PDF/EPUB uploads + remediated output, per
# file-storage.service.ts). A real gap caught while designing Phase 5: no
# earlier phase created this, and the app has no code path that works
# without S3_BUCKET pointing somewhere real -- src/config/index.ts's own
# fallback default is literally the STAGING bucket name, so this must exist
# before the production task definition can safely reference it (see also
# Phase 10's planned app-level hardening: that silent-fallback-to-staging
# behavior is a real gap in the app code itself, independent of this).

resource "aws_s3_bucket" "epub_storage" {
  bucket = "ninja-epub-${var.environment}"

  tags = {
    Name = "ninja-epub-${var.environment}"
  }
}

resource "aws_s3_bucket_versioning" "epub_storage" {
  bucket = aws_s3_bucket.epub_storage.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "epub_storage" {
  bucket = aws_s3_bucket.epub_storage.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "epub_storage" {
  bucket                  = aws_s3_bucket.epub_storage.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
