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
  description = "Mirrors staging's ninja-staging-redis engine version."
  type        = string
  default     = "7.1.0"
}

variable "auth_token" {
  description = "Redis AUTH token -- Terraform-generated (random_password) by the caller, never typed by a human."
  type        = string
  sensitive   = true
}
