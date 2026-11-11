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

# Custom domain(s) for this distribution's Alternate Domain Names (CNAMEs).
# Empty by default so existing callers (none yet besides production's own
# "frontend" module) keep working unchanged with no alias at all.
variable "aliases" {
  type    = list(string)
  default = []
}

# ARN of an ACM certificate, already issued in us-east-1 (CloudFront's own
# requirement, independent of the stack's region) covering every domain in
# var.aliases. Left null when var.aliases is empty, in which case the
# distribution keeps using the default *.cloudfront.net certificate.
variable "acm_certificate_arn" {
  type    = string
  default = null
}
