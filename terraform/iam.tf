# IAM role for Webhook Lambda
resource "aws_iam_role" "webhook_lambda" {
  name = "media-downloader-webhook-role-v2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "webhook_lambda" {
  name = "webhook-lambda-policy"
  role = aws_iam_role.webhook_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.download_queue.arn
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query"
        ]
        Resource = [
          "${aws_dynamodb_table.users.arn}",
          "${aws_dynamodb_table.files.arn}",
          "${aws_dynamodb_table.files.arn}/index/*",
          "${aws_dynamodb_table.active_downloads.arn}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = "*"
      }
    ]
  })
}

# IAM role for Processor Lambda
resource "aws_iam_role" "processor_lambda" {
  name = "media-downloader-processor-role-v2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "processor_lambda" {
  name = "processor-lambda-policy"
  role = aws_iam_role.processor_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.download_queue.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.media.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.media.arn
      },
      {
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = [
          aws_secretsmanager_secret.instagram_cookies.arn,
          aws_secretsmanager_secret.youtube_cookies.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query"
        ]
        Resource = [
          "${aws_dynamodb_table.users.arn}",
          "${aws_dynamodb_table.files.arn}",
          "${aws_dynamodb_table.files.arn}/index/*",
          "${aws_dynamodb_table.active_downloads.arn}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob"
        ]
        Resource = "*"
      }
    ]
  })
}

# Secrets Manager for Instagram cookies
resource "aws_secretsmanager_secret" "instagram_cookies" {
  name                    = "media-downloader/instagram-cookies"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "instagram_cookies" {
  secret_id     = aws_secretsmanager_secret.instagram_cookies.id
  secret_string = var.instagram_cookies != "" ? var.instagram_cookies : "# No cookies configured"
}

# Secrets Manager for YouTube cookies
resource "aws_secretsmanager_secret" "youtube_cookies" {
  name                    = "media-downloader/youtube-cookies"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "youtube_cookies" {
  secret_id     = aws_secretsmanager_secret.youtube_cookies.id
  secret_string = var.youtube_cookies != "" ? var.youtube_cookies : "# No cookies configured"
}
