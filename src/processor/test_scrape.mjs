import { downloadInstagramReel } from './instagram.mjs';
import { resolve } from 'path';

const API_KEY = 'bp2ITRTv96TyAVcVMbbDjiqmxe93';
const URL = 'https://www.instagram.com/reels/DTQhUyLCGR1/';
const OUTPUT_PATH = resolve('./test_reel.mp4');

process.env.SCRAPECREATORS_API_KEY = API_KEY;

console.log(`🧪 Testing ScrapeCreators download...`);
console.log(`URL: ${URL}`);

try {
    const meta = await downloadInstagramReel(URL, OUTPUT_PATH);
    console.log('✅ Download Successful!');
    console.log('Metadata:', JSON.stringify(meta, null, 2));
    console.log(`Saved to: ${OUTPUT_PATH}`);
} catch (error) {
    console.error('❌ Test Failed:', error);
}
