variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "telegram_bot_token" {
  description = "Telegram Bot API token from BotFather"
  type        = string
  sensitive   = true
}

variable "s3_bucket_name" {
  description = "Name of the S3 bucket for storing downloaded media"
  type        = string
}

variable "instagram_cookies" {
  description = "Instagram cookies.txt content for authenticated downloads (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "youtube_cookies" {
  description = "YouTube cookies.txt content for authenticated downloads (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "youtube_proxy" {
  description = "Proxy URL for YouTube downloads"
  type        = string
  default     = ""
  sensitive   = true
}



variable "telegram_admin_username" {
  description = "Telegram username of the bot admin (without @)"
  type        = string
}

variable "telegram_webhook_secret" {
  description = "Secret token for Telegram webhook authentication"
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for Gemini/Claude video analysis"
  type        = string
  sensitive   = true
}
