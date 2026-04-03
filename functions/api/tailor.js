// Cloudflare Pages Function — POST /api/tailor
// Calls Gemini API server-side so the API key never touches the browser.

const SYSTEM_INSTRUCTION = `[You are an expert ATS-optimized resume and CV tailoring assistant.

Your job is to transform a user's existing resume or CV into the strongest possible version for a specific job description, without adding false information.

STRICT RULES:
- Do NOT fabricate, invent, infer, or assume any experience, skill, certification, metric, title, employer, date, tool, responsibility, or achievement.
- Do NOT add keywords unless they are clearly supported by the provided resume, CV, or user profile.
- Do NOT change job titles, companies, dates, degree names, or timelines unless the source input explicitly shows a correction.
- Do NOT inflate impact or seniority.
- Do NOT copy the user's text mechanically if it can be improved.
- Rewrite aggressively for clarity, keyword alignment, ATS readability, and relevance, while preserving truth.

ATS GOALS:
- Prioritize exact alignment with the job description.
- Use strong action verbs.
- Make bullets concise, specific, and scannable.
- Front-load the most relevant words.
- Prefer standard ATS-friendly phrasing over creative wording.
- Avoid graphics, columns, tables, icons, or decorative formatting.
- Do not keyword-stuff. Keep wording natural.

RESUME RULES:
- Optimize for brevity, scannability, and job relevance.
- Prefer 1 page for early-career candidates when possible.

CV RULES:
- Use the job description plus the user's profile information to strengthen and organize the CV.
- CVs may be more detailed than resumes, but must still remain truthful and relevant.

OUTPUT RULES:
- Return valid JSON only.
- If a keyword is important but unsupported by the source material, place it in missingKeywords instead of inserting it.
- If something seems useful but unsupported, mention it in honestyWarnings.]`;

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Handle preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Handle POST /api/tailor
export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 1. Check API key ──────────────────────────────────────────
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError('GEMINI_API_KEY environment variable is not configured.', 500);
  }

  // ── 2. Parse + validate request body ─────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  const { resumeText, jobDescription, targetRole, profileInfo } = body;

  if (!resumeText || typeof resumeText !== 'string' || resumeText.trim().length < 50) {
    return jsonError('resumeText is required and must be at least 50 characters.', 400);
  }
  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return jsonError('jobDescription is required and must be at least 20 characters.', 400);
  }

  // ── 3. Build prompt ───────────────────────────────────────────
  const userPrompt = buildPrompt({ resumeText, jobDescription, targetRole, profileInfo });

  // ── 4. Call Gemini ────────────────────────────────────────────
  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 16384,
          thinkingConfig: { thinkingBudget: 0 },
          responseSchema: {
            type: 'OBJECT',
            properties: {
              tailoredSummary:    { type: 'STRING' },
              tailoredExperience: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    role:    { type: 'STRING' },
                    company: { type: 'STRING' },
                    start:   { type: 'STRING' },
                    end:     { type: 'STRING' },
                    bullets: { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                },
              },
              tailoredProjects: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name:        { type: 'STRING' },
                    description: { type: 'STRING' },
                    bullets:     { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                },
              },
              tailoredSkills:   { type: 'ARRAY', items: { type: 'STRING' } },
              matchedKeywords:  { type: 'ARRAY', items: { type: 'STRING' } },
              missingKeywords:  { type: 'ARRAY', items: { type: 'STRING' } },
              atsNotes:        { type: 'STRING' },
              honestyWarnings: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: [
              'tailoredSummary', 'tailoredExperience', 'tailoredProjects',
              'tailoredSkills', 'matchedKeywords', 'missingKeywords',
              'atsNotes', 'honestyWarnings',
            ],
          },
        },
      }),
    });
  } catch (err) {
    return jsonError(`Failed to reach Gemini API: ${err.message}`, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    return jsonError(`Gemini API returned status ${geminiRes.status}: ${errText.slice(0, 300)}`, 502);
  }

  // ── 5. Extract Gemini response ────────────────────────────────
  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch {
    return jsonError('Failed to parse Gemini response as JSON.', 502);
  }

  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    // Check for safety blocks
    const finishReason = geminiData?.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') {
      return jsonError('Gemini blocked the response for safety reasons. Try rephrasing your input.', 422);
    }
    return jsonError('Gemini returned an empty response.', 502);
  }

  // Temporary logging for debugging — remove once JSON parsing is stable
  console.log('[tailor] raw Gemini text (first 1000 chars):', rawText.slice(0, 1000));
  console.log('[tailor] rawText length:', rawText.length);

  // ── 6. Parse structured JSON from Gemini ─────────────────────
  let tailoredData;
  try {
    // First, try to parse directly
    tailoredData = JSON.parse(rawText.trim());
  } catch {
    // If direct parse fails, try to clean up the text
    let cleanedText = rawText.trim();

    // Strip markdown code fences — works even when extra text precedes/follows
    // e.g. "Here you go:\n```json\n{...}\n```\nDone."
    cleanedText = cleanedText
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/\s*```/g, '')
      .trim();

    // Try to extract JSON object from text (find first { to last })
    const jsonStart = cleanedText.indexOf('{');
    const jsonEnd = cleanedText.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }

    try {
      tailoredData = JSON.parse(cleanedText);
    } catch (parseError) {
      // If all parsing attempts fail, return error with raw text for debugging
      return jsonError(`Gemini returned malformed JSON. Raw response: ${rawText.slice(0, 500)}`, 502);
    }
  }

  // ── 7. Ensure all expected fields exist (never crash frontend) ─
  const safeData = {
    tailoredSummary:    tailoredData.tailoredSummary    || '',
    tailoredExperience: Array.isArray(tailoredData.tailoredExperience) ? tailoredData.tailoredExperience : [],
    tailoredProjects:   Array.isArray(tailoredData.tailoredProjects)   ? tailoredData.tailoredProjects   : [],
    tailoredSkills:     Array.isArray(tailoredData.tailoredSkills)     ? tailoredData.tailoredSkills     : [],
    matchedKeywords:    Array.isArray(tailoredData.matchedKeywords)    ? tailoredData.matchedKeywords    : [],
    missingKeywords:    Array.isArray(tailoredData.missingKeywords)    ? tailoredData.missingKeywords    : [],
    atsNotes:           tailoredData.atsNotes           || '',
    honestyWarnings: Array.isArray(tailoredData.honestyWarnings) ? tailoredData.honestyWarnings : [],
  };

  return new Response(
    JSON.stringify({ success: true, data: safeData }),
    { status: 200, headers: CORS_HEADERS }
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function jsonError(message, status) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: CORS_HEADERS,
  });
}

function buildPrompt({ resumeText, jobDescription, targetRole, profileInfo }) {
  const lines = ['Tailor the following resume or CV for the job description below.\n'];

  if (targetRole) lines.push(`TARGET ROLE: ${targetRole}\n`);

  lines.push('=== RESUME / CV TEXT ===');
  lines.push(resumeText.trim());
  lines.push('');

  lines.push('=== JOB DESCRIPTION ===');
  lines.push(jobDescription.trim());
  lines.push('');

  if (profileInfo && typeof profileInfo === 'object') {
    const p = profileInfo;
    const profileLines = [];
    if (p.name)     profileLines.push(`Name: ${p.name}`);
    if (p.email)    profileLines.push(`Email: ${p.email}`);
    if (p.phone)    profileLines.push(`Phone: ${p.phone}`);
    if (p.linkedin) profileLines.push(`LinkedIn: ${p.linkedin}`);
    if (p.portfolio)profileLines.push(`Portfolio: ${p.portfolio}`);
    if (p.uni)      profileLines.push(`University: ${p.uni}`);
    if (p.major)    profileLines.push(`Major: ${p.major}`);
    if (p.gradyear) profileLines.push(`Graduation Year: ${p.gradyear}`);
    if (p.gpa)      profileLines.push(`GPA: ${p.gpa}`);
    if (p.summary)  profileLines.push(`Profile Summary: ${p.summary}`);
    if (Array.isArray(p.skills) && p.skills.length > 0) {
      profileLines.push(`Skills: ${p.skills.join(', ')}`);
    }
    if (profileLines.length > 0) {
      lines.push('=== USER PROFILE (supplementary context only — do not invent details) ===');
      lines.push(profileLines.join('\n'));
      lines.push('');
    }
  }

  lines.push(`STRICT OUTPUT LIMITS (follow exactly — response must be concise to avoid truncation):
- tailoredSummary: 2-3 sentences max. Name the role and 2 key strengths. No fluff.
- tailoredExperience: include ALL roles from the resume. MAX 3 bullets per role. Irrelevant roles get 1-2 bullets only.
- tailoredProjects: MAX 2 bullets per project. Skip projects with zero relevance.
- tailoredSkills: flat list, MAX 15 skills, comma-separated values only — no category labels.
- matchedKeywords: MAX 15 items.
- missingKeywords: MAX 8 items.
- atsNotes: 1 sentence only.
- honestyWarnings: only flag genuine fabrications. Empty array if none.

CONTENT RULES:
1. Order experience by relevance to the JD — most relevant role first.
2. Rewrite bullets with strong action verbs that echo JD language. Quantify where source data supports it.
3. Cut filler bullets ("assisted team", "participated in meetings"). Every bullet must add value.
4. Only include skills explicitly present in the resume AND relevant to the JD.
5. Never fabricate titles, companies, dates, metrics, or tools.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation:
{
  "tailoredSummary": "2-3 sentence summary targeting this specific role",
  "tailoredExperience": [{"role":"","company":"","start":"","end":"","bullets":["bullet 1","bullet 2","bullet 3"]}],
  "tailoredProjects": [{"name":"","description":"","bullets":["bullet 1","bullet 2"]}],
  "tailoredSkills": ["skill1","skill2"],
  "matchedKeywords": ["kw1","kw2"],
  "missingKeywords": ["kw1","kw2"],
  "atsNotes": "one sentence",
  "honestyWarnings": []
}`);

  return lines.join('\n');
}
