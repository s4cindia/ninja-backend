variable "environment" {
  type = string
}

variable "secret_arns" {
  description = "ARNs the ECS task execution role needs secretsmanager:GetSecretValue on (injected into the container as `secrets`)."
  type        = list(string)
}

variable "s3_bucket_arn" {
  description = "Production file-storage bucket ARN the task role needs read/write on."
  type        = string
}
