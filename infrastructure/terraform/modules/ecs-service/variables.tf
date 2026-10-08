variable "environment" {
  type = string
}

variable "service_role" {
  description = "'web' or 'worker' -- becomes the PROCESS_ROLE env var and names resources (matches src/index.ts's own PROCESS_ROLE switch)."
  type        = string
  validation {
    condition     = contains(["web", "worker"], var.service_role)
    error_message = "service_role must be \"web\" or \"worker\"."
  }
}

variable "cluster_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "image" {
  description = "Bootstrap image only -- ongoing deploys happen via GitHub Actions (Phase 7), which registers new task-definition revisions directly, same as staging already does. This value just needs to be valid enough for the service to start on first apply."
  type        = string
  default     = "223643972423.dkr.ecr.ap-south-1.amazonaws.com/ninja-backend:latest"
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "s3_bucket_name" {
  type = string
}

variable "secrets" {
  description = "List of {name, valueFrom} objects -- ECS injects each at container start. valueFrom supports the \"<secret-arn>:<json-key>::\" selector for pulling one field out of a JSON secret (used for the RDS managed-secret password)."
  type = list(object({
    name      = string
    valueFrom = string
  }))
}

variable "extra_environment" {
  description = "Additional plain env vars beyond the shared set (e.g. worker's YOLO_* vars)."
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "attach_to_alb" {
  type    = bool
  default = false
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "command" {
  description = "Container command override -- null uses the image's own CMD. Used to compose DATABASE_URL/REDIS_URL from separately-injected pieces at container start, so the root module never has to hand Terraform a combined connection string containing a real password (see root main.tf's own comment on this)."
  type        = list(string)
  default     = null
}
