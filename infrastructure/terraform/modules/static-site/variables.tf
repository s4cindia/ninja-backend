variable "environment" {
  type = string
}

# Not derived from var.environment (unlike every other module's naming) --
# this reuses the exact bucket name a pre-existing-but-never-applied
# deploy-frontend-production.yml in the ninja-frontend repo already
# hardcodes, itself matching staging's real s4carlisle-ninja-frontend-staging
# bucket's naming family. Keeping that name means the workflow needs no
# bucket-name edit once this module creates the real bucket.
variable "bucket_name" {
  type = string
}
