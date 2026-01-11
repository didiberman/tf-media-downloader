# Webhook Lambda function
data "archive_file" "webhook" {
  type        = "zip"
  source_dir  = "${path.module}/../src/webhook"
  output_path = "${path.module}/.builds/webhook.zip"
}

resource "aws_lambda_function" "webhook" {
  function_name    = "media-downloader-webhook"
  filename         = data.archive_file.webhook.output_path
  source_code_hash = data.archive_file.webhook.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  role             = aws_iam_role.webhook_lambda.arn
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SQS_QUEUE_URL                   = aws_sqs_queue.download_queue.url
      TELEGRAM_BOT_TOKEN              = var.telegram_bot_token
      DYNAMODB_TABLE_NAME             = aws_dynamodb_table.users.name
      DYNAMODB_FILES_TABLE            = aws_dynamodb_table.files.name
      DYNAMODB_ACTIVE_DOWNLOADS_TABLE = aws_dynamodb_table.active_downloads.name
      TELEGRAM_ADMIN_USERNAME         = var.telegram_admin_username
      TELEGRAM_WEBHOOK_SECRET         = var.telegram_webhook_secret
    }
  }
}

resource "aws_lambda_function_url" "webhook" {
  function_name      = aws_lambda_function.webhook.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "webhook_url" {
  statement_id           = "AllowPublicInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.webhook.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${aws_lambda_function.webhook.function_name}"
  retention_in_days = 14
}
