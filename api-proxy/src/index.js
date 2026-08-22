import { SYSTEM_PROMPT } from './context.js';
import { handleUpload, handleFetchClip, handleDeleteClip } from './clips.js';
import { handleTranscribe, handleFetchTranscript } from './transcribe.js';
import { handleCreateShare, handleShareCard, handleDeleteShare } from './share.js';

const ALLOWED_ORIGINS = [
  'https://nerohamidi.github.io',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];

const MODEL = 'gemini-3.1-flash-lite-preview';

// Keep a stranger from turning this proxy into a free general-purpose Gemini relay.
const MAX_TURNS = 24;
const MAX_CHARS_PER_TURN = 2000;
const MAX_CHARS_TOTAL = 16000;

const GENERATION_CONFIG = {
  temperature: 0.7,
  maxOutputTokens: 512,
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Clip-Name, X-Clip-Prev, X-Clip-Lang, X-Clip-Key, X-Clip-Lock, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-Clip-Name, X-Clip-Locked',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Accepts the current client shape ({ messages: [{ role, text }] }) and also the
// legacy shape ({ contents: [...] }) that a cached copy of the old page still sends.
// Either way the client's own prompt text is discarded: the system prompt comes
// from the Worker and nowhere else.
function readTurns(body) {
  let turns = [];

  if (Array.isArray(body?.messages)) {
    turns = body.messages.map((m) => ({
      role: m?.role === 'model' ? 'model' : 'user',
      text: typeof m?.text === 'string' ? m.text : '',
    }));
  } else if (Array.isArray(body?.contents)) {
    let legacy = body.contents;
    // The old page opened with a priming user/model pair carrying the prompt. Drop it.
    const firstText = legacy[0]?.parts?.[0]?.text;
    if (typeof firstText === 'string' && firstText.startsWith('System context:')) {
      legacy = legacy.slice(2);
    }
    turns = legacy.map((c) => ({
      role: c?.role === 'model' ? 'model' : 'user',
      text: typeof c?.parts?.[0]?.text === 'string' ? c.parts[0].text : '',
    }));
  } else {
    return { error: 'Expected a messages array.' };
  }

  turns = turns.filter((t) => t.text.trim().length > 0);

  if (turns.length === 0) return { error: 'No message to send.' };
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);

  let total = 0;
  for (const t of turns) {
    if (t.text.length > MAX_CHARS_PER_TURN) return { error: 'Message too long.' };
    total += t.text.length;
  }
  if (total > MAX_CHARS_TOTAL) return { error: 'Conversation too long. Please reload to start over.' };

  return { turns };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const headers = corsHeaders(allowed ? origin : ALLOWED_ORIGINS[0]);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    // Clip routes are matched first. Anything that falls through stays on the
    // chatbot path, which the playroom page has posted to at the bare origin
    // since before clips existed.
    const clipMatch = url.pathname.match(/^\/clip\/([^/]+)$/);
    if (clipMatch) {
      // Open to any origin for the same reason the read is: the id in the link is
      // the permission, and whoever was given it can take the clip down from
      // wherever they opened it.
      if (request.method === 'DELETE') {
        return handleDeleteClip(request, env, clipMatch[1], {
          ...headers,
          'Access-Control-Allow-Origin': '*',
        });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      // Readable from any origin. The unguessable key is the access control here,
      // and a shared link has to work wherever the recipient opens it.
      return handleFetchClip(request, env, clipMatch[1], {
        ...headers,
        'Access-Control-Allow-Origin': '*',
      });
    }

    // The share card. A link with a title or a note points here rather than
    // straight at the page, because a static page cannot put a visitor's words in
    // its own meta tags and a fragment never reaches a server to try. Open to
    // everyone: this is the URL that gets forwarded around, and an unfurler sends
    // no Origin at all.
    const cardMatch = url.pathname.match(/^\/s\/([^/]+)$/);
    if (cardMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      return handleShareCard(request, env, cardMatch[1], {
        ...headers,
        'Access-Control-Allow-Origin': '*',
      });
    }

    const shareMatch = url.pathname.match(/^\/share\/([^/]+)$/);
    if (shareMatch) {
      // Open to any origin, like the clip delete: the card is taken down from
      // wherever its link was opened, and the password on it is the real check.
      if (request.method === 'DELETE') {
        return handleDeleteShare(request, env, shareMatch[1], {
          ...headers,
          'Access-Control-Allow-Origin': '*',
        });
      }
      return json({ error: 'Method not allowed' }, 405, headers);
    }

    // Origin-allowlisted, like the upload: this one writes to the bucket. The
    // destination the card forwards to is derived from that same allowlist and
    // never from the request body, so no caller can point a card somewhere else.
    if (url.pathname === '/share') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      if (!allowed) {
        return json({ error: 'Forbidden' }, 403, headers);
      }
      return handleCreateShare(request, env, origin, headers);
    }

    if (url.pathname === '/clip') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      if (!allowed) {
        return json({ error: 'Forbidden' }, 403, headers);
      }
      return handleUpload(request, env, ctx, headers);
    }

    // Already-transcribed chunks of a shared clip. Open to any origin for the same
    // reason the clip itself is: the recipient of a link opens it wherever they
    // like, and this only ever returns what the clip's own audio already says.
    const txMatch = url.pathname.match(/^\/transcript\/([^/]+)$/);
    if (txMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      return handleFetchTranscript(request, env, txMatch[1], {
        ...headers,
        'Access-Control-Allow-Origin': '*',
      });
    }

    // Origin-allowlisted, unlike the read above: this one spends model tokens.
    if (url.pathname === '/transcribe') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, headers);
      }
      if (!allowed) {
        return json({ error: 'Forbidden' }, 403, headers);
      }
      return handleTranscribe(request, env, ctx, headers);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, headers);
    }
    if (!allowed) {
      return json({ error: 'Forbidden' }, 403, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON.' }, 400, headers);
    }

    const { turns, error } = readTurns(body);
    if (error) return json({ error }, 400, headers);

    const apiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
      `?key=${env.GEMINI_API_KEY}`;

    let resp;
    try {
      resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
          generationConfig: GENERATION_CONFIG,
        }),
      });
    } catch {
      return json({ error: 'Upstream request failed.' }, 502, headers);
    }

    if (!resp.ok) {
      // Deliberately generic: upstream errors can quote the request back.
      return json({ error: 'The assistant is unavailable right now.' }, 502, headers);
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      return json({ error: 'The assistant is unavailable right now.' }, 502, headers);
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof reply !== 'string' || reply.trim().length === 0) {
      return json({ error: 'No response from the model.' }, 502, headers);
    }

    // Only the reply crosses back to the browser, never the request that produced it.
    return json({ reply }, 200, headers);
  },
};
