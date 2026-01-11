import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, ScanCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});

const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DYNAMODB_TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const DYNAMODB_FILES_TABLE = process.env.DYNAMODB_FILES_TABLE;
const DYNAMODB_ACTIVE_DOWNLOADS_TABLE = process.env.DYNAMODB_ACTIVE_DOWNLOADS_TABLE;
const TELEGRAM_ADMIN_USERNAME = process.env.TELEGRAM_ADMIN_USERNAME;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// URL patterns for supported sources
const patterns = {
  instagramStory: /instagram\.com\/stories\/[^\/]+\/\d+/i,
  instagramReel: /instagram\.com\/(reel|reels|p)\/[\w-]+/i,
  youtubeShort: /(youtube\.com\/shorts\/|youtu\.be\/[\w-]{11}$)/i,
  youtubeLong: /(youtube\.com\/watch\?v=|youtu\.be\/[\w-]+)/i,
};

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
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
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
}

async function checkAuth(username) {
  if (!username) return false;

  // Auto-allow admin
  if (username === TELEGRAM_ADMIN_USERNAME) {
    await ensureUserExists(username, true, 'admin');
    return true;
  }

  try {
    const command = new GetItemCommand({
      TableName: DYNAMODB_TABLE_NAME,
      Key: { username: { S: username } },
    });
    const response = await ddb.send(command);
    return response.Item?.is_allowed?.BOOL === true;
  } catch (error) {
    console.error('Auth check error:', error);
    return false;
  }
}

async function ensureUserExists(username, isAllowed = false, role = 'user') {
  try {
    const command = new PutItemCommand({
      TableName: DYNAMODB_TABLE_NAME,
      Item: {
        username: { S: username },
        is_allowed: { BOOL: isAllowed },
        role: { S: role },
        conversations: { N: '0' },
        total_mb: { N: '0' },
        platform_usage: { M: {} },
        created_at: { S: new Date().toISOString() }
      },
      ConditionExpression: 'attribute_not_exists(username)'
    });
    await ddb.send(command);
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') {
      console.error('Ensure user error:', error);
    }
  }
}

async function handleAdminCommands(chatId, text, senderUsername) {
  if (senderUsername !== TELEGRAM_ADMIN_USERNAME) return false;

  const parts = text.split(' ');
  const command = parts[0];
  const targetUser = parts[1]?.replace('@', '');

  if (command === '/add' && targetUser) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: DYNAMODB_TABLE_NAME,
        Key: { username: { S: targetUser } },
        UpdateExpression: 'SET is_allowed = :allowed, #role = :role, created_at = if_not_exists(created_at, :now)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: {
          ':allowed': { BOOL: true },
          ':role': { S: 'user' },
          ':now': { S: new Date().toISOString() }
        }
      }));
      await sendTelegramMessage(chatId, `✅ User @${targetUser} added to allowlist.`);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ Failed to add user: ${error.message}`);
    }
    return true;
  }

  if (command === '/remove' && targetUser) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: DYNAMODB_TABLE_NAME,
        Key: { username: { S: targetUser } },
        UpdateExpression: 'SET is_allowed = :allowed',
        ExpressionAttributeValues: { ':allowed': { BOOL: false } }
      }));
      await sendTelegramMessage(chatId, `🚫 User @${targetUser} removed from allowlist.`);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ Failed to remove user: ${error.message}`);
    }
    return true;
  }

  if (command === '/stats') {
    try {
      const scan = await ddb.send(new ScanCommand({ TableName: DYNAMODB_TABLE_NAME }));
      let statsMsg = '📊 <b>Usage Statistics</b>\n\n';

      for (const item of scan.Items || []) {
        const user = item.username.S;
        const mb = parseFloat(item.total_mb?.N || 0).toFixed(1);
        const reqs = item.conversations?.N || 0;
        const allowed = item.is_allowed?.BOOL ? '✅' : '🚫';

        // Get platform usage breakdown
        const platformUsage = item.platform_usage?.M || {};
        let platformBreakdown = '';

        const ytLong = parseFloat(platformUsage['youtube-long']?.N || 0);
        const ytShort = parseFloat(platformUsage['youtube-short']?.N || 0);
        const igReel = parseFloat(platformUsage['instagram-reel']?.N || 0);
        const igStory = parseFloat(platformUsage['instagram-story']?.N || 0);

        const ytTotal = ytLong + ytShort;
        const igTotal = igReel + igStory;

        if (ytTotal > 0 || igTotal > 0) {
          platformBreakdown = `   🎥 YT: ${ytTotal.toFixed(1)} MB | 📸 IG: ${igTotal.toFixed(1)} MB\n`;
        }

        statsMsg += `${allowed} <b>@${user}</b>\n`;
        statsMsg += `   💾 ${mb} MB | 🔄 ${reqs} reqs\n`;
        statsMsg += platformBreakdown;
        statsMsg += '\n';
      }

      await sendTelegramMessage(chatId, statsMsg);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ Failed to fetch stats: ${error.message}`);
    }
    return true;
  }

  // USERS LIST COMMAND
  if (command === '/users') {
    try {
      const scan = await ddb.send(new ScanCommand({ TableName: DYNAMODB_TABLE_NAME }));
      let msg = '👥 <b>Allowed Users</b>\n\n';
      let count = 0;

      for (const item of scan.Items || []) {
        if (item.is_allowed?.BOOL) {
          msg += `• @${item.username.S}\n`;
          count++;
        }
      }

      if (count === 0) msg += 'No allowed users.';
      else msg += `\nTotal: ${count}`;

      await sendTelegramMessage(chatId, msg);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ Failed to list users: ${error.message}`);
    }
    return true;
  }

  // HELP COMMAND
  if (command === '/help') {
    const helpMsg = '🤖 <b>Admin Commands</b>\n\n' +
      '<b>User Management</b>\n' +
      '• /users - List allowed users\n' +
      '• /add @user - Add user to allowlist\n' +
      '• /remove @user - Remove user\n\n' +
      '<b>Stats & Files</b>\n' +
      '• /stats - View usage stats\n' +
      '• /list - List all files\n' +
      '• /list youtube - List YouTube files\n' +
      '• /list instagram - List Instagram files\n' +
      '• /clear - ⚠️ Wipe DB & Files';

    await sendTelegramMessage(chatId, helpMsg);
    return true;
  }

  // LIST COMMANDS
  if (command === '/list') {
    const type = parts[1]; // 'youtube' or 'instagram' (optional)

    try {
      // First, get active downloads
      let activeDownloads = [];
      if (DYNAMODB_ACTIVE_DOWNLOADS_TABLE) {
        const activeScan = await ddb.send(new ScanCommand({ TableName: DYNAMODB_ACTIVE_DOWNLOADS_TABLE }));
        activeDownloads = activeScan.Items || [];
      }

      // Show active downloads section
      let msg = '';
      if (activeDownloads.length > 0) {
        msg += '⏳ <b>Active Downloads</b>\n\n';
        for (const item of activeDownloads) {
          const user = item.username?.S || 'Unknown';
          const sourceUrl = item.url?.S || 'N/A';
          const percent = item.percent?.S || '0%';
          const speed = item.speed?.S || '';
          const sourceType = item.source_type?.S || '';
          const startedAt = item.started_at?.S;

          // Calculate elapsed time
          let elapsed = '';
          if (startedAt) {
            const elapsedMs = Date.now() - new Date(startedAt).getTime();
            const elapsedSec = Math.floor(elapsedMs / 1000);
            elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
          }

          // Truncate URL for display
          const shortUrl = sourceUrl.length > 40 ? sourceUrl.substring(0, 40) + '...' : sourceUrl;

          msg += `📥 <b>${percent}</b> ${speed ? `(${speed})` : ''}\n`;
          msg += `   👤 @${user} | 🏷️ ${sourceType}\n`;
          msg += `   🔗 ${shortUrl}\n`;
          if (elapsed) msg += `   ⏱️ ${elapsed}\n`;
          msg += '\n';
        }
        msg += '-------------------\n\n';
      }

      let items = [];
      let header = '📂 <b>Downloaded Files</b>\n\n';

      if (type === 'youtube' || type === 'instagram') {
        header = `📂 <b>${type.charAt(0).toUpperCase() + type.slice(1)} Downloads</b>\n\n`;
        const scan = await ddb.send(new ScanCommand({
          TableName: DYNAMODB_FILES_TABLE,
          FilterExpression: 'contains(source_type, :type)',
          ExpressionAttributeValues: { ':type': { S: type } }
        }));
        items = scan.Items || [];
      } else {
        // List ALL
        const scan = await ddb.send(new ScanCommand({ TableName: DYNAMODB_FILES_TABLE }));
        items = scan.Items || [];
      }

      if (items.length === 0 && activeDownloads.length === 0) {
        await sendTelegramMessage(chatId, msg + header + 'No files found.');
        return true;
      }

      msg += header;
      let totalMB = 0;

      // Sort by date desc
      items.sort((a, b) => (b.created_at?.S || '').localeCompare(a.created_at?.S || ''));

      // Limit to last 20
      const displayItems = items.slice(0, 20);

      for (const item of displayItems) {
        const title = item.title?.S || 'Unknown';
        const size = parseFloat(item.size_mb?.N || 0);
        const type = item.source_type?.S || 'misc';

        msg += `📄 <b>${title}</b>\n`;
        msg += `   📦 ${size.toFixed(1)} MB | 🏷️ ${type}\n\n`;
      }

      // Calculate total size
      items.forEach(i => totalMB += parseFloat(i.size_mb?.N || 0));

      msg += `-------------------\n`;
      msg += `Total Stored: <b>${totalMB.toFixed(1)} MB</b> (${items.length} files)\n`;
      if (items.length > 20) msg += `<i>(Showing first 20 of ${items.length})</i>`;

      await sendTelegramMessage(chatId, msg);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ List failed: ${error.message}`);
    }
    return true;
  }

  // CLEAR COMMAND - Only clears files, preserves user stats
  if (command === '/clear') {
    try {
      await sendTelegramMessage(chatId, '⚠️ Clearing downloaded files... This may take a moment.');

      // Only delete files records (preserves user stats)
      const fileScan = await ddb.send(new ScanCommand({ TableName: DYNAMODB_FILES_TABLE }));
      let deletedCount = 0;
      for (const item of fileScan.Items || []) {
        await ddb.send(new DeleteItemCommand({
          TableName: DYNAMODB_FILES_TABLE,
          Key: { file_key: item.file_key }
        }));
        deletedCount++;
      }

      await sendTelegramMessage(chatId, `✅ Cleared ${deletedCount} file records! User stats preserved.`);

    } catch (error) {
      console.error(error);
      await sendTelegramMessage(chatId, `❌ Clear failed: ${error.message}`);
    }
    return true;
  }

  return false;
}

function detectSource(url) {
  if (patterns.instagramStory.test(url)) return 'instagram-story';
  if (patterns.instagramReel.test(url)) return 'instagram-reel';
  if (patterns.youtubeShort.test(url)) return 'youtube-short';
  if (patterns.youtubeLong.test(url)) return 'youtube-long';
  return null;
}

function extractUrl(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  return urlMatch ? urlMatch[0] : null;
}

async function answerCallbackQuery(callbackQueryId, text = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Failed to answer callback query:', error);
  }
}

export async function handler(event) {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Validate Telegram webhook secret token
  if (TELEGRAM_WEBHOOK_SECRET) {
    const secretHeader = event.headers?.['x-telegram-bot-api-secret-token'];
    if (secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('Invalid or missing webhook secret token');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  try {
    let bodyText = event.body || '{}';
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf8');
    }
    const body = JSON.parse(bodyText);

    // Handle callback queries (button presses)
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const callbackData = callbackQuery.data;
      const chatId = callbackQuery.message.chat.id;
      const username = callbackQuery.from?.username;

      console.log(`Callback query from @${username}: ${callbackData}`);

      // Check auth
      const isAllowed = await checkAuth(username);
      if (!isAllowed) {
        await answerCallbackQuery(callbackQuery.id, '🚫 Access denied');
        return { statusCode: 200, body: 'OK' };
      }

      // Handle "analyze:downloadId" callback
      if (callbackData.startsWith('analyze:')) {
        const downloadId = callbackData.replace('analyze:', '');

        // Answer the callback query immediately
        await answerCallbackQuery(callbackQuery.id, '🧠 Starting analysis...');

        // Edit the message to show analysis is starting
        await sendTelegramMessage(chatId, '🧠 <b>Video Analysis Starting...</b>\n\n<i>This will take ~2-3 minutes. I\'ll analyze the video\'s hook, retention mechanics, and virality strategy.</i>');

        // Queue analysis job to SQS
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: SQS_QUEUE_URL,
            MessageBody: JSON.stringify({
              action: 'analyze',
              chatId,
              downloadId,
              username,
            }),
          })
        );

        return { statusCode: 200, body: 'OK' };
      }

      return { statusCode: 200, body: 'OK' };
    }

    const message = body.message;

    if (!message?.text || !message?.chat?.id) {
      return { statusCode: 200, body: 'OK' };
    }

    const chatId = message.chat.id;
    const text = message.text;
    const username = message.from?.username;

    if (!username) {
      await sendTelegramMessage(chatId, '❌ Please set a Telegram username to use this bot.');
      return { statusCode: 200, body: 'OK' };
    }

    // AUTH CHECK
    const isAllowed = await checkAuth(username);

    // Handle Admin Commands if sender is admin
    if (username === TELEGRAM_ADMIN_USERNAME && text.startsWith('/')) {
      const handled = await handleAdminCommands(chatId, text, username);
      if (handled) return { statusCode: 200, body: 'OK' };
    }

    if (!isAllowed) {
      await sendTelegramMessage(chatId, '🚫 <b>Access Denied</b>\n\nYou are not authorized to use this bot. Contact the admin for access.');
      return { statusCode: 200, body: 'OK' };
    }

    // Handle /start command
    if (text === '/start') {
      await sendTelegramMessage(
        chatId,
        '🎬 <b>Media Downloader Bot</b>\n\n' +
        'Send me a link from:\n' +
        '• Instagram Story\n' +
        '• Instagram Reel\n' +
        '• YouTube Short\n' +
        '• YouTube Video\n\n' +
        "I'll download it and send you an S3 link (valid for 60 days).\n\n" +
        '<i>YouTube videos return MP3 audio only.</i>'
      );
      return { statusCode: 200, body: 'OK' };
    }

    // Extract URL from message
    const url = extractUrl(text);
    if (!url) {
      await sendTelegramMessage(chatId, '❌ No valid URL found in your message.');
      return { statusCode: 200, body: 'OK' };
    }

    // Detect source type
    const sourceType = detectSource(url);
    if (!sourceType) {
      await sendTelegramMessage(
        chatId,
        '❌ Unsupported URL. Please send an Instagram or YouTube link.'
      );
      return { statusCode: 200, body: 'OK' };
    }

    // Generate unique download ID for tracking
    const downloadId = randomUUID();

    // Create active download record
    if (DYNAMODB_ACTIVE_DOWNLOADS_TABLE) {
      try {
        const ttlSeconds = Math.floor(Date.now() / 1000) + (15 * 60); // 15 min TTL
        await ddb.send(new PutItemCommand({
          TableName: DYNAMODB_ACTIVE_DOWNLOADS_TABLE,
          Item: {
            download_id: { S: downloadId },
            username: { S: username },
            url: { S: url },
            source_type: { S: sourceType },
            status: { S: 'queued' },
            percent: { S: '0%' },
            started_at: { S: new Date().toISOString() },
            ttl: { N: String(ttlSeconds) }
          }
        }));
      } catch (error) {
        console.error('Failed to create active download record:', error);
      }
    }

    // Send processing confirmation FIRST and capture message_id
    const sourceEmoji = {
      'instagram-story': '📸',
      'instagram-reel': '🎞️',
      'youtube-short': '📱',
      'youtube-long': '🎵',
    };

    const outputType = sourceType === 'youtube-long' ? 'MP3' : 'MP4';

    const processingMsg = await sendTelegramMessage(
      chatId,
      `${sourceEmoji[sourceType]} Processing your ${sourceType.replace('-', ' ')}...\n\n` +
      `<i>You'll receive an S3 link (${outputType}) shortly.</i>`
    );

    const progressMessageId = processingMsg?.result?.message_id;

    // Queue the download request with progress message ID
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MessageBody: JSON.stringify({
          chatId,
          url,
          sourceType,
          messageId: message.message_id,
          username: username,
          downloadId: downloadId,
          progressMessageId: progressMessageId, // For live progress updates
        }),
      })
    );

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 200, body: 'OK' };
  }
}
