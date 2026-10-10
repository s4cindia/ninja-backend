# Reusable ECS service module -- parameterized for web vs worker (same
# shape staging already uses: one Docker image, PROCESS_ROLE env var
# switches behavior, see src/index.ts). Used twice from the root module.
# Also reused for a third, unrelated service (ACE microservice, Phase 8)
# purely for its generic ECS-service plumbing -- see service_role's and
# container_name's own doc comments in variables.tf.

locals {
  container_name = coalesce(var.container_name, "ninja-backend-${var.service_role}")
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/ninja-${var.environment}-${var.service_role}"
  retention_in_days = 30

  tags = {
    Name = "ninja-${var.environment}-${var.service_role}-logs"
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = "ninja-${var.environment}-${var.service_role}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name        = local.container_name
      image       = var.image
      essential   = true
      stopTimeout = 120
      command     = var.command
      portMappings = [
        { containerPort = var.app_port, protocol = "tcp" }
      ]
      environment = concat(
        [
          { name = "PROCESS_ROLE", value = var.service_role },
          { name = "S3_BUCKET", value = var.s3_bucket_name },
          { name = "S3_REGION", value = "ap-south-1" },
          { name = "VERAPDF_PATH", value = "/opt/verapdf/verapdf" },
        ],
        var.extra_environment
      )
      secrets = var.secrets
      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.app_port}/health || exit 1"]
        interval    = 60
        timeout     = 15
        retries     = 10
        startPeriod = 120
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = "ap-south-1"
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Name = "ninja-${var.environment}-${var.service_role}-task"
  }
}

resource "aws_ecs_service" "this" {
  name            = "ninja-${var.environment}-${var.service_role}-service"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.attach_to_alb ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = local.container_name
      container_port   = var.app_port
    }
  }

  # Ongoing deploys (Phase 7's GitHub Actions workflow) register new task-
  # definition revisions and update the service directly via the AWS CLI,
  # completely outside Terraform -- the exact same model staging's own
  # deploy-backend-staging.yml already uses (staging's ECS infra has zero
  # Terraform involvement at all). Without ignore_changes here, every
  # `terraform plan` after a real deploy would want to revert the service
  # back to this Terraform-created bootstrap revision, fighting the deploy
  # pipeline. Terraform's job is Day 1 creation only.
  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = {
    Name = "ninja-${var.environment}-${var.service_role}-service"
  }
}
