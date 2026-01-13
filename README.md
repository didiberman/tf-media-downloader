# Deep Video Strategist & Media Downloader 🤖

An advanced, serverless AI agent that analyzes short-form video content (Instagram Reels, YouTube Shorts) to reverse-engineer viral strategies. It combines media processing with multi-modal AI analysis (Visual + Audio) to generate actionable content insights.

## 🌟 Key Features

### 📥 Universal Media Downloader
- **Multi-Platform Support**: Downloads high-quality video/audio from:
    - Instagram (Reels, Stories, Posts)
    - YouTube (Shorts, Long-form Videos)
- **Smart Handling**:
    - Automatically handles platform-specific constraints.
    - Uses cookies/proxy rotation for reliability.
    - Deduplicates downloads to save storage and bandwidth.
- **Direct S3 Integration**: Files are stored securely in AWS S3 with auto-expiry.

### 🧠 Deep Video Intelligence (AI Analysis)
When a video is downloaded, the bot performs a "Deep Survey" using a multi-step AI pipeline:
1.  **Visual Analysis**: Extracts frames and uses **Google Gemini 2.5 Flash** to analyze visual narrative, hooks, and retention mechanics.
2.  **Audio Transcription**: Transcribes speech using **AWS Transcribe**.
3.  **Strategy Synthesis**: Uses **Claude 3.5 Sonnet** to combine visual and audio insights into a viral strategy report.
4.  **Telegram Delivery**: Delivers a beautifully formatted, HTML-rich report directly to your chat.

### 🛡️ Secure & Scalable Architecture
- **Serverless**: Built entirely on AWS Serverless technologies (Lambda, DynamoDB, SQS).
- **Access Control**: Whitelist-based access system managed via Telegram admin commands.
- **Cost Efficient**: Expenses scale to zero when not in use.

---

## 🏗️ Architecture

The project is deployed using Infrastructure as Code (IaC) and is available in two flavors: **Terraform** (default) and **AWS CloudFormation/SAM**.

### Diagram
`Telegram -> API Gateway/Lambda URL -> Webhook Lambda -> SQS -> Processor Lambda -> S3 / DynamoDB`

### Core Components
- **Webhook Lambda (Node.js)**: Handles Telegram updates, authentication, administrative commands, and queues jobs.
- **Processor Lambda (Node.js)**: Heavy lifter. Handles downloading (yt-dlp), FFmpeg processing, and AI orchestration.
- **DynamoDB**: Stores user sessions, file metadata, and active download states.
- **SQS**: Decouples the webhook from processing to ensure responsiveness and reliability.

---

## 🛠️ Technology Stack

- **Runtime**: Node.js 22.x
- **Infrastructure as Code**: Terraform & AWS CloudFormation
- **Cloud Provider**: AWS (Lambda, S3, DynamoDB, SQS, Secrets Manager, Transcribe)
- **AI Models**:
    - **Vision**: Google Gemini 2.5 Flash (via OpenRouter)
    - **Reasoning**: Anthropic Claude 3.5 Sonnet (via OpenRouter)
- **Tools**: yt-dlp, FFmpeg, ScrapeCreators API

---

## 🚀 Deployment

You can deploy this project using either **Terraform** or **AWS CloudFormation**.

### Option A: Terraform (Recommended)
Located in the `terraform/` directory.

1.  **Initialize**:
    ```bash
    cd terraform
    terraform init
    ```
2.  **Configure**:
    Create a `terraform.tfvars` file with your API keys and tokens.
3.  **Deploy**:
    ```bash
    terraform apply
    ```
    *Note: This automatically sets up the Telegram Webhook for you.*

### Option B: CloudFormation / AWS SAM
Located in the `cloudformation/` directory. Ideal for those preferring native AWS tooling.

1.  **Build**:
    ```bash
    cd cloudformation
    sam build --use-container
    ```
2.  **Deploy**:
    ```bash
    sam deploy --guided
    ```
3.  **Webhook**:
    Manually register your webhook URL (outputted by SAM) with Telegram.

---

## 📂 Project Structure

```
├── src/
│   ├── webhook/        # Telegram interaction & auth logic
│   └── processor/      # Download engine & AI analysis pipeline
├── terraform/          # Terraform Infrastructure definition
├── cloudformation/     # AWS SAM / CloudFormation template
├── layers/             # Lambda layers (yt-dlp, ffmpeg)
└── ...
```

---

## 🤖 Bot Commands

### User Commands
- `[Share Link]`: Auto-detects and processes Instagram/YouTube links.
- `/start`: Welcome message and instructions.

### Admin Commands
- `/users`: List authorized users.
- `/add @user`: Whitelist a new user.
- `/stats`: View usage statistics (MBs downloaded, requests).
- `/list`: Browse downloaded files.

---

*Verified & Architected for Scalability and Performance.*
