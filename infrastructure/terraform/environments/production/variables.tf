variable "aws_region" {
  description = "AWS region for every production resource -- same region staging already runs in."
  type        = string
  default     = "ap-south-1"
}

variable "aws_account_id" {
  description = "AWS account ID hosting both staging and production (confirmed via Phase 0 audit, 2026-10-07)."
  type        = string
  default     = "223643972423"
}
