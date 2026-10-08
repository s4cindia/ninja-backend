# ElastiCache Redis, mirroring ninja-staging-redis's real, audited
# configuration (node type, engine version, single-node -- not cluster-mode,
# matching the app's ioredis client which only supports a single endpoint)
# with two deliberate production deviations: at-rest + in-transit encryption
# and an AUTH token, all off on staging. transit_encryption_enabled requires
# the app's REDIS_URL to use the rediss:// scheme -- src/lib/redis.ts and
# src/queues/index.ts already auto-detect that and enable TLS accordingly,
# so no app code change is needed, just composing the URL correctly (done
# in the root module).
#
# Uses aws_elasticache_replication_group, not aws_elasticache_cluster --
# transit encryption and an AUTH token are only supported on a replication
# group in the AWS provider, even for a single node. num_cache_clusters = 1
# with no read replicas keeps the real topology identical to staging's
# single-node setup; this is purely how AWS models encryption/auth support,
# not a move to cluster-mode or added redundancy.

resource "aws_elasticache_subnet_group" "this" {
  name       = "ninja-${var.environment}-redis-subnet-group"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "ninja-${var.environment}-redis"
  description          = "Ninja ${var.environment} Redis -- single node, mirrors ninja-staging-redis's real topology."

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters = 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.security_group_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.auth_token

  snapshot_retention_limit = 1

  tags = {
    Name        = "ninja-${var.environment}-redis"
    Environment = var.environment
    Application = "ninja"
  }
}
