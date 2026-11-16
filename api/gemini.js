const DEFAULT_MODEL = 'gemini-3.1-flash';
const MAX_TOTAL_CHARS = 3400000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

async function readRawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) {
        throw new PayloadTooLargeError('Request body exceeds 4 MB limit.');
      }
      return JSON.parse(req.body || '{}');
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.byteLength > MAX_BODY_BYTES) {
        throw new PayloadTooLargeError('Request body exceeds 4 MB limit.');
      }
      return JSON.parse(req.body.toString('utf8') || '{}');
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
    if (serializedBytes > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError('Request body exceeds 4 MB limit.');
    }
    return req.body;
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new PayloadTooLargeError('Request body exceeds 4 MB limit.'));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
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
    const statusCode = err instanceof PayloadTooLargeError ? 413 : 400;
    return res.status(statusCode).json({
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
      error: 'Request content exceeds 3,400,000 character limit.',
    });
  }

  const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
  const model = requestedModel || (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
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
