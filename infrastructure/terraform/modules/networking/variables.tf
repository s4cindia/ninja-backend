variable "environment" {
  description = "Environment name, used in resource names/tags (e.g. \"production\")."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
}

variable "azs" {
  description = "Availability zones to span -- same two staging already uses."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "public_subnet_cidrs" {
  description = "One CIDR per AZ, for ALB-facing public subnets."
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "One CIDR per AZ, for ECS tasks / RDS / Redis."
  type        = list(string)
}

variable "app_port" {
  description = "Port the backend container listens on (matches the Dockerfile's EXPOSE/HEALTHCHECK port)."
  type        = number
  default     = 3000
}
