// Cloudflare Pages Function — POST /api/coverletter
// Accepts optional resume PDF + job description, generates a tailored cover letter.

const SYSTEM_INSTRUCTION = `You are an expert cover letter writer for college students and recent graduates. You write short, honest, personalized cover letters that sound like a real person wrote them.

STRUCTURE RULES:
- Address a real person if a hiring manager name is provided; otherwise use "Hiring Manager"
- First sentence must name the company's specific challenge or goal pulled directly from the job description
- Show you researched the company — reference their mission, product, or a specific detail from the JD
- 3 short paragraphs ONLY — no more, no less
- Focus entirely on what the candidate will contribute, not what they want from the company
- No generic phrases: "team player", "fast learner", "passionate", "detail-oriented", "hard worker", "I believe", "I feel", "I think"

TONE RULES:
- Sound like a real person in their early 20s who is confident but not arrogant
- No corporate speak. Never use: "leverage," "synergy," "utilize," "facilitate," "spearhead," "impactful"
- Short sentences. Active voice only.
- Never use em dashes (—)
- Write the way a smart student actually talks, not like a LinkedIn post

CRITICAL ACCURACY RULES:
- Only mention skills, tools, projects, and experiences the candidate explicitly provided. Do not invent or assume anything.
- If they only listed basic coursework, only reference basic coursework. Do not call it "extensive experience" or "advanced proficiency."
- Do not add technologies, frameworks, languages, or tools that were not mentioned by the candidate.
- Do not exaggerate titles or responsibilities. If they said "class project" do not call it "professional experience."
- If the candidate has limited experience, lead with enthusiasm, learning ability, and relevant coursework — not fabricated skills.
- A shorter honest letter beats a longer dishonest one every time.

OUTPUT: Return ONLY a raw JSON object — no markdown, no code fences, no explanation:
{
  "salutation": "Ms. Johnson" or "Hiring Manager",
  "hiringManagerName": "Sarah Johnson" or "",
  "hiringManagerTitle": "Head of Engineering" or "",
  "companyName": "Anthropic",
  "paragraphs": [
    "Opening paragraph — first sentence names specific challenge/goal, explains why you are excited about THIS company specifically",
    "Middle paragraph — your most relevant real experience or coursework, one specific thing that maps to their need",
    "Closing paragraph — what you will contribute, confident direct call to action"
  ]
}`;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.ANTHROPHIC_KEY;
  if (!apiKey) return jsonError('ANTHROPHIC_KEY environment variable is not configured.', 500);

  let body;
  try { body = await request.json(); } catch { return jsonError('Request body must be valid JSON.', 400); }

  const { jobDescription, companyName, hiringManagerName, profileInfo, resumePdfBase64 } = body;

  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return jsonError('jobDescription is required and must be at least 20 characters.', 400);
  }

  // Build prompt
  const lines = [];
  if (companyName) lines.push(`COMPANY: ${companyName}`);
  if (hiringManagerName) lines.push(`HIRING MANAGER: ${hiringManagerName}`);
  lines.push('\n=== JOB DESCRIPTION ===');
  lines.push(jobDescription.trim());

  if (profileInfo && typeof profileInfo === 'object') {
    const p = profileInfo;
    const pl = [];
    if (p.name)     pl.push(`Name: ${p.name}`);
    if (p.email)    pl.push(`Email: ${p.email}`);
    if (p.uni)      pl.push(`University: ${p.uni}`);
    if (p.major)    pl.push(`Major: ${p.major}`);
    if (p.gradyear) pl.push(`Graduation: ${p.gradyear}`);
    if (p.summary)  pl.push(`Summary: ${p.summary}`);
    if (pl.length) {
      lines.push('\n=== CANDIDATE PROFILE ===');
      lines.push(pl.join('\n'));
    }
  }

  lines.push('\nReturn ONLY the JSON object described in the system prompt.');
  const textPrompt = lines.join('\n');

  // Build message content
  const messageContent = [];
  if (resumePdfBase64 && resumePdfBase64.length > 100) {
    messageContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: resumePdfBase64 },
      title: 'Candidate Resume',
      context: 'Use this resume to understand the candidate\'s real background, skills, and experience.',
    });
  }
  messageContent.push({ type: 'text', text: textPrompt });

  let anthropicRes;
  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (resumePdfBase64 && resumePdfBase64.length > 100) {
      reqHeaders['anthropic-beta'] = 'pdfs-2024-09-25';
    }
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_INSTRUCTION,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });
  } catch (err) {
    return jsonError(`Failed to reach Anthropic API: ${err.message}`, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return jsonError(`Anthropic API returned status ${anthropicRes.status}: ${errText.slice(0, 300)}`, 502);
  }

  let anthropicData;
  try { anthropicData = await anthropicRes.json(); } catch { return jsonError('Failed to parse Anthropic response.', 502); }

  const rawText = anthropicData?.content?.[0]?.text;
  if (!rawText) return jsonError(`Anthropic returned empty response. Stop: ${anthropicData?.stop_reason}`, 502);

  let data;
  try {
    data = JSON.parse(rawText.trim());
  } catch {
    let cleaned = rawText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
    const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e > s) cleaned = cleaned.substring(s, e + 1);
    try { data = JSON.parse(cleaned); } catch { return jsonError(`Failed to parse JSON: ${rawText.slice(0, 400)}`, 502); }
  }

  const safeData = {
    salutation:         data.salutation         || 'Hiring Manager',
    hiringManagerName:  data.hiringManagerName  || '',
    hiringManagerTitle: data.hiringManagerTitle || '',
    companyName:        data.companyName        || companyName || '',
    paragraphs:         Array.isArray(data.paragraphs) ? data.paragraphs : [data.body || ''],
  };

  return new Response(JSON.stringify({ success: true, data: safeData }), { status: 200, headers: CORS_HEADERS });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers: CORS_HEADERS });
}
