// Signal Share's page logic, driven in jsdom: the hash format, the queue
// bookkeeping and the transcript wiring are the parts that are easy to get
// subtly wrong and impossible to see in a diff.
//
// Unlike api-proxy/test, this one needs a dependency:
//
//   npm install jsdom && node test/audio-page.test.mjs
//
// node_modules is not committed and the site build never looks at this file;
// _config.yml excludes the directory so Jekyll does not publish it.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const markup = fs.readFileSync(ROOT + '/_includes/audio-app.html', 'utf8');
let engine = fs.readFileSync(ROOT + '/_includes/audio-engine.html', 'utf8')
  .split('<script>')[1].split('</script>')[0]
  .replace('{{ "/assets/audio/symphony.mp3" | relative_url }}', '/assets/audio/symphony.mp3');

// A window onto the closure, so the tests can look at state the page keeps private.
engine = engine.replace('  sizeCanvas();\n  draw();\n})();', `
  window.__probe = {
    encodeState: encodeState,
    decodeState: decodeState,
    applyState: applyState,
    addTracks: addTracks,
    newEntry: newEntry,
    removeAt: removeAt,
    moveAt: moveAt,
    playIndex: playIndex,
    txFollow: txFollow,
    txPump: txPump,
    txCut: txCut,
    state: function() {
      return { queue: queue, current: current, txSegments: txSegments, txNext: txNext, txDone: txDone };
    },
    setQueue: function(q, c) { queue = q; current = c; renderQueue(); },
  };
  sizeCanvas();
  draw();
})();`);

function boot(hash, fetchImpl) {
  const dom = new JSDOM(
    '<!doctype html><body class="dark-mode"><div id="wrap"></div></body>',
    { url: 'https://nerohamidi.github.io/portfolio-website/playroom/audio/' + (hash || ''), runScripts: 'outside-only' },
  );
  const w = dom.window;
  w.document.getElementById('wrap').innerHTML = markup;

  // --- Web Audio, reduced to what the engine touches ---
  const param = (v) => ({ value: v, setValueAtTime() {} });
  const node = () => ({ connect() { return this; }, disconnect() {} });
  const buffer = (duration) => ({
    duration, sampleRate: 44100, numberOfChannels: 1,
    getChannelData: () => new Float32Array(Math.round(duration * 44100)),
  });
  w.AudioContext = function () {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = node();
    this.resume = () => {};
    this.createGain = () => Object.assign(node(), { gain: param(1) });
    this.createBiquadFilter = () => Object.assign(node(), { type: 'lowpass', frequency: param(350), Q: param(1) });
    this.createAnalyser = () => Object.assign(node(), {
      fftSize: 2048, frequencyBinCount: 1024,
      getByteTimeDomainData() {}, getByteFrequencyData() {}, getFloatTimeDomainData() {},
    });
    this.createBufferSource = () => Object.assign(node(), {
      buffer: null, playbackRate: param(1), onended: null,
      start() { this.started = true; }, stop() {},
    });
    this.decodeAudioData = (bytes, ok) => { const b = buffer(120); if (ok) ok(b); return Promise.resolve(b); };
  };
  w.OfflineAudioContext = function (channels, frames, rate) {
    this.destination = node();
    this.createBufferSource = () => Object.assign(node(), { buffer: null, playbackRate: param(1), start() {} });
    this.startRendering = () => Promise.resolve({
      duration: frames / rate, sampleRate: rate, numberOfChannels: 1,
      getChannelData: () => new Float32Array(frames),
    });
  };
  w.requestAnimationFrame = () => 0;
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({}) });
  w.fetch = fetchImpl || (() => Promise.reject(new Error('no fetch in this test')));
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};

  w.eval(engine);
  return w;
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const res = (body, headers = {}) => Promise.resolve({
  ok: true, status: 200,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: () => Promise.resolve(body),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
});

// --- 1. a v3 playlist link restores the whole queue --------------------------

let seen = [];
let w = boot(`#v=3&flt=lp,500,1&viz=1,1&vol=0.7&t=d,${ID_A},${ID_B}&i=1&n=second.mp3`, (url, init) => {
  seen.push((init && init.method) || 'GET');
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/clip/')) return res({}, { 'x-clip-name': encodeURIComponent('real name.mp3') });
  return res({});
});
await settle();
let st = w.__probe.state();

check('playlist link restores every track', st.queue.length === 3, JSON.stringify(st.queue.map((e) => e.ref)));
check('refs decode back to demo and clips', st.queue[0].ref === 'demo' && st.queue[1].ref === 'clip:' + ID_A && st.queue[2].ref === 'clip:' + ID_B);
check('it opens on the shared index', st.current === 1);
check('the clip\'s own name wins over the hash label', st.queue[1].name === 'real name.mp3', st.queue[1].name);
check('other clips are labelled from their own metadata', st.queue[2].name === 'real name.mp3', st.queue[2].name);
check('the playlist panel is shown', !w.document.getElementById('aud-queue').classList.contains('hidden'));
check('a row is rendered per track', w.document.getElementById('aud-q-list').children.length === 3);
check('prev/next appear for a playlist', !w.document.getElementById('aud-next').classList.contains('hidden'));
check('the shared note counts the tracks', /3 track/.test(w.document.getElementById('aud-shared-detail').textContent), w.document.getElementById('aud-shared-detail').textContent);
check('the filter from the link is applied', w.document.querySelector('[data-filter="lowpass"]').classList.contains('is-on'));

// --- 2. a v2 link still works ------------------------------------------------

w = boot(`#v=2&flt=bp,600,2&viz=1,0&vol=0.5&p=3&a=clip:${ID_A}&n=old%20song.mp3`, (url) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  return res({}, {});
});
await settle();
st = w.__probe.state();
check('v2 link restores its one track', st.queue.length === 1 && st.queue[0].ref === 'clip:' + ID_A, JSON.stringify(st.queue));
check('v2 name is kept', st.queue[0].name === 'old song.mp3');
check('v2 pitch is applied', w.document.getElementById('aud-pitch-val').textContent === '+3 st');
check('v2 spectrum toggle is applied', !w.document.getElementById('aud-view-freq').classList.contains('is-on'));

// --- 3. the hash a share produces --------------------------------------------

w = boot('', () => res({ chunks: [] }));
w.__probe.setQueue([
  w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' }),
  w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'a.mp3' }),
  w.__probe.newEntry({ name: 'never-uploaded.mp3', file: {} }),
], 1);
let hash = w.__probe.encodeState();
check('share hash is v3', /(^|&)v=3(&|$)/.test(hash), hash);
check('share hash lists the shareable refs', /(^|&)t=d,AAAAAAAAAAAAAAAAAAAAAA(&|$)/.test(hash), hash);
check('a local file is left out of the link', !hash.includes('never-uploaded'), hash);
check('the opening index travels', /(^|&)i=1(&|$)/.test(hash), hash);

let round = w.__probe.decodeState('#' + hash);
check('the hash decodes back', round.v === '3' && round.t === 'd,' + ID_A && round.i === '1', JSON.stringify(round));

// --- 4. queue bookkeeping ----------------------------------------------------

w = boot('', () => res({ chunks: [] }));
const four = ['one', 'two', 'three', 'four'].map((n) => w.__probe.newEntry({ ref: 'demo', name: n }));
w.__probe.setQueue(four, 2);
w.__probe.moveAt(2, -1);
st = w.__probe.state();
check('moving a track carries the playhead with it', st.queue.map((e) => e.name).join() === 'one,three,two,four' && st.current === 1, st.queue.map((e) => e.name).join() + ' @' + st.current);

w.__probe.setQueue(four.slice(), 2);
w.__probe.removeAt(0);
st = w.__probe.state();
check('removing an earlier track shifts the index down', st.current === 1 && st.queue.length === 3, 'current=' + st.current);

w.__probe.setQueue(['a', 'b', 'c'].map((n) => w.__probe.newEntry({ ref: 'demo', name: n })), 2);
w.__probe.removeAt(2);
st = w.__probe.state();
check('removing the last track falls back to the new last', st.current === 1 && st.queue.length === 2, 'current=' + st.current);

w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'only' })], 0);
w.__probe.removeAt(0);
st = w.__probe.state();
check('emptying the queue returns to the drop zone', st.queue.length === 0 && st.current === -1 &&
  !w.document.getElementById('aud-drop').classList.contains('hidden') &&
  w.document.getElementById('aud-player').classList.contains('hidden'));

// --- 5. a shared clip arrives with its transcript ----------------------------

const cached = {
  chunks: [
    { i: 0, start: 0, end: 12, language: 'en', segments: [{ s: 0.5, e: 3, t: 'the first line', w: [{ t: 'the', s: 0.5, e: 1 }, { t: ' first', s: 1, e: 2 }, { t: ' line', s: 2, e: 3 }] }] },
    { i: 1, start: 12, end: 24, segments: [{ s: 13, e: 15, t: 'the second line', w: [] }] },
  ],
};
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=${ID_A}`, (url) => {
  if (url.includes('/transcript/')) return res(cached);
  return res({}, { 'x-clip-name': encodeURIComponent('talk.mp3') });
});
await settle();
st = w.__probe.state();
check('a cached transcript is adopted', st.txSegments.length === 2, JSON.stringify(st.txSegments.map((s) => s.t)));
check('transcription resumes where the cache stops', st.txNext === 24, String(st.txNext));
check('a partial transcript is not marked finished', st.txDone === false);
check('transcript rows are rendered', w.document.getElementById('aud-tx-lines').children.length === 2);
check('the transcript panel opens itself', !w.document.getElementById('aud-tx-lines').classList.contains('hidden'));
check('the status says the transcript came along', /already transcribed/i.test(w.document.getElementById('aud-tx-status').textContent), w.document.getElementById('aud-tx-status').textContent);
check('rows are timestamped', w.document.querySelector('.aud-tx-at').textContent === '0:00');
check('the button offers to carry on', w.document.getElementById('aud-tx-btn').textContent === 'Keep transcribing', w.document.getElementById('aud-tx-btn').textContent);

// Nothing is under the playhead before the first line starts.
w.__probe.txFollow();
check('the caption is empty before the first line', w.document.getElementById('aud-caption-line').textContent === '');
check('but the caption keeps its place in the layout', !w.document.getElementById('aud-caption').classList.contains('hidden'));

// Seek into the first line, then look again.
w.document.querySelectorAll('.aud-tx-seek')[0].click();
w.__probe.txFollow();
check('the caption shows the line under the playhead', w.document.getElementById('aud-caption-line').textContent.replace(/\s+/g, ' ').trim() === 'the first line', JSON.stringify(w.document.getElementById('aud-caption-line').textContent));
check('the caption is split into word spans', w.document.querySelectorAll('.aud-cap-w').length === 3);
check('the word under the playhead is marked', w.document.querySelectorAll('.aud-cap-w.is-now').length === 1);
check('the matching transcript row is marked', w.document.querySelectorAll('.aud-tx-line.is-on').length === 1);

// Clicking a transcript row seeks.
w.document.querySelectorAll('.aud-tx-seek')[1].click();
check('clicking a line seeks to it', Number(w.document.getElementById('aud-seek').value) === 13, w.document.getElementById('aud-seek').value);
check('the clock follows the seek', w.document.getElementById('aud-current').textContent === '0:13');

// --- 6. sharing a playlist of local files ------------------------------------

let uploads = 0;
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.endsWith('/clip') && init && init.method === 'POST') {
    uploads++;
    return res({ id: uploads === 1 ? ID_A : ID_B, name: 'track' + uploads + '.mp3', expiresInDays: 30 });
  }
  return res({}, {});
});
w.__probe.setQueue([
  w.__probe.newEntry({ name: 'one.mp3', file: { name: 'one.mp3', type: 'audio/mpeg' } }),
  w.__probe.newEntry({ name: 'two.mp3', file: { name: 'two.mp3', type: 'audio/mpeg' } }),
], 0);
w.document.getElementById('aud-share-btn').click();
await settle();
st = w.__probe.state();
check('every local file is uploaded', uploads === 2, String(uploads));
check('uploads happen one at a time', st.queue.every((e) => e.ref && !e.file), JSON.stringify(st.queue.map((e) => e.ref)));
check('the link carries both new clips', w.document.getElementById('aud-share-link').value.includes(ID_A + ',' + ID_B), w.document.getElementById('aud-share-link').value);
check('the share status reports the expiry', /works for 30 days/.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);

// A failure mid-batch keeps what already went up.
uploads = 0;
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.endsWith('/clip') && init && init.method === 'POST') {
    uploads++;
    if (uploads === 2) return Promise.resolve({ ok: false, status: 507, headers: { get: () => null }, json: () => Promise.resolve({ error: 'The clip library is full right now.' }) });
    return res({ id: ID_A, name: 'one.mp3', expiresInDays: 30 });
  }
  return res({}, {});
});
w.__probe.setQueue([
  w.__probe.newEntry({ name: 'one.mp3', file: { name: 'one.mp3' } }),
  w.__probe.newEntry({ name: 'two.mp3', file: { name: 'two.mp3' } }),
], 0);
w.document.getElementById('aud-share-btn').click();
await settle();
st = w.__probe.state();
check('a failed upload keeps the ones before it', st.queue[0].ref === 'clip:' + ID_A && !st.queue[1].ref);
check('the failure is reported to the user', /full right now/.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);
check('the share button is usable again', w.document.getElementById('aud-share-btn').disabled === false);

// --- 7. live transcription ---------------------------------------------------

import realWorker from '../api-proxy/src/index.js';

let posts = [];
let reply = { i: 0, start: 0, end: 12, language: 'en', segments: [{ s: 1, e: 4, t: 'spoken words', w: [] }] };
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/transcribe')) {
    posts.push({ url, init });
    return res(reply);
  }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'talk.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();

check('transcribing is offered once a track is loaded', w.document.getElementById('aud-tx-btn').disabled === false);
w.document.getElementById('aud-tx-btn').click();
check('the button turns into a stop', w.document.getElementById('aud-tx-btn').textContent === 'Stop transcribing');

w.__probe.txPump();
await settle();
check('a window is posted', posts.length === 1, JSON.stringify(posts.length));
check('the window is tied to the clip so it can be cached', posts[0].url.includes('clip=' + ID_A), posts[0].url);
check('the first window starts at zero', /[?&]i=0&start=0\.000/.test(posts[0].url), posts[0].url);
check('it is sent as WAV', posts[0].init.headers['Content-Type'] === 'audio/wav');
check('the returned segment is shown', w.document.getElementById('aud-tx-lines').children.length === 1);

// The window the page cut, handed to the real Worker: the two halves have to
// agree on what a WAV is.
const body = posts[0].init.body;
const head = new TextDecoder().decode(new Uint8Array(body.slice(0, 4)));
const view = new DataView(body);
check('the page produces a RIFF header', head === 'RIFF', head);
check('it is 16 kHz mono 16-bit', view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16000 && view.getUint16(34, true) === 16);

let aiSeen = [];
const wResp = await realWorker.fetch(new Request('https://proxy/transcribe?i=0&start=0', {
  method: 'POST', headers: { Origin: 'https://nerohamidi.github.io', 'Content-Type': 'audio/wav' }, body,
}), {
  AI: { run: async (m, i) => { aiSeen.push(i); return { text: 'ok', segments: [] }; } },
}, { waitUntil() {} });
const wBody = await wResp.json();
check('the Worker accepts the page\'s own window', wResp.status === 200, String(wResp.status));
check('and measures it as the length the page cut', Math.abs(wBody.end - 12) < 1.5, JSON.stringify(wBody));

// Second window picks up where the first stopped, and carries the tail as context.
w.__probe.txPump();
await settle();
check('the next window follows the first', posts.length === 2 && /[?&]i=1&/.test(posts[1].url), posts[1] && posts[1].url);
check('the tail of the last line is sent as context', decodeURIComponent(posts[1].init.headers['X-Clip-Prev']) === 'spoken words', JSON.stringify(posts[1].init.headers));
check('the detected language is echoed back', posts[1].init.headers['X-Clip-Lang'] === 'en');

// Paused at zero, the pump must stop once it is a lead ahead of the playhead.
posts = [];
for (let i = 0; i < 6; i++) { w.__probe.txPump(); await settle(); }
check('the pump stays a bounded distance ahead', posts.length <= 1, 'extra windows: ' + posts.length);

// A refusal stops the loop and says why.
w = boot('', (url) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/transcribe')) {
    return Promise.resolve({ ok: false, status: 429, headers: { get: () => null }, json: () => Promise.resolve({ error: 'Transcription has hit its daily limit.' }) });
  }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
w.document.getElementById('aud-tx-btn').click();
w.__probe.txPump();
await settle();
check('a refused window stops the pump', w.document.getElementById('aud-tx-btn').textContent !== 'Stop transcribing');
check('the reason is passed on to the user', /daily limit/.test(w.document.getElementById('aud-tx-status').textContent), w.document.getElementById('aud-tx-status').textContent);

// Cuts land on a quiet moment near the target, and never run past the track.
check('a cut lands near the target length', Math.abs(w.__probe.txCut(0) - 12) <= 1.3, String(w.__probe.txCut(0)));
check('the last window runs to the end', w.__probe.txCut(119) === 120, String(w.__probe.txCut(119)));

// --- 8. which picker did the asking -----------------------------------------

function pickFiles(win, names) {
  // jsdom will not let a test set input.files, so the change handler is given the
  // list the browser would have handed it.
  const input = win.document.getElementById('aud-file');
  const ev = new win.Event('change');
  Object.defineProperty(ev, 'target', {
    value: { files: names.map((n) => ({ name: n, type: 'audio/mpeg' })), value: '' },
  });
  input.dispatchEvent(ev);
}

w = boot('', () => res({ chunks: [] }));
w.__probe.setQueue([
  w.__probe.newEntry({ ref: 'demo', name: 'first.mp3' }),
  w.__probe.newEntry({ ref: 'demo', name: 'second.mp3' }),
], 0);

// "Change track" swaps the row it is on.
w.document.getElementById('aud-change').click();
pickFiles(w, ['swapped.mp3']);
await settle();
st = w.__probe.state();
check('change track replaces rather than appends', st.queue.length === 2 && st.queue[0].name === 'swapped.mp3', st.queue.map((e) => e.name).join());
check('and stays on that row', st.current === 0);

// The picker opened from the drop zone appends.
w.document.querySelector('label[for="aud-file"]').click();
pickFiles(w, ['added.mp3']);
await settle();
st = w.__probe.state();
check('the drop-zone picker appends', st.queue.length === 3 && st.queue[2].name === 'added.mp3', st.queue.map((e) => e.name).join());

// A cancelled "Change track" must not leave the next pick armed to replace.
w.document.getElementById('aud-change').click();   // dialog opened...
pickFiles(w, []);                                  // ...and cancelled
w.document.querySelector('label[for="aud-add"]').click();
pickFiles(w, ['later.mp3']);
await settle();
st = w.__probe.state();
check('a cancelled replace does not arm the next pick', st.queue.length === 4 && st.queue[3].name === 'later.mp3', st.queue.map((e) => e.name).join());

// Dropping several files at once builds the playlist.
w = boot('', () => res({ chunks: [] }));
const drop = new w.Event('drop');
Object.defineProperty(drop, 'dataTransfer', {
  value: { files: ['a.mp3', 'b.mp3', 'c.mp3'].map((n) => ({ name: n, type: 'audio/mpeg' })) },
});
w.document.getElementById('aud-drop').dispatchEvent(drop);
await settle();
st = w.__probe.state();
check('a multi-file drop becomes a playlist', st.queue.length === 3 && st.current === 0, String(st.queue.length));

// The queue is capped, and says so.
w.__probe.addTracks(Array.from({ length: 20 }, (_, i) => w.__probe.newEntry({ ref: 'demo', name: 'x' + i })), false);
st = w.__probe.state();
check('the queue stops at the cap', st.queue.length === 10, String(st.queue.length));
check('the overflow is explained', /did not fit/.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
