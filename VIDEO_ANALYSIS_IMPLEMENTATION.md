# Video Analysis Feature Implementation

## ✅ What We've Built

A complete AI-powered video analysis system that triggers via a Telegram inline button after video downloads complete.

---

## 🎯 User Flow

1. **User sends video URL** → Bot downloads video
2. **Download completes** → Bot shows "🧠 Analyze Video" button
3. **User clicks button** → Bot starts analysis (~2-3 min)
4. **Analysis complete** → Bot sends formatted insights

---

## 🏗️ Architecture

```
User clicks button
      ↓
Webhook Lambda (handles callback_query)
      ↓
SQS Queue (action: 'analyze')
      ↓
Processor Lambda
      ↓
┌─────────────────────────────┐
│  Video Analysis Pipeline    │
├─────────────────────────────┤
│ 1. Download from S3         │
│ 2. Extract frames (FFmpeg)  │
│ 3. Extract audio (FFmpeg)   │
│ 4. Transcribe (AWS Transcribe│
│ 5. Analyze visuals (Gemini) │
│ 6. Synthesize (Claude 4.5)  │
└─────────────────────────────┘
      ↓
Telegram (formatted analysis)
```

---

## 📁 Files Modified/Created

### **Created:**
1. `src/processor/videoAnalysis.mjs` - Complete analysis pipeline
   - Frame extraction
   - Audio transcription
   - Visual analysis (Gemini 2.5 Flash Image)
   - Synthesis (Claude Sonnet 4.5)

### **Modified:**
1. `src/webhook/index.mjs`
   - Added `answerCallbackQuery()` function
   - Added callback query handler for button clicks
   - Queues analysis jobs to SQS

2. `src/processor/index.mjs`
   - Added `handleAnalysisRequest()` function
   - Added `sendAnalysisToTelegram()` function
   - Added `splitMessage()` for Telegram char limit handling
   - Updated message handlers to support inline buttons
   - Added analysis action routing

3. `analyze_video_complete.py` (updated test script)
   - Added VIDEO OVERVIEW section to prompt
   - Uses Claude Sonnet 4.5 for synthesis

---

## 🔧 What Still Needs to be Done

### 1. **Environment Variables** (Terraform)

Add to `terraform/main.tf` processor Lambda environment:

```hcl
environment {
  variables = {
    # ... existing vars ...
    OPENROUTER_API_KEY = var.openrouter_api_key
  }
}
```

Add to `terraform/variables.tf`:

```hcl
variable "openrouter_api_key" {
  description = "OpenRouter API key for Gemini/Claude"
  type        = string
  sensitive   = true
}
```

Add to `terraform/terraform.tfvars`:

```hcl
openrouter_api_key = "sk-or-v1-YOUR-KEY-HERE"
```

### 2. **IAM Permissions** (Terraform)

Add AWS Transcribe permissions to processor Lambda role:

```hcl
# In terraform/main.tf, add to processor Lambda policy:

{
  "Effect": "Allow",
  "Action": [
    "transcribe:StartTranscriptionJob",
    "transcribe:GetTranscriptionJob"
  ],
  "Resource": "*"
}
```

### 3. **Lambda Configuration** (Terraform)

Update processor Lambda:

```hcl
# Increase timeout for analysis (current: 900s is OK)
timeout = 900

# Increase memory for FFmpeg operations
memory_size = 1536  # Up from 1024

# Increase ephemeral storage for frames/audio
ephemeral_storage {
  size = 1024  # 1GB (up from default 512MB)
}
```

### 4. **Package Dependencies**

The `videoAnalysis.mjs` module needs to be packaged with the processor Lambda. It's already in the same directory (`src/processor/`), so it will be included automatically when deploying.

### 5. **Test Deployment**

```bash
cd terraform
terraform apply
```

---

## 💰 Cost Estimate Per Analysis

| Component | Cost |
|-----------|------|
| AWS Transcribe (1 min) | $0.024 |
| Gemini 2.5 Flash Image | $0.022 |
| Claude Sonnet 4.5 | $0.045 |
| Lambda + S3 | $0.004 |
| **TOTAL** | **~$0.095** |

---

## 📱 Telegram Formatting

The analysis output is optimized for Telegram:

- ✅ HTML formatting with `<b>` tags
- ✅ Emojis for scannability
- ✅ Bullet points instead of paragraphs
- ✅ Auto-splits messages > 4096 characters
- ✅ Structured sections (Overview, Hook, Success Factors, Remix Ideas)

### Example Output:

```
🎬 Video Analysis: How to go viral

📊 VIDEO OVERVIEW
This 45-second tutorial teaches the "master prompt"
technique for better AI interactions...

🎯 THE HOOK (0-3s)
Visual: Split-screen + bold text "ULTIMATE AI CHEAT CODE"
Audio: "If you want to get better at using AI..."
Synergy: Authority + accessibility in 3 seconds

⚡ SUCCESS FACTORS (Top 3)
1. Meta-Value Proposition - Appeals to all AI users
2. Visual Metaphor - Robot hands illustrate concept
3. Clear CTA - "Comment AI" feels achievable

🔥 VIRALITY MECHANICS
• Emotional arc: Frustration → Empowerment
• Universal problem with immediate solution
• High practical value + entertainment

💡 CONTENT REMIX IDEAS
1. [Fitness]: "Ultimate Workout Generator Hack"
2. [Recipe Dev]: "How Pro Chefs Use AI for Recipes"
3. [Content]: "Secret Framework for Viral Headlines"
```

---

## 🧪 Testing Locally

You can test the analysis pipeline locally with:

```bash
python3 analyze_video_complete.py lastone.mp4
```

This runs the same analysis pipeline that will run in Lambda.

---

## 🚀 Deployment Checklist

- [ ] Add `OPENROUTER_API_KEY` to terraform.tfvars
- [ ] Add Transcribe permissions to processor IAM role
- [ ] Increase Lambda memory to 1536 MB
- [ ] Increase ephemeral storage to 1024 MB
- [ ] Run `terraform apply`
- [ ] Test with a short video in Telegram
- [ ] Verify button appears after download
- [ ] Verify analysis completes successfully

---

## 🐛 Potential Issues & Solutions

### Issue: "Module not found: videoAnalysis.mjs"
**Solution:** Ensure the file is in `src/processor/` and is included in the Lambda deployment package.

### Issue: "FFmpeg/FFprobe not found"
**Solution:** Verify the Lambda Layer contains these binaries at `/opt/bin/`

### Issue: "Transcription job failed"
**Solution:** Check IAM permissions and S3 bucket access

### Issue: "Analysis takes too long / times out"
**Solution:** Increase Lambda timeout or reduce frame count in `videoAnalysis.mjs` (line 89)

### Issue: "Telegram message too long"
**Solution:** The `splitMessage()` function handles this automatically, but you can reduce the prompt instructions to get shorter output from Claude

---

## 📊 Monitoring

Key CloudWatch metrics to watch:

- **Lambda Duration** (Processor): Should be 120-180s for analysis
- **Lambda Errors**: Catch transcription/API failures
- **SQS Queue Depth**: Monitor backlog
- **Cost**: Track Transcribe/OpenRouter usage

---

## 🔮 Future Enhancements

1. **Cache analysis results** in DynamoDB (avoid re-analyzing same video)
2. **Add user preferences** (`/settings` command) for auto-analysis
3. **Support longer videos** by sampling frames more intelligently
4. **Add emoji reactions** as alternative trigger (🧠 emoji = analyze)
5. **Export analysis to PDF** for download
6. **Compare multiple videos** side-by-side

---

## 📝 Notes

- Analysis works best on videos **< 90 seconds**
- Transcript quality depends on audio clarity
- Frame extraction prioritizes the hook (first 3s @ 2fps)
- Claude Sonnet 4.5 is used for synthesis (latest model)
- Gemini 2.5 Flash Image handles up to 35 frames efficiently
