variable "environment" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "node_type" {
  description = "Mirrors staging's ninja-staging-redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "engine_version" {
  # Major.minor only -- AWS's create API for a replication group rejects a
  # full major.minor.patch string ("7.1.0") for Redis 6+, even though
  # `aws elasticache describe-cache-clusters` reports staging's version
  # back in that fuller form. Discovered on the first real `terraform
  # plan`, not assumed. AWS resolves "7.1" to the current latest 7.1.x
  # patch automatically.
  description = "Mirrors staging's ninja-staging-redis engine version (major.minor only)."
  type        = string
  default     = "7.1"
}

variable "auth_token" {
  description = "Redis AUTH token -- Terraform-generated (random_password) by the caller, never typed by a human."
  type        = string
  sensitive   = true
}
