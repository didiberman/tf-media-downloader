import { spawn } from 'child_process';
import { createReadStream, unlinkSync, writeFileSync, existsSync, readdirSync, openAsBlob, mkdirSync, rmSync, renameSync } from 'fs';
import { stat } from 'fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient, UpdateItemCommand, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
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
const DYNAMODB_ACTIVE_DOWNLOADS_TABLE = process.env.DYNAMODB_ACTIVE_DOWNLOADS_TABLE;

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

async function editTelegramMessage(chatId, messageId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
        return response.json();
    } catch (error) {
        console.error('Failed to edit Telegram message:', error.message);
        return null;
    }
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
    args.push('-o', outputPath, '--no-playlist', '--restrict-filenames');

    // Socket timeout to catch proxy hangs
    args.push('--socket-timeout', '10');

    // Add URL
    args.push(url);

    return args;
}

async function updateActiveDownload(downloadId, percent, speed) {
    if (!DYNAMODB_ACTIVE_DOWNLOADS_TABLE || !downloadId) return;

    try {
        await ddb.send(new UpdateItemCommand({
            TableName: DYNAMODB_ACTIVE_DOWNLOADS_TABLE,
            Key: { download_id: { S: downloadId } },
            UpdateExpression: 'SET #status = :status, percent = :percent, speed = :speed',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': { S: 'downloading' },
                ':percent': { S: percent },
                ':speed': { S: speed || 'N/A' }
            }
        }));
    } catch (error) {
        console.error('Failed to update active download:', error.message);
    }
}

async function deleteActiveDownload(downloadId) {
    if (!DYNAMODB_ACTIVE_DOWNLOADS_TABLE || !downloadId) return;

    try {
        await ddb.send(new DeleteItemCommand({
            TableName: DYNAMODB_ACTIVE_DOWNLOADS_TABLE,
            Key: { download_id: { S: downloadId } }
        }));
        console.log(`Deleted active download: ${downloadId}`);
    } catch (error) {
        console.error('Failed to delete active download:', error.message);
    }
}

async function downloadMedia(sourceType, url, cookiesPath, downloadId, chatId, progressMessageId) {
    const uuid = randomUUID();
    const tempDir = `/tmp/${uuid}`;
    mkdirSync(tempDir);

    // Template: "Title [ID].ext" 
    const outputTemplate = `${tempDir}/%(title)s [%(id)s].%(ext)s`;

    const args = buildYtdlpArgs(sourceType, url, outputTemplate, cookiesPath);

    // Add progress template for JSON output (both download and postprocess phases)
    args.push('--progress-template', 'download:{"percent":"%(progress._percent_str)s","speed":"%(progress._speed_str)s","phase":"download"}');
    args.push('--progress-template', 'postprocess:{"phase":"postprocess"}');
    args.push('--newline'); // Ensure each progress update is on a new line

    console.log('Running yt-dlp with args:', args);

    // Immediately update status to show download is starting
    if (chatId && progressMessageId) {
        await editTelegramMessage(chatId, progressMessageId, `📥 Starting download...\n\n<i>Please wait...</i>`);
    }
    await updateActiveDownload(downloadId, 'starting', '');

    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args, {
            env: {
                ...process.env,
                PATH: '/opt/bin:/usr/bin:/bin',
                HOME: '/tmp',
            },
        });

        let lastUpdateTime = Date.now(); // Start with current time to allow first update quickly
        const UPDATE_INTERVAL = 5000; // 5 seconds
        let stderr = '';

        proc.stdout.on('data', async (data) => {
            const output = data.toString();
            console.log('yt-dlp stdout:', output);

            // Parse progress - check both JSON template and standard format
            const lines = output.split('\n');
            for (const line of lines) {
                let percent = null;
                let speed = null;

                // Try JSON template format: download:{"percent":"45.2%","speed":"2.5MiB/s","phase":"download"}
                if (line.startsWith('download:') || line.startsWith('postprocess:')) {
                    try {
                        const jsonStart = line.indexOf('{');
                        const json = JSON.parse(line.substring(jsonStart));

                        if (json.phase === 'postprocess') {
                            // Show converting message for postprocess phase
                            const now = Date.now();
                            if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                                lastUpdateTime = now;
                                await updateActiveDownload(downloadId, 'converting', '');
                                if (chatId && progressMessageId) {
                                    await editTelegramMessage(chatId, progressMessageId, `🎵 Converting to MP3...\n\n<i>Almost done...</i>`);
                                }
                            }
                        } else {
                            percent = json.percent;
                            speed = json.speed;
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }

                // Fallback: standard yt-dlp format: [download]  45.2% of 10.5MiB at 2.5MiB/s
                if (!percent) {
                    const match = line.match(/\[download\]\s+(\d+\.?\d*%)\s+of.*?(?:at\s+([^\s]+))?/i);
                    if (match) {
                        percent = match[1];
                        speed = match[2] || '';
                    }
                }

                if (percent) {
                    const now = Date.now();
                    // Throttle DynamoDB updates to every 5 seconds
                    if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                        lastUpdateTime = now;
                        await updateActiveDownload(downloadId, percent, speed);

                        // Also update the Telegram message with progress
                        if (chatId && progressMessageId) {
                            const progressText = `📥 Downloading... <b>${percent}</b>` +
                                (speed ? ` (${speed})` : '') +
                                `\n\n<i>Please wait...</i>`;
                            await editTelegramMessage(chatId, progressMessageId, progressText);
                        }
                    }
                }
            }
        });

        proc.stderr.on('data', async (data) => {
            const output = data.toString();
            stderr += output;
            console.log('yt-dlp stderr:', output);

            // Also check stderr for progress (some yt-dlp versions output progress here)
            const lines = output.split('\n');
            for (const line of lines) {
                let percent = null;
                let speed = null;

                // Try JSON template format
                if (line.startsWith('download:') || line.startsWith('postprocess:')) {
                    try {
                        const jsonStart = line.indexOf('{');
                        const json = JSON.parse(line.substring(jsonStart));

                        if (json.phase === 'postprocess') {
                            const now = Date.now();
                            if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                                lastUpdateTime = now;
                                await updateActiveDownload(downloadId, 'converting', '');
                                if (chatId && progressMessageId) {
                                    await editTelegramMessage(chatId, progressMessageId, `🎵 Converting to MP3...\n\n<i>Almost done...</i>`);
                                }
                            }
                        } else {
                            percent = json.percent;
                            speed = json.speed;
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }

                // Fallback: standard yt-dlp format
                if (!percent) {
                    const match = line.match(/\[download\]\s+(\d+\.?\d*%)\s+of.*?(?:at\s+([^\s]+))?/i);
                    if (match) {
                        percent = match[1];
                        speed = match[2] || '';
                    }
                }

                if (percent) {
                    const now = Date.now();
                    if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                        lastUpdateTime = now;
                        await updateActiveDownload(downloadId, percent, speed);

                        // Also update the Telegram message with progress
                        if (chatId && progressMessageId) {
                            const progressText = `📥 Downloading... <b>${percent}</b>` +
                                (speed ? ` (${speed})` : '') +
                                `\n\n<i>Please wait...</i>`;
                            await editTelegramMessage(chatId, progressMessageId, progressText);
                        }
                    }
                }
            }
        });

        // Set timeout
        const timeout = setTimeout(() => {
            proc.kill();
            rmSync(tempDir, { recursive: true, force: true });
            reject(new Error('Download timed out after 14 minutes'));
        }, 840000);

        proc.on('close', (code) => {
            clearTimeout(timeout);

            if (code !== 0) {
                if (stderr.includes('Requested format is not available')) {
                    console.log('Format not available...');
                }
                rmSync(tempDir, { recursive: true, force: true });
                reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
                return;
            }

            // Find the downloaded file in the temp dir
            try {
                const files = readdirSync(tempDir);
                const downloadedFile = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));

                if (!downloadedFile) {
                    rmSync(tempDir, { recursive: true, force: true });
                    reject(new Error('Downloaded file not found in temp dir'));
                    return;
                }

                const fullPath = `${tempDir}/${downloadedFile}`;
                console.log('Downloaded file:', fullPath);
                resolve(fullPath);
            } catch (error) {
                rmSync(tempDir, { recursive: true, force: true });
                reject(error);
            }
        });

        proc.on('error', (error) => {
            clearTimeout(timeout);
            rmSync(tempDir, { recursive: true, force: true });
            reject(error);
        });
    });
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
        const { chatId, url, sourceType, username, downloadId, progressMessageId } = JSON.parse(record.body);
        let filePath = null;

        try {
            // Get cookies if available
            const cookiesPath = await getCookiesForSource(sourceType);

            // Download with yt-dlp (pass downloadId, chatId, progressMessageId for progress tracking)
            filePath = await downloadMedia(sourceType, url, cookiesPath, downloadId, chatId, progressMessageId);
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

            // Clean up active download record on success
            await deleteActiveDownload(downloadId);
        } catch (error) {
            console.error('Processing error:', error);

            // Clean up active download record on failure
            await deleteActiveDownload(downloadId);

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
