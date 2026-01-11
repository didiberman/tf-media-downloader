# Deep Video Strategist – Telegram Bot  

A serverless Telegram bot that **downloads short-form videos** (Instagram Reels, YouTube Shorts) and **analyzes them with AI** to extract deep viral strategy insights. Powered by Gemini 2.5 Flash (visual analysis) and Claude Sonnet (strategic synthesis) via OpenRouter.

---

## What It Does

1. **Download** – Send an Instagram Reel or YouTube Short link and get the MP4 delivered to your chat + stored in S3.  
2. **Analyze** – Tap the "🧠 Analyze Video" button to receive a full strategic breakdown:
   - Visual narrative & hook analysis (Gemini 2.5 Flash with frame extraction)  
   - Audio transcript (AWS Transcribe)  
   - Deep strategic synthesis (Claude Sonnet)  
3. **Learn** – Get actionable insights on *why* the video works, the psychological hooks, virality mechanics, and a replication blueprint for your own content.

---

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Telegram      │─────▶│  Webhook Lambda │─────▶│      SQS        │
│   (User Input)  │      │  (Auth + Route) │      │  (Message Queue)│
└─────────────────┘      └─────────────────┘      └────────┬────────┘
                                                           │
                                                           ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   S3 Bucket     │◀─────│ Processor Lambda│◀─────│  DynamoDB x3    │
│ (7-day Lifecycle│      │ (Download + AI) │      │ (Users + Files  │
└─────────────────┘      └────────┬────────┘      │  + Active DLs)  │
                                  │               └─────────────────┘
                                  ▼
                    ┌─────────────────────────┐
                    │ AI Analysis Pipeline    │
                    │ ┌─────────┐ ┌─────────┐ │
                    │ │ Gemini  │ │Transcribe│ │
                    │ │ (Visual)│ │ (Audio) │ │
                    │ └────┬────┘ └────┬────┘ │
                    │      └─────┬─────┘      │
                    │      ┌─────▼─────┐      │
                    │      │  Claude   │      │
                    │      │(Synthesis)│      │
                    │      └───────────┘      │
                    └─────────────────────────┘
```

---

## AI Analysis Pipeline

The "🧠 Analyze Video" feature runs a multi-model analysis:

| Step | Model | Purpose |
|------|-------|---------|
| **Frame Extraction** | FFmpeg | Extract key frames (2fps hook, 1fps body) |
| **Visual Analysis** | Gemini 2.5 Flash Image | Analyze hook, pacing, production, text overlays |
| **Transcription** | AWS Transcribe | Convert audio to text |
| **Synthesis** | Claude Sonnet | Combine analyses into strategic insights |

**Output includes:**
- 📊 What the video really is (core insight)
- 🎯 Psychological hook analysis  
- ⚡ Success factors (3 core principles)
- 🔥 Virality mechanics breakdown
- 💡 Replication blueprint
- 🎬 Creator insights

---

## AWS Services Used

| Service | Purpose | Key Configuration |
|---------|---------|-------------------|
| **Lambda** (Webhook) | Receives Telegram webhooks, authenticates users, routes commands | Node.js 22, 256MB, 30s timeout |
| **Lambda** (Processor) | Downloads media, runs AI analysis, sends to Telegram | Node.js 22, 1024MB, 900s timeout, Custom Lambda Layer |
| **SQS** | Decouples webhook from processor, handles retry logic | 900s visibility timeout, DLQ after 3 attempts |
| **DynamoDB** (`users`) | Stores user auth status, usage stats (total + per-platform) | PAY_PER_REQUEST, PK: `username` |
| **DynamoDB** (`files`) | Indexes downloaded files for deduplication and listing | PAY_PER_REQUEST, PK: `file_key`, TTL enabled |
| **DynamoDB** (`active_downloads`) | Tracks in-progress downloads for real-time status | PAY_PER_REQUEST, PK: `download_id`, TTL: 15min |
| **S3** | Stores downloaded media files + temp audio for transcription | 7-day lifecycle expiration on `downloads/` prefix |
| **Secrets Manager** | Stores Instagram/YouTube cookies & OpenRouter API key | Retrieved at runtime by Processor Lambda |
| **AWS Transcribe** | Converts video audio to text for analysis | On-demand, en-US |
| **IAM** | Least-privilege policies for each Lambda | Separate roles per function |

---

## Key Implementation Details

### 1. Webhook Lambda (`src/webhook/index.mjs`)

**Responsibilities:**
- Parse Telegram webhook payload
- Authenticate user against DynamoDB allowlist
- Handle admin commands (`/add`, `/remove`, `/stats`, `/list`, `/clear`, `/help`, `/users`)
- Extract and validate URLs (Instagram/YouTube patterns)
- Queue valid requests to SQS

**Auth Flow:**
```javascript
// Admin auto-allowed, others checked against DynamoDB
if (username === TELEGRAM_ADMIN_USERNAME) return true;
const response = await ddb.GetItem({ Key: { username } });
return response.Item?.is_allowed?.BOOL === true;
```

### 2. Processor Lambda (`src/processor/index.mjs`)

**Responsibilities:**
- Consume SQS messages
- Download media using yt-dlp with platform-specific cookies
- Upload to S3 with deduplication (HeadObject check)
- Generate presigned URL (7-day expiry)
- Send file directly to Telegram (if < 50MB) or send S3 link
- Update usage stats in DynamoDB
- Index file in `files` table with TTL

**yt-dlp Arguments:**
```javascript
const args = [
  '--no-playlist',
  '--restrict-filenames',
  '--socket-timeout', '10',
  '--extractor-args', 'youtube:player_client=ios',
  '--format', 'best[ext=mp4]/best',
  '-o', `${tempDir}/%(title)s [%(id)s].%(ext)s`,
  '--cookies', cookiesPath,
  '--proxy', YOUTUBE_PROXY, // For YouTube only
];
```

### 3. DynamoDB TTL (Time-To-Live)

Files are automatically deleted from DynamoDB when their `ttl` attribute (epoch seconds) is reached.

**Implementation:**
```javascript
// Processor saves TTL = now + 7 days
const ttlSeconds = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
await ddb.PutItem({
  Item: { ..., ttl: { N: String(ttlSeconds) } }
});
```

**Terraform:**
```hcl
resource "aws_dynamodb_table" "files" {
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
```

### 4. S3 Lifecycle Policy

Files in `downloads/` prefix are automatically deleted after 7 days.

```hcl
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  rule {
    id     = "expire-after-7-days"
    status = "Enabled"
    filter { prefix = "downloads/" }
    expiration { days = 7 }
  }
}
```

### 5. Deduplication

Before downloading, the Processor checks if the S3 key already exists:
```javascript
try {
  await s3.send(new HeadObjectCommand({ Bucket, Key }));
  // File exists, return existing presigned URL
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn });
} catch (e) {
  if (e.name === 'NotFound') {
    // Proceed with download
  }
}
```

### 6. Lambda Layer (yt-dlp + FFmpeg)

Custom Lambda Layer containing:
- `yt-dlp` binary (for media extraction)
- `ffmpeg` binary (for audio/video processing)

**Build process:**
```bash
cd layers/yt-dlp
./build.sh  # Downloads binaries and packages as ZIP
```

---

## Admin Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/users` | List allowed users |
| `/add @user` | Add user to allowlist |
| `/remove @user` | Remove user |
| `/stats` | View per-user usage (total + YouTube/Instagram breakdown) |
| `/list` | List all indexed files + active downloads with progress |
| `/list youtube` | List YouTube downloads only |
| `/list instagram` | List Instagram downloads only |
| `/clear` | Delete all file records (preserves user stats) |

---

## Real-Time Progress Tracking

Active downloads show live progress updates:

1. **In Telegram**: The "Processing..." message updates every **2 seconds** with current download percentage and speed
2. **In `/list`**: Shows active downloads with percentage, speed, user, and elapsed time
3. **File Size Inclusion**: All completion messages include the final file size (e.g., `(25.4 MB)`) next to the title.

**Phases shown:**
- 📥 Starting download...
- 📥 Downloading... **45.2%** (2.5MiB/s)
- 🎵 Converting to MP3... (for audio extraction)

**Example `/list` output:**
```
⏳ Active Downloads

📥 45.2% (2.5MiB/s)
   👤 @username | 🏷️ youtube-long
   🔗 https://youtube.com/watch?v=...
   ⏱️ 1m 23s

-------------------

📂 Downloaded Files
...
```

---

## Webhook Security

Telegram webhook requests are authenticated using a secret token:

1. Set in `terraform.tfvars`: `telegram_webhook_secret = "<random-string>"`
2. Passed to Telegram via `setWebhook` API
3. Validated in Lambda via `X-Telegram-Bot-Api-Secret-Token` header
4. Requests without valid token return `403 Forbidden`

---

## Environment Variables

### Webhook Lambda
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ADMIN_USERNAME` | Admin username (no @) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token for webhook authentication |
| `SQS_QUEUE_URL` | URL of download queue |
| `DYNAMODB_TABLE_NAME` | Name of users table |
| `DYNAMODB_FILES_TABLE` | Name of files table |
| `DYNAMODB_ACTIVE_DOWNLOADS_TABLE` | Name of active downloads table |

### Processor Lambda
| Variable | Description |
|----------|-------------|
| `S3_BUCKET_NAME` | Bucket for media storage |
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `OPENROUTER_API_KEY` | OpenRouter API key for Gemini/Claude access |
| `INSTAGRAM_COOKIES_SECRET` | Secrets Manager ARN |
| `YOUTUBE_COOKIES_SECRET` | Secrets Manager ARN |
| `YOUTUBE_PROXY` | Proxy URL for YouTube (bypass IP blocks) |
| `DYNAMODB_TABLE_NAME` | Name of users table |
| `DYNAMODB_FILES_TABLE` | Name of files table |
| `DYNAMODB_ACTIVE_DOWNLOADS_TABLE` | Name of active downloads table |

---

## Deployment

```bash
# 1. Build Lambda Layer
cd layers/yt-dlp && ./build.sh

# 2. Configure variables
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 3. Deploy
terraform init
terraform apply

# 4. Set Telegram webhook
terraform output -raw set_webhook_command | bash
```

---

## Key Learnings (Cloud Education)

1. **Decoupled Architecture**: SQS between Webhook/Processor enables async processing, retry handling, and DLQ for failed messages.

2. **IAM Least Privilege**: Each Lambda has its own role with only the permissions it needs (e.g., Webhook can't write to S3).

3. **DynamoDB TTL vs S3 Lifecycle**: Both expire data automatically, but must be configured separately to stay in sync.

4. **Presigned URLs**: S3 objects stay private; access is granted via time-limited signed URLs.

5. **Lambda Layers**: Heavy binaries (yt-dlp, ffmpeg) are packaged separately, keeping function code small.

6. **Secrets Manager**: Sensitive data (cookies) never stored in code or environment variables.

7. **Lambda Timeout Considerations**: Processor needs 15-minute timeout for large downloads; SQS visibility timeout must match.

8. **Proxy for IP Blocking**: YouTube blocks AWS IPs; residential proxy solves this.
