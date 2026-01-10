import { spawnSync } from 'child_process';
import { createReadStream, unlinkSync, writeFileSync, existsSync, readdirSync, openAsBlob, mkdirSync, rmSync, renameSync } from 'fs';
import { stat } from 'fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient, UpdateItemCommand, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const ddb = new DynamoDBClient({});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const INSTAGRAM_COOKIES_SECRET = process.env.INSTAGRAM_COOKIES_SECRET;
const YOUTUBE_COOKIES_SECRET = process.env.YOUTUBE_COOKIES_SECRET;
const YOUTUBE_PROXY = process.env.YOUTUBE_PROXY;
const DYNAMODB_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const DYNAMODB_FILES_TABLE = process.env.DYNAMODB_FILES_TABLE;

// Paths to binaries in Lambda Layer
const YTDLP_PATH = '/opt/bin/yt-dlp';
const FFMPEG_PATH = '/opt/bin/ffmpeg';

async function getSecretValue(secretArn) {
    try {
        const response = await secrets.send(
            new GetSecretValueCommand({ SecretId: secretArn })
        );
        return response.SecretString;
    } catch (error) {
        console.log(`Failed to get secret:`, error.message);
        return null;
    }
}

async function getCookies(secretArn, filename) {
    const cookies = await getSecretValue(secretArn);
    if (cookies) {
        const cookiesPath = `/tmp/${filename}`;
        writeFileSync(cookiesPath, cookies);
        return cookiesPath;
    }
    return null;
}

async function getCookiesForSource(sourceType) {
    if (sourceType.startsWith('youtube')) {
        return getCookies(YOUTUBE_COOKIES_SECRET, 'youtube_cookies.txt');
    } else if (sourceType.startsWith('instagram')) {
        return getCookies(INSTAGRAM_COOKIES_SECRET, 'instagram_cookies.txt');
    }
    return null;
}

async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    return response.json();
}

async function uploadToTelegram(chatId, filePath, caption) {
    const stats = await stat(filePath);
    const fileSizeInBytes = stats.size;
    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

    if (fileSizeInMB > 50) {
        console.log(`File too large for Telegram upload (${fileSizeInMB.toFixed(2)} MB). Skipping.`);
        return false;
    }

    const fileBlob = await openAsBlob(filePath);
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');

    // Determine if audio or video
    const isAudio = filePath.endsWith('.mp3');
    const method = isAudio ? 'sendAudio' : 'sendVideo';
    const fieldName = isAudio ? 'audio' : 'video';

    formData.append(fieldName, fileBlob, filePath.split('/').pop());

    console.log(`Uploading ${fieldName} to Telegram (${fileSizeInMB.toFixed(2)} MB)...`);

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const response = await fetch(url, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Telegram upload failed: ${response.status} - ${errorText}`);
        return false;
    }

    const result = await response.json();
    return result.ok;
}

function buildYtdlpArgs(sourceType, url, outputPath, cookiesPath) {
    const args = [];

    // Add proxy if configured
    if (sourceType.startsWith('youtube') && YOUTUBE_PROXY) {
        args.push('--proxy', YOUTUBE_PROXY);
    }

    // Add ffmpeg location
    args.push('--ffmpeg-location', FFMPEG_PATH);

    // Add cookies if available
    if (cookiesPath) {
        args.push('--cookies', cookiesPath);
    }

    // Source-specific options
    if (sourceType === 'youtube-long') {
        // Extract audio only for long YouTube videos
        args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
        // Download best video+audio and merge to mp4
        args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    }

    // Output template with Title and ID for valid filesystem name
    args.push('-o', outputPath, '--no-playlist', '--no-warnings', '--restrict-filenames');

    // Debugging: Verbose output and socket timeout to catch proxy hangs
    args.push('--verbose', '--socket-timeout', '10');

    // Add URL
    args.push(url);

    return args;
}

async function downloadMedia(sourceType, url, cookiesPath) {
    const uuid = randomUUID();
    const tempDir = `/tmp/${uuid}`;
    mkdirSync(tempDir);

    // Template: "Title [ID].ext" 
    // We use a unique dir so we can just grab the valid file created there.
    const outputTemplate = `${tempDir}/%(title)s [%(id)s].%(ext)s`;

    const args = buildYtdlpArgs(sourceType, url, outputTemplate, cookiesPath);
    console.log('Running yt-dlp with args:', args);

    try {
        const result = spawnSync(YTDLP_PATH, args, {
            timeout: 840000, // 14 minutes
            maxBuffer: 50 * 1024 * 1024, // 50MB
            env: {
                ...process.env,
                PATH: '/opt/bin:/usr/bin:/bin',
                HOME: '/tmp',
            },
        });

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            const stderr = result.stderr?.toString() || 'Unknown error';

            if (stderr.includes('Requested format is not available')) {
                console.log('Format not available...');
            }

            throw new Error(`yt-dlp exited with code ${result.status}: ${stderr}`);
        }

        console.log('yt-dlp output:', result.stdout?.toString());

        // Find the downloaded file in the temp dir
        const files = readdirSync(tempDir);
        const downloadedFile = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));

        if (!downloadedFile) {
            throw new Error('Downloaded file not found in temp dir');
        }

        const fullPath = `${tempDir}/${downloadedFile}`;
        console.log('Downloaded file:', fullPath);
        return fullPath;
    } catch (error) {
        console.error('yt-dlp error:', error.message);
        // Clean up temp dir if failed
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
}

async function uploadToS3(filePath, sourceType) {
    const filename = filePath.split('/').pop();
    const extension = filename.split('.').pop();
    const key = `downloads/${sourceType}/${filename}`;

    // Deduplication: Check if file already exists
    try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }));
        console.log(`File already exists in S3 (${key}). Skipping upload.`);
        // Return signed URL for existing file
        return getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }),
            { expiresIn: 7 * 24 * 60 * 60 }
        );
    } catch (error) {
        if (error.name !== 'NotFound') {
            console.error('S3 HeadObject error:', error);
            // Ignore other errors and try to upload
        }
    }

    const fileStream = createReadStream(filePath);

    await s3.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: fileStream,
            ContentType: extension === 'mp3' ? 'audio/mpeg' : 'video/mp4',
        })
    );

    // Generate pre-signed URL valid for 7 days
    const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
        }),
        { expiresIn: 7 * 24 * 60 * 60 }
    );

    return signedUrl;
}

function cleanupFile(filePath) {
    try {
        // filePath is like /tmp/uuid/filename.ext
        // We want to remove the uuid dir
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    } catch (error) {
        console.log('Cleanup error:', error.message);
    }
}

async function updateUsage(username, platform, sizeMB) {
    if (!username || !DYNAMODB_TABLE_NAME) return;

    try {
        await ddb.send(new UpdateItemCommand({
            TableName: DYNAMODB_TABLE_NAME,
            Key: { username: { S: username } },
            UpdateExpression: `
                SET conversations = if_not_exists(conversations, :zero) + :one, 
                    total_mb = if_not_exists(total_mb, :zero) + :size,
                    platform_usage.#p = if_not_exists(platform_usage.#p, :zero) + :size
            `,
            ExpressionAttributeNames: { '#p': platform },
            ExpressionAttributeValues: {
                ':zero': { N: '0' },
                ':one': { N: '1' },
                ':size': { N: sizeMB.toFixed(2) }
            }
        }));
        console.log(`Updated usage for @${username}: +${sizeMB.toFixed(2)} MB (${platform})`);
    } catch (error) {
        console.error(`Failed to update usage for ${username}:`, error);
    }
}

async function trackFile(key, sourceType, title, sizeMB, url, username) {
    if (!DYNAMODB_FILES_TABLE) return;

    try {
        // Calculate TTL: 7 days from now in epoch seconds
        const ttlSeconds = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);

        await ddb.send(new PutItemCommand({
            TableName: DYNAMODB_FILES_TABLE,
            Item: {
                file_key: { S: key },
                source_type: { S: sourceType },
                title: { S: title },
                url: { S: url },
                username: { S: username || 'unknown' },
                size_mb: { N: sizeMB.toFixed(2) },
                created_at: { S: new Date().toISOString() },
                ttl: { N: String(ttlSeconds) }
            },
            ConditionExpression: 'attribute_not_exists(file_key)'
        }));
        console.log(`Tracked file: ${title}`);
    } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') {
            console.error('Failed to track file:', error);
        }
    }
}

export async function handler(event) {
    console.log('Processing event:', JSON.stringify(event, null, 2));

    for (const record of event.Records) {
        const { chatId, url, sourceType, username } = JSON.parse(record.body);
        let filePath = null;

        try {
            // Get cookies if available
            const cookiesPath = await getCookiesForSource(sourceType);

            // Download with yt-dlp
            filePath = await downloadMedia(sourceType, url, cookiesPath);
            const stats = await stat(filePath);
            const fileSizeMB = stats.size / (1024 * 1024);

            // Upload to S3 (checks for duplicates via S3 HeadObject)
            // Note: We deliberately use S3 check for now as it's the source of truth for storage.
            // Future optimization: Check DynamoDB 'files' table first.
            const s3Url = await uploadToS3(filePath, sourceType);

            // Extract filename/title for display and tracking
            const filename = filePath.split('/').pop();
            const s3Key = `downloads/${sourceType}/${filename}`;
            const title = filename.replace(/\.[^/.]+$/, ""); // Simple title extraction from filename

            // Track File in DB
            await trackFile(s3Key, sourceType, title, fileSizeMB, url, username);

            // Update user usage stats
            await updateUsage(username, sourceType, fileSizeMB);

            const outputType = sourceType === 'youtube-long' ? '🎵 MP3' : '🎬 MP4';

            const caption = `✅ <b>Download Complete!</b>\n\n` +
                `<b>${title}</b>\n` +
                `${outputType} ready:\n` +
                `<a href="${s3Url}">📥 Direct S3 Link</a>\n\n` +
                `<i>Link expires in 7 days</i>`;

            // Try to upload directly to Telegram
            const uploadSuccess = await uploadToTelegram(chatId, filePath, caption);

            // If upload failed or was skipped (too large), send the link message
            if (!uploadSuccess) {
                await sendTelegramMessage(chatId, caption);
            }
        } catch (error) {
            console.error('Processing error:', error);

            await sendTelegramMessage(
                chatId,
                `❌ <b>Download Failed</b>\n\n` +
                `Sorry, I couldn't download that media.\n\n` +
                `<i>Error: ${error.message}</i>`
            );
        } finally {
            // Cleanup temp file/dir
            if (filePath) {
                cleanupFile(filePath);
            }
        }
    }

    return { statusCode: 200 };
}
