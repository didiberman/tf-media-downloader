import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, createReadStream } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { VISUAL_ANALYSIS_PROMPT, getSynthesisPrompt } from './prompts.mjs';

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
async function transcribeAudio(audioPath, videoName, onProgress) {
    const s3Key = `temp/transcribe/${videoName}_${Date.now()}.wav`;

    // Upload audio to S3
    const fileStream = createReadStream(audioPath);
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

    if (onProgress) await onProgress('✅ Audio Uploaded via S3');

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
            await s3.send(new DeleteObjectCommand({
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

    console.log(`Analyzing ${frames.length} frames with Gemini...`);

    const content = [{
        type: "text",
        text: VISUAL_ANALYSIS_PROMPT
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

    // Get raw response text first for debugging
    const responseText = await response.text();
    console.log(`Gemini API response status: ${response.status}`);
    console.log(`Gemini API response (first 500 chars): ${responseText.substring(0, 500)}`);

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} - ${responseText}`);
    }

    // Parse JSON with error handling
    let result;
    try {
        result = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error(`Failed to parse Gemini response: ${parseError.message}. Response was: ${responseText.substring(0, 200)}`);
    }

    if (!result.choices || !result.choices[0] || !result.choices[0].message) {
        throw new Error(`Unexpected Gemini response structure: ${JSON.stringify(result).substring(0, 200)}`);
    }

    return result.choices[0].message.content;
}

/**
 * Synthesize analysis with Claude Sonnet 4.5
 */
async function synthesizeAnalysis(visualAnalysis, transcript, duration, title) {
    const prompt = getSynthesisPrompt(visualAnalysis, transcript, duration, title);

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

    // Get raw response text first for debugging
    const responseText = await response.text();
    console.log(`Claude API response status: ${response.status}`);
    console.log(`Claude API response (first 500 chars): ${responseText.substring(0, 500)}`);

    if (!response.ok) {
        throw new Error(`Claude API error: ${response.status} - ${responseText}`);
    }

    // Parse JSON with error handling
    let result;
    try {
        result = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error(`Failed to parse Claude response: ${parseError.message}. Response was: ${responseText.substring(0, 200)}`);
    }

    if (!result.choices || !result.choices[0] || !result.choices[0].message) {
        throw new Error(`Unexpected Claude response structure: ${JSON.stringify(result).substring(0, 200)}`);
    }

    return result.choices[0].message.content;
}

/**
 * Main analysis pipeline
 */
export async function analyzeVideo(videoPath, title, onProgress) {
    const duration = await getVideoDuration(videoPath);
    console.log(`Video duration: ${duration.toFixed(1)}s`);
    if (onProgress) await onProgress('✅ Duration Analyzed');

    const framesDir = `/tmp/frames_${Date.now()}`;
    const audioPath = `/tmp/audio_${Date.now()}.wav`;

    // Define parallel tasks
    const visualTask = async () => {
        console.log('Starting visual task...');
        const frames = await extractFrames(videoPath, framesDir, duration);
        console.log(`Extracted ${frames.length} frames`);
        if (onProgress) await onProgress('✅ Frames Extracted');

        if (onProgress) await onProgress('🔄 Analyzing Visuals (Gemini)...');
        const analysis = await analyzeVisuals(frames);
        console.log('Visual analysis complete');
        return analysis;
    };

    const audioTask = async () => {
        console.log('Starting audio task...');
        let transcript = '[No audio detected]';

        const hasAudio = await extractAudio(videoPath, audioPath);
        if (hasAudio) {
            try {
                if (onProgress) await onProgress('🔄 Transcribing Audio...');
                transcript = await transcribeAudio(audioPath, title.replace(/[^a-zA-Z0-9]/g, '_'), onProgress);
                console.log(`Transcript: ${transcript.substring(0, 100)}...`);
                // Note: transcribeAudio calls onProgress('✅ Audio Transcribed') internally
            } catch (error) {
                console.error('Transcription failed:', error);
            }
            if (existsSync(audioPath)) unlinkSync(audioPath);
        } else {
            if (onProgress) await onProgress('⚠️ No Audio Detected');
        }
        return transcript;
    };

    // Execute in parallel
    const [visualAnalysis, transcript] = await Promise.all([visualTask(), audioTask()]);

    // Synthesize
    if (onProgress) await onProgress('⬜ Synthesizing Strategy (Claude)...');
    const finalAnalysis = await synthesizeAnalysis(visualAnalysis, transcript, duration, title);
    console.log('Synthesis complete');

    // Cleanup
    if (existsSync(framesDir)) {
        rmSync(framesDir, { recursive: true, force: true });
    }

    return finalAnalysis;
}
