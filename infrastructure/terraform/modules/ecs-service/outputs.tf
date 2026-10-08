output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
