output "bucket_name" {
  value = aws_s3_bucket.epub_storage.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.epub_storage.arn
}
