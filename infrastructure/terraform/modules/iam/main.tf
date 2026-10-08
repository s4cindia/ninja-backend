# Two roles, same split staging already uses (per ninja-backend-worker-task-
# definition.json's real executionRoleArn/taskRoleArn): the EXECUTION role is
# what ECS itself assumes to pull the image and inject secrets before the
# container starts; the TASK role is what the running application code
# assumes for its own AWS SDK calls (S3). Deliberately separate, dedicated
# production roles rather than reusing staging's -- consistent with every
# other Phase 2/3 resource being a clean, isolated production copy rather
# than a shared one.

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "ninja-${var.environment}-ecs-task-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The managed policy above covers ECR pull + awslogs -- it does NOT cover
# reading the specific Secrets Manager secrets the task definition injects
# (ninja/production/*, the RDS-managed secret, staging's shared
# anthropic/gemini secrets), so that's a separate, narrowly-scoped inline
# policy rather than a broader SecretsManagerReadWrite-style grant.
data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "ninja-${var.environment}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# Scoped to exactly the production file-storage bucket -- not S3FullAccess.
data "aws_iam_policy_document" "ecs_task_s3" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.s3_bucket_arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.s3_bucket_arn}/*"]
  }
}

resource "aws_iam_role_policy" "ecs_task_s3" {
  name   = "s3-access"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_s3.json
}
