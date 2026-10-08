# Production ALB -- HTTP only (port 80), no HTTPS listener. Per the
# approved rollout plan's domain decision (CloudFront's own auto-generated
# domain, no custom domain/ACM cert), there's no certificate to attach to an
# HTTPS listener here. CloudFront (Phase 6) terminates the public HTTPS
# connection with its own built-in certificate and talks to this ALB over
# plain HTTP internally -- the same pattern the frontend's own (previously
# unreachable) production config already assumed, per its own
# "don't hit the ALB directly, use CloudFront -- causes CORS issues"
# comment. The ALB's security group (Phase 2) still allows 443 ingress for
# future flexibility if a custom domain is added later; this module just
# doesn't create a listener on it yet.

resource "aws_lb" "this" {
  name               = "ninja-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.security_group_id]
  subnets            = var.public_subnet_ids

  tags = {
    Name = "ninja-${var.environment}-alb"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "ninja-${var.environment}-web-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Fargate tasks register by IP, not instance ID.

  health_check {
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "ninja-${var.environment}-web-tg"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
