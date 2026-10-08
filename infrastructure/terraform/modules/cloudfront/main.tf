# CloudFront in front of the production ALB -- terminates public HTTPS with
# its own built-in default certificate (CloudFront's auto-generated domain,
# per the approved rollout plan's domain decision: no custom domain, no ACM
# cert, no Route53 work) and talks to the ALB over plain HTTP, matching
# Phase 4's design.
#
# No WAF attached. Staging's own CloudFront (per this repo's own CLAUDE.md)
# hit a real, documented issue where WAF "Core protections" blocked
# multipart/form-data file uploads, fixed there via presigned S3 URLs. Not
# attaching a WAF here avoids reintroducing that exact problem; add one
# later with that gotcha designed around explicitly if needed.
#
# API backend, not a static site -- caching is disabled (AWS's managed
# "CachingDisabled" policy) and every header/cookie/querystring is forwarded
# to the origin (AWS's managed "AllViewer" origin request policy), same
# shape staging's own backend CloudFront distribution needs for the same
# reason (dynamic API responses, not cacheable assets).

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "this" {
  enabled     = true
  comment     = "ninja-backend-api-${var.environment}"
  price_class = "PriceClass_100"

  origin {
    domain_name = var.alb_dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "ninja-backend-api-${var.environment}"
  }
}
