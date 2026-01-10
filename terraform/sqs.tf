# SQS queue for async processing
resource "aws_sqs_queue" "download_queue" {
  name                       = "media-download-queue"
  visibility_timeout_seconds = 900   # 15 minutes (matches Lambda timeout)
  message_retention_seconds  = 86400 # 1 day
  receive_wait_time_seconds  = 20    # Long polling
}

resource "aws_sqs_queue" "download_dlq" {
  name                      = "media-download-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue_redrive_policy" "download_queue" {
  queue_url = aws_sqs_queue.download_queue.id
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.download_dlq.arn
    maxReceiveCount     = 3
  })
}
