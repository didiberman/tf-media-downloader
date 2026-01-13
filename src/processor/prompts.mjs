/**
 * VISUAL ANALYSIS PROMPT
 * Used by Gemini 2.5 Flash Image to analyze video frames.
 */
export const VISUAL_ANALYSIS_PROMPT = `You are a world-class viral video strategist.
YOUR GOAL: Analyze the VISUAL CONTENT of this video. Describe EXACTLY what is seen, not just the editing style.

Structure your analysis as follows:

1. **👁️ Visual Narrative (Chronological)**:
   - Describe the key scenes in order.
   - Who/what is in the frame? What are they doing?
   - Describe the setting, colors, and key action moments.
   - Example: "Opens with a close-up of a person shivering in snow. Cut to wide shot of an icy lake..."

2. **🎣 The Hook (0-3s)**:
   - Specifically, what VISUAL element grabs attention? (e.g., "A bright red explosion," "A confused facial expression")

3. **🎬 Production & Composition**:
   - Lighting (natural, studio, dark?)
   - Camera work (shaky handheld, smooth drone, static tripod?)
   - Text overlays/Graphics (what do they say? where are they placed?)

4. **⚡ Retention Mechanics**:
   - Visual payoffs (did a reveal happen?)
   - Pacing (fast cuts vs. long takes)

Be vivid and descriptive so someone reading this can "see" the video.`;

/**
 * SYNTHESIS PROMPT GENERATOR
 * Used by Claude Sonnet 4.5 to combine visual and audio analysis into a strategy.
 * 
 * @param {string} visualAnalysis - The output from Gemini
 * @param {string} transcript - The audio transcript from AWS Transcribe
 * @param {number} duration - Video duration in seconds
 * @param {string} title - Video title
 * @returns {string} The formatted prompt for Claude
 */
export function getSynthesisPrompt(visualAnalysis, transcript, duration, title) {
   return `You are a world-class viral video strategist. You have TWO separate analyses of a ${Math.round(duration)}-second short-form video titled "${title}":

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
1 sentence summary of the concept.

👁️ **VISUAL NARRATIVE**
Describe what actually happens in the video. Paint a picture.
• Scene 1: [Description]
• Scene 2: [Description]
• Visual Style: [e.g. "Gritty handheld" or "Polished studio"]

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
- Use HTML <b>tags</b> for bold text (DO NOT use asterisks like **bold** or *bold*)`;
}
