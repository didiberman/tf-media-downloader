# CloudFormation / SAM Deployment

This directory contains the AWS CloudFormation/SAM equivalent of the Terraform configuration.

## Prerequisites

1. **AWS SAM CLI** - Install from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
2. **AWS CLI** - Configured with appropriate credentials
3. **Docker** - Required for `sam build --use-container`

## Pre-Deployment Setup

Before deploying, you need to upload the Lambda layer to S3 manually (one-time setup):

```bash
# Create the S3 bucket first (or use an existing one)
aws s3 mb s3://your-bucket-name --region us-east-1

# Upload the yt-dlp layer
aws s3 cp ../layers/yt-dlp/layer.zip s3://your-bucket-name/layers/yt-dlp-ffmpeg.zip
```

## Deployment with SAM CLI (Recommended)

### 1. Configure your parameters

Edit `samconfig.toml` and update the `parameter_overrides` with your values:
- `TelegramBotToken` - Your bot token from @BotFather
- `TelegramAdminUsername` - Your Telegram username (without @)
- `TelegramWebhookSecret` - Generate with `openssl rand -hex 32`
- `S3BucketName` - Unique bucket name for media storage
- `ScrapecreatorsApiKey` - Your ScrapeCreators API key
- `OpenRouterApiKey` - Your OpenRouter API key

### 2. Build the application

```bash
cd cloudformation
sam build --use-container
```

### 3. Deploy

```bash
sam deploy --guided  # First time (interactive)
sam deploy           # Subsequent deployments
```

### 4. Set up Telegram webhook

After deployment, SAM will output the webhook URL. Run:

```bash
curl -X POST 'https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<WEBHOOK_URL>&secret_token=<YOUR_SECRET>'
```

## Deployment with AWS CLI (Alternative)

If you prefer not to use SAM:

### 1. Package the template

```bash
# First, zip your Lambda code manually
cd ../src/webhook && zip -r ../../cloudformation/webhook.zip . && cd ../../cloudformation
cd ../src/processor && zip -r ../../cloudformation/processor.zip . && cd ../../cloudformation

# Upload to S3
aws s3 cp webhook.zip s3://your-bucket-name/code/webhook.zip
aws s3 cp processor.zip s3://your-bucket-name/code/processor.zip
```

### 2. Deploy the stack

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name media-downloader-bot \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides file://parameters.json
```

## Comparison: Terraform vs CloudFormation

| Aspect | Terraform | CloudFormation/SAM |
|--------|-----------|-------------------|
| Deploy command | `terraform apply` | `sam deploy` |
| State management | Local/S3 tfstate file | AWS manages internally |
| Preview changes | `terraform plan` | `sam deploy --no-execute-changeset` |
| Destroy | `terraform destroy` | `sam delete` or AWS Console |
| Variable file | `terraform.tfvars` | `samconfig.toml` or `parameters.json` |

## Useful Commands

```bash
# View stack events
aws cloudformation describe-stack-events --stack-name media-downloader-bot

# View stack outputs (get webhook URL)
aws cloudformation describe-stacks --stack-name media-downloader-bot --query 'Stacks[0].Outputs'

# Delete the stack
sam delete --stack-name media-downloader-bot

# View logs for a function
sam logs -n media-downloader-webhook --stack-name media-downloader-bot --tail
```

## File Structure

```
cloudformation/
├── template.yaml           # Main SAM/CloudFormation template
├── samconfig.toml          # SAM CLI configuration
├── parameters.example.json # Example parameters for AWS CLI deployment
└── README.md               # This file
```
