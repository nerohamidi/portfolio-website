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

// The decoded track the fake AudioContext hands back. It fades rather than being
// silent, so the quietest moment in each of txCut's search bands sits at the far
// end of the band and windows are cut long. Silence cuts every window as short as
// the band allows, which is the one shape that hides whether the preload floor is
// doing anything.
const decayed = new Map();
const decay = (n) => {
  if (!decayed.has(n)) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = 1 - i / n;
    decayed.set(n, d);
  }
  return decayed.get(n);
};
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
      return { queue: queue, current: current, txSegments: txSegments, txNext: txNext, txDone: txDone, txOn: txOn };
    },
    effects: function() {
      return { echoOn: echoOn, revOn: revOn, mathOn: mathOn };
    },
    graph: function() {
      return { ctx: audioCtx, gain: gainNode, filter: filterNode, echo: echoNodes, rev: revNodes, analyser: analyser };
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
  // Connections are recorded rather than thrown away: whether the stages are
  // wired in the right order, and whether a stage that was switched off is
  // really out of the path, is the whole question the stacking tests ask.
  const node = (kind) => ({
    kind,
    out: [],
    connect(to) { this.out.push(to); return to; },
    disconnect() { this.out.length = 0; },
  });
  const buffer = (duration) => ({
    duration, sampleRate: 44100, numberOfChannels: 1,
    getChannelData: () => decay(Math.round(duration * 44100)),
  });
  w.AudioContext = function () {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = node('destination');
    this.resume = () => {};
    this.createGain = () => Object.assign(node('gain'), { gain: param(1) });
    this.createBiquadFilter = () => Object.assign(node('biquad'), {
      type: 'lowpass', frequency: param(350), Q: param(1),
      // Whatever the engine asks for, answered with -3 dB, so the row that
      // reports a measured response has something to report.
      getFrequencyResponse(freqs, mag, phase) {
        for (let i = 0; i < freqs.length; i++) { mag[i] = Math.SQRT1_2; phase[i] = 0; }
      },
    });
    this.createDelay = (max) => Object.assign(node('delay'), { maxDelayTime: max, delayTime: param(0) });
    this.createConvolver = () => Object.assign(node('convolver'), { buffer: null, normalize: true });
    this.createBuffer = (channels, length, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: (c) => data[c] };
    };
    this.createAnalyser = () => Object.assign(node('analyser'), {
      fftSize: 2048, frequencyBinCount: 1024,
      getByteTimeDomainData() {}, getByteFrequencyData() {}, getFloatTimeDomainData() {},
    });
    this.createBufferSource = () => Object.assign(node('source'), {
      buffer: null, playbackRate: param(1), onended: null,
      start() { this.started = true; }, stop() {},
    });
    this.decodeAudioData = (bytes, ok) => { const b = buffer(120); if (ok) ok(b); return Promise.resolve(b); };
  };
  w.OfflineAudioContext = function (channels, frames, rate) {
    this.destination = node('destination');
    this.createBufferSource = () => Object.assign(node('source'), { buffer: null, playbackRate: param(1), start() {} });
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

// Ticking the transcript toggle, which is the only thing that starts any of it.
const arm = (win) => {
  const box = win.document.getElementById('aud-tx-on');
  box.checked = true;
  box.dispatchEvent(new win.Event('change'));
};
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
let asked = [];
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=${ID_A}`, (url) => {
  asked.push(url);
  if (url.includes('/transcript/')) return res(cached);
  return res({}, { 'x-clip-name': encodeURIComponent('talk.mp3') });
});
await settle();
st = w.__probe.state();

// Opening a shared link must not ask the Worker what the audio says. The lookup
// is free, but it still names a clip to a server, and nobody has asked for it.
check('opening a shared link fetches no transcript', !asked.some((u) => u.includes('/transcript/')), JSON.stringify(asked));
check('and no words are held', st.txSegments.length === 0, String(st.txSegments.length));
check('the toggle is off, since nobody asked for it', w.document.getElementById('aud-tx-on').checked === false);
check('with nothing to copy', w.document.getElementById('aud-tx-copy').disabled === true);

arm(w);
await settle();
st = w.__probe.state();
check('ticking it brings back what was already transcribed', st.txSegments.length === 2, JSON.stringify(st.txSegments.map((s) => s.t)));
check('transcription resumes where the cache stops', st.txNext === 24, String(st.txNext));
check('a partial transcript is not marked finished', st.txDone === false);
check('the status says the transcript came along', /already transcribed/i.test(w.document.getElementById('aud-tx-status').textContent), w.document.getElementById('aud-tx-status').textContent);
check('copying is offered as soon as there is text', w.document.getElementById('aud-tx-copy').disabled === false);

// Nothing is under the playhead before the first line starts.
w.__probe.txFollow();
check('the caption is empty before the first line', w.document.getElementById('aud-caption-line').textContent === '');
check('but the caption keeps its place in the layout', !w.document.getElementById('aud-caption').classList.contains('hidden'));

// The line is laid out in full the moment it starts, but only the words already
// heard are inked. Anything else and the caption would run ahead of the audio.
const capWords = () => [...w.document.querySelectorAll('.aud-cap-w')];
const shown = () => capWords().filter((s) => s.classList.contains('is-in')).map((s) => s.textContent).join('').trim();
const lit = () => (capWords().find((s) => s.classList.contains('is-now')) || { textContent: '' }).textContent.trim();
const seek = (sec) => {
  const bar = w.document.getElementById('aud-seek');
  bar.value = String(sec);
  bar.dispatchEvent(new w.Event('input'));
  w.__probe.txFollow();
};

// Seek into the first line, then look.
seek(0.5);
check('the caption shows the line under the playhead', w.document.getElementById('aud-caption-line').textContent.replace(/\s+/g, ' ').trim() === 'the first line', JSON.stringify(w.document.getElementById('aud-caption-line').textContent));
check('the caption is split into word spans', capWords().length === 3);
check('the word under the playhead is marked', w.document.querySelectorAll('.aud-cap-w.is-now').length === 1);
check('only the first word is showing at the top of the line', shown() === 'the', JSON.stringify(shown()));
check('but the whole line is already laid out', w.document.getElementById('aud-caption-line').textContent.replace(/\s+/g, ' ').trim() === 'the first line');
seek(1.5);
check('the second word arrives on its own timing', shown() === 'the first', JSON.stringify(shown()));
check('and it is the one lit', lit() === 'first', JSON.stringify(lit()));
seek(2.5);
check('the third word follows', shown() === 'the first line', JSON.stringify(shown()));
seek(1.5);
check('seeking back takes the later words away again', shown() === 'the first', JSON.stringify(shown()));

// The second cached line came back with no word timings on it. It is spread over
// its own span rather than landing as one block.
seek(13);
check('a line with no word timings is still split into words', capWords().length === 3, String(capWords().length));
check('and it opens on its first word alone', shown() === 'the', JSON.stringify(shown()));
seek(14.9);
check('by its end the whole line is showing', shown() === 'the second line', JSON.stringify(shown()));

seek(13);
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

// --- 6b. the upload key ------------------------------------------------------

let sentHeaders = [];
const shareBoot = () => boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.endsWith('/clip') && init && init.method === 'POST') {
    sentHeaders.push(init.headers);
    return res({ id: ID_A, name: 'one.mp3', expiresInDays: 30 });
  }
  if (init && init.method === 'DELETE') { deletes.push(url); return res({ deleted: true }); }
  return res({}, {});
});
let deletes = [];

w = shareBoot();
w.__probe.setQueue([w.__probe.newEntry({ name: 'one.mp3', file: { name: 'one.mp3' } })], 0);
w.document.getElementById('aud-share-btn').click();
await settle();
check('no key means no key header', sentHeaders[0]['X-Clip-Key'] === undefined, JSON.stringify(Object.keys(sentHeaders[0])));

sentHeaders = [];
w = shareBoot();
const keyIn = w.document.getElementById('aud-key');
keyIn.value = '  open-sesame  ';
keyIn.dispatchEvent(new w.Event('input'));
check('the key is held for the session only', w.sessionStorage.getItem('aud-upload-key') === 'open-sesame', String(w.sessionStorage.getItem('aud-upload-key')));
check('and never written to disk', w.localStorage.getItem('aud-upload-key') === null);

w.__probe.setQueue([w.__probe.newEntry({ name: 'one.mp3', file: { name: 'one.mp3' } })], 0);
w.document.getElementById('aud-share-btn').click();
await settle();
check('the key travels as a request header', sentHeaders[0]['X-Clip-Key'] === 'open-sesame', JSON.stringify(sentHeaders[0]));
check('and never lands in the link', !w.__probe.encodeState().includes('sesame'), w.__probe.encodeState());
check('nor in the box the link is copied from', !w.document.getElementById('aud-share-link').value.includes('sesame'));

// Clearing the field forgets it rather than sending an empty header.
keyIn.value = '';
keyIn.dispatchEvent(new w.Event('input'));
check('clearing the field forgets the key', w.sessionStorage.getItem('aud-upload-key') === null);

// --- 6c. deleting from the cloud ---------------------------------------------

deletes = [];
w = shareBoot();
check('nothing to delete before anything is uploaded', w.document.getElementById('aud-danger').classList.contains('hidden'));

w.__probe.setQueue([
  w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'one.mp3' }),
  w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' }),
  w.__probe.newEntry({ ref: 'clip:' + ID_B, name: 'two.mp3' }),
], 0);
check('an uploaded track offers a delete', !w.document.getElementById('aud-danger').classList.contains('hidden'));

// One press arms, and only the second one acts.
const delBtn = w.document.getElementById('aud-del-btn');
delBtn.click();
await settle();
check('the first press only arms it', deletes.length === 0, String(deletes.length));
check('and the button says what happens next', /Really delete 2 tracks\?/.test(delBtn.textContent), delBtn.textContent);

delBtn.click();
await settle();
check('the second press deletes every uploaded track', deletes.length === 2, String(deletes.length));
check('the demo is not one of them', deletes.every((u) => !u.includes('demo')), JSON.stringify(deletes));
check('each goes to its own clip', deletes.some((u) => u.endsWith('/clip/' + ID_A)) && deletes.some((u) => u.endsWith('/clip/' + ID_B)), JSON.stringify(deletes));

st = w.__probe.state();
check('the refs are dropped so a stale link cannot be made', st.queue.every((e) => e.ref !== 'clip:' + ID_A && e.ref !== 'clip:' + ID_B), JSON.stringify(st.queue.map((e) => e.ref)));
check('the tracks stay in the queue', st.queue.length === 3);
check('the old link is taken down', w.document.getElementById('aud-share-out').classList.contains('hidden'));
check('and the delete is no longer on offer', w.document.getElementById('aud-danger').classList.contains('hidden'));
check('the outcome is reported', /Deleted all 2/.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);

// A clip the Worker says is already gone still counts as done.
deletes = [];
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (init && init.method === 'DELETE') {
    deletes.push(url);
    return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: () => Promise.resolve({ error: 'That clip is already gone.' }) });
  }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'one.mp3' })], 0);
w.document.getElementById('aud-del-btn').click();
w.document.getElementById('aud-del-btn').click();
await settle();
check('a clip that was already gone is not an error', /Deleted\./.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);

// Someone who opened a shared link gets the same button: the link is the permission.
deletes = [];
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=${ID_A}`, (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (init && init.method === 'DELETE') { deletes.push(url); return res({ deleted: true }); }
  return res({}, { 'x-clip-name': encodeURIComponent('theirs.mp3') });
});
await settle();
check('a recipient is offered the delete too', !w.document.getElementById('aud-danger').classList.contains('hidden'));
w.document.getElementById('aud-del-btn').click();
w.document.getElementById('aud-del-btn').click();
await settle();
check('and it takes down the sharer\'s clip', deletes.length === 1 && deletes[0].endsWith('/clip/' + ID_A), JSON.stringify(deletes));

// --- 6d. the title, the note, and the card that previews them ----------------
//
// A hash never reaches a server, so a link straight at this page previews as
// whatever the page says about itself. With a title or a note the share goes
// through a card on the Worker instead, which carries them in its meta tags.

let cards = [];
const cardBoot = (reply) => boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.endsWith('/clip') && init && init.method === 'POST') {
    return res({ id: ID_A, name: 'one.mp3', expiresInDays: 30, locked: Boolean(init.headers['X-Clip-Lock']) });
  }
  if (url.endsWith('/share') && init && init.method === 'POST') {
    cards.push({ init, body: JSON.parse(init.body) });
    return reply ? reply() : res({ id: ID_B, url: 'https://proxy.example/s/' + ID_B, expiresInDays: 30 });
  }
  if (init && init.method === 'DELETE') { deletes.push({ url, init }); return res({ deleted: true }); }
  return res({}, {});
});

// Nothing written: the link stays the page's own URL and no card is filed.
cards = [];
w = cardBoot();
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.document.getElementById('aud-share-btn').click();
await settle();
check('a share with nothing written files no card', cards.length === 0, String(cards.length));
check('and hands over the page\'s own link', /\/playroom\/audio\/#v=3/.test(w.document.getElementById('aud-share-link').value), w.document.getElementById('aud-share-link').value);

// With a title, the card is what gets handed over.
cards = [];
w = cardBoot();
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.document.getElementById('aud-share-title').value = 'Late night mix';
w.document.getElementById('aud-share-note').value = 'Track 3 is the one.';
w.document.getElementById('aud-share-btn').click();
await settle();
check('a title files a card', cards.length === 1, String(cards.length));
check('and the card carries both what was written', cards[0].body.title === 'Late night mix' && cards[0].body.note === 'Track 3 is the one.', JSON.stringify(cards[0].body));
check('and the whole hash with it', /(^|&)t=d(&|$)/.test(cards[0].body.hash), cards[0].body.hash);
check('the link handed over is the card', w.document.getElementById('aud-share-link').value === 'https://proxy.example/s/' + ID_B, w.document.getElementById('aud-share-link').value);
check('the address bar still shows the state', w.location.hash.includes('t=d'), w.location.hash);
check('the words ride in the hash as well as in the card', /(^|&)ti=Late%20night%20mix(&|$)/.test(w.__probe.encodeState()), w.__probe.encodeState());

// A card that cannot be filed must not cost the sender a working link.
cards = [];
w = cardBoot(() => Promise.resolve({
  ok: false, status: 507, headers: { get: () => null },
  json: () => Promise.resolve({ error: 'Too many share cards right now.' }),
}));
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.document.getElementById('aud-share-title').value = 'Late night mix';
w.document.getElementById('aud-share-btn').click();
await settle();
check('a failed card still hands over the plain link', /#v=3/.test(w.document.getElementById('aud-share-link').value), w.document.getElementById('aud-share-link').value);
check('and says what was lost', /still works, without the preview/.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);

// Opening a link that carries them shows them, and re-sharing carries them on.
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d&ti=Late%20night%20mix&no=Track%203%20is%20the%20one.&s=${ID_B}`, () => res({ chunks: [] }));
await settle();
check('a shared title is shown at the top', w.document.getElementById('aud-shared-title').textContent === 'Late night mix', w.document.getElementById('aud-shared-title').textContent);
check('and the note under it', w.document.getElementById('aud-shared-msg').textContent === 'Track 3 is the one.', w.document.getElementById('aud-shared-msg').textContent);
check('the note is shown rather than left hidden', !w.document.getElementById('aud-shared-msg').classList.contains('hidden'));
check('and both are put back in the fields, so forwarding keeps them', w.document.getElementById('aud-share-title').value === 'Late night mix' && w.document.getElementById('aud-share-note').value === 'Track 3 is the one.');

// --- 6e. the delete password -------------------------------------------------

// Set at upload, never after: the field closes as soon as anything is up.
let uploadHeaders = [];
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.endsWith('/clip') && init && init.method === 'POST') {
    uploadHeaders.push(init.headers);
    return res({ id: ID_A, name: 'one.mp3', expiresInDays: 30, locked: Boolean(init.headers['X-Clip-Lock']) });
  }
  if (init && init.method === 'DELETE') { deletes.push({ url, init }); return res({ deleted: true }); }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ name: 'one.mp3', file: { name: 'one.mp3' } })], 0);
const passIn = w.document.getElementById('aud-share-pass');
check('the password can be set before anything is uploaded', passIn.disabled === false);
passIn.value = 'hunter2';
passIn.dispatchEvent(new w.Event('input'));
check('typing one reveals where it will be asked for', !w.document.getElementById('aud-del-pass').classList.contains('hidden'));

w.document.getElementById('aud-share-btn').click();
await settle();
check('the password travels as a request header', uploadHeaders[0]['X-Clip-Lock'] === 'hunter2', JSON.stringify(Object.keys(uploadHeaders[0])));
check('and never lands in the link', !w.__probe.encodeState().includes('hunter2'), w.__probe.encodeState());
check('nor in the box the link is copied from', !w.document.getElementById('aud-share-link').value.includes('hunter2'));
check('once the track is up the password can no longer be changed', passIn.disabled === true);
check('and the panel says the lock is now fixed', /nothing can change it/i.test(w.document.getElementById('aud-lock-hint').textContent), w.document.getElementById('aud-lock-hint').textContent);

// A recipient meets the lock: the button is refused, and the field appears.
deletes = [];
let attempts = 0;
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=${ID_A}`, (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (init && init.method === 'DELETE') {
    attempts++;
    deletes.push({ url, init });
    const given = init.headers && init.headers['X-Clip-Lock'];
    if (given === 'hunter2') return res({ deleted: true });
    return Promise.resolve({
      ok: false, status: given ? 403 : 401, headers: { get: () => null },
      json: () => Promise.resolve({ error: given ? 'That password does not match.' : 'That clip is password protected.', locked: true }),
    });
  }
  return res({}, { 'x-clip-name': encodeURIComponent('theirs.mp3'), 'x-clip-locked': '1' });
});
await settle();
check('a locked clip shows its password field before the button is pressed', !w.document.getElementById('aud-del-pass').classList.contains('hidden'));

const delBtn2 = w.document.getElementById('aud-del-btn');
delBtn2.click();
delBtn2.click();
await settle();
st = w.__probe.state();
check('a delete with no password is refused', attempts === 1 && st.queue[0].ref === 'clip:' + ID_A, JSON.stringify(st.queue.map((e) => e.ref)));
check('and the refusal is passed on', /password protected/i.test(w.document.getElementById('aud-share-status').textContent), w.document.getElementById('aud-share-status').textContent);
check('the clip is still shareable, because it is still there', !w.document.getElementById('aud-danger').classList.contains('hidden'));

w.document.getElementById('aud-del-pass').value = 'wrong';
delBtn2.click();
delBtn2.click();
await settle();
check('a wrong password keeps the clip too', w.__probe.state().queue[0].ref === 'clip:' + ID_A);
check('and says it did not match', /does not match/i.test(w.document.getElementById('aud-del-note').textContent), w.document.getElementById('aud-del-note').textContent);

w.document.getElementById('aud-del-pass').value = 'hunter2';
delBtn2.click();
delBtn2.click();
await settle();
check('the right password deletes it', w.__probe.state().queue[0].ref === null, JSON.stringify(w.__probe.state().queue.map((e) => e.ref)));
check('and the password went with the request', deletes[deletes.length - 1].init.headers['X-Clip-Lock'] === 'hunter2');

// A card arriving in a link is taken down with the audio it advertises.
deletes = [];
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=${ID_A}&s=${ID_B}`, (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (init && init.method === 'DELETE') { deletes.push(url); return res({ deleted: true }); }
  return res({}, { 'x-clip-name': encodeURIComponent('theirs.mp3') });
});
await settle();
w.document.getElementById('aud-del-btn').click();
w.document.getElementById('aud-del-btn').click();
await settle();
check('deleting takes the clip down', deletes.some((u) => u.endsWith('/clip/' + ID_A)), JSON.stringify(deletes));
check('and the preview card with it', deletes.some((u) => u.endsWith('/share/' + ID_B)), JSON.stringify(deletes));

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

check('a loaded track does not transcribe itself', w.__probe.state().txOn === false);
check('nothing is copyable yet', w.document.getElementById('aud-tx-copy').disabled === true);

arm(w);
check('ticking the toggle starts it', w.__probe.state().txOn === true);

w.__probe.txPump();
await settle();
check('a window is posted', posts.length === 1, JSON.stringify(posts.length));
check('the window is tied to the clip so it can be cached', posts[0].url.includes('clip=' + ID_A), posts[0].url);
check('the first window starts at zero', /[?&]i=0&start=0\.000/.test(posts[0].url), posts[0].url);
check('it is sent as WAV', posts[0].init.headers['Content-Type'] === 'audio/wav');
check('the returned segment is kept', w.__probe.state().txSegments.length === 1, String(w.__probe.state().txSegments.length));
check('and the caption row is opened for it', !w.document.getElementById('aud-caption').classList.contains('hidden'));

// The window the page cut, handed to the real Worker: the two halves have to
// agree on what a WAV is.
const body = posts[0].init.body;
const head = new TextDecoder().decode(new Uint8Array(body.slice(0, 4)));
const view = new DataView(body);
check('the page produces a RIFF header', head === 'RIFF', head);
check('it is 16 kHz mono 16-bit', view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16000 && view.getUint16(34, true) === 16);

// The model is an HTTPS call now, so the stand-in is global fetch. Stubbed only
// around this one call: nothing else in this file should reach the network, and a
// real request here would spend real tokens on a buffer of test tones.
const realFetch = globalThis.fetch;
let modelSeen = [];
globalThis.fetch = async (url, init) => {
  modelSeen.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ language: 'en', segments: [] }) }] } }],
  }), { status: 200 });
};
const wResp = await realWorker.fetch(new Request('https://proxy/transcribe?i=0&start=0', {
  method: 'POST', headers: { Origin: 'https://nerohamidi.github.io', 'Content-Type': 'audio/wav' }, body,
}), { GEMINI_API_KEY: 'test-key' }, { waitUntil() {} });
const wBody = await wResp.json();
globalThis.fetch = realFetch;
check('the Worker accepts the page\'s own window', wResp.status === 200, String(wResp.status));
check('and measures it as the length the page cut', Math.abs(wBody.end - 12) < 1.5, JSON.stringify(wBody));
check('and hands the model that same audio', modelSeen.length === 1 &&
  modelSeen[0].body.contents[0].parts[1].inlineData.mimeType === 'audio/wav', JSON.stringify(modelSeen.length));

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
arm(w);
w.__probe.txPump();
await settle();
check('a refused window stops the pump', w.__probe.state().txOn === false);
check('and the toggle clears so it can be retried', w.document.getElementById('aud-tx-on').checked === false);
check('the reason is passed on to the user', /daily limit/.test(w.document.getElementById('aud-tx-status').textContent), w.document.getElementById('aud-tx-status').textContent);

// Cuts land on a quiet moment near the target, and never run past the track.
check('a cut lands near the target length', Math.abs(w.__probe.txCut(0) - 12) <= 1.3, String(w.__probe.txCut(0)));
check('the last window runs to the end', w.__probe.txCut(119) === 120, String(w.__probe.txCut(119)));

// --- 7b. the toggle is the only thing that starts it -------------------------

// The playhead never moves here: the opening is fetched because transcription was
// switched on, not because anything is playing.
posts = [];
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/transcribe')) { posts.push({ url, init }); return res(reply); }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
check('a fresh visit is not transcribing', w.__probe.state().txOn === false);
for (let i = 0; i < 3; i++) { w.__probe.txPump(); await settle(); }
check('and no windows go out unasked', posts.length === 0, String(posts.length));

arm(w);
check('the toggle turns it on', w.__probe.state().txOn === true);
check('nothing has been played', Number(w.document.getElementById('aud-seek').value) === 0);

for (let i = 0; i < 8; i++) { w.__probe.txPump(); await settle(); }
st = w.__probe.state();
check('the preload runs past the first half minute', st.txNext >= 30, String(st.txNext));
check('and stops there rather than eating the whole track', st.txNext < 45, String(st.txNext));
check('which is a handful of windows, not a transcription of everything', posts.length === 3, String(posts.length));

// Switching it off stops the pump and keeps what it already has.
const toggle = w.document.getElementById('aud-tx-on');
toggle.checked = false;
toggle.dispatchEvent(new w.Event('change'));
check('the toggle stops it', w.__probe.state().txOn === false);
posts = [];
for (let i = 0; i < 4; i++) { w.__probe.txPump(); await settle(); }
check('no more windows go out', posts.length === 0, String(posts.length));
check('the text so far is kept', w.__probe.state().txSegments.length > 0);
check('and stays copyable', w.document.getElementById('aud-tx-copy').disabled === false);

// Nothing about the choice is written to disk. A preference that outlived the tab
// would start a later visit transcribing on the strength of a press from days ago.
check('the choice is not remembered on disk', w.localStorage.getItem('aud-tx-on') === null, String(w.localStorage.getItem('aud-tx-on')));

// A finished transcript used to re-tick the box the instant it was cleared:
// the handler set the preference false, the sync put the tick back from txDone,
// and the toggle could not be switched off at all.
w = boot('', (url) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/transcribe')) return res({ i: 0, start: 0, end: 200, segments: [{ s: 1, e: 4, t: 'all of it', w: [] }] });
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
arm(w);
// Jumped to the last few seconds, so the pump reaches the end of the track in
// two windows rather than ten. A seek this long gives up on the gap by design.
const bar = w.document.getElementById('aud-seek');
bar.value = '118';
bar.dispatchEvent(new w.Event('input'));
for (let i = 0; i < 3; i++) { w.__probe.txPump(); await settle(); }
check('a track can finish transcribing', w.__probe.state().txDone === true, JSON.stringify(w.__probe.state().txNext));
check('and the toggle still reads on', w.document.getElementById('aud-tx-on').checked === true);

const done = w.document.getElementById('aud-tx-on');
done.checked = false;
done.dispatchEvent(new w.Event('change'));
check('a finished transcript can be switched off', done.checked === false);
check('and it stays off', w.__probe.state().txOn === false);

// A new track starts from nothing, however the last one was left.
posts = [];
w = boot('', (url, init) => {
  if (url.includes('/transcript/')) return res({ chunks: [] });
  if (url.includes('/transcribe')) { posts.push({ url, init }); return res(reply); }
  return res({}, {});
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'one.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
arm(w);
w.__probe.txPump();
await settle();
check('the first track transcribes once it is asked to', posts.length === 1, String(posts.length));

posts = [];
w.__probe.setQueue([w.__probe.newEntry({ ref: 'demo', name: 'two.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
check('the next track does not carry the press over', w.__probe.state().txOn === false);
check('and its toggle reads off', w.document.getElementById('aud-tx-on').checked === false);
for (let i = 0; i < 3; i++) { w.__probe.txPump(); await settle(); }
check('so nothing of it is sent', posts.length === 0, String(posts.length));

// --- 7c. the cache is looked up on the press, and only then ------------------

let cachePosts = 0;
let cacheLookups = 0;
w = boot('', (url) => {
  if (url.includes('/transcript/')) { cacheLookups++; return res(cached); }
  if (url.includes('/transcribe')) { cachePosts++; return res(reply); }
  return res({}, { 'x-clip-name': encodeURIComponent('talk.mp3') });
});
w.__probe.setQueue([w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'talk.mp3' })], 0);
w.__probe.playIndex(0, false);
await settle();
check('loading a clip looks up nothing', cacheLookups === 0, String(cacheLookups));

arm(w);
await settle();
st = w.__probe.state();
check('the press is what asks for the cached transcript', cacheLookups === 1, String(cacheLookups));
check('and it is adopted', st.txSegments.length === 2, String(st.txSegments.length));
check('nothing was posted before it landed', cachePosts === 0, String(cachePosts));
check('the pump picks up where the cache stops', st.txNext === 24, String(st.txNext));
check('and carries on from there', st.txOn === true);

// Leaving a track and coming back keeps its words, and the toggle with them.
w.__probe.setQueue([
  w.__probe.newEntry({ ref: 'clip:' + ID_A, name: 'talk.mp3' }),
  w.__probe.newEntry({ ref: 'demo', name: 'other.mp3' }),
], 0);
w.__probe.playIndex(0, false);
await settle();
arm(w);
await settle();
w.__probe.playIndex(1, false);
await settle();
check('moving to another track turns it off again', w.__probe.state().txOn === false);
w.__probe.playIndex(0, false);
await settle();
st = w.__probe.state();
check('coming back finds the words still there', st.txSegments.length === 2, String(st.txSegments.length));
check('and picks the track up where it was left', st.txOn === true);

// Copying hands over the whole transcript, not just the line under the playhead.
let copied = null;
Object.defineProperty(w.navigator, 'clipboard', {
  value: { writeText: (t) => { copied = t; return Promise.resolve(); } },
  configurable: true,
});
w.document.getElementById('aud-tx-copy').click();
await settle();
check('the copy button hands over every line', copied === 'the first line\nthe second line', JSON.stringify(copied));
check('and it says so beside the toggle', w.document.getElementById('aud-tx-status').textContent === 'Copied.');

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

// --- 9. stacking effects -----------------------------------------------------
//
// The claim the panel makes is that the stages chain rather than replace one
// another, so these tests read the graph itself: who is connected to whom, in
// what order, and what is left dangling when a stage is switched off.

const live = (win) => Array.from(win.document.querySelectorAll('.aud-chain-node.is-on:not(.is-fixed)'))
  .map((n) => n.textContent).join(',');
const press = (win, id) => win.document.getElementById(id).click();

w = boot(`#v=3&flt=lp,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
let g = w.__probe.graph();

check('a filter alone is the only stage in the path', g.gain.out.length === 1 && g.gain.out[0] === g.filter && g.filter.out[0] === g.analyser);
check('the chain strip names it', live(w) === 'Low Pass', live(w));
check('echo and reverb start off', !w.__probe.effects().echoOn && !w.__probe.effects().revOn);
check('their sliders stay folded away', w.document.getElementById('aud-echo-params').classList.contains('hidden') &&
  w.document.getElementById('aud-rev-params').classList.contains('hidden'));

press(w, 'aud-echo-on');
g = w.__probe.graph();
check('echo switches on', w.__probe.effects().echoOn && !w.document.getElementById('aud-echo-params').classList.contains('hidden'));
check('and lands after the filter, not instead of it', g.filter.out.length === 1 && g.filter.out[0] === g.echo.input && g.echo.output.out[0] === g.analyser);
check('its delay feeds itself, which is what makes the repeats', g.echo.delay.out.indexOf(g.echo.fb) >= 0 && g.echo.fb.out.indexOf(g.echo.delay) >= 0);
check('and it keeps a dry path alongside the wet one', g.echo.dry.gain.value === 0.65 && g.echo.wet.gain.value === 0.35);

press(w, 'aud-rev-on');
g = w.__probe.graph();
check('reverb stacks on top of both', live(w) === 'Low Pass,Echo,Reverb', live(w));
check('three stages run in order', g.gain.out[0] === g.filter && g.filter.out[0] === g.echo.input &&
  g.echo.output.out[0] === g.rev.input && g.rev.output.out[0] === g.analyser && g.analyser.out[0] === g.ctx.destination);
check('the pre-delay sits before the convolver', g.rev.pre.out[0] === g.rev.conv && g.rev.conv.out[0] === g.rev.wet);
check('an impulse response was built to the size asked for', g.rev.conv.buffer &&
  g.rev.conv.buffer.length === Math.round(2.2 * 44100) && g.rev.conv.buffer.numberOfChannels === 2,
  String(g.rev.conv.buffer && g.rev.conv.buffer.length));

hash = w.__probe.encodeState();
check('a stacked link carries the echo', /(^|&)ec=320,0.35,0.35(&|$)/.test(hash), hash);
check('and the reverb', /(^|&)rv=2.2,20,0.3(&|$)/.test(hash), hash);
check('and stays a v3 link, so an older page still restores the playlist', /(^|&)v=3(&|$)/.test(hash), hash);

press(w, 'aud-echo-on');
g = w.__probe.graph();
check('switching echo off closes the gap it left', g.filter.out.length === 1 && g.filter.out[0] === g.rev.input, String(g.filter.out.length));
check('the dropped stage stops feeding the analyser', g.echo.output.out.length === 0);
check('and drops out of the link', !/(^|&)ec=/.test(w.__probe.encodeState()), w.__probe.encodeState());

// A link that arrives with both of them set.
w = boot(`#v=3&flt=off,500,1&ec=500,0.6,0.5&rv=4.5,60,0.45&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
g = w.__probe.graph();
check('a shared link restores both effects', w.__probe.effects().echoOn && w.__probe.effects().revOn);
check('with the numbers the sender set', w.document.getElementById('aud-echo-time-val').textContent === '500 ms' &&
  w.document.getElementById('aud-echo-fb-val').textContent === '0.60' &&
  w.document.getElementById('aud-rev-mix-val').textContent === '45%',
  w.document.getElementById('aud-echo-time-val').textContent + ' / ' + w.document.getElementById('aud-echo-fb-val').textContent);
check('and with no filter in front of them', live(w) === 'Echo,Reverb' && g.gain.out[0] === g.echo.input, live(w));

w = boot(`#v=3&flt=lp,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a link from before the effects existed leaves them off', !w.__probe.effects().echoOn && !w.__probe.effects().revOn);

// --- 10. the maths panel -----------------------------------------------------

w = boot(`#v=3&flt=lp,500,1&ec=320,0.35,0.35&rv=2.2,20,0.3&p=5&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
const maths = () => w.document.getElementById('aud-math');
const tick = (win, id, on) => {
  const box = win.document.getElementById(id);
  box.checked = on;
  box.dispatchEvent(new win.Event('change'));
};

check('the maths is off on arrival', maths().classList.contains('hidden') && !w.__probe.effects().mathOn);
check('and nothing is rendered until it is asked for', maths().textContent === '', maths().textContent.slice(0, 40));
check('the running figures under the sliders are there anyway',
  /D = 14 112 samples/.test(w.document.getElementById('aud-echo-tail').textContent),
  w.document.getElementById('aud-echo-tail').textContent);

tick(w, 'aud-math-on', true);
let mathText = maths().textContent;
check('ticking it opens the panel', !maths().classList.contains('hidden') && w.__probe.effects().mathOn);
check('every running stage gets a block', /The chain/.test(mathText) && /Filter — one biquad/.test(mathText) &&
  /Echo — a feedback comb/.test(mathText) && /Reverb — convolution with a room/.test(mathText));
check('stacking is stated as a product of transfer functions',
  /H<sub>filter<\/sub>\(z\) · H<sub>echo<\/sub>\(z\) · H<sub>reverb<\/sub>\(z\)/.test(maths().innerHTML), '');
check('the echo delay is worked out in samples', /14 112 samples of delay line/.test(mathText), '');
check('and its tail is counted in repeats', /7, so about 2\.2 s of tail/.test(mathText), '');
check('the reverb tap count follows the size', /97 020 taps/.test(mathText), '');
check('the biquad reports the browser\'s own response', /−3\.0 dB, measured on the node itself/.test(mathText), '');
check('a pitch shift gets its own block', /Pitch — resampling/.test(mathText) && /1\.3348/.test(mathText), '');
check('the sample rate is the one the context is running at', /44 100 Hz/.test(mathText), '');

// Moving a slider re-runs the arithmetic rather than leaving the old answer up.
const fb = w.document.getElementById('aud-echo-fb');
fb.value = '0.7';
fb.dispatchEvent(new w.Event('input', { bubbles: true }));
check('the numbers follow the sliders', /20, so about 6\.4 s of tail/.test(maths().textContent),
  (maths().textContent.match(/[\d.]+ s of tail/) || [''])[0]);
check('and so does the graph', w.__probe.graph().echo.fb.gain.value === 0.7);

check('the maths never rides in a link', !/(^|&)m=/.test(w.__probe.encodeState()), w.__probe.encodeState());

tick(w, 'aud-math-on', false);
check('unticking closes it', maths().classList.contains('hidden'));
check('and clears it out rather than hiding stale numbers', maths().textContent === '');

// With nothing switched on it says so, rather than showing an empty panel.
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
tick(w, 'aud-math-on', true);
mathText = w.document.getElementById('aud-math').textContent;
check('a clean chain still explains itself', /Nothing is switched on/.test(mathText) && /y\[n\] = x\[n\]/.test(mathText), '');
check('and offers no block for a stage that is off', !/feedback comb/.test(mathText) && !/one biquad/.test(mathText));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
