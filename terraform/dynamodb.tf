resource "aws_dynamodb_table" "users" {
  name         = "media-downloader-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "username"

  attribute {
    name = "username"
    type = "S"
  }

  tags = {
    Project = "media-downloader"
  }
}

resource "aws_dynamodb_table" "files" {
  name         = "media-downloader-files"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "file_key"

  attribute {
    name = "file_key"
    type = "S"
  }

  attribute {
    name = "source_type"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "SourceTypeIndex"
    hash_key        = "source_type"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Project = "media-downloader"
  }
}

resource "aws_dynamodb_table" "active_downloads" {
  name         = "media-downloader-active-downloads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "download_id"

  attribute {
    name = "download_id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Project = "media-downloader"
  }
}
