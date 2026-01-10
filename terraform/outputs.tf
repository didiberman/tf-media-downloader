output "webhook_url" {
  description = "Lambda Function URL for Telegram webhook"
  value       = aws_lambda_function_url.webhook.function_url
}

output "s3_bucket_name" {
  description = "S3 bucket name for downloaded media"
  value       = aws_s3_bucket.media.id
}

output "set_webhook_command" {
  description = "Command to set Telegram webhook"
  value       = "curl -X POST 'https://api.telegram.org/bot${var.telegram_bot_token}/setWebhook?url=${aws_lambda_function_url.webhook.function_url}&secret_token=${var.telegram_webhook_secret}'"
  sensitive   = true
}
