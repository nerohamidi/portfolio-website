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

// Survives a boot, the way a real browser's localStorage survives a reload.
const persisted = new Map();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const markup = fs.readFileSync(ROOT + '/_includes/audio-app.html', 'utf8');
const workerSrc = fs.readFileSync(ROOT + '/_includes/audio-separate.html', 'utf8')
  .split('type="text/worker">')[1].split('</scr' + 'ipt>')[0];
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
      return { queue: queue, current: current, txSegments: txSegments, txNext: txNext, txDone: txDone,
        txOn: txOn, playing: playing, offsetSec: offsetSec, bgActive: bgActive,
        bgAllowed: bgAllowed, handoffNeeded: handoffNeeded, pausedByHide: pausedByHide,
        bgPrimed: bgPrimed, hasSource: !!bufSource };
    },
    seekTo: seekTo,
    effects: function() {
      var r = rack();
      return { echoOn: r.echoOn, revOn: r.revOn, mathOn: mathOn,
        filterType: r.filterType, freqPos: r.freqPos, qPos: r.qPos, q: rackQ(r) };
    },
    graph: function() {
      var n = rack().nodes || {};
      return { ctx: audioCtx, gain: gainNode, filter: n.filter, echo: n.echo, rev: n.rev,
        analyser: analyser, master: master.nodes, split: split.nodes };
    },
    stems: function() { return stems; },
    split: function() { return split; },
    setTarget: setTarget,
    setSplit: setSplit,
    setMode: setMode,
    mode: function() { return simpleMode; },
    target: function() { return target; },
    racks: function() { return { master: master, stems: stems.map(function(s) { return s.rack; }) }; },
    sep: function() {
      return { buffer: sepBuffer, busy: sepBusy, ready: sepReady(), live: sourcesLive(),
        mode: split.mode, separated: txSeparated() };
    },
    setSplitMode: setSplitMode,
    txMono: txMono,
    txCut: txCut,
    txListensTo: txListensTo,
    setQueue: function(q, c) { queue = q; current = c; renderQueue(); },
  };
  sizeCanvas();
  draw();
})();`);

// The default agent is a desktop one, where an AudioContext survives a hidden
// tab. IPHONE_UA boots the other branch: the one platform that interrupts it.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// A Mac, which says "Macintosh" like an iPad does and is told apart from one by
// having no touch points.
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

function boot(hash, fetchImpl, userAgent) {
  const dom = new JSDOM(
    '<!doctype html><body class="dark-mode"><div id="wrap"></div></body>',
    { url: 'https://nerohamidi.github.io/portfolio-website/playroom/audio/' + (hash || ''), runScripts: 'outside-only' },
  );
  const w = dom.window;
  // Set here rather than through jsdom's own option, which has moved between
  // versions. maxTouchPoints comes with it because the pair is what tells an
  // iPad apart from the Mac whose user agent it borrows.
  if (userAgent) {
    Object.defineProperty(w.navigator, 'userAgent', { value: userAgent, configurable: true });
    Object.defineProperty(w.navigator, 'maxTouchPoints', {
      value: /iPad|iPhone|iPod/.test(userAgent) ? 5 : 0,
      configurable: true,
    });
  }
  w.document.getElementById('wrap').innerHTML = markup;
  // The separator's source rides in the page as text; the engine looks it up by
  // id, so it has to be there or the button reports the browser cannot run it.
  const tag = w.document.createElement('script');
  tag.id = 'aud-sep-worker';
  tag.type = 'text/worker';
  tag.textContent = workerSrc;
  w.document.body.appendChild(tag);

  // --- Web Audio, reduced to what the engine touches ---
  const param = (v) => ({ value: v, setValueAtTime() {} });
  // Connections are recorded rather than thrown away: whether the stages are
  // wired in the right order, and whether a stage that was switched off is
  // really out of the path, is the whole question the stacking tests ask.
  // `wires` keeps the output and input indices as well, which is the only way to
  // tell a mid/side matrix from four gains wired to nothing in particular.
  const node = (kind) => ({
    kind,
    out: [],
    wires: [],
    connect(to, from, into) {
      this.out.push(to);
      this.wires.push({ to, from: from | 0, into: into | 0 });
      return to;
    },
    disconnect() { this.out.length = 0; this.wires.length = 0; },
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
    this.createChannelSplitter = (n) => Object.assign(node('splitter'), { numberOfOutputs: n });
    this.createChannelMerger = (n) => Object.assign(node('merger'), { numberOfInputs: n });
    this.createConvolver = () => Object.assign(node('convolver'), { buffer: null, normalize: true });
    this.createBuffer = (channels, length, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels, length, sampleRate: rate,
        duration: length / rate,
        getChannelData: (c) => data[c],
        copyToChannel: (src, c) => data[c].set(src.subarray(0, data[c].length)),
      };
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
  // jsdom has no Worker. A fake one records what it was asked to do and lets the
  // test hand back what the real separator would have sent, so the page's half of
  // the exchange is driven without running the DSP -- which has its own tests.
  w.Blob = class { constructor(parts) { this.parts = parts; } };
  w.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  w.Worker = class {
    constructor() { this.sent = []; w.__worker = this; }
    postMessage(msg) { this.sent.push(msg); }
    terminate() {}
  };

  // jsdom implements no media element, and the engine's handoff path touches
  // one. Stubbed so it is inert and quiet, and recorded so the handoff tests can
  // see what it was asked to do.
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  w.HTMLMediaElement.prototype.play = function () {
    this.playing = true;
    this.everPlayed = true;
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    this.playing = false;
    this.dispatchEvent(new w.Event('pause'));
  };
  w.HTMLMediaElement.prototype.load = function () {};
  // Real browsers carry this, and the engine only switches it off where it finds
  // it, so the mock has to have it for that path to be exercised at all.
  w.HTMLMediaElement.prototype.preservesPitch = true;
  Object.defineProperty(w.HTMLMediaElement.prototype, 'readyState', { get() { return 4; }, configurable: true });
  // currentTime is a no-op setter in jsdom, so it is made real here.
  Object.defineProperty(w.HTMLMediaElement.prototype, 'currentTime', {
    get() { return this._t || 0; },
    set(v) { this._t = v; },
    configurable: true,
  });
  // The math panel stages its entrance one frame after it builds, so rAF has to
  // really run. draw() re-registers itself every frame, though, and letting that
  // loop would spin the run forever, so it alone is left un-scheduled.
  w.requestAnimationFrame = (fn) => { if (fn.name !== 'draw') setTimeout(() => fn(0), 0); return 0; };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({}) });
  // jsdom gives each window its own storage, and a preference that survives the
  // page is exactly what the background toggle claims to be. One store across
  // boots is what "the next visit" means here.
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (persisted.has(k) ? persisted.get(k) : null),
      setItem: (k, v) => persisted.set(k, String(v)),
      removeItem: (k) => persisted.delete(k),
    },
  });
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

function pickFiles(win, names, id = 'aud-file') {
  // jsdom will not let a test set input.files, so the change handler is given the
  // list the browser would have handed it.
  const input = win.document.getElementById(id);
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

// The volume reaches the rack rather than the stage: a rack has an input and an
// output that never move, which is what lets five of them exist at once.
check('a filter alone is the only stage in the path', g.gain.out.length === 1 && g.gain.out[0] === g.master.input &&
  g.master.input.out[0] === g.filter && g.filter.out[0] === g.master.output && g.master.output.out[0] === g.analyser);
check('the chain strip names it', live(w) === 'Low Pass', live(w));
check('echo and reverb start off', !w.__probe.effects().echoOn && !w.__probe.effects().revOn);
check('their sliders stay folded away', w.document.getElementById('aud-echo-params').classList.contains('hidden') &&
  w.document.getElementById('aud-rev-params').classList.contains('hidden'));

press(w, 'aud-echo-on');
g = w.__probe.graph();
check('echo switches on', w.__probe.effects().echoOn && !w.document.getElementById('aud-echo-params').classList.contains('hidden'));
check('and lands after the filter, not instead of it', g.filter.out.length === 1 && g.filter.out[0] === g.echo.input && g.echo.output.out[0] === g.master.output);
check('its delay feeds itself, which is what makes the repeats', g.echo.delay.out.indexOf(g.echo.fb) >= 0 && g.echo.fb.out.indexOf(g.echo.delay) >= 0);
check('and it keeps a dry path alongside the wet one', g.echo.dry.gain.value === 0.65 && g.echo.wet.gain.value === 0.35);

press(w, 'aud-rev-on');
g = w.__probe.graph();
check('reverb stacks on top of both', live(w) === 'Low Pass,Echo,Reverb', live(w));
check('three stages run in order', g.gain.out[0] === g.master.input && g.master.input.out[0] === g.filter &&
  g.filter.out[0] === g.echo.input && g.echo.output.out[0] === g.rev.input &&
  g.rev.output.out[0] === g.master.output && g.master.output.out[0] === g.analyser &&
  g.analyser.out[0] === g.ctx.destination);
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
check('and with no filter in front of them', live(w) === 'Echo,Reverb' && g.master.input.out[0] === g.echo.input, live(w));

w = boot(`#v=3&flt=lp,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a link from before the effects existed leaves them off', !w.__probe.effects().echoOn && !w.__probe.effects().revOn);

// --- 9b. what the two sliders are called ------------------------------------
//
// One pair of sliders serves five chips, and the quantity under each one moves
// with the chip. A band type has a centre and two edges rather than a cut-off,
// and the biquad reads the second slider as decibels for the low and high pass
// and as a plain Q everywhere else. The slider positions never move, so a link
// written before any of this reads back exactly the same.

w = boot(`#v=3&flt=lp,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
const fname = () => w.document.getElementById('aud-filter-freq-name').textContent;
const qname = () => w.document.getElementById('aud-filter-q-name').textContent;
const fval = () => w.document.getElementById('aud-filter-freq-val').textContent;
const qval = () => w.document.getElementById('aud-filter-q-val').textContent;
const chip = (win, type) => win.document.querySelector(`[data-filter="${type}"]`).click();
const qpos = () => w.document.getElementById('aud-filter-q').value;
const nodeQ = () => w.__probe.graph().filter.Q.value;
const setQ = (pos) => {
  const n = w.document.getElementById('aud-filter-q');
  n.value = String(pos);
  n.dispatchEvent(new w.Event('input', { bubbles: true }));
};

check('a low pass has a cut-off', fname() === 'Cutoff', fname());
check('and its second slider is resonance, in the decibels the node reads', qname() === 'Resonance' && qval() === '1.0 dB', qname() + ' ' + qval());
check('the frequency is the one the slider is sitting on', fval() === '632 Hz', fval());

chip(w, 'highpass');
check('a high pass is named the same way', fname() === 'Cutoff' && qname() === 'Resonance', fname() + ' / ' + qname());

check('and a chip without an arrival Q leaves the slider where it was', qpos() === '45' && qval() === '1.0 dB', qpos() + ' ' + qval());

chip(w, 'bandpass');
check('a band pass has a centre, not a cut-off', fname() === 'Centre', fname());
check('and a plain Q, with no decibels on it', qname() === 'Q' && qval() === '2.0', qname() + ' ' + qval());

chip(w, 'notch-wide');
check('band stop reads as a centre too', fname() === 'Centre' && qname() === 'Q', fname() + ' / ' + qname());
check('and arrives on its own wide Q', qval() === '0.50', qval());

chip(w, 'notch-narrow');
check('the notch is the narrow one', qval() === '10.0', qval());

chip(w, 'lowpass');
check('coming back to a low pass reads the same position as decibels', qname() === 'Resonance' && qval() === '17.0 dB', qval());

chip(w, 'lowpass');
check('switching the filter off leaves the words alone rather than blanking them', fname() === 'Cutoff' && qname() === 'Resonance', fname() + ' / ' + qname());
check('and folds the sliders away', w.document.getElementById('aud-params').classList.contains('hidden'));

// The link is written from the slider positions, so none of the naming reaches it.
w = boot(`#v=3&flt=bp,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a band pass link restores as a centre', fname() === 'Centre' && fval() === '632 Hz', fname() + ' ' + fval());
check('on the Q the sender set, not the one the chip arrives on', qval() === '1.0', qval());
check('and goes back out unchanged', /(^|&)flt=bp,500,1(&|$)/.test(w.__probe.encodeState()), w.__probe.encodeState());

// --- 9c. the Q a chip arrives on ---------------------------------------------
//
// The second slider keeps its position across a chip change, but its meaning does
// not: 20 is 20 dB of resonance on a low pass and a 30 Hz slit on a band pass. A
// chip whose Q is a width arrives on one of its own rather than inheriting a
// number that would leave nothing to hear.

w = boot(`#v=3&flt=lp,500,20&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a low pass sitting at the top of the slider', qpos() === '1000' && qval() === '20.0 dB', qpos() + ' ' + qval());

chip(w, 'bandpass');
check('band pass does not inherit it', qval() === '2.0', qval());
check('and the node is filtering on the new one', Math.abs(nodeQ() - 2) < 1e-9, String(nodeQ()));
check('so the band is wide enough to hear through', w.__probe.graph().filter.frequency.value / 2 > 300,
  String(w.__probe.graph().filter.frequency.value / 2));

chip(w, 'notch-narrow');
chip(w, 'bandpass');
check('and it arrives the same way from a notch', qval() === '2.0', qval());

// A low pass still takes whatever it is handed: resonance in decibels is a filter
// you can listen to anywhere on the slider, so there is nothing to rescue it from.
chip(w, 'lowpass');
check('a low pass keeps the position it was handed', qpos() === '500' && qval() === '10.0 dB', qpos() + ' ' + qval());

// --- 9d. how fast the second slider moves ------------------------------------
//
// Q is a width for the band types and width is heard in octaves, so a slider
// linear in Q spent its top half on bands that all sound like one frequency:
// halfway was Q 10, a band a seventh of an octave wide. It is logarithmic in Q
// now, 0.2 to 20, so every quarter turn is about the same change to the ear.
// The low and high pass are left linear, because decibels already are a log.

w = boot(`#v=3&flt=bp,500,2&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();

setQ(500);
check('halfway along a band type is a band, not a spike', Math.abs(nodeQ() - 2) < 0.01, String(nodeQ()));

const quarters = [0, 250, 500, 750, 1000].map((pos) => { setQ(pos); return nodeQ(); });
check('the ends are the range', Math.abs(quarters[0] - 0.2) < 1e-6 && Math.abs(quarters[4] - 20) < 1e-6,
  quarters[0] + ' .. ' + quarters[4]);
const steps = quarters.slice(1).map((q, i) => q / quarters[i]);
// Within the rounding: the value is snapped to the precision it is printed at,
// so the ratios land a few tenths of a percent either side of the exact root.
check('and every quarter turn is the same multiple of the one before',
  steps.every((r) => Math.abs(r - Math.sqrt(10)) < 0.02), steps.map((r) => r.toFixed(3)).join(', '));

// Which is the whole point: the widths those land on are evenly spaced too.
const octaves = quarters.map((q) => {
  const k = Math.sqrt(1 + 1 / (4 * q * q));
  return Math.log2((k + 1 / (2 * q)) / (k - 1 / (2 * q)));
});
check('so no two stops on the slider are the same band', octaves.every((o, i) => i === 0 || octaves[i - 1] / o > 1.9),
  octaves.map((o) => o.toFixed(2)).join(', '));

// The low and high pass keep a linear slider, in decibels.
chip(w, 'lowpass');
setQ(500);
check('halfway on a low pass is halfway up the decibels', qval() === '10.0 dB', qval());
setQ(250);
check('and a quarter of the way is a quarter of them', qval() === '5.1 dB', qval());

// --- 9e. the link still means one thing --------------------------------------
//
// The third field of flt= has always been the Q itself, which happened to equal
// the slider position until the slider was remapped. It is still the Q, so a
// link written before that restores the filter it described rather than a
// position on a slider that has moved underneath it.

w = boot(`#v=3&flt=nt,500,10&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a notch link from before the remap restores its Q', qval() === '10.0' && Math.abs(nodeQ() - 10) < 0.01, qval());
check('from a position it never named', qpos() === '849', qpos());
check('and goes back out as the same link', /(^|&)flt=nt,500,10(&|$)/.test(w.__probe.encodeState()), w.__probe.encodeState());

w = boot(`#v=3&flt=bs,500,0.5&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('and a wide band stop survives the trip too', qval() === '0.50' && /(^|&)flt=bs,500,0.5(&|$)/.test(w.__probe.encodeState()),
  qval() + ' ' + w.__probe.encodeState());

// A resonance in decibels was never a Q and still is not.
w = boot(`#v=3&flt=lp,500,6&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
check('a low pass link is decibels at both ends', qval() === '6.0 dB' && /(^|&)flt=lp,500,6(&|$)/.test(w.__probe.encodeState()),
  qval() + ' ' + w.__probe.encodeState());

// Dragging anywhere and writing the link back has to land on the same place.
w = boot(`#v=3&flt=bp,500,2&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
const carriedQ = (link) => parseFloat((/flt=[^,]+,[^,]+,([^&]+)/.exec(link) || [])[1]);
let drift = [], unstable = [];
[0, 7, 123, 349, 500, 661, 850, 993, 1000].forEach((pos) => {
  setQ(pos);
  const link = w.__probe.encodeState();
  const was = nodeQ();
  if (Math.abs(carriedQ(link) - was) > 1e-9) drift.push(pos + ': link says ' + carriedQ(link) + ', node is ' + was);
  w.__probe.applyState(w.__probe.decodeState('#' + link));
  if (Math.abs(nodeQ() - was) > 1e-9) drift.push(pos + ': came back as ' + nodeQ());
  // The position may settle a step or two away, so the link has to stop moving
  // on the second pass rather than creeping every time it is reshared.
  const again = w.__probe.encodeState();
  if (again !== link) unstable.push(pos + ': ' + carriedQ(link) + ' -> ' + carriedQ(again));
});
check('a link carries exactly what the filter is running on', drift.length === 0, drift.join(' | '));
check('and resharing it does not move it', unstable.length === 0, unstable.join(' | '));

// --- 10. the math panel ------------------------------------------------------
//
// It reads like the caption under the visualiser: short lines, each arriving a
// token at a time. What matters here is that it starts closed, that it stages
// its entrance, and that a moving slider patches the numbers rather than
// re-running that entrance on every input event.

w = boot(`#v=3&flt=lp,500,1&ec=320,0.35,0.35&rv=2.2,20,0.3&p=5&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
const math = () => w.document.getElementById('aud-math');
const mathRows = () => [...w.document.querySelectorAll('.aud-math-line')].map((n) => n.textContent);
const tick = (win, id, on) => {
  const box = win.document.getElementById(id);
  box.checked = on;
  box.dispatchEvent(new win.Event('change'));
};

check('the math is off on arrival', math().classList.contains('hidden') && !w.__probe.effects().mathOn);
check('and nothing is rendered until it is asked for', math().textContent === '', math().textContent.slice(0, 40));

tick(w, 'aud-math-on', true);
let rows = mathRows();
let mathText = rows.join(' | ');
check('ticking it opens the panel', !math().classList.contains('hidden') && w.__probe.effects().mathOn);
check('it is lines, not paragraphs', rows.length > 6 && rows.every((r) => r.length < 80),
  'longest ' + Math.max(...rows.map((r) => r.length)));
check('every running stage gets a heading', /Low Pass/.test(mathText) && /Echo/.test(mathText) &&
  /Reverb/.test(mathText) && /Pitch/.test(mathText));
check('stacking is stated as a product of transfer functions',
  /H\(z\) = Hflt\(z\) · Hecho\(z\) · Hrev\(z\)/.test(mathText), mathText.slice(0, 60));
check('the echo delay is worked out in samples', /D = τfs = 14\u2009112 samples/.test(mathText), mathText);
check('and its tail is counted in repeats', /−60 dB after 7 repeats, 2\.2 s/.test(mathText), '');
check('the reverb tap count follows the size', /N = Tfs = 97\u2009020 taps/.test(mathText), '');
check('the biquad reports the browser\'s own response', /\|H\(f0\)\| = −3\.0 dB/.test(mathText), '');
check('a pitch shift gets a line', /r = 2n\/12 = 1\.3348/.test(mathText), '');
check('the sample rate is the one the context is running at', /fs = 44\u2009100 Hz/.test(mathText), '');

// The entrance: every token is laid out at once and inked on a stagger, which is
// what keeps the lines from reflowing as the rest of them arrive.
const words = () => [...w.document.querySelectorAll('.aud-math-w')];
check('every token is laid out before any is shown', words().length > 30, String(words().length));
check('and each is given its turn', words()[10].style.transitionDelay !== words()[0].style.transitionDelay,
  words()[0].style.transitionDelay + ' vs ' + words()[10].style.transitionDelay);
check('the ink is held back for a frame', words().every((n) => !n.classList.contains('is-in')));
await settle();
check('then it arrives', words().every((n) => n.classList.contains('is-in')));

// Moving a slider re-runs the arithmetic, but patches it in rather than making
// the whole panel strobe through its entrance again.
const before = words()[0];
const fb = w.document.getElementById('aud-echo-fb');
fb.value = '0.7';
fb.dispatchEvent(new w.Event('input', { bubbles: true }));
check('the numbers follow the sliders', /−60 dB after 20 repeats, 6\.4 s/.test(mathRows().join(' | ')),
  (mathRows().join(' | ').match(/after \d+ repeats, [\d.]+ s/) || [''])[0]);
check('and so does the graph', w.__probe.graph().echo.fb.gain.value === 0.7);
check('the panel is patched, not rebuilt', words()[0] === before);
check('so nothing fades back in under a moving slider', words().every((n) => n.classList.contains('is-in')));
check('the number that moved is lit', [...w.document.querySelectorAll('.aud-math-w.is-hot')].length > 0,
  String([...w.document.querySelectorAll('.aud-math-w.is-hot')].length));

// Switching a stage on is a different shape, so that one does rebuild.
press(w, 'aud-rev-on');
check('switching a stage off rebuilds the panel', words()[0] !== before && !/Reverb/.test(mathRows().join(' | ')));

check('the math never rides in a link', !/(^|&)m=/.test(w.__probe.encodeState()), w.__probe.encodeState());

tick(w, 'aud-math-on', false);
check('unticking closes it', math().classList.contains('hidden'));
check('and clears it out rather than hiding stale numbers', math().textContent === '');

// With nothing switched on it says so, rather than showing an empty panel.
w = boot(`#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d`, () => res({ chunks: [] }));
await settle();
tick(w, 'aud-math-on', true);
mathText = mathRows().join(' | ');
check('a clean chain still says what it is doing', /y\[n\] = x\[n\]/.test(mathText), mathText);
check('and offers no line for a stage that is off', !/Echo/.test(mathText) && !/Reverb/.test(mathText));

// --- 11. leaving the page ----------------------------------------------------
//
// One switch and one platform fact decide all of this. A desktop tab keeps its
// AudioContext running while hidden, so the right move there is to do nothing;
// iOS Safari interrupts it, so the track has to be handed to a media element.
// These drive every branch of that.

const hide = (win, hidden) => {
  Object.defineProperty(win.document, 'hidden', { value: hidden, configurable: true });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
};
const DEMO = '#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d';

// --- the desktop branch: the graph is left alone -----------------------------

w = boot(DEMO, () => res({ chunks: [] }), MAC_UA);
await settle();
let bg = w.document.getElementById('aud-bg');

check('the toggle is on by default', w.document.getElementById('aud-bg-on').checked && w.__probe.state().bgAllowed);
check('a Mac is not mistaken for an iPad', w.__probe.state().handoffNeeded === false);
check('and the tip says so', /switch tabs/.test(w.document.getElementById('aud-bg-tip').textContent),
  w.document.getElementById('aud-bg-tip').textContent);
check('the track is still kept as bytes an element could play', /^blob:/.test(bg.src), bg.src);

w.document.getElementById('aud-play').click();
await settle();
check('playing starts on the graph while the page is visible', w.__probe.state().hasSource && !bg.playing);
check('and the element is left untouched, because it will never be needed', !bg.everPlayed);

w.__probe.seekTo(30);
hide(w, true);
check('leaving a desktop tab does not hand the track over', w.__probe.state().bgActive === false && !bg.playing);
check('the buffer source is still the one playing, so nothing blips and nothing gets louder',
  w.__probe.state().hasSource === true);
check('and the page still reads as playing', w.__probe.state().playing === true);

hide(w, false);
check('coming back changes nothing either', w.__probe.state().playing === true && w.__probe.state().bgActive === false);
check('and the position was never rewound', Math.abs(w.__probe.state().offsetSec - 30) < 0.5,
  String(w.__probe.state().offsetSec));

// --- the iOS branch: the element takes the track -----------------------------

w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
bg = w.document.getElementById('aud-bg');
check('an iPhone is marked as needing the handoff', w.__probe.state().handoffNeeded === true);
check('and the tip warns the effects drop out', /effects/.test(w.document.getElementById('aud-bg-tip').textContent),
  w.document.getElementById('aud-bg-tip').textContent);

w.document.getElementById('aud-play').click();
await settle();
check('the play button unlocks the element for later, muted', bg.everPlayed === true && w.__probe.state().bgPrimed);
check('and leaves it paused and audible for when it is really needed', !bg.playing && bg.muted === false);
check('while the graph is the one actually playing', w.__probe.graph().gain.out.length > 0);

w.__probe.seekTo(30);
hide(w, true);
check('leaving the page hands the track to the element', bg.playing === true);
check('and takes it off the graph', w.__probe.state().hasSource === false);
check('at the position the graph had reached', Math.abs(bg.currentTime - 30) < 0.5, String(bg.currentTime));
check('and the page still reads as playing', w.__probe.state().playing === true);

bg.currentTime = 42;
hide(w, false);
check('coming back takes it off the element', bg.playing === false);
check('and picks the graph up where the element got to', Math.abs(w.__probe.state().offsetSec - 42) < 0.5,
  String(w.__probe.state().offsetSec));
check('still playing', w.__probe.state().playing === true);

// A paused page is left paused: nothing here starts audio nobody asked for.
w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
bg = w.document.getElementById('aud-bg');
hide(w, true);
check('leaving a paused page starts nothing', bg.playing !== true && w.__probe.state().playing === false);

// The element carries the volume and the varispeed across with it.
w = boot('#v=3&flt=off,500,1&viz=1,1&vol=0.4&p=7&t=d', () => res({ chunks: [] }), IPHONE_UA);
await settle();
bg = w.document.getElementById('aud-bg');
w.document.getElementById('aud-play').click();
await settle();
hide(w, true);
check('the handoff happened, so the rest of this is about the element', bg.playing === true);
check('the element takes the volume with it', Math.abs(bg.volume - 0.4) < 0.001, String(bg.volume));
check('and the pitch shift, as a rate', Math.abs(bg.playbackRate - Math.pow(2, 7 / 12)) < 0.001, String(bg.playbackRate));
check('with pitch preservation off, so it varispeeds like the buffer source', bg.preservesPitch === false);

// And keeps following the slider once it has it, since the gain node it used to
// go through is no longer in the path.
const vol = w.document.getElementById('aud-volume');
vol.value = '0.9';
vol.dispatchEvent(new w.Event('input'));
check('a volume change while away reaches the element', Math.abs(bg.volume - 0.9) < 0.001, String(bg.volume));

// Something outside the page stopping the element is a decision, not a glitch.
w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
bg = w.document.getElementById('aud-bg');
w.document.getElementById('aud-play').click();
await settle();
w.__probe.seekTo(12);
hide(w, true);
check('the element has the track', w.__probe.state().bgActive === true && bg.playing);

bg.currentTime = 25;
bg.pause();
check('a pause from outside the page is believed', w.__probe.state().playing === false &&
  w.__probe.state().bgActive === false);
check('and the position it stopped at is kept', Math.abs(w.__probe.state().offsetSec - 25) < 0.5,
  String(w.__probe.state().offsetSec));

hide(w, false);
check('so coming back does not start it again behind the listener', w.__probe.state().playing === false);
check('with the track still where it was left', Math.abs(w.__probe.state().offsetSec - 25) < 0.5,
  String(w.__probe.state().offsetSec));

// --- the toggle off: pause at the door, resume on the way in -----------------

const setBg = (win, on) => {
  const box = win.document.getElementById('aud-bg-on');
  box.checked = on;
  box.dispatchEvent(new win.Event('change'));
};

w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
bg = w.document.getElementById('aud-bg');
setBg(w, false);
check('turning it off is remembered', w.__probe.state().bgAllowed === false);
check('and the tip changes to match', /picks up/.test(w.document.getElementById('aud-bg-tip').textContent),
  w.document.getElementById('aud-bg-tip').textContent);

w.document.getElementById('aud-play').click();
await settle();
w.__probe.seekTo(18);
hide(w, true);
check('leaving now pauses instead of handing over', w.__probe.state().playing === false && !bg.playing);
check('at the position it had reached', Math.abs(w.__probe.state().offsetSec - 18) < 0.5,
  String(w.__probe.state().offsetSec));
check('and it is remembered as ours to undo', w.__probe.state().pausedByHide === true);

hide(w, false);
check('coming back picks it up again', w.__probe.state().playing === true);
check('from where it stopped', Math.abs(w.__probe.state().offsetSec - 18) < 0.5, String(w.__probe.state().offsetSec));
check('and the debt is cleared', w.__probe.state().pausedByHide === false);

// Pausing by hand while away is the listener's decision, not ours to undo.
w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
setBg(w, false);
w.document.getElementById('aud-play').click();
await settle();
hide(w, true);
w.document.getElementById('aud-stop').click();
hide(w, false);
check('a stop while away is not undone on return', w.__probe.state().playing === false &&
  w.__probe.state().pausedByHide === false);

// The choice outlives the page.
w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
check('the stored choice is read back on the next visit', w.__probe.state().bgAllowed === false);
setBg(w, true);
w = boot(DEMO, () => res({ chunks: [] }), IPHONE_UA);
await settle();
check('and so is turning it back on', w.__probe.state().bgAllowed === true);

// --- 12. the split -----------------------------------------------------------
//
// Four stems out of two crossovers and a mid/side matrix. What is asserted here
// is the topology, because the topology is the whole claim: an allpass on the
// low band so the four sum flat, and a matrix that is exact rather than nearly
// so. jsdom does no audio, so nothing here can hear it -- but a matrix wired to
// the wrong splitter output is a wiring fact, and wiring is recorded.

const DEMO2 = '#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d';
const stemsOf = (win) => win.__probe.stems();
const rowsOf = (win) => Array.from(win.document.querySelectorAll('.aud-stem'));

w = boot(DEMO2, () => res({ chunks: [] }));
await settle();

check('the split starts off', w.__probe.split().on === false);
check('and its faders are folded away', w.document.getElementById('aud-stem-list').classList.contains('hidden'));
check('so there is nothing to point the effects panel at', w.document.getElementById('aud-target').classList.contains('hidden'));
check('the whole track reaches the master rack', w.__probe.graph().gain.out[0] === w.__probe.graph().master.input);

press(w, 'aud-split-on');
let sp = w.__probe.graph().split;
g = w.__probe.graph();

check('splitting reroutes the volume into the crossover tree', g.gain.out.length === 1 && g.gain.out[0] === sp.input);
check('and the tree still ends at the master rack', sp.output.out[0] === g.master.input);
check('four rows appear', rowsOf(w).length === 4);
check('named for where they come from', rowsOf(w).map((r) => r.querySelector('.aud-stem-name').textContent).join(',') === 'Low,Centre,Sides,High');

// Linkwitz-Riley is two Butterworth sections in series, and Web Audio wants that
// Q as decibels rather than as 0.707.
const BUTTER_DB = 20 * Math.log10(Math.SQRT1_2);
const near = (a, b) => Math.abs(a - b) < 1e-6;
check('each crossover half is two sections deep', sp.lo.a.out[0] === sp.lo.b && sp.hi.a.out[0] === sp.hi.b &&
  sp.mid.a.out[0] === sp.mid.b && sp.top.a.out[0] === sp.top.b);
check('every one of them Butterworth aligned, in the units the browser reads',
  [sp.lo.a, sp.lo.b, sp.hi.a, sp.hi.b, sp.mid.a, sp.mid.b, sp.top.a, sp.top.b].every((f) => near(f.Q.value, BUTTER_DB)),
  String(sp.lo.a.Q.value));
check('and pointed at the two crossovers the sliders name',
  [sp.lo.a, sp.hi.b].every((f) => Math.abs(f.frequency.value - 200) < 1) &&
  [sp.mid.a, sp.top.b].every((f) => Math.abs(f.frequency.value - 6000) < 30),
  sp.lo.a.frequency.value + ' / ' + sp.mid.a.frequency.value);

check('the low band is taken off the first crossover', sp.input.out[0] === sp.lo.input && sp.lo.output.out[0] === sp.comp);
check('and put through the allpass the other two sum to, or it would not add back up flat',
  sp.comp.type === 'allpass' && near(sp.comp.Q.value, Math.SQRT1_2) && Math.abs(sp.comp.frequency.value - 6000) < 30,
  sp.comp.type + ' Q' + sp.comp.Q.value);
check('the second crossover hangs off the first', sp.hi.output.out.indexOf(sp.mid.input) >= 0 &&
  sp.hi.output.out.indexOf(sp.top.input) >= 0);

// The matrix. M is a sum of both channels into one node, S is the same with the
// right inverted, and the two of them go back out as (M, M) and (S, -S).
const merger = sp.heads[1];
const sideMerger = sp.heads[2];
check('the mid band is forced to two channels before it is taken apart',
  sp.mid.output.out[0].channelCount === 2 && sp.mid.output.out[0].channelInterpretation === 'speakers');
const splitter = sp.mid.output.out[0].out[0];
check('and then split', splitter.kind === 'splitter' && splitter.numberOfOutputs === 2);

const sumOf = (n) => splitter.wires.filter((x) => x.to === n).map((x) => x.from).sort().join('');
const midNode = splitter.wires.map((x) => x.to).find((n) => sumOf(n) === '01');
check('M takes both channels into one node', Boolean(midNode) && midNode.gain.value === 0.5);
const inverted = splitter.wires.filter((x) => x.from === 1).map((x) => x.to).find((n) => n.gain && n.gain.value === -1);
check('S takes the right one inverted', Boolean(inverted));
const sideNode = inverted.out[0];
check('into a node the left is also arriving at', splitter.wires.some((x) => x.from === 0 && x.to === sideNode) &&
  sideNode.gain.value === 0.5);

check('Centre goes back out as M against M',
  midNode.wires.filter((x) => x.to === merger).map((x) => x.into).sort().join('') === '01');
const negS = sideNode.out.find((n) => n.gain && n.gain.value === -1);
check('Sides goes back out as S against minus S',
  sideNode.wires.some((x) => x.to === sideMerger && x.into === 0) &&
  Boolean(negS) && negS.wires.some((x) => x.to === sideMerger && x.into === 1));

// Every stem has its own rack, and the rack sits between the split and the mix.
let stemList = stemsOf(w);
check('each stem gets its own fader and its own meter',
  stemList.every((st) => st.gainNode && st.meter));
check('each head feeds its stem rack, which feeds the fader, which feeds the mix',
  stemList.every((st, i) => sp.heads[i].out[0] === st.rack.nodes.input &&
    st.rack.nodes.output.out[0] === st.gainNode &&
    st.gainNode.out[0] === st.meter && st.meter.out[0] === sp.output));
check('and they all start at unity', stemList.every((st) => st.gainNode.gain.value === 1));

// --- 12b. mute, solo and the fader ------------------------------------------

const stemBtn = (win, i, label) =>
  rowsOf(win)[i].querySelectorAll('.aud-stem-btn')[label];
const MUTE = 0, SOLO = 1, EDIT = 2;

stemBtn(w, 0, MUTE).click();
check('muting a stem takes it out of the mix', stemList[0].gainNode.gain.value === 0);
check('and says so on the row', rowsOf(w)[0].classList.contains('is-silent'));
check('while the rest carry on', stemList[1].gainNode.gain.value === 1);
stemBtn(w, 0, MUTE).click();
check('unmuting puts it back', stemList[0].gainNode.gain.value === 1);

stemBtn(w, 1, SOLO).click();
check('a solo silences everything that is not soloed',
  stemList.map((st) => st.gainNode.gain.value).join(',') === '0,1,0,0',
  stemList.map((st) => st.gainNode.gain.value).join(','));
stemBtn(w, 2, SOLO).click();
check('and a second solo joins the first rather than replacing it',
  stemList.map((st) => st.gainNode.gain.value).join(',') === '0,1,1,0');
stemBtn(w, 1, SOLO).click();
stemBtn(w, 2, SOLO).click();
check('clearing them all brings the mix back', stemList.every((st) => st.gainNode.gain.value === 1));

const fader = (win, i) => rowsOf(win)[i].querySelector('.aud-stem-gain');
const setRange = (node, value) => {
  node.value = String(value);
  node.dispatchEvent(new w.Event('input', { bubbles: true }));
};
setRange(fader(w, 3), -6);
check('a fader is decibels, not a raw gain', Math.abs(stemList[3].gainNode.gain.value - Math.pow(10, -6 / 20)) < 1e-6,
  String(stemList[3].gainNode.gain.value));
check('and the row prints what it is set to', rowsOf(w)[3].querySelector('.aud-stem-db').textContent === '−6.0 dB',
  rowsOf(w)[3].querySelector('.aud-stem-db').textContent);
setRange(fader(w, 3), -40);
check('the bottom of the travel is off rather than very quiet', stemList[3].gainNode.gain.value === 0 &&
  rowsOf(w)[3].querySelector('.aud-stem-db').textContent === 'off');
setRange(fader(w, 3), 0);

// --- 12c. the effects panel points somewhere ---------------------------------

const targetChips = (win) => Array.from(win.document.querySelectorAll('#aud-target-chips .aud-chip'));

check('the panel offers the master and all four stems', targetChips(w).map((c) => c.textContent).join(',') === 'Master,Low,Centre,Sides,High');
check('and starts on the master', w.__probe.target() === -1 && targetChips(w)[0].classList.contains('is-on'));

targetChips(w)[2].click();
check('picking a stem moves the panel to it', w.__probe.target() === 1);
check('and the row it belongs to lights up', rowsOf(w)[1].classList.contains('is-target'));
check('the chain strip says whose rack it is drawing',
  Array.from(w.document.querySelectorAll('.aud-chain-node.is-fixed')).map((n) => n.textContent).join(',') === 'Centre,Mix',
  Array.from(w.document.querySelectorAll('.aud-chain-node.is-fixed')).map((n) => n.textContent).join(','));

press(w, 'aud-echo-on');
check('the echo lands on that stem', stemList[1].rack.echoOn === true);
check('and not on the master', w.__probe.racks().master.echoOn === false);
check('the stem it is on says it is carrying something', rowsOf(w)[1].classList.contains('has-fx'));
g = w.__probe.graph();
check('and it is wired inside that stem, between the split and the fader',
  sp.heads[1].out[0] === stemList[1].rack.nodes.input &&
  stemList[1].rack.nodes.input.out[0] === stemList[1].rack.nodes.echo.input &&
  stemList[1].rack.nodes.echo.output.out[0] === stemList[1].rack.nodes.output);

w.document.getElementById('aud-filters').querySelector('[data-filter="highpass"]').click();
check('so does a filter', stemList[1].rack.filterType === 'highpass' && w.__probe.racks().master.filterType === null);
check('and it runs before the echo on that stem',
  stemList[1].rack.nodes.input.out[0] === stemList[1].rack.nodes.filter &&
  stemList[1].rack.nodes.filter.out[0] === stemList[1].rack.nodes.echo.input);

targetChips(w)[0].click();
check('going back to the master shows the master again', w.__probe.target() === -1 &&
  w.document.getElementById('aud-echo-on').classList.contains('is-on') === false);
check('while the stem keeps what it was given', stemList[1].rack.echoOn === true &&
  stemList[1].rack.filterType === 'highpass');

// The Edit button on a row is the same door from the other side.
stemBtn(w, 3, EDIT).click();
check('the row edit button points the panel too', w.__probe.target() === 3);

// --- 12d. a link carries the split ------------------------------------------

targetChips(w)[0].click();
setRange(fader(w, 0), -3);
stemBtn(w, 2, MUTE).click();
hash = w.__probe.encodeState();

check('the link carries the crossovers and which cut they belong to',
  /(^|&)sp=\d+,\d+,b(&|$)/.test(hash), hash);
check('and the fader that was moved', /(^|&)s0=-3,0,0(&|$)/.test(hash), hash);
check('and the mute', /(^|&)s2=0,1,0(&|$)/.test(hash), hash);
check('and the stem that is carrying effects', /(^|&)s1flt=hp,/.test(hash) && /(^|&)s1ec=/.test(hash), hash);
check('but writes nothing for a stem that is doing nothing', !/(^|&)s3(flt|ec|rv)?=/.test(hash), hash);
check('and stays a v3 link, so a page that predates the stems still opens it',
  /(^|&)v=3(&|$)/.test(hash), hash);

const shared = boot('#' + hash, () => res({ chunks: [] }));
await settle();
const back = stemsOf(shared);
check('opening it splits the track again', shared.__probe.split().on === true);
check('with the faders where they were', back[0].db === -3 && back[2].muted === true);
check('and the stem effects on the stem they were on',
  back[1].rack.echoOn === true && back[1].rack.filterType === 'highpass' &&
  back[3].rack.echoOn === false);
check('the master is still clean', shared.__probe.racks().master.echoOn === false &&
  shared.__probe.racks().master.filterType === null);
check('and the graph is wired for it', shared.__probe.graph().gain.out[0] === shared.__probe.graph().split.input);

// A link from before any of this leaves the track whole.
w = boot('#v=3&flt=lp,500,1&ec=320,0.35,0.35&viz=1,1&vol=0.7&t=d', () => res({ chunks: [] }));
await settle();
check('an older link opens unsplit', w.__probe.split().on === false);
check('with its effects on the master, where they were', w.__probe.racks().master.echoOn === true &&
  w.__probe.racks().master.filterType === 'lowpass');
check('and the volume reaching that rack directly', w.__probe.graph().gain.out[0] === w.__probe.graph().master.input);

// Turning the split off puts the track back together and lets go of the stems.
press(w, 'aud-split-on');
targetChips(w)[2].click();
check('a stem can be edited while the split is on', w.__probe.target() === 1);
press(w, 'aud-split-on');
check('turning it off sends the panel back to the master', w.__probe.target() === -1);
check('and the volume back to the master rack', w.__probe.graph().gain.out[0] === w.__probe.graph().master.input);
check('with the stems left as they were, for when it comes back',
  stemsOf(w).every((st) => st.rack.nodes !== null));
check('and nothing of them in the link', !/(^|&)sp=/.test(w.__probe.encodeState()), w.__probe.encodeState());

// --- 13. simple and pro ------------------------------------------------------
//
// One set of controls, not two: the canvas, the transport and the scrubber in
// simple mode are the ones pro mode uses, which is why the switch never
// interrupts anything.

w = boot(DEMO2, () => res({ chunks: [] }));
await settle();

check('a first visit lands in simple mode', w.__probe.mode() === true &&
  w.document.body.classList.contains('aud-simple'));
check('with the switch showing where it is', w.document.getElementById('aud-mode-simple').classList.contains('is-on') &&
  !w.document.getElementById('aud-mode-pro').classList.contains('is-on'));

press(w, 'aud-simple-echo');
check('the echo switch there reaches the master rack', w.__probe.racks().master.echoOn === true);
check('and lights up', w.document.getElementById('aud-simple-echo').classList.contains('is-on'));
check('and it is a real stage in the graph, not a label',
  w.__probe.graph().master.input.out[0] === w.__probe.graph().master.echo.input);
press(w, 'aud-simple-rev');
check('so does the reverb', w.__probe.racks().master.revOn === true);
check('and it stacks behind the echo, in the order the pro panel says',
  w.__probe.graph().master.echo.output.out[0] === w.__probe.graph().master.rev.input);

const stChip = (win, st) => win.document.querySelector('.aud-simple-st[data-st="' + st + '"]');
stChip(w, -12).click();
check('a pitch mode moves the pitch', w.__probe.graph().ctx && w.document.getElementById('aud-pitch').value === '-12');
check('and the chip that was pressed is the one lit',
  stChip(w, -12).classList.contains('is-on') && !stChip(w, 0).classList.contains('is-on'));
check('the rate readout follows it', w.document.getElementById('aud-pitch-rate').textContent.indexOf('0.50') === 0,
  w.document.getElementById('aud-pitch-rate').textContent);
stChip(w, 0).click();
check('and zero puts it back', w.document.getElementById('aud-pitch').value === '0' &&
  stChip(w, 0).classList.contains('is-on'));

hash = w.__probe.encodeState();
check('what was built in simple mode is a plain link', /(^|&)ec=/.test(hash) && /(^|&)rv=/.test(hash), hash);
check('and the mode itself stays out of it', !/(^|&)(mode|ui)=/.test(hash), hash);

press(w, 'aud-mode-pro');
check('switching to pro takes the class off the body', w.__probe.mode() === false &&
  !w.document.body.classList.contains('aud-simple'));
check('and the pro panel is already on what simple mode built',
  w.document.getElementById('aud-echo-on').classList.contains('is-on') &&
  w.document.getElementById('aud-rev-on').classList.contains('is-on'));
check('nothing was rebuilt to get there', w.__probe.graph().master.echo.output.out[0] === w.__probe.graph().master.rev.input);

// The pro panel is the other half of the same switch.
press(w, 'aud-echo-on');
check('turning it off in pro turns it off in simple too', w.__probe.racks().master.echoOn === false &&
  !w.document.getElementById('aud-simple-echo').classList.contains('is-on'));

w = boot(DEMO2, () => res({ chunks: [] }));
await settle();
check('the choice outlives the page', w.__probe.mode() === false);
press(w, 'aud-mode-simple');
w = boot(DEMO2, () => res({ chunks: [] }));
await settle();
check('and so does switching back', w.__probe.mode() === true);

// Simple mode has no playlist on screen, so its one file button swaps the track
// rather than quietly growing a list nobody can see.
w = boot(DEMO2, () => res({ chunks: [] }));
await settle();
w.__probe.setQueue([
  w.__probe.newEntry({ ref: 'demo', name: 'symphony.mp3' }),
  w.__probe.newEntry({ ref: 'demo', name: 'second.mp3' }),
], 0);
w.document.querySelector('label[for="aud-simple-file"]').click();
pickFiles(w, ['other.mp3'], 'aud-simple-file');
await settle();
st = w.__probe.state();
check('the simple track button swaps rather than appending out of sight',
  st.queue.length === 2 && st.queue[0].name === 'other.mp3', st.queue.map((q) => q.name).join(','));

// With nothing loaded there is nothing to swap, so it loads instead.
w = boot('', () => res({ chunks: [] }));
await settle();
w.document.querySelector('label[for="aud-simple-file"]').click();
pickFiles(w, ['first.mp3'], 'aud-simple-file');
await settle();
st = w.__probe.state();
check('and on an empty page it just loads the track', st.queue.length === 1 && st.current === 0,
  st.queue.map((q) => q.name).join(','));

// A shared link decides nothing about which mode it opens in: that is the
// listener's, the same way the background switch is.
w = boot('#v=3&flt=off,500,1&rv=2.2,20,0.3&viz=1,1&vol=0.7&t=d', () => res({ chunks: [] }));
await settle();
check('a shared link opens in whichever mode this browser was left in', w.__probe.mode() === true);
check('with its effects showing on the simple switches',
  w.document.getElementById('aud-simple-rev').classList.contains('is-on'));

// --- 14. separating by source ------------------------------------------------
//
// The DSP has its own tests, on a mix whose parts are known. What is checked
// here is the page's half of the exchange: what it sends, what it does with what
// comes back, and that a stem buffer actually reaches the graph and the
// transcriber.

const DEMO3 = '#v=3&flt=off,500,1&viz=1,1&vol=0.7&t=d';

// What the separator would have sent back, for a track of `n` samples. Channel
// zero is the voice, so it is given something recognisable.
const separated = (win, n = 120 * 44100) => {
  const mk = (fill) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = fill;
    return a.buffer;
  };
  win.__worker.onmessage({ data: {
    type: 'done', vox: mk(0.5), drL: mk(0.25), drR: mk(0.125), bass: mk(0.0625),
    length: n, sampleRate: 44100,
  } });
};

w = boot(DEMO3, () => res({ chunks: [] }));
await settle();
press(w, 'aud-split-on');

check('a fresh split is by band', w.__probe.sep().mode === 'bands');
check('and the source controls are put away', w.document.getElementById('aud-sep').classList.contains('hidden'));

w.document.getElementById('aud-by-sources').click();
check('choosing sources switches the cut', w.__probe.sep().mode === 'sources');
check('the crossover sliders go away with it', w.document.getElementById('aud-split-params').classList.contains('hidden'));
check('and the separate button appears', !w.document.getElementById('aud-sep').classList.contains('hidden'));
check('the strips are renamed for what will feed them',
  rowsOf(w).map((r) => r.querySelector('.aud-stem-name').textContent).join(',') === 'Vocals,Drums,Bass,Other',
  rowsOf(w).map((r) => r.querySelector('.aud-stem-name').textContent).join(','));
check('and read as not yet doing anything', rowsOf(w).every((r) => r.classList.contains('is-idle')));
check('nothing has been separated yet', w.__probe.sep().ready === false);
// And with nothing to split by, the track is left whole rather than being put
// through the band network under source-mode labels.
check('so the track reaches the master rack untouched',
  w.__probe.graph().gain.out.length === 1 && w.__probe.graph().gain.out[0] === w.__probe.graph().master.input);
check('and every strip is silent', w.__probe.stems().every((st) => st.level === 0));

press(w, 'aud-sep-go');
check('pressing separate sends the track to the worker', w.__worker.sent.length === 1 &&
  w.__worker.sent[0].type === 'separate');
const sent = w.__worker.sent[0];
check('with both channels', sent.left instanceof w.ArrayBuffer || sent.left.byteLength > 0);
check('and the knobs it needs, in the units the panel shows',
  sent.widthDb >= 1 && sent.widthDb <= 6 && sent.voice > 0 && sent.bassHz > 0,
  JSON.stringify({ widthDb: sent.widthDb, voice: sent.voice, bassHz: Math.round(sent.bassHz) }));
check('and the readouts carry those units', /dB$/.test(w.document.getElementById('aud-sep-width-val').textContent) &&
  /×$/.test(w.document.getElementById('aud-sep-voice-val').textContent),
  w.document.getElementById('aud-sep-width-val').textContent + ' / ' +
  w.document.getElementById('aud-sep-voice-val').textContent);
check('the three tests are spelled out before the knobs',
  w.document.querySelectorAll('.aud-test-list li').length === 3);
// Both cuts explain themselves; neither is left as a pair of unlabelled sliders.
check('and the band cut explains its own middle step',
  /L\+R/.test(w.document.getElementById('aud-split-params').textContent),
  w.document.getElementById('aud-split-params').textContent.slice(-90));
check('and the strips are written in the same words',
  /held/.test(rowsOf(w)[0].querySelector('.aud-stem-what').textContent) &&
  /hit/.test(rowsOf(w)[1].querySelector('.aud-stem-what').textContent),
  rowsOf(w)[0].querySelector('.aud-stem-what').textContent);
check('the button says what it is doing', w.document.getElementById('aud-sep-go').disabled === true);

w.__worker.onmessage({ data: { type: 'progress', stage: 'Finding what repeats', frac: 0.5, loop: 3.9 } });
check('progress is shown', w.document.getElementById('aud-sep-fill').style.width === '50%');
check('and the loop it found is named', /3\.9 s/.test(w.document.getElementById('aud-sep-status').textContent),
  w.document.getElementById('aud-sep-status').textContent);

separated(w);
check('the stems arrive as one four-channel buffer', w.__probe.sep().buffer &&
  w.__probe.sep().buffer.numberOfChannels === 4, String(w.__probe.sep().buffer && w.__probe.sep().buffer.numberOfChannels));
check('and the page says they are ready', w.__probe.sep().ready === true && w.__probe.sep().live === true);
check('the strips stop reading as idle', rowsOf(w).every((r) => !r.classList.contains('is-idle')));

g = w.__probe.graph();
sp = g.split;
check('the band network stops being fed', g.gain.out.indexOf(sp.input) < 0);
let sn = w.__probe.stems();
check('every strip is fed by the source network', sn.every((st) => st.rack.nodes && st.gainNode));
check('and the mix still ends at the master rack', g.master.input.out.length > 0);

// The fourth stem is the track with the other three taken out of it, so it must
// be fed by the mix and by three inverted stems and nothing else.
const restNode = sn[3].rack.nodes.input;
check('the fourth strip is a subtraction, not a fourth channel',
  sn[3].rack.nodes.input !== sn[0].rack.nodes.input);

// --- 14b. what a link says about it -----------------------------------------

hash = w.__probe.encodeState();
check('the link records that the cut was by source', /(^|&)sp=\d+,\d+,s(&|$)/.test(hash), hash);

const other = boot('#' + hash, () => res({ chunks: [] }));
await settle();
check('opening it comes up in source mode', other.__probe.sep().mode === 'sources');
check('with nothing separated, because stems do not fit in a URL', other.__probe.sep().ready === false);
check('and it says so rather than looking broken',
  /Separate/.test(other.document.getElementById('aud-sep-status').textContent),
  other.document.getElementById('aud-sep-status').textContent);

// --- 14c. the transcriber listens to the voice ------------------------------

w = boot(DEMO3, () => res({ chunks: [] }));
await settle();
check('with no stems, the transcript comes off the track', w.__probe.sep().separated === false &&
  w.__probe.txListensTo() === 'the track');
check('and the tip says so', /short windows of the track/.test(w.document.getElementById('aud-tx-tip').textContent),
  w.document.getElementById('aud-tx-tip').textContent);

press(w, 'aud-split-on');
w.document.getElementById('aud-by-sources').click();
press(w, 'aud-sep-go');
separated(w);

check('once separated it listens to the vocal stem instead', w.__probe.sep().separated === true &&
  w.__probe.txListensTo() === 'the vocal stem');
check('and the tip changes to match', /vocal stem/.test(w.document.getElementById('aud-tx-tip').textContent),
  w.document.getElementById('aud-tx-tip').textContent);

// The window handed to the resampler must be the voice on its own. The fake
// stems put a different constant in each channel, so which one arrived is not a
// matter of opinion.
let mono = w.__probe.txMono(1, 2);
check('the window it cuts is one channel', mono.numberOfChannels === 1);
check('and it is the vocal channel, not a mix of all four',
  Math.abs(mono.getChannelData(0)[0] - 0.5) < 1e-6, String(mono.getChannelData(0)[0]));

// The stems outlive the split switch, and so does the transcript source: what
// makes the best signal for a transcriber has nothing to do with what is coming
// out of the speakers.
press(w, 'aud-split-on');
check('turning the split off leaves the transcript on the vocal stem',
  w.__probe.txListensTo() === 'the vocal stem');
check('because the stems are still there to listen to', w.__probe.sep().ready === true &&
  w.__probe.sep().live === false);

// A new track invalidates the stems, which were made out of the old one.
w.__probe.playIndex(0, false);
await settle();
check('loading a track drops the stems it did not come from', w.__probe.sep().ready === false);
check('and the button offers to run again', w.document.getElementById('aud-sep-go').disabled === false &&
  w.document.getElementById('aud-sep-go').textContent === 'Separate');

void restNode;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
