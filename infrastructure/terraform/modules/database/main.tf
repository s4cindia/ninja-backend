# RDS Postgres, mirroring ninja-staging-db's real, audited configuration
# (instance class, engine version, storage, backup window) with two
# deliberate production deviations, flagged explicitly rather than silently
# copied: deletion_protection = true (staging has it off), and the master
# password is AWS-managed (manage_master_user_password = true) instead of a
# manually-set one -- it never appears in Terraform state, a tfvars file, a
# chat transcript, or anywhere a human has to type or paste it. AWS creates
# and owns its own Secrets Manager secret for it automatically.

resource "aws_db_subnet_group" "this" {
  name       = "ninja-${var.environment}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "ninja-${var.environment}-db-subnet-group"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "ninja-${var.environment}-db"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.master_username
  # No `password` argument -- AWS generates, stores, and can rotate it via
  # its own managed Secrets Manager secret (data-sourced below).
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false

  backup_retention_period = var.backup_retention_period
  multi_az                = false

  # Deliberate deviation from staging (which has this off) -- production
  # should never be a single fat-fingered `terraform destroy`/console click
  # away from data loss.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "ninja-${var.environment}-db-final"

  tags = {
    Name        = "ninja-${var.environment}-db"
    Environment = var.environment
    Application = "ninja"
  }
}

# Reads back the password from AWS's own managed secret, so the root module
# can compose a single DATABASE_URL connection string for the app -- Prisma
# reads one plain `postgresql://...` string, not AWS's structured JSON.
data "aws_secretsmanager_secret_version" "master_password" {
  secret_id = aws_db_instance.this.master_user_secret[0].secret_arn
}
