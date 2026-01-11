import { createWriteStream, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Downloads an Instagram Reel using ScrapeCreators API.
 * 
 * @param {string} url - The Instagram Reel URL.
 * @param {string} outputPath - Local path to save the video.
 * @returns {Promise<void>}
 */
export async function downloadInstagramReel(url, outputPath) {
    const apiKey = process.env.SCRAPECREATORS_API_KEY;
    if (!apiKey) {
        throw new Error('SCRAPECREATORS_API_KEY is not configured');
    }

    console.log(`Fetching from ScrapeCreators for: ${url}`);

    const apiUrl = `https://api.scrapecreators.com/v1/instagram/post?url=${encodeURIComponent(url)}`;

    const response = await fetch(apiUrl, {
        headers: {
            'x-api-key': apiKey
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ScrapeCreators API failed (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    console.log(`ScrapeCreators Response: ${JSON.stringify(json, null, 2)}`);

    if (!json.success && json.error) {
        throw new Error(`ScrapeCreators API error: ${json.message || json.error}`);
    }

    // Attempt to locate video URL in typical Instagram API response structures
    // 1. Root level 'data' object usually contains the media info
    const data = json.data || json;

    // Possible paths for video URL:
    // - data.shortcode_media.video_url (Observed in test)
    // - data.video_url
    // - data.video_versions[0].url
    // - data.items[0].video_versions[0].url (if list)

    let videoUrl = data.video_url;

    // Check shortcode_media / xdt_shortcode_media wrapper
    const media = data.shortcode_media || data.xdt_shortcode_media;

    if (!videoUrl && media) {
        videoUrl = media.video_url;
        if (!videoUrl && media.video_versions && media.video_versions.length > 0) {
            videoUrl = media.video_versions[0].url;
        }
    }

    if (!videoUrl && data.video_versions && data.video_versions.length > 0) {
        videoUrl = data.video_versions[0].url;
    }

    if (!videoUrl && data.items && data.items.length > 0) {
        const item = data.items[0];
        if (item.video_versions && item.video_versions.length > 0) {
            videoUrl = item.video_versions[0].url;
        }
    }

    if (!videoUrl) {
        throw new Error(`Could not find video URL in ScrapeCreators response. Check logs for structure.`);
    }



    console.log(`Downloading video from: ${videoUrl}`);

    // Configure Agent if proxy is available
    const proxyUrl = process.env.YOUTUBE_PROXY;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    if (proxyUrl) {
        console.log(`Using Proxy for download: ${proxyUrl.replace(/:[^:]*@/, ':***@')}`);
    }

    // Download the file
    const videoResponse = await fetch(videoUrl, { agent });
    if (!videoResponse.ok) {
        throw new Error(`Failed to download video file: ${videoResponse.statusText}`);
    }

    const stream = createWriteStream(outputPath);
    await pipeline(videoResponse.body, stream);

    console.log(`Video saved to: ${outputPath}`);

    // Return metadata
    const metaMedia = data.shortcode_media || data.xdt_shortcode_media;
    const user = data.user || data.owner || (metaMedia ? metaMedia.owner : {}) || {};
    const captionText = data.caption?.text || data.caption || (metaMedia?.edge_media_to_caption?.edges[0]?.node?.text) || 'Instagram Reel';

    return {
        title: captionText,
        username: user.username || 'instagram_user',
        duration: data.video_duration || (metaMedia ? metaMedia.video_duration : undefined),
        uploadDate: data.taken_at || (metaMedia ? metaMedia.taken_at_timestamp : undefined)
    };
}
