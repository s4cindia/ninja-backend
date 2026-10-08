output "endpoint" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "db_name" {
  value = aws_db_instance.this.db_name
}

output "master_username" {
  value = aws_db_instance.this.username
}

# ARN of AWS's own managed secret (NOT the decrypted value) -- Phase 5's ECS
# task definition reads the password directly from this via a JSON-key
# selector, so the plaintext never passes through Terraform.
output "master_user_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}
