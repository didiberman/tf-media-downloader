# Processor Lambda function
data "archive_file" "processor" {
  type        = "zip"
  source_dir  = "${path.module}/../src/processor"
  output_path = "${path.module}/.builds/processor.zip"
}

resource "aws_lambda_function" "processor" {
  function_name    = "media-downloader-processor"
  filename         = data.archive_file.processor.output_path
  source_code_hash = data.archive_file.processor.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  role             = aws_iam_role.processor_lambda.arn
  timeout          = 900 # 15 minutes for large downloads
  memory_size      = 1024
  ephemeral_storage {
    size = 2048 # 2GB temp storage for videos
  }

  layers = [aws_lambda_layer_version.ytdlp.arn]

  environment {
    variables = {
      S3_BUCKET_NAME           = aws_s3_bucket.media.id
      TELEGRAM_BOT_TOKEN       = var.telegram_bot_token
      INSTAGRAM_COOKIES_SECRET = aws_secretsmanager_secret.instagram_cookies.arn
      YOUTUBE_COOKIES_SECRET   = aws_secretsmanager_secret.youtube_cookies.arn
      YOUTUBE_PROXY            = var.youtube_proxy
      DYNAMODB_TABLE_NAME      = aws_dynamodb_table.users.name
      DYNAMODB_FILES_TABLE     = aws_dynamodb_table.files.name

      AWS_REGION_OVERRIDE      = var.aws_region
    }
  }
}

resource "aws_lambda_event_source_mapping" "processor_sqs" {
  event_source_arn = aws_sqs_queue.download_queue.arn
  function_name    = aws_lambda_function.processor.arn
  batch_size       = 1
}

resource "aws_cloudwatch_log_group" "processor" {
  name              = "/aws/lambda/${aws_lambda_function.processor.function_name}"
  retention_in_days = 14
}

# S3 bucket for Lambda layer (exceeds 70MB direct upload limit)
resource "aws_s3_object" "ytdlp_layer" {
  bucket = aws_s3_bucket.media.id
  key    = "layers/yt-dlp-ffmpeg.zip"
  source = "${path.module}/../layers/yt-dlp/layer.zip"
  etag   = filemd5("${path.module}/../layers/yt-dlp/layer.zip")
}

# yt-dlp Lambda Layer
resource "aws_lambda_layer_version" "ytdlp" {
  layer_name          = "yt-dlp-ffmpeg"
  s3_bucket           = aws_s3_bucket.media.id
  s3_key              = aws_s3_object.ytdlp_layer.key
  s3_object_version   = aws_s3_object.ytdlp_layer.version_id
  compatible_runtimes = ["nodejs22.x"]
  description         = "yt-dlp and ffmpeg binaries for media downloading"

  depends_on = [aws_s3_object.ytdlp_layer]
}
