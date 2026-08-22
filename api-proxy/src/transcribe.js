// Live transcription for the signal playground.
//
// The page cuts the decoded track into short windows, resamples each to 16 kHz
// mono WAV, and posts them one at a time while the track plays. Whisper runs here
// rather than in the browser because there is no way to feed the Web Speech API
// anything but a microphone, and shipping a model to the client for a page that is
// mostly a filter demo is not a trade worth making.
//
// Every chunk of a *shared* clip is cached under `tx/c/<clipId>/<n>`, so the first
// listener pays for the transcription and everyone after them reads it back for
// free. Local files have no id and are never cached.

import { ttlDays, envNum } from './clips.js';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

// One window. The page aims well under this; the cap is here so a hand-made
// request cannot bill a whole album in one call.
const MAX_CHUNK_SECONDS = 30;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
// 16 kHz mono is what the page sends, so a chunk at the ceiling is ~960 KB.
const MAX_CHUNK_INDEX = 400;

// Workers AI's free allocation is 10,000 Neurons a day and this model costs 46.63
// Neurons per audio minute, so the free tier is worth about 214 audio minutes.
// 120 minutes leaves room for the undercount described in `addUsage` and still
// bills nothing.
const MAX_DAILY_SECONDS = 7200;

const MAX_PREV_CHARS = 220;

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function maxDailySeconds(env) {
  return envNum(env.TRANSCRIBE_MAX_DAILY_SECONDS, MAX_DAILY_SECONDS);
}

function maxChunkSeconds(env) {
  return envNum(env.TRANSCRIBE_MAX_CHUNK_SECONDS, MAX_CHUNK_SECONDS) || MAX_CHUNK_SECONDS;
}

// Reads the real duration out of the RIFF header rather than trusting a declared
// one, so the daily budget below is spent against the audio that was actually
// transcribed. Doubles as the format check: anything that is not a WAV we can
// measure does not reach the model.
function readWavInfo(bytes) {
  function ascii(off, str) {
    if (off + str.length > bytes.length) return false;
    for (let i = 0; i < str.length; i++) {
      if (bytes[off + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }
  if (!ascii(0, 'RIFF') || !ascii(8, 'WAVE')) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;

  while (off + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      // A streamed WAV can carry a zero or overlong data size; the bytes that
      // actually arrived are the honest measure either way.
      dataBytes = Math.min(size || bytes.length - body, bytes.length - body);
      break;
    }
    // Chunks are word-aligned, and an odd size carries a pad byte.
    off = body + size + (size % 2);
  }

  if (!rate || !channels || !bits || !dataBytes) return null;
  const seconds = dataBytes / (rate * channels * (bits / 8));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { rate, channels, bits, seconds };
}

function toBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readUsage(env) {
  if (!env.CLIPS) return 0;
  try {
    const obj = await env.CLIPS.get(`tx/usage/${today()}`);
    if (!obj) return 0;
    const n = Number(await obj.text());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// Read, add, write. Two requests finishing together can each miss the other's
// increment, so the stored total is a floor and the day's real spend can run a
// little past it. The gap between the cap and the free allocation is sized to
// absorb that; a counter that cannot drift would need a Durable Object, which is
// a lot of machinery for a budget guard.
async function addUsage(env, seconds) {
  if (!env.CLIPS) return;
  const key = `tx/usage/${today()}`;
  try {
    const used = await readUsage(env);
    await env.CLIPS.put(key, String(Math.round(used + seconds)));
  } catch {
    // A lost increment costs accuracy, never correctness: the cap still holds on
    // the next request that manages to read the counter.
  }
}

function decodeHeader(value, limit) {
  if (!value) return '';
  try {
    return decodeURIComponent(value).slice(0, limit);
  } catch {
    return '';
  }
}

// Whisper's own timings are relative to the window it was handed. Everything the
// page renders is in track time, so the offset is folded in here, once.
function shiftSegments(result, offset, limit) {
  const out = [];

  const raw = Array.isArray(result && result.segments) ? result.segments : [];
  for (const seg of raw) {
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const words = [];
    if (Array.isArray(seg.words)) {
      for (const w of seg.words) {
        const ws = Number(w && w.start);
        const we = Number(w && w.end);
        const wt = w && typeof w.word === 'string' ? w.word : '';
        if (!wt || !Number.isFinite(ws) || !Number.isFinite(we)) continue;
        words.push({ t: wt, s: +(ws + offset).toFixed(3), e: +(we + offset).toFixed(3) });
      }
    }
    out.push({
      s: +(Math.max(0, start) + offset).toFixed(3),
      e: +(Math.min(limit, end) + offset).toFixed(3),
      t: text,
      w: words,
    });
  }

  if (out.length) return out;

  // No segments came back but there is still text: keep the words rather than the
  // timing, and let the whole window carry them.
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (text) return [{ s: +offset.toFixed(3), e: +(offset + limit).toFixed(3), t: text, w: [] }];
  return [];
}

function cacheKey(clipId, index) {
  return `tx/c/${clipId}/${String(index).padStart(4, '0')}`;
}

export async function handleTranscribe(request, env, ctx, headers) {
  if (!env.AI) {
    return json({ error: 'Transcription is not configured.' }, 503, headers);
  }

  const url = new URL(request.url);
  const clipId = url.searchParams.get('clip') || '';
  // Read as text first. Number(null) is 0, so a missing parameter would otherwise
  // pass both checks below and quietly transcribe the window at the wrong offset.
  const rawIndex = url.searchParams.get('i');
  const rawStart = url.searchParams.get('start');
  const index = rawIndex === null || rawIndex === '' ? NaN : Number(rawIndex);
  const start = rawStart === null || rawStart === '' ? NaN : Number(rawStart);

  if (clipId && !ID_RE.test(clipId)) {
    return json({ error: 'Bad clip id.' }, 400, headers);
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) {
    return json({ error: 'Bad chunk index.' }, 400, headers);
  }
  if (!Number.isFinite(start) || start < 0) {
    return json({ error: 'Bad chunk start.' }, 400, headers);
  }

  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_CHUNK_BYTES) {
    return json({ error: 'That audio chunk is too long.' }, 413, headers);
  }

  if (env.TRANSCRIBE_CALLS) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.TRANSCRIBE_CALLS.limit({ key: ip });
    if (!success) {
      return json({ error: 'Transcribing too fast. Give it a moment.' }, 429, headers);
    }
  }

  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return json({ error: 'That chunk failed in transit.' }, 400, headers);
  }
  if (buf.byteLength > MAX_CHUNK_BYTES) {
    return json({ error: 'That audio chunk is too long.' }, 413, headers);
  }

  const info = readWavInfo(new Uint8Array(buf));
  if (!info) {
    return json({ error: 'Expected 16-bit PCM WAV audio.' }, 415, headers);
  }
  const capSeconds = maxChunkSeconds(env);
  if (info.seconds > capSeconds + 0.5) {
    return json({ error: 'That audio chunk is too long.' }, 413, headers);
  }

  // Checked after the size checks so a malformed request is refused before it
  // touches R2, and before the model.
  const budget = maxDailySeconds(env);
  if (budget) {
    const used = await readUsage(env);
    if (used + info.seconds > budget) {
      return json({
        error: 'Transcription has hit its daily limit. It resets at midnight UTC.',
      }, 429, headers);
    }
  }

  const prev = decodeHeader(request.headers.get('x-clip-prev'), MAX_PREV_CHARS);
  const language = decodeHeader(request.headers.get('x-clip-lang'), 12);

  const inputs = {
    audio: toBase64(new Uint8Array(buf)),
    task: 'transcribe',
    // Silence is where Whisper invents text, and a filtered or quiet passage of a
    // song is mostly silence as far as the model is concerned.
    vad_filter: true,
  };
  // The window is cut mid-sentence by definition, so the tail of the previous one
  // is what keeps a word split across the boundary from coming back twice.
  if (prev) inputs.initial_prompt = prev;
  // Detected once on the first window and echoed back by the page after that: per
  // window detection lets a quiet passage flip a song into another language.
  if (/^[a-z]{2,3}$/i.test(language)) inputs.language = language.toLowerCase();

  let result;
  try {
    result = await env.AI.run(MODEL, inputs);
  } catch {
    return json({ error: 'Transcription is unavailable right now.' }, 502, headers);
  }

  if (ctx) ctx.waitUntil(addUsage(env, info.seconds));

  const segments = shiftSegments(result, start, info.seconds);
  const detected = result && result.transcription_info && result.transcription_info.language;
  const payload = {
    i: index,
    start: +start.toFixed(3),
    end: +(start + info.seconds).toFixed(3),
    segments,
    language: typeof detected === 'string' ? detected : (language || ''),
  };

  // Cached only for clips, and only once the clip exists: an id the uploader made
  // up would otherwise let anyone write objects into the bucket.
  if (clipId && env.CLIPS && ctx) {
    ctx.waitUntil((async () => {
      try {
        const head = await env.CLIPS.head(`clips/${clipId}`);
        if (!head) return;
        await env.CLIPS.put(cacheKey(clipId, index), JSON.stringify(payload), {
          httpMetadata: { contentType: 'application/json' },
        });
      } catch {
        // A miss on the next play is the whole cost of failing here.
      }
    })());
  }

  return json(payload, 200, headers);
}

// Everything already transcribed for a clip, in one call. A recipient opening a
// shared link gets the transcript straight away, with no upload and no model run;
// whatever is missing the page fills in live from where the cache stops.
export async function handleFetchTranscript(request, env, id, headers) {
  if (!ID_RE.test(id)) return json({ error: 'Not found' }, 404, headers);
  if (!env.CLIPS) return json({ chunks: [] }, 200, headers);

  const cutoff = Date.now() - ttlDays(env) * 86400000;
  let keys = [];
  try {
    const listed = await env.CLIPS.list({ prefix: `tx/c/${id}/`, limit: 1000 });
    keys = listed.objects
      .filter((o) => !o.uploaded || o.uploaded.getTime() >= cutoff)
      .map((o) => o.key)
      .sort();
  } catch {
    return json({ chunks: [] }, 200, headers);
  }

  const chunks = [];
  const bodies = await Promise.all(keys.map((k) => env.CLIPS.get(k).catch(() => null)));
  for (const obj of bodies) {
    if (!obj) continue;
    try {
      const parsed = JSON.parse(await obj.text());
      if (parsed && Array.isArray(parsed.segments)) chunks.push(parsed);
    } catch {
      // One unreadable chunk should not cost the reader the rest of the transcript.
    }
  }

  chunks.sort((a, b) => a.i - b.i);
  return json({ chunks }, 200, {
    ...headers,
    // Short: the transcript grows while the first listener is still playing it.
    'Cache-Control': 'public, max-age=30',
  });
}
