output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

# Consumed by Phase 8 to add path-based listener rules (e.g. /ace/*),
# mirroring staging's ninja-alb-staging pattern, without modifying this
# module.
output "http_listener_arn" {
  value = aws_lb_listener.http.arn
}

output "web_target_group_arn" {
  value = aws_lb_target_group.web.arn
}
