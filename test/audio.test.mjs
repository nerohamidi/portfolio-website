// Signal Share's page logic, driven in jsdom: the link format, the playlist,
// sharing, deleting and the transcript pump. These are the parts that are easy
// to get subtly wrong and impossible to see in a diff.
//
//   npm install && node test/audio.test.mjs

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://nerohamidi.github.io/portfolio-website/playroom/audio/';
const API = 'https://nero-chatbot-proxy.nhamidi.workers.dev';
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_S = 'SSSSSSSSSSSSSSSSSSSSSS';
const DURATION = 60;

const html = fs.readFileSync(ROOT + '/playroom/audio/index.html', 'utf8')
  .replace(/<script src="[^"]*audio\.js"><\/script>/, '');
const script = fs.readFileSync(ROOT + '/assets/js/audio.js', 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

// --- fakes ------------------------------------------------------------------------

function param(value) { return { value }; }

function node() {
  return { connect() {}, disconnect() {}, gain: param(1) };
}

function fakeBuffer(seconds, rate) {
  const data = new Float32Array(Math.round(seconds * rate));
  // Fades rather than staying silent, so a cut lands at the quiet end of its
  // search band and windows are cut long.
  for (let i = 0; i < data.length; i++) data[i] = 1 - i / data.length;
  return {
    duration: seconds, sampleRate: rate, numberOfChannels: 1, length: data.length,
    getChannelData() { return data; },
    copyToChannel() {}
  };
}

function fakeContext(win) {
  const ctx = {
    state: 'running', currentTime: 0, sampleRate: 44100, destination: node(),
    resume() {},
    createGain: node,
    createDelay() { return { ...node(), delayTime: param(0) }; },
    createConvolver() { return { ...node(), buffer: null }; },
    createBiquadFilter() {
      return { ...node(), type: 'lowpass', frequency: param(350), Q: param(1),
        getFrequencyResponse(hz, mag) { mag.fill(1); } };
    },
    createAnalyser() {
      return { ...node(), fftSize: 2048, frequencyBinCount: 1024,
        getByteTimeDomainData() {}, getByteFrequencyData() {} };
    },
    createBuffer(channels, length, rate) { return fakeBuffer(length / rate, rate); },
    createBufferSource() {
      return { ...node(), buffer: null, playbackRate: param(1), onended: null, start() {}, stop() {} };
    },
    decodeAudioData() { return Promise.resolve(fakeBuffer(DURATION, 44100)); }
  };
  win.__ctx = ctx;
  return ctx;
}

function fakeOffline() {
  return function (channels, frames, rate) {
    const done = fakeBuffer(frames / rate, rate);
    return {
      destination: node(),
      createBufferSource() { return { ...node(), buffer: null, start() {} }; },
      createBiquadFilter() { return { ...node(), type: '', frequency: param(0), Q: param(0) }; },
      startRendering() { return Promise.resolve(done); }
    };
  };
}

// A fetch that answers from a table of handlers and records every request.
function fakeFetch(win, handlers) {
  const log = [];
  const fetch = async function (input, init = {}) {
    const url = new URL(String(input), win.location.href);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const entry = { url: url.href, path: url.pathname, query: url.search, method, headers, body: init.body };
    log.push(entry);
    for (const h of handlers) {
      if (h.method === method && h.match(url)) return h.reply(entry, log);
    }
    return new Response('nope', { status: 404 });
  };
  return [fetch, log];
}

function reply(json, status = 200, headers = {}) {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function boot({ hash = '', handlers = [], userAgent } = {}) {
  const dom = new JSDOM(html, { url: PAGE + hash, runScripts: 'outside-only', pretendToBeVisual: false });
  const win = dom.window;
  // IOS is read from the user agent when the script boots, so set it first.
  if (userAgent) Object.defineProperty(win.navigator, 'userAgent', { configurable: true, get: () => userAgent });
  win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; }
  });
  win.HTMLMediaElement.prototype.pause = () => {};
  win.HTMLMediaElement.prototype.load = () => {};
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  win.requestAnimationFrame = () => 0;
  win.setInterval = () => 0;
  win.AudioContext = function () { return fakeContext(win); };
  win.OfflineAudioContext = fakeOffline();
  win.URL.createObjectURL = () => 'blob:fake';
  win.URL.revokeObjectURL = () => {};
  if (!win.Blob.prototype.arrayBuffer) {
    win.Blob.prototype.arrayBuffer = function () { return Promise.resolve(new ArrayBuffer(this.size)); };
  }
  const [fetch, log] = fakeFetch(win, handlers);
  win.fetch = fetch;
  win.eval(script);
  await settle();
  const $ = (id) => win.document.getElementById(id);
  return { dom, win, $, log, app: win.signalShare, state: () => win.signalShare.state() };
}

function file(win, name, bytes = 1000, type = 'audio/mpeg') {
  return new win.File([new Uint8Array(bytes)], name, { type });
}

function decoded(win) { return win.signalShare.decodeState(win.signalShare.encodeState()); }

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// A stand-in for the hidden <audio> that models the one iOS behaviour the fix
// is about: play() begins playback only when its promise settles, and a settle
// that lands after the page has taken playback back still starts the element.
function instrumentBg(win) {
  const bg = win.document.getElementById('bg-audio');
  const st = { paused: true, muted: false, currentTime: 0, pending: [] };
  Object.defineProperty(bg, 'muted', { configurable: true, get: () => st.muted, set: (v) => { st.muted = v; } });
  Object.defineProperty(bg, 'currentTime', { configurable: true, get: () => st.currentTime, set: (v) => { st.currentTime = v; } });
  Object.defineProperty(bg, 'ended', { configurable: true, get: () => false });
  bg.play = () => new Promise((resolve) => {
    st.pending.push(() => { st.paused = false; bg.dispatchEvent(new win.Event('playing')); resolve(); });
  });
  bg.pause = () => { st.paused = true; };
  bg.load = () => {};
  st.settlePlay = () => { st.pending.splice(0).forEach((fn) => fn()); };
  return st;
}

function setHidden(win, hidden) {
  Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => hidden });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
}

const clipHandlers = (names = {}) => [
  { method: 'HEAD', match: (u) => /^\/clip\//.test(u.pathname),
    reply: (e) => new Response(null, { status: 200, headers: { 'X-Clip-Name': encodeURIComponent(names[e.path.slice(6)] || 'clip') } }) },
  { method: 'GET', match: (u) => /^\/clip\//.test(u.pathname),
    reply: (e) => new Response(new Uint8Array(64), { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'X-Clip-Name': encodeURIComponent(names[e.path.slice(6)] || 'clip') } }) },
  { method: 'GET', match: (u) => /symphony\.mp3$/.test(u.pathname),
    reply: () => new Response(new Uint8Array(64), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }) }
];

// --- the link ----------------------------------------------------------------------

console.log('\nA fresh page');
{
  const { $, win, state } = await boot();
  check('shows nothing but the way in', $('player').hidden && $('effects').hidden && $('share').hidden);
  check('encodes a v3 link with the filter off', decoded(win).v === '3' && decoded(win).flt === 'off,500,1');
  check('and the default volume', decoded(win).vol === '0.7');
  check('and no tracks', decoded(win).t === undefined && state().queue.length === 0);
}

console.log('\nOpening a v3 link');
{
  const hash = '#v=3&flt=bp,700,2.5&ec=400,0.5,0.4&rv=3.1,50,0.2&vol=0.5&p=3&t=d,' + ID_A + '&i=1&n=Song&ti=Late%20night&no=Turn%20it%20up&s=' + ID_S;
  const { $, win, log, state } = await boot({ hash, handlers: clipHandlers({ [ID_A]: 'their-track.mp3' }) });
  await settle();
  const s = state();
  check('restores both tracks', s.queue.length === 2 && s.queue[0].ref === 'demo' && s.queue[1].ref === 'clip:' + ID_A);
  check('opens on the shared index', s.current === 1);
  check('fetches the opening clip', log.some((e) => e.method === 'GET' && e.path === '/clip/' + ID_A));
  check('labels the clip from its own metadata', s.queue[1].name === 'their-track.mp3', s.queue[1].name);
  check('the player is shown', !$('player').hidden && !$('effects').hidden);
  check('the filter type is applied', $('filter-type').value === 'bandpass');
  check('the frequency slider is where the link says', $('freq').value === '700');
  check('the Q comes back as a slider position under the band type', $('q').value === String(Math.round(1000 * Math.log(2.5 / 0.2) / Math.log(100))), $('q').value);
  check('echo is on with its numbers', $('echo-on').checked && $('echo-time').value === '400' && $('echo-fb').value === '0.5' && $('echo-mix').value === '0.4');
  check('reverb is on with its numbers', $('rev-on').checked && $('rev-size').value === '3.1' && $('rev-pre').value === '50' && $('rev-mix').value === '0.2');
  check('volume and pitch are applied', $('volume').value === '0.5' && $('pitch').value === '3');
  check('the sender\'s words are shown', !$('shared').hidden && $('shared-title').textContent === 'Late night' && $('shared-note').textContent === 'Turn it up');
  check('and put back in the share fields', $('share-title').value === 'Late night' && $('share-note').value === 'Turn it up');
  check('the card id is remembered for deleting', s.shareId === ID_S);
  check('no transcript is fetched unasked', !log.some((e) => e.path.startsWith('/transcript')));
  const d = decoded(win);
  check('the link goes back out the same', d.flt === 'bp,700,2.5' && d.ec === '400,0.5,0.4' && d.rv === '3.1,50,0.2' && d.vol === '0.5' && d.p === '3' && d.t === 'd,' + ID_A && d.i === '1', JSON.stringify(d));
  check('with the opening track\'s name', d.n === 'their-track.mp3');
}

console.log('\nOpening a v2 link');
{
  const { state } = await boot({ hash: '#v=2&a=clip:' + ID_A + '&n=Old%20one', handlers: clipHandlers() });
  const s = state();
  check('restores its one track', s.queue.length === 1 && s.queue[0].ref === 'clip:' + ID_A);
  check('under its name', s.queue[0].name === 'clip');
}

console.log('\nA link from a stranger');
{
  const { $, state } = await boot({ hash: '#v=3&flt=lp,9999,-4&ec=1,2,3&vol=7&p=40&t=notanid,' + ID_A + ',d&i=9', handlers: clipHandlers() });
  const s = state();
  check('slider values are held to their ranges', $('freq').value === '1000' && $('echo-time').value === '20' && $('echo-fb').value === '0.9' && $('volume').value === '1' && $('pitch').value === '12');
  check('bad refs are dropped', s.queue.length === 2);
  check('a bad index opens on the first track', s.current === 0);
}

// --- the playlist ----------------------------------------------------------------------

console.log('\nThe playlist');
{
  const { $, win, app, state } = await boot({ handlers: clipHandlers() });
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' }),
    app.newEntry({ file: file(win, 'two.mp3'), name: 'two.mp3' })], true);
  await settle();
  check('two files make two rows', state().queue.length === 2 && $('queue').children.length === 2);
  check('the first is loaded', state().current === 0 && !$('player').hidden);
  check('prev and next appear', !$('prev').hidden && !$('next').hidden);
  check('a local file is left out of the link', decoded(win).t === undefined);

  app.moveAt(0, 1);
  check('moving the current track carries the index with it', state().current === 1 && state().queue[1].name === 'one.mp3');
  app.removeAt(0);
  await settle();
  check('removing an earlier track shifts the index down', state().current === 0 && state().queue[0].name === 'one.mp3');
  app.removeAt(0);
  await settle();
  check('emptying the list hides the player', state().queue.length === 0 && $('player').hidden);

  app.addTracks(Array.from({ length: 12 }, (_, i) => app.newEntry({ file: file(win, i + '.mp3'), name: i + '.mp3' })), false);
  check('the list stops at ten', state().queue.length === 10);
  check('and says so', /did not fit/.test($('share-status').textContent));
}

// --- sharing ------------------------------------------------------------------------

console.log('\nSharing two local files');
{
  let inFlight = 0;
  let overlap = false;
  let n = 0;
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/clip', reply: async (e) => {
      inFlight++;
      if (inFlight > 1) overlap = true;
      await tick();
      inFlight--;
      n++;
      return reply({ id: n === 1 ? ID_A : ID_B, name: decodeURIComponent(e.headers['X-Clip-Name']), expiresInDays: 30, locked: Boolean(e.headers['X-Clip-Lock']) });
    } },
    ...clipHandlers()
  ];
  const { $, win, app, log, state } = await boot({ handlers });
  win.sessionStorage.setItem('aud-upload-key', 'sekrit');
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' }),
    app.newEntry({ file: file(win, 'two.mp3'), name: 'two.mp3' })], true);
  await settle();
  $('share-btn').click();
  await settle();
  const uploads = log.filter((e) => e.method === 'POST' && e.path === '/clip');
  check('every local file is uploaded', uploads.length === 2);
  check('one at a time', !overlap);
  check('the key travels as a header', uploads.every((e) => e.headers['X-Clip-Key'] === 'sekrit'));
  check('and never in the link', !$('share-link').value.includes('sekrit') && !win.location.hash.includes('sekrit'));
  check('both tracks now have refs', state().queue[0].ref === 'clip:' + ID_A && state().queue[1].ref === 'clip:' + ID_B);
  check('the link lists both', decoded(win).t === ID_A + ',' + ID_B);
  check('the link is this page with the state in its hash', $('share-link').value === PAGE + '#' + win.signalShare.encodeState());
  check('the address bar shows the same state', win.location.hash === '#' + win.signalShare.encodeState());
  check('the status reports the expiry', /30 days/.test($('share-status').textContent));
  check('a delete is now on offer', !$('danger').hidden);
  check('the password can no longer be set', $('share-pass').disabled);
}

console.log('\nA failed upload');
{
  let n = 0;
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/clip', reply: () => {
      n++;
      return n === 1 ? reply({ id: ID_A, name: 'one.mp3', expiresInDays: 30 }) : reply({ error: 'The clip library is full right now.' }, 507);
    } },
    ...clipHandlers()
  ];
  const { $, win, app, state } = await boot({ handlers });
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' }),
    app.newEntry({ file: file(win, 'two.mp3'), name: 'two.mp3' })], true);
  await settle();
  $('share-btn').click();
  await settle();
  check('keeps the one that went up', state().queue[0].ref === 'clip:' + ID_A && state().queue[1].ref === null);
  check('reports the failure', /library is full/.test($('share-status').textContent) && /1 before it/.test($('share-status').textContent));
  check('the button is usable again', !$('share-btn').disabled);
  check('no link is offered', $('share-out').hidden);
}

console.log('\nA share with a title');
{
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/share', reply: (e) => {
      const body = JSON.parse(e.body);
      return reply({ id: ID_S, url: API + '/s/' + ID_S, title: body.title, note: body.note, locked: false, expiresInDays: 30 });
    } },
    ...clipHandlers()
  ];
  const { $, win, log, state } = await boot({ hash: '#v=3&t=d', handlers });
  $('share-title').value = 'Late night';
  $('share-note').value = 'Track 3 is the one.';
  $('share-btn').click();
  await settle();
  const card = log.find((e) => e.method === 'POST' && e.path === '/share');
  check('files a card', Boolean(card));
  check('the card carries the words and the whole hash', card && JSON.parse(card.body).title === 'Late night' && JSON.parse(card.body).hash === win.signalShare.encodeState());
  check('the link handed over is the card', $('share-link').value === API + '/s/' + ID_S);
  check('the address bar still shows the state', win.location.hash === '#' + win.signalShare.encodeState());
  check('the words ride in the hash too', decoded(win).ti === 'Late night' && decoded(win).no === 'Track 3 is the one.');
  check('the card is remembered', state().shareId === ID_S);
}

console.log('\nA share with a title, when the card cannot be made');
{
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/share', reply: () => reply({ error: 'Too many share cards right now.' }, 507) },
    ...clipHandlers()
  ];
  const { $, win } = await boot({ hash: '#v=3&t=d', handlers });
  $('share-title').value = 'Late night';
  $('share-btn').click();
  await settle();
  check('still hands over the plain link', $('share-link').value === PAGE + '#' + win.signalShare.encodeState());
  check('and says what was lost', /Too many share cards/.test($('share-status').textContent) && /still works/.test($('share-status').textContent));
}

// --- deleting -----------------------------------------------------------------------

console.log('\nDeleting');
{
  const deleted = [];
  const handlers = [
    { method: 'DELETE', match: (u) => /^\/(clip|share)\//.test(u.pathname), reply: (e) => { deleted.push(e.path); return reply({ deleted: true }); } },
    ...clipHandlers()
  ];
  const { $, win, state } = await boot({ hash: '#v=3&t=d,' + ID_A + ',' + ID_B + '&s=' + ID_S, handlers });
  check('a recipient is offered the delete', !$('danger').hidden);
  $('del-btn').click();
  check('the first press only arms it', deleted.length === 0 && /Really delete 2 tracks/.test($('del-btn').textContent));
  $('del-btn').click();
  await settle();
  check('the second press deletes every clip', deleted.includes('/clip/' + ID_A) && deleted.includes('/clip/' + ID_B));
  check('and the card', deleted.includes('/share/' + ID_S));
  check('but not the demo', deleted.length === 3);
  check('the refs are dropped so a stale link cannot be made', state().queue.every((e) => e.ref === null || e.ref === 'demo') && decoded(win).t === 'd');
  check('the tracks stay in the list', state().queue.length === 3);
  check('the outcome is reported', /Deleted/.test($('share-status').textContent));
  check('the delete is no longer on offer', $('danger').hidden);
}

console.log('\nA delete password');
{
  const requests = [];
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/clip', reply: (e) => reply({ id: ID_A, name: 'one.mp3', expiresInDays: 30, locked: Boolean(e.headers['X-Clip-Lock']) }) },
    { method: 'DELETE', match: (u) => /^\/clip\//.test(u.pathname), reply: (e) => {
      requests.push(e.headers['X-Clip-Lock'] || '');
      const pass = e.headers['X-Clip-Lock'];
      if (!pass) return reply({ error: 'That clip is password protected.', locked: true }, 401);
      if (pass !== 'hunter2') return reply({ error: 'That password does not match.', locked: true }, 403);
      return reply({ deleted: true });
    } },
    ...clipHandlers()
  ];
  const { $, win, app, log, state } = await boot({ handlers });
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' })], true);
  await settle();
  $('share-pass').value = 'hunter2';
  $('share-pass').dispatchEvent(new win.Event('input'));
  check('typing a password shows where it will be asked for', !$('del-pass').hidden);
  $('share-btn').click();
  await settle();
  const upload = log.find((e) => e.method === 'POST' && e.path === '/clip');
  check('the password travels as a header', upload.headers['X-Clip-Lock'] === 'hunter2');
  check('and never in the link', !$('share-link').value.includes('hunter2'));
  check('the clip is marked locked', state().queue[0].locked);

  // A recipient, on a fresh page, with no password.
  const other = await boot({ hash: '#v=3&t=' + ID_A, handlers });
  await settle();
  other.$('del-btn').click();
  other.$('del-btn').click();
  await settle();
  check('a delete with no password is refused', requests[requests.length - 1] === '' && /password/.test(other.$('del-note').textContent));
  check('the clip keeps its ref, because it is still there', other.state().queue[0].ref === 'clip:' + ID_A);
  other.$('del-pass').value = 'wrong';
  other.$('del-btn').click();
  other.$('del-btn').click();
  await settle();
  check('a wrong password is refused too', /does not match/.test(other.$('del-note').textContent));
  other.$('del-pass').value = 'hunter2';
  other.$('del-btn').click();
  other.$('del-btn').click();
  await settle();
  check('the right password deletes it', other.state().queue[0].ref === null && requests[requests.length - 1] === 'hunter2');
}

// --- the transcript ---------------------------------------------------------------------

function wavInfo(buf) {
  const view = new DataView(buf);
  const tag = (at) => String.fromCharCode(...new Uint8Array(buf, at, 4));
  return { riff: tag(0) === 'RIFF' && tag(8) === 'WAVE', channels: view.getUint16(22, true),
    rate: view.getUint32(24, true), bits: view.getUint16(34, true), seconds: view.getUint32(40, true) / (view.getUint32(24, true) * 2) };
}

console.log('\nTranscribing a local track');
{
  const windows = [];
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/transcribe', reply: (e) => {
      const q = new URLSearchParams(e.query);
      windows.push({ i: Number(q.get('i')), start: Number(q.get('start')), clip: q.get('clip'), prev: decodeURIComponent(e.headers['X-Clip-Prev'] || ''), lang: e.headers['X-Clip-Lang'], wav: wavInfo(e.body) });
      const start = Number(q.get('start'));
      return reply({ i: Number(q.get('i')), start, end: start + 12, language: 'en',
        segments: [{ s: start + 1, e: start + 4, t: 'line ' + q.get('i'), w: [] }] });
    } },
    ...clipHandlers()
  ];
  const { $, win, app, state } = await boot({ handlers });
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' })], true);
  await settle();
  check('a loaded track does not transcribe itself', windows.length === 0 && !$('tx-on').checked);
  app.txPump();
  await settle();
  check('nor does the pump send anything unasked', windows.length === 0);

  $('tx-on').checked = true;
  $('tx-on').dispatchEvent(new win.Event('change'));
  app.txPump();          // builds the band
  await settle();
  app.txPump();          // sends the first window
  await settle();
  check('ticking the box sends a window', windows.length === 1);
  check('the first window starts at zero', windows[0].i === 0 && windows[0].start === 0);
  check('a local file names no clip', windows[0].clip === null);
  check('it is 16 kHz mono 16-bit WAV', windows[0].wav.riff && windows[0].wav.rate === 16000 && windows[0].wav.channels === 1 && windows[0].wav.bits === 16);
  check('about twelve seconds of it', windows[0].wav.seconds > 10 && windows[0].wav.seconds < 14, String(windows[0].wav.seconds));
  check('the segment is kept', state().tx.segments.length === 1 && state().tx.segments[0].t === 'line 0');
  check('copying is offered', !$('tx-copy').disabled);

  app.seek(2);
  app.txFollow();
  check('the caption shows the line under the playhead', $('caption').textContent === 'line 0');
  app.seek(8);
  app.txFollow();
  check('and nothing between lines', $('caption').textContent === '');

  app.txPump();
  await settle();
  check('the next window follows the first', windows.length === 2 && windows[1].i === 1 && windows[1].start === windows[0].wav.seconds);
  check('the tail of the last line goes with it', windows[1].prev === 'line 0');
  check('and the detected language', windows[1].lang === 'en');

  for (let i = 0; i < 10; i++) { app.txPump(); await settle(); }
  check('the pump stays a bounded distance ahead', windows.length < 6, String(windows.length));

  $('tx-on').checked = false;
  $('tx-on').dispatchEvent(new win.Event('change'));
  const before = windows.length;
  app.txPump();
  await settle();
  check('unticking stops it', windows.length === before && /kept/.test($('tx-status').textContent));
  check('the text so far is kept', state().tx.segments.length === before);
}

console.log('\nA refused window');
{
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/transcribe', reply: () => reply({ error: 'Transcription has hit its daily limit.' }, 429) },
    ...clipHandlers()
  ];
  const { $, win, app } = await boot({ hash: '#v=3&t=d', handlers });
  $('tx-on').checked = true;
  $('tx-on').dispatchEvent(new win.Event('change'));
  app.txPump(); await settle();
  app.txPump(); await settle();
  check('clears the box', !$('tx-on').checked);
  check('and passes the reason on', /daily limit/.test($('tx-status').textContent));
}

console.log('\nA shared clip with a cached transcript');
{
  const windows = [];
  const handlers = [
    { method: 'GET', match: (u) => u.pathname === '/transcript/' + ID_A, reply: () => reply({ chunks: [
      { i: 0, start: 0, end: 12, language: 'en', segments: [{ s: 1, e: 3, t: 'first', w: [] }] },
      { i: 1, start: 12, end: 24, language: 'en', segments: [{ s: 13, e: 15, t: 'second', w: [] }] }
    ] }) },
    { method: 'POST', match: (u) => u.pathname === '/transcribe', reply: (e) => {
      const q = new URLSearchParams(e.query);
      windows.push({ i: Number(q.get('i')), start: Number(q.get('start')), clip: q.get('clip') });
      return reply({ i: Number(q.get('i')), start: Number(q.get('start')), end: Number(q.get('start')) + 12, segments: [] });
    } },
    ...clipHandlers()
  ];
  const { $, win, app, log, state } = await boot({ hash: '#v=3&t=' + ID_A, handlers });
  check('opening the link fetches no transcript', !log.some((e) => e.path.startsWith('/transcript')));
  $('tx-on').checked = true;
  $('tx-on').dispatchEvent(new win.Event('change'));
  await settle();
  check('ticking the box asks for the cached transcript', log.some((e) => e.path === '/transcript/' + ID_A));
  check('and adopts it', state().tx.segments.length === 2 && state().tx.segments[1].t === 'second');
  check('a partial transcript is not marked finished', !state().tx.done && /already transcribed/.test($('tx-status').textContent));
  app.txPump(); await settle();
  app.txPump(); await settle();
  check('the pump picks up where the cache stops', windows.length === 1 && windows[0].i === 2 && windows[0].start === 24);
  check('and ties the window to the clip', windows[0].clip === ID_A);
}

console.log('\nMoving between tracks');
{
  const windows = [];
  const handlers = [
    { method: 'POST', match: (u) => u.pathname === '/transcribe', reply: (e) => {
      const q = new URLSearchParams(e.query);
      windows.push(q.get('i'));
      return reply({ i: Number(q.get('i')), start: 0, end: 12, segments: [{ s: 1, e: 2, t: 'words', w: [] }] });
    } },
    ...clipHandlers()
  ];
  const { $, win, app, state } = await boot({ handlers });
  app.addTracks([app.newEntry({ file: file(win, 'one.mp3'), name: 'one.mp3' }),
    app.newEntry({ file: file(win, 'two.mp3'), name: 'two.mp3' })], true);
  await settle();
  $('tx-on').checked = true;
  $('tx-on').dispatchEvent(new win.Event('change'));
  app.txPump(); await settle();
  app.txPump(); await settle();
  check('the first track transcribes once asked', windows.length === 1 && state().tx.segments.length === 1);
  app.playIndex(1, false);
  await settle();
  check('the next track does not carry the press over', !$('tx-on').checked && !state().tx.on);
  app.txPump(); await settle();
  check('so nothing of it is sent', windows.length === 1);
  app.playIndex(0, false);
  await settle();
  check('coming back finds the words still there', state().tx.segments.length === 1 && !$('tx-copy').disabled);
}

console.log('\niOS: the graph and the background element never sound together');
{
  const { $, win, app, state } = await boot({ hash: '#v=3&t=d', userAgent: IPHONE, handlers: clipHandlers() });
  await settle();
  const bg = instrumentBg(win);
  setHidden(win, false);      // a visible page, so play goes through the graph

  // Play in the foreground: the graph is the output, and the element, once its
  // muted unlock play resolves, is left paused and silent.
  app.togglePlay();
  bg.settlePlay();
  await settle();
  check('playing through the graph, the element is silent', state().playing && bg.paused);

  // Lock the screen: playback is handed to the element. iOS has not actually
  // started it yet, so its play() promise is still in flight.
  setHidden(win, true);
  await settle();
  check('hidden, the element takes over, unmuted', !bg.muted);

  // Unlock before that play() resolves: playback goes back to the graph.
  setHidden(win, false);
  await settle();
  check('back in the foreground, the graph is playing again', state().playing);

  // Now iOS finally starts the element from the play() it had queued while
  // hidden. Left alone it would sound under the graph: two tracks at once,
  // and a stop that reaches only one of them.
  bg.settlePlay();
  await settle();
  check('the resumed element is silenced, not left sounding under the graph', bg.paused && bg.muted);
  check('and the graph is still the one playing', state().playing);

  // Stop must leave nothing playing, on either output.
  $('stop').click();
  bg.settlePlay();
  await settle();
  check('stop leaves neither the graph nor the element playing', !state().playing && bg.paused);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
