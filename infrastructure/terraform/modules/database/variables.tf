variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "instance_class" {
  description = "Mirrors staging's ninja-staging-db instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "engine_version" {
  description = "Mirrors staging's ninja-staging-db Postgres version."
  type        = string
  default     = "15.17"
}

variable "allocated_storage" {
  description = "GB. Mirrors staging's ninja-staging-db."
  type        = number
  default     = 20
}

variable "backup_retention_period" {
  description = "Days. Mirrors staging's ninja-staging-db (7 days)."
  type        = number
  default     = 7
}

variable "db_name" {
  type    = string
  default = "ninja_production"
}

variable "master_username" {
  description = "Mirrors staging's ninja-staging-db master username."
  type        = string
  default     = "postgres"
}
