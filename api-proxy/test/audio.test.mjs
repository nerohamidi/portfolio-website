// Clips, playlists and transcription. The chatbot half of the Worker is covered
// by worker.test.mjs; nothing here touches Gemini.

import worker from '../src/index.js';

const ORIGIN = 'https://nerohamidi.github.io';
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';       // 22 chars, the shape newId() produces

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// --- fakes -------------------------------------------------------------------

const sizeOf = (v) => (typeof v === 'string' ? Buffer.byteLength(v) : v.byteLength);

function wrap(key, rec) {
  return {
    key,
    size: sizeOf(rec.body),
    uploaded: rec.uploaded,
    httpEtag: '"etag-' + key + '"',
    customMetadata: rec.customMetadata || {},
    body: rec.body,
    range: undefined,
    writeHttpMetadata(headers) { headers.set('content-type', 'audio/mpeg'); },
    async text() { return typeof rec.body === 'string' ? rec.body : Buffer.from(rec.body).toString(); },
  };
}

function fakeBucket(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, { body: v.body ?? v, uploaded: v.uploaded ?? new Date(), customMetadata: v.customMetadata });
  }
  const calls = { get: 0, head: 0, put: 0 };
  return {
    store, calls,
    async get(key) { calls.get++; const r = store.get(key); return r ? wrap(key, r) : null; },
    async head(key) { calls.head++; const r = store.get(key); return r ? wrap(key, r) : null; },
    async put(key, body, opts = {}) {
      calls.put++;
      store.set(key, { body, uploaded: new Date(), customMetadata: opts.customMetadata });
    },
    async delete() {},
    async list({ prefix = '' } = {}) {
      const objects = [];
      for (const [k, r] of store) {
        if (k.startsWith(prefix)) objects.push({ key: k, size: sizeOf(r.body), uploaded: r.uploaded, customMetadata: r.customMetadata });
      }
      return { objects, truncated: false, cursor: undefined };
    },
  };
}

// Collected rather than dropped: the cache write and the usage counter both run
// under waitUntil, and the assertions below are about what they left behind.
function fakeCtx() {
  const jobs = [];
  return { waitUntil: (p) => jobs.push(p), settle: () => Promise.all(jobs) };
}

function fakeAI(result) {
  const seen = [];
  return {
    seen,
    async run(model, inputs) { seen.push({ model, inputs }); return result; },
  };
}

const WHISPER = {
  transcription_info: { language: 'en', duration: 4 },
  text: 'one two',
  segments: [{
    start: 0.5, end: 1.5, text: ' one two',
    words: [{ word: ' one', start: 0.5, end: 1.0 }, { word: ' two', start: 1.0, end: 1.5 }],
  }],
};

// 16 kHz mono 16-bit PCM, the shape the page sends.
function wav(seconds, rate = 16000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const transcribe = (body, env, ctx, { origin = ORIGIN, query = `?i=0&start=10&clip=${ID}` } = {}) =>
  worker.fetch(new Request('https://proxy/transcribe' + query, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/wav' }, body,
  }), env, ctx);

// --- transcribe --------------------------------------------------------------

let env = { AI: fakeAI(WHISPER), CLIPS: fakeBucket({ [`clips/${ID}`]: 'fake-audio' }) };
let ctx = fakeCtx();
let r = await transcribe(wav(4), env, ctx);
let j = await r.json();
await ctx.settle();

check('200 with segments', r.status === 200 && j.segments.length === 1, JSON.stringify(j).slice(0, 160));
check('segment times are shifted into track time', j.segments[0].s === 10.5 && j.segments[0].e === 11.5, JSON.stringify(j.segments[0]));
check('word times are shifted too', j.segments[0].w[0].s === 10.5 && j.segments[0].w[1].e === 11.5);
check('chunk end comes from the WAV, not the client', j.end === 14);
check('audio reaches the model as base64', typeof env.AI.seen[0].inputs.audio === 'string' && /^[A-Za-z0-9+/=]+$/.test(env.AI.seen[0].inputs.audio));
check('detected language is returned', j.language === 'en');
check('transcript is cached for the clip', env.CLIPS.store.has(`tx/c/${ID}/0000`));
check('audio seconds are counted against the day', Number(await env.CLIPS.store.get(`tx/usage/${new Date().toISOString().slice(0, 10)}`).body) === 4);

// A made-up clip id must not become a way to write objects into the bucket.
env = { AI: fakeAI(WHISPER), CLIPS: fakeBucket() };
ctx = fakeCtx();
r = await transcribe(wav(2), env, ctx);
await ctx.settle();
check('unknown clip id is not cached', r.status === 200 && ![...env.CLIPS.store.keys()].some((k) => k.startsWith('tx/c/')));

// Continuity hints from the page.
env = { AI: fakeAI(WHISPER), CLIPS: fakeBucket() };
ctx = fakeCtx();
await worker.fetch(new Request(`https://proxy/transcribe?i=3&start=36`, {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'audio/wav', 'X-Clip-Prev': 'the%20line%20before', 'X-Clip-Lang': 'fr' },
  body: wav(2),
}), env, ctx);
check('previous text is passed as the prompt', env.AI.seen[0].inputs.initial_prompt === 'the line before');
check('language hint is honoured', env.AI.seen[0].inputs.language === 'fr');

// Rejections.
env = { AI: fakeAI(WHISPER), CLIPS: fakeBucket() };
check('bad origin -> 403', (await transcribe(wav(1), env, fakeCtx(), { origin: 'https://evil.example' })).status === 403);
check('not a WAV -> 415', (await transcribe(new TextEncoder().encode('this is not audio at all'), env, fakeCtx())).status === 415);
check('bad chunk index -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=-2&start=0' })).status === 400);
check('bad clip id -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=0&start=0&clip=nope' })).status === 400);
check('missing start -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=0' })).status === 400);
check('GET -> 405', (await worker.fetch(new Request('https://proxy/transcribe', { headers: { Origin: ORIGIN } }), env)).status === 405);
check('model never ran for a rejected request', env.AI.seen.length === 0);

// Over-long window, measured from the header rather than from what was declared.
env = { AI: fakeAI(WHISPER), CLIPS: fakeBucket(), TRANSCRIBE_MAX_CHUNK_SECONDS: '30' };
r = await transcribe(wav(45), env, fakeCtx());
check('window past the cap -> 413', r.status === 413, String(r.status));
check('over-long window never reaches the model', env.AI.seen.length === 0);

// The daily budget.
const day = new Date().toISOString().slice(0, 10);
env = {
  AI: fakeAI(WHISPER),
  CLIPS: fakeBucket({ [`tx/usage/${day}`]: '7199' }),
  TRANSCRIBE_MAX_DAILY_SECONDS: '7200',
};
r = await transcribe(wav(10), env, fakeCtx());
j = await r.json();
check('spent budget -> 429', r.status === 429, String(r.status));
check('refusal explains itself', /daily limit/i.test(j.error), j.error);
check('nothing is billed once the budget is gone', env.AI.seen.length === 0);

// Missing binding.
r = await transcribe(wav(1), { CLIPS: fakeBucket() }, fakeCtx());
check('no AI binding -> 503', r.status === 503);

// --- reading a cached transcript ---------------------------------------------

env = { CLIPS: fakeBucket({
  [`tx/c/${ID}/0000`]: JSON.stringify({ i: 0, start: 0, end: 12, segments: [{ s: 1, e: 2, t: 'first', w: [] }] }),
  [`tx/c/${ID}/0002`]: JSON.stringify({ i: 2, start: 24, end: 36, segments: [{ s: 25, e: 26, t: 'third', w: [] }] }),
  [`tx/c/${ID}/0001`]: JSON.stringify({ i: 1, start: 12, end: 24, segments: [{ s: 13, e: 14, t: 'second', w: [] }] }),
}) };
r = await worker.fetch(new Request(`https://proxy/transcript/${ID}`, { headers: { Origin: ORIGIN } }), env);
j = await r.json();
check('cached chunks come back in order', j.chunks.map((c) => c.i).join() === '0,1,2', JSON.stringify(j.chunks.map((c) => c.i)));
check('segments survive the round trip', j.chunks[1].segments[0].t === 'second');
check('a transcript is readable from any origin', r.headers.get('Access-Control-Allow-Origin') === '*');
check('nothing cached is not an error', (await (await worker.fetch(new Request('https://proxy/transcript/BBBBBBBBBBBBBBBBBBBBBB', { headers: { Origin: ORIGIN } }), env)).json()).chunks.length === 0);
check('bad transcript id -> 404', (await worker.fetch(new Request('https://proxy/transcript/nope', { headers: { Origin: ORIGIN } }), env)).status === 404);

// An expired transcript must not outlive the clip it describes.
env = { CLIPS: fakeBucket({
  [`tx/c/${ID}/0000`]: { body: JSON.stringify({ i: 0, start: 0, end: 12, segments: [{ s: 1, e: 2, t: 'stale', w: [] }] }),
    uploaded: new Date(Date.now() - 40 * 86400000) },
}), CLIP_TTL_DAYS: '30' };
j = await (await worker.fetch(new Request(`https://proxy/transcript/${ID}`, { headers: { Origin: ORIGIN } }), env)).json();
check('transcript past the TTL is not served', j.chunks.length === 0, JSON.stringify(j));

// --- clip metadata, which is what labels a playlist --------------------------

env = { CLIPS: fakeBucket({ [`clips/${ID}`]: { body: 'audio-bytes', customMetadata: { name: 'my song.mp3' } } }) };
r = await worker.fetch(new Request(`https://proxy/clip/${ID}`, { method: 'HEAD', headers: { Origin: ORIGIN } }), env);
check('HEAD returns the stored name', decodeURIComponent(r.headers.get('X-Clip-Name')) === 'my song.mp3', r.headers.get('X-Clip-Name'));
check('HEAD reads metadata, not the object', env.CLIPS.calls.head === 1 && env.CLIPS.calls.get === 0);
check('HEAD carries no body', (await r.text()) === '');
check('the name header is exposed to the page', (r.headers.get('Access-Control-Expose-Headers') || '').includes('X-Clip-Name'));

r = await worker.fetch(new Request(`https://proxy/clip/${ID}`, { headers: { Origin: ORIGIN } }), env);
check('GET carries the name too', decodeURIComponent(r.headers.get('X-Clip-Name')) === 'my song.mp3');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
