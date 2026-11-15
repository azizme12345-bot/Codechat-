const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_TOTAL_CHARS = 450000;

async function readRawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      return JSON.parse(req.body || '{}');
    }
    if (Buffer.isBuffer(req.body)) {
      return JSON.parse(req.body.toString('utf8') || '{}');
    }
    return req.body;
  }

  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('Request payload too large.'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured on the server.',
    });
  }

  let body;
  try {
    body = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : 'Invalid request body.',
    });
  }

  const rawMessages = Array.isArray(body?.messages) ? body.messages : null;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const systemInstruction =
    typeof body?.systemInstruction === 'string' ? body.systemInstruction.trim() : '';

  const contents = [];
  let totalChars = systemInstruction.length;

  if (rawMessages && rawMessages.length > 0) {
    for (const item of rawMessages) {
      if (!item || typeof item.text !== 'string') continue;
      const text = item.text.trim();
      if (!text) continue;
      const role = item.role === 'model' ? 'model' : 'user';
      totalChars += text.length;
      contents.push({ role, parts: [{ text }] });
    }
  } else if (prompt) {
    totalChars += prompt.length;
    contents.push({ role: 'user', parts: [{ text: prompt }] });
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'Prompt or messages are required.' });
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    return res.status(413).json({
      error: 'Request content is too large. Please shorten your message or attachment.',
    });
  }

  const model = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const payload = { contents };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const apiErrMsg =
        data?.error?.message || `Gemini API request failed (${response.status}).`;
      return res.status(response.status).json({ error: apiErrMsg });
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts
          .map((p) => (typeof p?.text === 'string' ? p.text : ''))
          .join('')
          .trim()
      : '';

    if (!text) {
      return res.status(502).json({
        error: 'Gemini returned an empty response. Please try again.',
      });
    }

    return res.status(200).json({ text });
  } catch {
    return res.status(502).json({
      error: 'Failed to reach Gemini API. Please try again later.',
    });
  }
}
