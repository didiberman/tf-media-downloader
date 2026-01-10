import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

const s3 = new S3Client({});
const transcribe = new TranscribeClient({});

const FFMPEG_PATH = '/opt/bin/ffmpeg';
const FFPROBE_PATH = '/opt/bin/ffprobe';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * Get video duration using ffprobe
 */
async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFPROBE_PATH, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ]);

        let stdout = '';
        proc.stdout.on('data', (data) => stdout += data.toString());
        proc.on('close', (code) => {
            if (code === 0) {
                resolve(parseFloat(stdout.trim()));
            } else {
                reject(new Error(`ffprobe failed with code ${code}`));
            }
        });
    });
}

/**
 * Extract frames from video at specified frame rate
 */
async function extractFrames(videoPath, outputDir, duration) {
    mkdirSync(outputDir, { recursive: true });

    const hookDuration = Math.min(3, duration);
    const hookFps = 2;
    const bodyFps = 1;

    console.log(`Extracting hook frames (0-${hookDuration}s @ ${hookFps}fps)...`);

    // Extract hook frames
    await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, [
            '-i', videoPath,
            '-vf', `fps=${hookFps},scale=1280:-1`,
            '-t', String(hookDuration),
            '-q:v', '2',
            `${outputDir}/hook_%03d.jpg`
        ]);

        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg hook extraction failed: ${code}`)));
    });

    // Extract body frames if video > 3s
    if (duration > 3) {
        console.log(`Extracting body frames (${hookDuration}s-${duration}s @ ${bodyFps}fps)...`);
        await new Promise((resolve, reject) => {
            const proc = spawn(FFMPEG_PATH, [
                '-i', videoPath,
                '-vf', `fps=${bodyFps},scale=1280:-1`,
                '-ss', String(hookDuration),
                '-q:v', '2',
                `${outputDir}/body_%03d.jpg`
            ]);

            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg body extraction failed: ${code}`)));
        });
    }

    const frames = readdirSync(outputDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map(f => `${outputDir}/${f}`);

    // Limit to 35 frames
    if (frames.length > 35) {
        const step = Math.floor(frames.length / 35);
        return frames.filter((_, i) => i % step === 0).slice(0, 35);
    }

    return frames;
}

/**
 * Extract audio from video
 */
async function extractAudio(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, [
            '-i', videoPath,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-y',
            outputPath
        ]);

        proc.on('close', (code) => {
            if (code === 0 && existsSync(outputPath)) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

/**
 * Transcribe audio using AWS Transcribe
 */
async function transcribeAudio(audioPath, videoName) {
    const s3Key = `temp/transcribe/${videoName}_${Date.now()}.wav`;

    // Upload audio to S3
    const fileStream = require('fs').createReadStream(audioPath);
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3Key,
        Body: fileStream
    }));

    const s3Uri = `s3://${S3_BUCKET_NAME}/${s3Key}`;
    const jobName = `analysis-${videoName}-${Date.now()}`;

    console.log(`Starting transcription job: ${jobName}`);

    // Start transcription
    await transcribe.send(new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        Media: { MediaFileUri: s3Uri },
        MediaFormat: 'wav',
        LanguageCode: 'en-US'
    }));

    // Poll for completion
    while (true) {
        const status = await transcribe.send(new GetTranscriptionJobCommand({
            TranscriptionJobName: jobName
        }));

        const jobStatus = status.TranscriptionJob.TranscriptionJobStatus;

        if (jobStatus === 'COMPLETED') {
            const transcriptUri = status.TranscriptionJob.Transcript.TranscriptFileUri;
            const response = await fetch(transcriptUri);
            const data = await response.json();
            const transcript = data.results.transcripts[0].transcript;

            // Cleanup S3
            await s3.send(new require('@aws-sdk/client-s3').DeleteObjectCommand({
                Bucket: S3_BUCKET_NAME,
                Key: s3Key
            }));

            return transcript;
        } else if (jobStatus === 'FAILED') {
            throw new Error('Transcription failed');
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

/**
 * Analyze video frames with Gemini 2.5 Flash Image
 */
async function analyzeVisuals(frames) {
    const { readFileSync } = require('fs');

    console.log(`Analyzing ${frames.length} frames with Gemini...`);

    const content = [{
        type: "text",
        text: `You are a world-class viral video strategist analyzing a short-form video.

Focus ONLY on VISUAL elements (audio analyzed separately):

1. **The Hook (0-3s)**: What visual elements stop the scroll?
2. **Visual Pacing & Editing**: Cut frequency, transitions, scene variety
3. **Camera Work & Production**: Angles, lighting, composition
4. **Visual Hooks Throughout**: Text overlays, graphics, effects
5. **Retention Mechanics**: Visual payoff structure, curiosity gaps

Be specific, actionable, and sophisticated.`
    }];

    // Add frames as base64
    for (const framePath of frames) {
        const base64 = readFileSync(framePath, { encoding: 'base64' });
        content.push({
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${base64}`
            }
        });
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'google/gemini-2.5-flash-image',
            messages: [{ role: 'user', content }]
        })
    });

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const result = await response.json();
    return result.choices[0].message.content;
}

/**
 * Synthesize analysis with Claude Sonnet 4.5
 */
async function synthesizeAnalysis(visualAnalysis, transcript, duration, title) {
    const prompt = `You are a world-class viral video strategist. You have TWO separate analyses of a ${Math.round(duration)}-second short-form video titled "${title}":

━━━━━━━━━━━━━━━━━━━━━━
📹 VISUAL ANALYSIS (Gemini 2.5 Flash Image):
━━━━━━━━━━━━━━━━━━━━━━
${visualAnalysis}

━━━━━━━━━━━━━━━━━━━━━━
🎙️ AUDIO TRANSCRIPT (AWS Transcribe):
━━━━━━━━━━━━━━━━━━━━━━
${transcript}

━━━━━━━━━━━━━━━━━━━━━━

Your task: Create a TELEGRAM-OPTIMIZED analysis (max 4000 chars) with this structure:

📊 **VIDEO OVERVIEW**
2-3 sentences about what this video is about.

🎯 **THE HOOK (0-3s)**
How audio + visuals work together to stop scrolling.

⚡ **SUCCESS FACTORS** (Top 3)
1. Factor name - why it works
2. Factor name - why it works
3. Factor name - why it works

🔥 **VIRALITY MECHANICS**
• Emotional arc
• Retention loop
• Shareability factor

💡 **CONTENT REMIX IDEAS**
1. [Niche]: Specific angle
2. [Niche]: Specific angle
3. [Niche]: Specific angle

IMPORTANT:
- Use emojis for scanability
- Keep sections concise (Telegram has char limits)
- Use bullet points, not long paragraphs
- Bold key terms with *asterisks* for Telegram MarkdownV2`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'anthropic/claude-sonnet-4.5',
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        throw new Error(`Claude API error: ${response.status}`);
    }

    const result = await response.json();
    return result.choices[0].message.content;
}

/**
 * Main analysis pipeline
 */
export async function analyzeVideo(videoPath, title) {
    const duration = await getVideoDuration(videoPath);
    console.log(`Video duration: ${duration.toFixed(1)}s`);

    // Extract frames
    const framesDir = `/tmp/frames_${Date.now()}`;
    const frames = await extractFrames(videoPath, framesDir, duration);
    console.log(`Extracted ${frames.length} frames`);

    // Extract and transcribe audio
    const audioPath = `/tmp/audio_${Date.now()}.wav`;
    let transcript = '[No audio detected]';

    const hasAudio = await extractAudio(videoPath, audioPath);
    if (hasAudio) {
        try {
            transcript = await transcribeAudio(audioPath, title.replace(/[^a-zA-Z0-9]/g, '_'));
            console.log(`Transcript: ${transcript.substring(0, 100)}...`);
        } catch (error) {
            console.error('Transcription failed:', error);
        }
        if (existsSync(audioPath)) unlinkSync(audioPath);
    }

    // Analyze visuals
    const visualAnalysis = await analyzeVisuals(frames);
    console.log('Visual analysis complete');

    // Synthesize
    const finalAnalysis = await synthesizeAnalysis(visualAnalysis, transcript, duration, title);
    console.log('Synthesis complete');

    // Cleanup
    if (existsSync(framesDir)) {
        require('fs').rmSync(framesDir, { recursive: true, force: true });
    }

    return finalAnalysis;
}
