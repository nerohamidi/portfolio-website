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
  const calls = { get: 0, head: 0, put: 0, delete: 0 };
  return {
    store, calls,
    async get(key) { calls.get++; const r = store.get(key); return r ? wrap(key, r) : null; },
    async head(key) { calls.head++; const r = store.get(key); return r ? wrap(key, r) : null; },
    async put(key, body, opts = {}) {
      calls.put++;
      store.set(key, { body, uploaded: new Date(), customMetadata: opts.customMetadata });
    },
    async delete(keys) {
      calls.delete++;
      for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
    },
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

// Transcription is an HTTPS call to Gemini now rather than a binding, so the fake
// is a stand-in for global fetch. Installed once for the whole file: nothing else
// here reaches the network, and a call that is not the model would show up in
// `seen` as an unexpected entry rather than escaping.
const GEMINI = {
  language: 'en',
  segments: [{ text: 'one two', start: 0.5, end: 1.5 }],
};

const gemini = { seen: [], reply: GEMINI, status: 200, text: null };
globalThis.fetch = async (url, init) => {
  gemini.seen.push({ url: String(url), body: JSON.parse(init.body) });
  if (gemini.status !== 200) return new Response('upstream said no', { status: gemini.status });
  const answer = gemini.text !== null ? gemini.text : JSON.stringify(gemini.reply);
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
const resetGemini = () => {
  gemini.seen = [];
  gemini.reply = GEMINI;
  gemini.status = 200;
  gemini.text = null;
};

// What the model was told for a given call: the instruction part of the prompt.
const askedFor = (call) => call.body.contents[0].parts[0].text;
const audioSent = (call) => call.body.contents[0].parts[1].inlineData;

const KEYED = { GEMINI_API_KEY: 'test-key' };

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

let env = { ...KEYED, CLIPS: fakeBucket({ [`clips/${ID}`]: 'fake-audio' }) };
let ctx = fakeCtx();
let r = await transcribe(wav(4), env, ctx);
let j = await r.json();
await ctx.settle();

check('200 with segments', r.status === 200 && j.segments.length === 1, JSON.stringify(j).slice(0, 160));
check('segment times are shifted into track time', j.segments[0].s === 10.5 && j.segments[0].e === 11.5, JSON.stringify(j.segments[0]));
// No word timings come back from this model, and the page spreads a line over
// its own span when they are missing. The field still has to be there.
check('a segment carries a word list, empty or not', Array.isArray(j.segments[0].w) && j.segments[0].w.length === 0, JSON.stringify(j.segments[0]));
check('chunk end comes from the WAV, not the client', j.end === 14);
check('the request goes to the configured model', /models\/gemini[^:]*:generateContent/.test(gemini.seen[0].url), gemini.seen[0].url);
check('audio reaches the model as base64 WAV', audioSent(gemini.seen[0]).mimeType === 'audio/wav' &&
  /^[A-Za-z0-9+/=]+$/.test(audioSent(gemini.seen[0]).data), JSON.stringify(audioSent(gemini.seen[0])).slice(0, 80));
check('and JSON is asked for against a schema', gemini.seen[0].body.generationConfig.responseMimeType === 'application/json' &&
  Boolean(gemini.seen[0].body.generationConfig.responseSchema));
check('the window length is stated in the prompt', /4\.0 seconds/.test(askedFor(gemini.seen[0])), askedFor(gemini.seen[0]));
check('detected language is returned', j.language === 'en');
check('transcript is cached for the clip', env.CLIPS.store.has(`tx/c/${ID}/0000`));
check('audio seconds are counted against the day', Number(await env.CLIPS.store.get(`tx/usage/${new Date().toISOString().slice(0, 10)}`).body) === 4);

// A made-up clip id must not become a way to write objects into the bucket.
resetGemini();
env = { ...KEYED, CLIPS: fakeBucket() };
ctx = fakeCtx();
r = await transcribe(wav(2), env, ctx);
await ctx.settle();
check('unknown clip id is not cached', r.status === 200 && ![...env.CLIPS.store.keys()].some((k) => k.startsWith('tx/c/')));

// Continuity hints from the page.
resetGemini();
env = { ...KEYED, CLIPS: fakeBucket() };
ctx = fakeCtx();
await worker.fetch(new Request(`https://proxy/transcribe?i=3&start=36`, {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'audio/wav', 'X-Clip-Prev': 'the%20line%20before', 'X-Clip-Lang': 'fr' },
  body: wav(2),
}), env, ctx);
check('previous text is carried into the prompt', askedFor(gemini.seen[0]).includes('the line before'), askedFor(gemini.seen[0]));
check('and it says not to repeat it', /do not repeat/i.test(askedFor(gemini.seen[0])), askedFor(gemini.seen[0]));
check('language hint is honoured', /in fr\b/.test(askedFor(gemini.seen[0])), askedFor(gemini.seen[0]));

// Rejections.
resetGemini();
env = { ...KEYED, CLIPS: fakeBucket() };
check('bad origin -> 403', (await transcribe(wav(1), env, fakeCtx(), { origin: 'https://evil.example' })).status === 403);
check('not a WAV -> 415', (await transcribe(new TextEncoder().encode('this is not audio at all'), env, fakeCtx())).status === 415);
check('bad chunk index -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=-2&start=0' })).status === 400);
check('bad clip id -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=0&start=0&clip=nope' })).status === 400);
check('missing start -> 400', (await transcribe(wav(1), env, fakeCtx(), { query: '?i=0' })).status === 400);
check('GET -> 405', (await worker.fetch(new Request('https://proxy/transcribe', { headers: { Origin: ORIGIN } }), env)).status === 405);
check('model never ran for a rejected request', gemini.seen.length === 0, String(gemini.seen.length));

// Over-long window, measured from the header rather than from what was declared.
env = { ...KEYED, CLIPS: fakeBucket(), TRANSCRIBE_MAX_CHUNK_SECONDS: '30' };
r = await transcribe(wav(45), env, fakeCtx());
check('window past the cap -> 413', r.status === 413, String(r.status));
check('over-long window never reaches the model', gemini.seen.length === 0);

// The daily budget.
const day = new Date().toISOString().slice(0, 10);
env = {
  ...KEYED,
  CLIPS: fakeBucket({ [`tx/usage/${day}`]: '7199' }),
  TRANSCRIBE_MAX_DAILY_SECONDS: '7200',
};
r = await transcribe(wav(10), env, fakeCtx());
j = await r.json();
check('spent budget -> 429', r.status === 429, String(r.status));
check('refusal explains itself', /daily limit/i.test(j.error), j.error);
check('nothing is billed once the budget is gone', gemini.seen.length === 0);

// Missing credential.
r = await transcribe(wav(1), { CLIPS: fakeBucket() }, fakeCtx());
check('no Gemini key -> 503', r.status === 503);

// What comes back from the model is not trusted to be sane. A timing outside the
// window it was given belongs to no part of the track.
resetGemini();
gemini.reply = { language: 'en', segments: [
  { text: 'inside', start: 1, end: 2 },
  { text: 'invented', start: 90, end: 95 },
  { text: 'backwards', start: 3, end: 1 },
] };
r = await transcribe(wav(4), { ...KEYED, CLIPS: fakeBucket() }, fakeCtx(), { query: '?i=0&start=0' });
j = await r.json();
check('a segment past the end of the window is dropped', j.segments.length === 2, JSON.stringify(j.segments));
check('and one that ends before it starts is straightened out', j.segments[1].e > j.segments[1].s, JSON.stringify(j.segments[1]));

// An upstream refusal, and an answer that is not the JSON that was asked for,
// are both one 502 rather than a caption made of error text.
resetGemini();
gemini.status = 503;
r = await transcribe(wav(2), { ...KEYED, CLIPS: fakeBucket() }, fakeCtx());
check('an upstream failure -> 502', r.status === 502, String(r.status));

resetGemini();
gemini.text = 'I am terribly sorry, but I cannot do that.';
r = await transcribe(wav(2), { ...KEYED, CLIPS: fakeBucket() }, fakeCtx());
check('an answer that is not JSON -> 502', r.status === 502, String(r.status));
check('and nothing of it reaches the page', !/terribly sorry/.test(await r.text()));

resetGemini();

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


// --- the upload key, and deleting from the bucket ----------------------------

// An ID3 header is all sniffAudio needs to accept the body as an MP3.
const mp3 = (bytes) => {
  const b = Buffer.alloc(bytes);
  b.write('ID3', 0);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const limiter = () => {
  const calls = [];
  return { calls, async limit(opts) { calls.push(opts); return { success: true }; } };
};

const upload = (body, env, key) => {
  const headers = { Origin: ORIGIN, 'Content-Type': 'audio/mpeg', 'X-Clip-Name': 'song.mp3' };
  if (key !== undefined) headers['X-Clip-Key'] = key;
  return worker.fetch(new Request('https://proxy/clip', { method: 'POST', headers, body }), env, fakeCtx());
};

// Small ceilings so the bodies stay small: 1 KB normally, 8 KB with the key.
const keyed = (extra = {}) => ({
  CLIPS: fakeBucket(),
  CLIP_ADMIN_KEY: 'open-sesame',
  CLIP_MAX_BYTES: '1024',
  CLIP_MAX_BYTES_UNLOCKED: '8192',
  ...extra,
});

env = keyed();
check('an ordinary upload under the cap is stored', (await upload(mp3(500), env)).status === 200);
check('and over it is refused', (await upload(mp3(2000), keyed())).status === 413);

env = keyed();
r = await upload(mp3(2000), env, 'open-sesame');
check('the key lifts the size cap', r.status === 200, String(r.status) + ' ' + JSON.stringify(await r.clone().json()));
check('and the clip really lands in the bucket', [...env.CLIPS.store.keys()].some((k) => k.startsWith('clips/')));
check('but not past the unlocked cap', (await upload(mp3(9000), keyed(), 'open-sesame')).status === 413);

r = await upload(mp3(500), keyed(), 'wrong-key');
j = await r.json();
check('a wrong key is refused outright', r.status === 403, String(r.status));
check('and says so rather than quoting a size limit', /upload key/i.test(j.error), j.error);

// An absent secret must never read as "anything matches".
r = await upload(mp3(500), { CLIPS: fakeBucket(), CLIP_MAX_BYTES: '1024' }, 'open-sesame');
check('with no secret configured every key is refused', r.status === 403, String(r.status));

// The limiter, and who skips it.
let lim = limiter();
await upload(mp3(500), keyed({ CLIP_UPLOADS: lim }));
check('an unkeyed upload is rate limited', lim.calls.length === 1, String(lim.calls.length));

lim = limiter();
await upload(mp3(2000), keyed({ CLIP_UPLOADS: lim }), 'open-sesame');
check('a keyed upload skips the limiter', lim.calls.length === 0, String(lim.calls.length));

lim = limiter();
await upload(mp3(500), keyed({ CLIP_UPLOADS: lim }), 'wrong-key');
check('a wrong key is throttled before it is refused', lim.calls.length === 1, String(lim.calls.length));

// The key waives the share the uploader gets, but never the bucket ceiling: that
// one is the line between the free tier and a bill.
r = await upload(mp3(2000), keyed({ CLIP_MAX_PER_UPLOADER_BYTES: '10' }), 'open-sesame');
check('the key waives the per-uploader cap', r.status === 200, String(r.status));
r = await upload(mp3(2000), keyed({ CLIP_MAX_TOTAL_BYTES: '100' }), 'open-sesame');
check('but not the bucket ceiling', r.status === 507, String(r.status));

// --- delete ---

const del = (id, origin = ORIGIN) =>
  worker.fetch(new Request(`https://proxy/clip/${id}`, { method: 'DELETE', headers: { Origin: origin } }), env);

env = { CLIPS: fakeBucket({
  [`clips/${ID}`]: 'audio-bytes',
  [`tx/c/${ID}/0000`]: JSON.stringify({ i: 0, segments: [] }),
  [`tx/c/${ID}/0001`]: JSON.stringify({ i: 1, segments: [] }),
  'clips/BBBBBBBBBBBBBBBBBBBBBB': 'someone-elses',
}) };
r = await del(ID);
j = await r.json();
check('delete reports what it removed', r.status === 200 && j.deleted === true && j.id === ID, JSON.stringify(j));
check('the audio is gone', !env.CLIPS.store.has(`clips/${ID}`));
check('and so is every cached transcript window', ![...env.CLIPS.store.keys()].some((k) => k.startsWith(`tx/c/${ID}/`)));
check('another clip is untouched', env.CLIPS.store.has('clips/BBBBBBBBBBBBBBBBBBBBBB'));

check('deleting it again reports it already gone', (await del(ID)).status === 404);
check('a malformed id is a 404, not a sweep', (await del('not-an-id')).status === 404);

// The whole point: a recipient deletes from wherever they opened the link.
env = { CLIPS: fakeBucket({ [`clips/${ID}`]: 'audio-bytes' }) };
r = await del(ID, 'https://somewhere-else.example');
check('a stranger holding the link can delete it', r.status === 200, String(r.status));
check('the delete answers any origin', r.headers.get('Access-Control-Allow-Origin') === '*');
check('and DELETE is advertised in the preflight', (await worker.fetch(new Request(`https://proxy/clip/${ID}`, {
  method: 'OPTIONS', headers: { Origin: ORIGIN },
}), env)).headers.get('Access-Control-Allow-Methods').includes('DELETE'));

// A transcript can outlive its audio once the lifecycle rule sweeps clips/. A
// delete has to reach it anyway, or the words stay readable after the track is gone.
env = { CLIPS: fakeBucket({ [`tx/c/${ID}/0000`]: JSON.stringify({ i: 0, segments: [] }) }) };
r = await del(ID);
check('an orphaned transcript is swept even though the clip is gone', r.status === 404 && env.CLIPS.store.size === 0, String(env.CLIPS.store.size));


// --- the delete password ------------------------------------------------------
//
// A clip id is the delete permission by default. An uploader who does not want
// that sets a password as the clip goes up, and only then. Fewer rounds here than
// in production: the test is about the gate, not about how slow it is.
const LOCKED = { CLIP_LOCK_ITERATIONS: '1000' };

const uploadLocked = (env, password) =>
  worker.fetch(new Request('https://proxy/clip', {
    method: 'POST',
    headers: {
      Origin: ORIGIN, 'Content-Type': 'audio/mpeg', 'X-Clip-Name': 'song.mp3',
      ...(password === undefined ? {} : { 'X-Clip-Lock': password }),
    },
    body: mp3(500),
  }), env, fakeCtx());

const delWith = (env, id, password) =>
  worker.fetch(new Request(`https://proxy/clip/${id}`, {
    method: 'DELETE',
    headers: { Origin: ORIGIN, ...(password === undefined ? {} : { 'X-Clip-Lock': password }) },
  }), env);

env = { CLIPS: fakeBucket(), ...LOCKED };
r = await uploadLocked(env, 'hunter2');
j = await r.json();
const lockedId = j.id;
check('an upload can set a delete password', r.status === 200 && j.locked === true, JSON.stringify(j));

const storedLock = env.CLIPS.store.get(`clips/${lockedId}`).customMetadata;
check('the password itself is never stored', !JSON.stringify(storedLock).includes('hunter2'), JSON.stringify(storedLock));
check('a salt and an iteration count are stored with it', Boolean(storedLock.lockSalt) && storedLock.lockIter === '1000');

r = await worker.fetch(new Request(`https://proxy/clip/${lockedId}`, { method: 'HEAD', headers: { Origin: ORIGIN } }), env);
check('the clip says it is locked before anyone presses delete', r.headers.get('X-Clip-Locked') === '1');
check('and that header is readable from the page', (await worker.fetch(new Request(`https://proxy/clip/${lockedId}`, {
  method: 'OPTIONS', headers: { Origin: ORIGIN },
}), env)).headers.get('Access-Control-Expose-Headers').includes('X-Clip-Locked'));

r = await delWith(env, lockedId);
j = await r.json();
check('deleting without the password -> 401', r.status === 401, String(r.status));
check('and it says a password is what is missing', j.locked === true && /password/i.test(j.error), j.error);
check('the clip is still there', env.CLIPS.store.has(`clips/${lockedId}`));

r = await delWith(env, lockedId, 'hunter3');
check('a wrong password -> 403', r.status === 403, String(r.status));
check('a wrong password is told apart from a missing one', /does not match/i.test((await r.json()).error));
check('and the clip survives that too', env.CLIPS.store.has(`clips/${lockedId}`));

r = await delWith(env, lockedId, 'hunter2');
check('the right password deletes it', r.status === 200, String(r.status));
check('and the audio is really gone', !env.CLIPS.store.has(`clips/${lockedId}`));

// An unlocked clip keeps the old behaviour exactly: the link is the permission.
env = { CLIPS: fakeBucket(), ...LOCKED };
j = await (await uploadLocked(env)).json();
check('an upload without a password is not locked', j.locked === false);
r = await worker.fetch(new Request(`https://proxy/clip/${j.id}`, { method: 'HEAD', headers: { Origin: ORIGIN } }), env);
check('and says nothing about a lock', r.headers.get('X-Clip-Locked') === null);
check('anyone holding its link still deletes it', (await delWith(env, j.id)).status === 200);

// Guessing is throttled before the password is even looked at.
env = { CLIPS: fakeBucket(), ...LOCKED };
j = await (await uploadLocked(env, 'hunter2')).json();
lim = { calls: [], async limit(o) { this.calls.push(o); return { success: this.calls.length < 3 }; } };
env.CLIP_DELETES = lim;
await delWith(env, j.id, 'guess-1');
await delWith(env, j.id, 'guess-2');
r = await delWith(env, j.id, 'hunter2');
check('delete attempts are rate limited', r.status === 429, String(r.status));
check('and the limiter runs before the password check', lim.calls.length === 3, String(lim.calls.length));
check('so a throttled guess cannot delete', env.CLIPS.store.has(`clips/${j.id}`));

// --- share cards --------------------------------------------------------------
//
// A fragment never reaches a server, so a link straight to the static page cannot
// preview. A card is a real document on this Worker carrying the sender's words
// in its meta tags, which forwards on to the same hash.

const HASH = 'v=3&flt=off,500,1&viz=1,1&vol=0.7&t=' + ID;

const makeCard = (env, body, { origin = ORIGIN, password } = {}) =>
  worker.fetch(new Request('https://proxy/share', {
    method: 'POST',
    headers: {
      Origin: origin, 'Content-Type': 'application/json',
      ...(password ? { 'X-Clip-Lock': password } : {}),
    },
    body: JSON.stringify(body),
  }), env, fakeCtx());

env = { CLIPS: fakeBucket() };
r = await makeCard(env, { hash: HASH, title: 'Late night mix', note: 'Track 3 is the one.' });
j = await r.json();
const cardId = j.id;
check('a card is created', r.status === 200 && /\/s\/[A-Za-z0-9_-]{22}$/.test(j.url), JSON.stringify(j));

r = await worker.fetch(new Request(`https://proxy/s/${cardId}`), env);
let html = await r.text();
check('the card is served as HTML', r.status === 200 && r.headers.get('Content-Type').startsWith('text/html'));
check('with the sender\'s title in og:title', html.includes('<meta property="og:title" content="Late night mix">'), html.slice(0, 400));
check('and their note in og:description', html.includes('<meta property="og:description" content="Track 3 is the one.">'));
check('the page title is the sender\'s title too', html.includes('<title>Late night mix</title>'));
check('it forwards to the page with the whole hash', html.includes('#' + HASH), html.slice(0, 800));
check('and hands the page its own id so the card can be deleted', html.includes('&s=' + cardId));
check('an unfurler is not redirected away before it reads the tags', r.status === 200 && !r.headers.get('Location'));
// An unfurler that re-fetches what og:url names has to land back on the card. On
// the destination it would read the static page's own generic tags instead.
check('og:url names the card, not the page it forwards to', html.includes(`<meta property="og:url" content="https://proxy/s/${cardId}">`), html.slice(0, 700));

// The title is a stranger's text going into a document this Worker serves.
r = await makeCard(env, { hash: HASH, title: '</title><script>alert(1)</script>', note: 'x" onload="evil()' });
html = await (await worker.fetch(new Request(`https://proxy/s/${(await r.json()).id}`), env)).text();
check('a title cannot close its own tag', !html.includes('<script>alert(1)'), html.slice(0, 600));
check('and a note cannot break out of an attribute', !html.includes('onload="evil()'), html.slice(0, 900));

// The destination is the Worker's, never the caller's.
r = await makeCard(env, { hash: HASH, title: 'Hi', base: 'https://evil.example/', url: 'https://evil.example/' });
html = await (await worker.fetch(new Request(`https://proxy/s/${(await r.json()).id}`), env)).text();
check('a card cannot be pointed at another site', !html.includes('evil.example'), html.slice(0, 600));

check('a card needs something to say', (await makeCard(env, { hash: HASH })).status === 400);
check('a hash that is not one is refused', (await makeCard(env, { hash: '<script>', title: 'Hi' })).status === 400);
check('an enormous hash is refused', (await makeCard(env, { hash: 'v=3&t=' + 'a'.repeat(3000), title: 'Hi' })).status === 400);
check('a stranger cannot create one', (await makeCard(env, { hash: HASH, title: 'Hi' }, { origin: 'https://evil.example' })).status === 403);
check('an unknown card is a 404', (await worker.fetch(new Request('https://proxy/s/' + 'Z'.repeat(22)), env)).status === 404);

// A card is deleted the way a clip is, and takes the same password.
env = { CLIPS: fakeBucket(), ...LOCKED };
j = await (await makeCard(env, { hash: HASH, title: 'Locked' }, { password: 'hunter2' })).json();
const delCard = (password) => worker.fetch(new Request(`https://proxy/share/${j.id}`, {
  method: 'DELETE',
  headers: { Origin: ORIGIN, ...(password ? { 'X-Clip-Lock': password } : {}) },
}), env);
check('a locked card refuses a delete with no password', (await delCard()).status === 401);
check('and one with the wrong password', (await delCard('nope')).status === 403);
check('the right password takes it down', (await delCard('hunter2')).status === 200);
check('and it stops being served', (await worker.fetch(new Request(`https://proxy/s/${j.id}`), env)).status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
