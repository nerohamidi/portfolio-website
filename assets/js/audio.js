// Signal Share: an audio player whose whole state fits in a link.
//
// A track, or a playlist of them, is decoded into memory and played through
//
//   source → volume → [filter] → [echo] → [reverb] → analyser → speakers
//
// with pitch as the source's playback rate. "Create share link" uploads any
// local files to the Worker and writes the playlist and every setting into the
// URL hash, so whoever opens the link hears the same thing. A transcript can be
// asked for: short windows of the track then go to the Worker, which hands them
// to Gemini, and the words appear under the picture as they are heard.
//
// The controls are the state. Every setting lives in its input, the link is
// written from the inputs, and opening a link writes the inputs back.

(function () {
  var API = 'https://nero-chatbot-proxy.nhamidi.workers.dev';
  var DEMO_URL = '../../assets/audio/symphony.mp3';
  var DEMO_NAME = 'symphony.mp3';
  var CLIP_ID = /^[A-Za-z0-9_-]{22}$/;
  var MAX_QUEUE = 10;      // a share uploads one file per track, inside the Worker's per-minute limit
  var MAX_TITLE = 80;
  var MAX_NOTE = 300;
  var KEY_STORE = 'aud-upload-key';

  // Filter types, the short codes a link carries them as, and the Q each band
  // type starts on when it is chosen (a Q left behind by another type can be
  // too narrow to hear through).
  var FILTER_CODE = { lowpass: 'lp', highpass: 'hp', bandpass: 'bp', 'notch-wide': 'bs', 'notch-narrow': 'nt' };
  var FILTER_FROM_CODE = { lp: 'lowpass', hp: 'highpass', bp: 'bandpass', bs: 'notch-wide', nt: 'notch-narrow' };
  var BAND_TYPES = { bandpass: true, 'notch-wide': true, 'notch-narrow': true };
  var ARRIVAL_Q = { bandpass: 2, 'notch-wide': 0.5, 'notch-narrow': 10 };

  var F_MIN = 20;
  var F_MAX = 20000;
  var ECHO_MAX_SEC = 1.6;
  var REVERB_MAX_PRE = 0.25;
  var CANVAS_HEIGHT = 220;

  // Transcription: windows of about twelve seconds, cut on a quiet moment, sent
  // as 16 kHz mono WAV of the centre band, and kept half a minute ahead of the
  // playhead.
  var TX_RATE = 16000;
  var TX_WINDOW = 12;
  var TX_SEARCH = 1.2;
  var TX_LEAD = 24;
  var TX_PRELOAD = 30;
  var TX_JUMP = 45;
  var TX_BAND_LOW = 200;
  var TX_BAND_HIGH = 6000;
  var BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

  function $(id) { return document.getElementById(id); }
  var el = {
    file: $('file'), demo: $('demo'), player: $('player'), queue: $('queue'), through: $('through'),
    scope: $('scope'), caption: $('caption'),
    play: $('play'), stop: $('stop'), prev: $('prev'), next: $('next'), time: $('time'),
    seek: $('seek'), volume: $('volume'),
    txOn: $('tx-on'), txCopy: $('tx-copy'), txStatus: $('tx-status'),
    effects: $('effects'), filterType: $('filter-type'), freq: $('freq'), q: $('q'),
    freqName: $('freq-name'), qName: $('q-name'),
    echoOn: $('echo-on'), echoTime: $('echo-time'), echoFb: $('echo-fb'), echoMix: $('echo-mix'),
    revOn: $('rev-on'), revSize: $('rev-size'), revPre: $('rev-pre'), revMix: $('rev-mix'),
    pitch: $('pitch'),
    share: $('share'), shareTitle: $('share-title'), shareNote: $('share-note'), sharePass: $('share-pass'),
    lockHint: $('lock-hint'), shareBtn: $('share-btn'), shareStatus: $('share-status'),
    shareOut: $('share-out'), shareLink: $('share-link'), shareCopy: $('share-copy'),
    danger: $('danger'), delBtn: $('del-btn'), delPass: $('del-pass'), delNote: $('del-note'),
    key: $('key'),
    shared: $('shared'), sharedTitle: $('shared-title'), sharedDetail: $('shared-detail'), sharedNote: $('shared-note'),
    bg: $('bg-audio')
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(input) { return Number(input.value); }
  function outputOf(input) { return input.parentNode.querySelector('output'); }
  function show(input, text) { outputOf(input).value = text; }

  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function formatHz(hz) {
    return hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz';
  }

  // --- the filter's two sliders ------------------------------------------------
  //
  // Frequency runs logarithmically from 20 Hz to 20 kHz over a thousand steps.
  // The second slider is resonance in decibels for a low or high pass (which is
  // how a Web Audio biquad reads Q for those) and a plain Q, on a log scale, for
  // the band types. Values are rounded to what the readout prints, so the link
  // carries exactly what the filter runs on.

  function sliderToHz(pos) { return F_MIN * Math.pow(F_MAX / F_MIN, pos / 1000); }

  function hzToSlider(hz) {
    return clamp(Math.round(1000 * Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)), 0, 1000);
  }

  function sliderToQ(type, pos) {
    if (!BAND_TYPES[type]) return Math.round((0.1 + (pos / 1000) * 19.9) * 10) / 10;
    var q = 0.2 * Math.pow(100, pos / 1000);
    return q < 1 ? Math.round(q * 100) / 100 : Math.round(q * 10) / 10;
  }

  function qToSlider(type, q) {
    if (!BAND_TYPES[type]) return clamp(Math.round(((q - 0.1) / 19.9) * 1000), 0, 1000);
    return clamp(Math.round(1000 * Math.log(q / 0.2) / Math.log(100)), 0, 1000);
  }

  function formatQ(type, q) {
    if (!BAND_TYPES[type]) return q.toFixed(1) + ' dB';
    return q < 1 ? q.toFixed(2) : q.toFixed(1);
  }

  function filterType() { return el.filterType.value; }
  function filterHz() { return sliderToHz(num(el.freq)); }
  function filterQ() { return sliderToQ(filterType() || 'lowpass', num(el.q)); }

  // --- the audio graph -----------------------------------------------------------

  var ctx = null;
  var nodes = null;     // gain, filter, echo, reverb, analyser; made with the context

  function ensureContext() {
    if (ctx) {
      // Creating a context needs no gesture; resuming one does, so this is
      // called again from the play button.
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    nodes = {
      gain: ctx.createGain(),
      filter: ctx.createBiquadFilter(),
      echo: makeEcho(),
      reverb: makeReverb(),
      analyser: ctx.createAnalyser()
    };
    nodes.analyser.fftSize = 2048;
    nodes.analyser.connect(ctx.destination);
    applyVolume();
    applyFilter();
    applyEcho();
    applyReverb();
    wire();
    return ctx;
  }

  // A delay that feeds itself, crossfaded against the dry signal.
  function makeEcho() {
    var e = {
      input: ctx.createGain(), output: ctx.createGain(),
      dry: ctx.createGain(), wet: ctx.createGain(),
      delay: ctx.createDelay(ECHO_MAX_SEC), feedback: ctx.createGain()
    };
    e.input.connect(e.dry);
    e.dry.connect(e.output);
    e.input.connect(e.delay);
    e.delay.connect(e.feedback);
    e.feedback.connect(e.delay);
    e.delay.connect(e.wet);
    e.wet.connect(e.output);
    return e;
  }

  // Convolution with a made-up room: noise that dies away exponentially, 60 dB
  // down by the end of the tail, after a short pre-delay.
  function makeReverb() {
    var r = {
      input: ctx.createGain(), output: ctx.createGain(),
      dry: ctx.createGain(), wet: ctx.createGain(),
      pre: ctx.createDelay(REVERB_MAX_PRE), convolver: ctx.createConvolver(),
      irKey: '', timer: null
    };
    r.input.connect(r.dry);
    r.dry.connect(r.output);
    r.input.connect(r.pre);
    r.pre.connect(r.convolver);
    r.convolver.connect(r.wet);
    r.wet.connect(r.output);
    return r;
  }

  function impulseResponse(seconds) {
    var rate = ctx.sampleRate;
    var n = Math.max(1, Math.round(seconds * rate));
    var ir = ctx.createBuffer(2, n, rate);
    var k = Math.log(1000) / n;
    for (var c = 0; c < 2; c++) {
      var data = ir.getChannelData(c);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-k * i);
    }
    return ir;
  }

  // Strings whichever stages are switched on between the volume and the
  // analyser. Only the connections between stages are remade; the wiring
  // inside each stage is made once.
  function wire() {
    if (!nodes) return;
    var stages = [];
    if (filterType()) stages.push({ input: nodes.filter, output: nodes.filter });
    if (el.echoOn.checked) stages.push(nodes.echo);
    if (el.revOn.checked) stages.push(nodes.reverb);

    [nodes.gain, nodes.filter, nodes.echo.output, nodes.reverb.output].forEach(function (n) { n.disconnect(); });
    var head = nodes.gain;
    stages.forEach(function (stage) {
      head.connect(stage.input);
      head = stage.output;
    });
    head.connect(nodes.analyser);
  }

  function applyVolume() {
    show(el.volume, Math.round(num(el.volume) * 100) + '%');
    if (nodes) nodes.gain.gain.value = num(el.volume);
    syncBg();
  }

  function applyFilter() {
    var type = filterType();
    var band = BAND_TYPES[type];
    el.freqName.textContent = band ? 'centre' : 'cutoff';
    el.qName.textContent = band ? 'Q' : 'resonance';
    show(el.freq, formatHz(filterHz()));
    show(el.q, formatQ(type || 'lowpass', filterQ()));
    el.freq.disabled = el.q.disabled = !type;
    if (!nodes) return;
    if (type) nodes.filter.type = type.replace(/-.*/, '');
    nodes.filter.frequency.value = filterHz();
    nodes.filter.Q.value = filterQ();
  }

  function applyEcho() {
    show(el.echoTime, Math.round(num(el.echoTime)) + ' ms');
    show(el.echoFb, num(el.echoFb).toFixed(2));
    show(el.echoMix, Math.round(num(el.echoMix) * 100) + '%');
    if (!nodes) return;
    var e = nodes.echo;
    e.delay.delayTime.value = num(el.echoTime) / 1000;
    e.feedback.gain.value = num(el.echoFb);
    e.wet.gain.value = num(el.echoMix);
    e.dry.gain.value = 1 - num(el.echoMix);
  }

  function applyReverb() {
    show(el.revSize, num(el.revSize).toFixed(1) + ' s');
    show(el.revPre, Math.round(num(el.revPre)) + ' ms');
    show(el.revMix, Math.round(num(el.revMix) * 100) + '%');
    if (!nodes) return;
    var r = nodes.reverb;
    r.pre.delayTime.value = num(el.revPre) / 1000;
    r.wet.gain.value = num(el.revMix);
    r.dry.gain.value = 1 - num(el.revMix);
    if (el.revOn.checked) refreshReverb(false);
  }

  // A new impulse response is a few hundred thousand random numbers, so while
  // the size slider is moving it is rebuilt at most every 90 ms.
  function refreshReverb(now) {
    var r = nodes.reverb;
    var key = num(el.revSize).toFixed(1) + '@' + ctx.sampleRate;
    if (r.irKey === key) return;
    clearTimeout(r.timer);
    if (!now) {
      r.timer = setTimeout(function () { refreshReverb(true); }, 90);
      return;
    }
    r.irKey = key;
    r.convolver.buffer = impulseResponse(num(el.revSize));
  }

  // Resampling rather than a phase vocoder: pitch and tempo move together.
  // `rateNow` is the rate the graph is running at; position() converts elapsed
  // time with it, so it is rebased before it changes.
  var rateNow = 1;

  function applyPitch() {
    var st = Math.round(num(el.pitch));
    show(el.pitch, (st > 0 ? '+' : '') + st + ' st');
    if (playing && !bgActive) {
      offset = position();
      startedAt = ctx.currentTime;
    }
    rateNow = Math.pow(2, st / 12);
    if (source) source.playbackRate.value = rateNow;
    syncBg();
  }

  // --- the playlist ------------------------------------------------------------
  //
  // Each entry is one track:
  //   ref     'demo', 'clip:<id>', or null while a file is still only local
  //   file    the File, until a share uploads it and it gains a ref
  //   name    what the row shows
  //   locked  whether deleting the clip will ask for a password
  //   tx      the track's transcript state, kept so coming back to it is free

  var queue = [];
  var current = -1;

  function newEntry(fields) {
    return { ref: fields.ref || null, name: fields.name || '', file: fields.file || null,
      locked: Boolean(fields.locked), tx: null };
  }

  function clipIdOf(entry) {
    return entry && entry.ref && entry.ref.indexOf('clip:') === 0 ? entry.ref.slice(5) : null;
  }

  function uploadedIds() {
    return queue.map(clipIdOf).filter(function (id, i, all) { return id && all.indexOf(id) === i; });
  }

  function addTracks(entries, playFirst) {
    var room = MAX_QUEUE - queue.length;
    resetShare();
    if (room <= 0) {
      el.shareStatus.textContent = 'A playlist holds ' + MAX_QUEUE + ' tracks.';
      return;
    }
    if (entries.length > room) {
      el.shareStatus.textContent = 'A playlist holds ' + MAX_QUEUE + ' tracks, so ' +
        (entries.length - room) + ' did not fit.';
    }
    var at = queue.length;
    queue = queue.concat(entries.slice(0, room));
    if (playFirst || current < 0) playIndex(at, playFirst && playing);
    else renderQueue();
  }

  function removeAt(i) {
    if (i < 0 || i >= queue.length) return;
    var wasCurrent = i === current;
    var wasPlaying = playing;
    queue.splice(i, 1);
    resetShare();
    if (!queue.length) { emptyPage(); return; }
    if (wasCurrent) { playIndex(Math.min(i, queue.length - 1), wasPlaying); return; }
    if (i < current) current -= 1;
    renderQueue();
  }

  function moveAt(i, delta) {
    var to = i + delta;
    if (i < 0 || i >= queue.length || to < 0 || to >= queue.length) return;
    var held = queue[i];
    queue[i] = queue[to];
    queue[to] = held;
    if (current === i) current = to;
    else if (current === to) current = i;
    resetShare();
    renderQueue();
  }

  function playIndex(i, autostart) {
    if (i < 0 || i >= queue.length) return;
    current = i;
    renderQueue();
    loadEntry(queue[i], autostart);
  }

  function step(delta) {
    var to = current + delta;
    if (to >= 0 && to < queue.length) playIndex(to, playing);
  }

  function renameEntry(entry, name) {
    if (!entry || !name || entry.name === name) return;
    entry.name = name;
    renderQueue();
    if (entry === queue[current]) updateMediaSession();
  }

  // Rows are built with the DOM rather than markup: a name is text the visitor chose.
  function renderQueue() {
    el.queue.textContent = '';
    queue.forEach(function (entry, i) {
      var li = document.createElement('li');
      if (i === current) li.className = 'current';

      var name = document.createElement('span');
      name.textContent = (i + 1) + '. ' + (entry.name || 'Untitled track') +
        (entry.ref === 'demo' ? ' (demo)' : clipIdOf(entry) ? ' (uploaded)' : '');
      name.title = entry.name;
      name.style.cursor = 'pointer';
      name.addEventListener('click', function () { playIndex(i, playing); });
      li.appendChild(name);

      [['↑', 'Move up', function () { moveAt(i, -1); }, i === 0],
       ['↓', 'Move down', function () { moveAt(i, 1); }, i === queue.length - 1],
       ['×', 'Remove', function () { removeAt(i); }, false]].forEach(function (spec) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = spec[0];
        b.setAttribute('aria-label', spec[1] + ' ' + (entry.name || 'track'));
        b.disabled = spec[3];
        b.addEventListener('click', spec[2]);
        li.appendChild(b);
      });
      el.queue.appendChild(li);
    });

    var many = queue.length > 1;
    el.prev.hidden = el.next.hidden = !many;
    el.prev.disabled = current <= 0;
    el.next.disabled = current >= queue.length - 1;
    syncDanger();
  }

  // A restored playlist asks each clip for its name with a HEAD request, which
  // the Worker answers from metadata.
  function labelClips() {
    queue.forEach(function (entry, i) {
      var id = clipIdOf(entry);
      if (!id) return;
      if (!entry.name) entry.name = 'Shared track ' + (i + 1);
      fetch(API + '/clip/' + id, { method: 'HEAD' }).then(function (r) {
        if (!r.ok) return;
        var sent = r.headers.get('X-Clip-Name');
        if (sent) renameEntry(entry, decodeURIComponent(sent));
        if (r.headers.get('X-Clip-Locked')) { entry.locked = true; syncDanger(); }
      }).catch(function () {});
    });
    renderQueue();
  }

  function takeFiles(files) {
    var entries = [];
    for (var i = 0; i < files.length; i++) entries.push(newEntry({ file: files[i], name: files[i].name }));
    if (entries.length) addTracks(entries, current < 0);
  }

  function emptyPage() {
    current = -1;
    stopSource();
    releaseBg();
    buffer = null;
    offset = 0;
    setPlaying(false);
    txReset();
    loadToken++;
    el.player.hidden = el.effects.hidden = el.share.hidden = true;
    el.shared.hidden = true;
    renderQueue();
  }

  // --- loading -------------------------------------------------------------------

  var buffer = null;      // the decoded track
  var loadToken = 0;      // a slow load must not land after a newer one

  function loadEntry(entry, autostart) {
    var token = ++loadToken;
    stopSource();
    releaseBg();
    buffer = null;
    offset = 0;
    setPlaying(false);
    txReset();
    el.player.hidden = el.effects.hidden = el.share.hidden = false;
    el.time.textContent = 'decoding…';
    ensureContext();

    readBytes(entry).then(function (got) {
      if (token !== loadToken) return null;
      // Before the decode, which detaches the bytes it is given.
      if (IOS) adoptBg(got.bytes, got.type);
      return ctx.decodeAudioData(got.bytes);
    }).then(function (decoded) {
      if (token !== loadToken || !decoded) return;
      buffer = decoded;
      el.seek.max = buffer.duration;
      showTime();
      txAdopt(entry);
      updateMediaSession();
      if (autostart) startPlayback(0);
    }).catch(function () {
      if (token !== loadToken) return;
      el.time.textContent = entry.file ? 'That file could not be decoded.' : 'This track could not be loaded.';
    });
  }

  // The raw bytes of a track, from the File or from the Worker.
  function readBytes(entry) {
    if (entry.file) {
      return entry.file.arrayBuffer().then(function (bytes) { return { bytes: bytes, type: entry.file.type }; });
    }
    var url = entry.ref === 'demo' ? DEMO_URL : API + '/clip/' + clipIdOf(entry);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var sent = r.headers.get('X-Clip-Name');
      if (sent) renameEntry(entry, decodeURIComponent(sent));
      if (r.headers.get('X-Clip-Locked')) { entry.locked = true; syncDanger(); }
      return r.arrayBuffer().then(function (bytes) { return { bytes: bytes, type: r.headers.get('Content-Type') || '' }; });
    });
  }

  // --- transport -----------------------------------------------------------------

  var source = null;
  var offset = 0;        // where the buffer is, in track seconds
  var startedAt = 0;     // context time when the source started
  var playing = false;

  function position() {
    if (!buffer) return 0;
    if (bgActive) return el.bg.currentTime || 0;
    if (!playing) return offset;
    return clamp(offset + (ctx.currentTime - startedAt) * rateNow, 0, buffer.duration);
  }

  function startAt(sec) {
    if (!buffer) return;
    ensureContext();
    stopSource();
    offset = clamp(sec, 0, Math.max(0, buffer.duration - 0.01));
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rateNow;
    source.connect(nodes.gain);
    source.onended = trackEnded;
    startedAt = ctx.currentTime;
    source.start(0, offset);
    setPlaying(true);
  }

  // Only a natural end reaches this; stopSource clears the handler first.
  function trackEnded() {
    source = null;
    offset = 0;
    setPlaying(false);
    showTime();
    if (el.through.checked && current < queue.length - 1) playIndex(current + 1, true);
  }

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch (e) {}
    source.disconnect();
    source = null;
  }

  // On iOS a hidden page cannot run the graph, so the element takes the track.
  function startPlayback(sec) {
    if (document.hidden && IOS && bgUrl) startBg(sec);
    else startAt(sec);
  }

  function togglePlay() {
    if (!buffer) return;
    ensureContext();
    if (playing) { pause(); return; }
    primeBg();
    startPlayback(offset >= buffer.duration - 0.02 ? 0 : offset);
  }

  function pause() {
    if (!playing) return;
    offset = position();
    if (bgActive) stopBg(); else stopSource();
    setPlaying(false);
  }

  function stop() {
    if (bgActive) stopBg(); else stopSource();
    offset = 0;
    setPlaying(false);
    showTime();
  }

  function seek(sec) {
    if (!buffer) return;
    var to = clamp(sec, 0, buffer.duration);
    if (playing) startPlayback(to);
    else offset = to;
    showTime();
  }

  function setPlaying(on) {
    playing = on;
    el.play.textContent = on ? 'Pause' : 'Play';
    if (navigator.mediaSession) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  }

  function showTime() {
    var pos = position();
    el.seek.value = pos;
    el.time.textContent = formatTime(pos) + ' / ' + formatTime(buffer ? buffer.duration : 0);
  }

  // What the phone shows on its lock screen, and the buttons there.
  function updateMediaSession() {
    var ms = navigator.mediaSession;
    if (!ms) return;
    var entry = queue[current];
    try {
      ms.metadata = new MediaMetadata({
        title: (entry && entry.name) || 'Signal Share',
        artist: queue.length > 1 ? 'Track ' + (current + 1) + ' of ' + queue.length : 'Signal Share'
      });
    } catch (e) {}
    [['play', function () { if (!playing) togglePlay(); }], ['pause', pause], ['stop', stop],
     ['previoustrack', function () { step(-1); }], ['nexttrack', function () { step(1); }]]
      .forEach(function (pair) {
        try { ms.setActionHandler(pair[0], pair[1]); } catch (e) {}
      });
  }

  // --- keeping playing when the page is hidden -------------------------------------
  //
  // A desktop browser keeps an AudioContext running in a hidden tab, so nothing
  // needs doing there. iOS moves it to "interrupted" the moment the page is
  // backgrounded or the screen locks, and only a plain <audio> element keeps
  // playing, so on iOS the track is handed to the element at the door and taken
  // back on return. The element plays the track unrouted: effects and the
  // picture wait until the page is back.

  var IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  var bgUrl = null;       // object URL of the current track, iOS only
  var bgActive = false;   // the element, not the graph, has the track
  var bgPrimed = false;   // the element has played once from a real gesture

  function adoptBg(bytes, type) {
    releaseBg();
    bgUrl = URL.createObjectURL(new Blob([bytes], { type: type || 'audio/mpeg' }));
    el.bg.src = bgUrl;
  }

  function releaseBg() {
    bgActive = false;
    el.bg.pause();
    el.bg.removeAttribute('src');
    el.bg.load();
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = null;
  }

  // iOS lets a media element play only after it has played from a gesture, and
  // the handoff happens on a visibility change, which is not one. So the
  // element is unlocked on the click that starts the graph: a muted play, and a
  // pause the moment it is granted.
  function primeBg() {
    if (bgPrimed || !IOS || !bgUrl) return;
    bgPrimed = true;
    el.bg.muted = true;
    var p = el.bg.play();
    if (!p || !p.then) return;
    p.then(function () {
      if (!bgActive) { el.bg.pause(); el.bg.currentTime = 0; }
      el.bg.muted = false;
    }, function () {
      el.bg.muted = false;
      bgPrimed = false;
    });
  }

  function syncBg() {
    if (!bgUrl) return;
    el.bg.volume = num(el.volume);
    el.bg.playbackRate = rateNow;
    el.bg.preservesPitch = false;
  }

  function startBg(sec) {
    bgActive = true;
    el.bg.muted = false;
    syncBg();
    el.bg.currentTime = Math.max(0, sec || 0);
    var p = el.bg.play();
    if (p && p.catch) {
      p.catch(function () {
        bgActive = false;
        offset = Math.max(0, sec || 0);
        setPlaying(false);
      });
    }
    setPlaying(true);
  }

  function stopBg() {
    bgActive = false;
    el.bg.pause();
  }

  el.bg.addEventListener('ended', function () {
    if (!bgActive) return;
    bgActive = false;
    trackEnded();
  });

  // Stopped by something other than this page: the lock screen, a call.
  el.bg.addEventListener('pause', function () {
    if (!bgActive || el.bg.ended) return;
    bgActive = false;
    offset = el.bg.currentTime || 0;
    setPlaying(false);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (playing && IOS && !bgActive && bgUrl) {
        var at = position();
        stopSource();
        startBg(at);
      }
      return;
    }
    if (bgActive) {
      var back = el.bg.currentTime || 0;
      stopBg();
      offset = back;
      if (playing) startAt(back);
    } else if (ctx && ctx.state !== 'running') {
      ctx.resume();
    }
  });

  // --- the picture ---------------------------------------------------------------
  //
  // The wave across the top, the spectrum along the bottom on a log axis, and
  // the filter's response drawn over the spectrum on the same axis, so a dip in
  // the curve sits over the bars it is taking out.

  var g = el.scope.getContext('2d');
  var timeData = null;
  var freqData = null;
  var colours = { fg: '#111', muted: '#666', line: '#ccc' };

  function readColours() {
    var style = getComputedStyle(document.documentElement);
    colours.fg = style.getPropertyValue('--fg').trim() || colours.fg;
    colours.muted = style.getPropertyValue('--muted').trim() || colours.muted;
    colours.line = style.getPropertyValue('--line').trim() || colours.line;
  }
  readColours();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColours);

  function hzToX(hz, w) { return w * Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN); }
  function xToHz(x, w) { return F_MIN * Math.pow(F_MAX / F_MIN, x / w); }

  function draw() {
    if (buffer && playing) showTime();
    txFollow();

    var w = el.scope.clientWidth;
    var h = CANVAS_HEIGHT;
    var dpr = window.devicePixelRatio || 1;
    if (el.scope.width !== Math.round(w * dpr) || el.scope.height !== Math.round(h * dpr)) {
      el.scope.width = Math.round(w * dpr);
      el.scope.height = Math.round(h * dpr);
      el.scope.style.height = h + 'px';
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!w) { requestAnimationFrame(draw); return; }

    if (nodes) {
      var bins = nodes.analyser.frequencyBinCount;
      if (!timeData || timeData.length !== bins) {
        timeData = new Uint8Array(bins);
        freqData = new Uint8Array(bins);
      }
      nodes.analyser.getByteTimeDomainData(timeData);
      nodes.analyser.getByteFrequencyData(freqData);
    }

    // The wave.
    var mid = h * 0.25;
    g.strokeStyle = colours.fg;
    g.lineWidth = 1.5;
    g.beginPath();
    if (timeData) {
      for (var i = 0; i < timeData.length; i++) {
        var y = mid + (timeData[i] / 128 - 1) * h * 0.2;
        if (i === 0) g.moveTo(0, y); else g.lineTo((i / timeData.length) * w, y);
      }
    } else {
      g.moveTo(0, mid);
      g.lineTo(w, mid);
    }
    g.stroke();

    // The spectrum: one bar per few pixels, each the loudest bin under it.
    var base = h * 0.95;
    var span = h * 0.4;
    if (freqData && ctx) {
      var nyquist = ctx.sampleRate / 2;
      var bars = Math.max(24, Math.floor(w / 4));
      var bw = w / bars;
      g.fillStyle = colours.muted;
      for (var b = 0; b < bars; b++) {
        var i0 = Math.floor(xToHz(b * bw, w) / nyquist * freqData.length);
        var i1 = Math.max(i0 + 1, Math.ceil(xToHz((b + 1) * bw, w) / nyquist * freqData.length));
        if (i0 >= freqData.length) break;
        var peak = 0;
        for (var k = i0; k < i1 && k < freqData.length; k++) peak = Math.max(peak, freqData[k]);
        g.fillRect(b * bw, base - (peak / 255) * span, Math.max(bw - 1, 1), (peak / 255) * span);
      }
    }

    // Decade ticks, so the log axis can be read.
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillStyle = colours.muted;
    [100, 1000, 10000].forEach(function (hz) {
      var x = hzToX(hz, w);
      g.fillRect(x, base, 1, 4);
      g.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), x, h - 1);
    });

    if (filterType() && nodes) drawFilterCurve(w, base, span);
    requestAnimationFrame(draw);
  }

  // The response is read from the node doing the filtering. Points are spaced
  // evenly along the log axis, with a cluster around the centre frequency so a
  // narrow notch is drawn at its full depth rather than stepped over.
  var curveHz = new Float32Array(288);
  var curveMag = new Float32Array(288);
  var curvePhase = new Float32Array(288);

  function drawFilterCurve(w, base, span) {
    var f0 = filterHz();
    var top = Math.min(F_MAX, ctx.sampleRate / 2 * 0.999);
    var i;
    for (i = 0; i < 256; i++) curveHz[i] = F_MIN * Math.pow(top / F_MIN, i / 255);
    for (i = 0; i < 32; i++) curveHz[256 + i] = clamp(f0 / 1.3 * Math.pow(1.69, i / 31), F_MIN, top);
    curveHz.sort();
    nodes.filter.getFrequencyResponse(curveHz, curveMag, curvePhase);

    var dbTop = 18, dbBottom = -42;
    function yOf(mag) {
      var db = mag > 0 ? 20 * Math.log10(mag) : dbBottom;
      return base - span * clamp((db - dbBottom) / (dbTop - dbBottom), 0, 1);
    }

    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = colours.fg;
    g.lineWidth = 1.5;
    g.beginPath();
    for (i = 0; i < curveHz.length; i++) {
      var x = hzToX(curveHz[i], w);
      if (i === 0) g.moveTo(x, yOf(curveMag[i])); else g.lineTo(x, yOf(curveMag[i]));
    }
    g.stroke();
    g.restore();

    var fx = hzToX(f0, w);
    g.fillStyle = colours.fg;
    g.fillRect(fx, base - span, 1, span);
    g.textAlign = 'center';
    g.fillText(formatHz(f0), clamp(fx, 24, w - 24), base - span - 4);
  }

  // --- the transcript ----------------------------------------------------------------
  //
  // Nothing is sent until the box is ticked, and the tick is per track and per
  // visit. Once it is on, windows are cut from the centre band (the track
  // through a 200 Hz to 6 kHz band, summed to mono, which is where a voice is
  // and most of the band is not), posted a little ahead of the playhead, and
  // the segments that come back are shown as the playhead reaches them.

  var tx = null;          // the current track's transcript state; lives on its entry
  var txBand = null;      // the centre band at 16 kHz, built once per track
  var txBandBusy = false;

  function txFresh() {
    return { on: false, segments: [], next: 0, index: 0, lang: '', prev: '',
      done: false, busy: false, lookedUp: false, failed: false };
  }

  function txStatus(text) { el.txStatus.textContent = text || ''; }

  function txSync() {
    el.txOn.checked = Boolean(tx && tx.on);
    el.txOn.disabled = !buffer;
    el.txCopy.disabled = !(tx && tx.segments.length);
  }

  function txReset() {
    tx = null;
    txBand = null;
    txBandBusy = false;
    el.caption.textContent = '';
    txStatus('');
    txSync();
  }

  // Back on a track that was transcribed earlier this visit, its words and its
  // toggle come back with it. A new track starts with nothing.
  function txAdopt(entry) {
    tx = entry.tx || (entry.tx = txFresh());
    tx.busy = false;
    if (tx.segments.length) txStatus(tx.done ? 'Transcript complete.' : 'Picking up where this left off.');
    txSync();
  }

  function txBegin() {
    tx.on = true;
    tx.failed = false;
    if (!tx.segments.length && !tx.next) tx.next = Math.max(0, position() - 0.5);
    txSync();
    var id = clipIdOf(queue[current]);
    if (id && !tx.lookedUp) {
      tx.lookedUp = true;
      txLoadCached(id);
    } else if (!tx.segments.length) {
      txStatus('Listening ahead…');
    }
  }

  // Whatever the Worker already holds for this clip: the first listener paid
  // for it and everyone after reads it back for nothing.
  function txLoadCached(id) {
    var mine = tx;
    fetch(API + '/transcript/' + id).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || mine !== tx || mine.segments.length) return;
      var end = 0;
      (data.chunks || []).forEach(function (c) {
        (c.segments || []).forEach(function (seg) { mine.segments.push(seg); });
        end = Math.max(end, c.end || 0);
        if (c.i >= mine.index) mine.index = c.i + 1;
        if (c.language && !mine.lang) mine.lang = c.language;
      });
      if (!mine.segments.length) return;
      mine.segments.sort(function (a, b) { return a.s - b.s; });
      mine.next = end;
      mine.done = end >= buffer.duration - 0.5;
      txStatus(mine.done ? 'Transcript came with the link.' : 'Part of this is already transcribed.');
      txSync();
    }).catch(function () {}).then(function () {
      if (mine === tx && mine.on && !mine.segments.length) txStatus('Listening ahead…');
    });
  }

  // The centre band, rendered once at the rate it is posted at, so a window is
  // a slice of it. A stereo track feeding a mono destination is summed to
  // (L+R)/2, which is the middle; the two crossover pairs take off the bass and
  // the top.
  function txBuildBand() {
    if (txBandBusy || !buffer) return;
    txBandBusy = true;
    var mine = tx;
    var frames = Math.max(1, Math.round(buffer.duration * TX_RATE));
    var done = function (rendered) {
      if (mine !== tx) return;
      txBandBusy = false;
      if (rendered) { txBand = rendered.getChannelData(0); return; }
      mine.on = false;
      mine.failed = true;
      txStatus('This track could not be prepared for transcription.');
      txSync();
    };
    try {
      var off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, frames, TX_RATE);
      var src = off.createBufferSource();
      src.buffer = buffer;
      var head = src;
      [['highpass', TX_BAND_LOW], ['highpass', TX_BAND_LOW], ['lowpass', TX_BAND_HIGH], ['lowpass', TX_BAND_HIGH]]
        .forEach(function (spec) {
          var f = off.createBiquadFilter();
          f.type = spec[0];
          f.frequency.value = spec[1];
          f.Q.value = BUTTERWORTH_Q_DB;
          head.connect(f);
          head = f;
        });
      head.connect(off.destination);
      src.start(0);
      off.startRendering().then(done, function () { done(null); });
    } catch (e) {
      done(null);
    }
  }

  // Where to end a window: the quietest 20 ms within reach of the target
  // length, so a cut is less likely to land in the middle of a word.
  function txCut(start) {
    var duration = buffer.duration;
    var target = Math.min(start + TX_WINDOW, duration);
    if (duration - target < 2) return duration;
    var win = Math.floor(TX_RATE * 0.02);
    var best = target;
    var quietest = Infinity;
    for (var t = Math.max(start + 1, target - TX_SEARCH); t <= Math.min(duration - 0.05, target + TX_SEARCH); t += 0.02) {
      var at = Math.floor(t * TX_RATE);
      var energy = 0;
      for (var i = at; i < at + win && i < txBand.length; i++) energy += txBand[i] * txBand[i];
      if (energy < quietest) { quietest = energy; best = t; }
    }
    return best;
  }

  // 16-bit mono PCM WAV of a slice of the band.
  function txWav(start, end) {
    var from = clamp(Math.round(start * TX_RATE), 0, txBand.length);
    var to = clamp(Math.round(end * TX_RATE), from + 1, txBand.length);
    var samples = txBand.subarray(from, to);
    var bytes = samples.length * 2;
    var buf = new ArrayBuffer(44 + bytes);
    var view = new DataView(buf);
    function str(at, text) { for (var i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, TX_RATE, true); view.setUint32(28, TX_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, bytes, true);
    for (var i = 0; i < samples.length; i++) {
      var v = clamp(samples[i], -1, 1);
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return buf;
  }

  function txPost(wav, start, index) {
    var id = clipIdOf(queue[current]);
    var url = API + '/transcribe?i=' + index + '&start=' + start.toFixed(3) + (id ? '&clip=' + id : '');
    var headers = { 'Content-Type': 'audio/wav' };
    // The tail of the last window, so a sentence cut in two is finished rather
    // than restarted; and the language, detected once and held.
    if (tx.prev) headers['X-Clip-Prev'] = encodeURIComponent(tx.prev);
    if (tx.lang) headers['X-Clip-Lang'] = encodeURIComponent(tx.lang);
    return fetch(url, { method: 'POST', headers: headers, body: wav }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) throw new Error(data.error || 'Transcription failed.');
        return data;
      });
    });
  }

  // Called twice a second. Sends the next window when the words are wanted and
  // the playhead is getting close to needing them.
  function txPump() {
    if (!tx || !tx.on || tx.busy || tx.done || !buffer) return;
    if (!txBand) { txBuildBand(); return; }
    if (tx.next >= buffer.duration - 0.2) {
      tx.done = true;
      txStatus('Transcript complete.');
      return;
    }
    var pos = position();
    // A jump forward leaves the skipped minutes as a gap rather than spending
    // the budget on audio nobody will hear.
    if (pos > tx.next + TX_JUMP) { tx.next = pos; tx.prev = ''; }
    if (tx.next > pos + TX_LEAD && tx.next >= TX_PRELOAD) return;

    var start = tx.next;
    var end = txCut(start);
    if (end - start < 0.4) { tx.done = true; return; }

    var mine = tx;
    mine.busy = true;
    if (!mine.segments.length) txStatus('Listening ahead…');
    txPost(txWav(start, end), start, mine.index).then(function (data) {
      if (mine !== tx) return;
      mine.index += 1;
      mine.next = end;
      if (data.language) mine.lang = data.language;
      var added = data.segments || [];
      if (added.length) {
        added.forEach(function (seg) { mine.segments.push(seg); });
        mine.prev = (mine.prev + ' ' + added[added.length - 1].t).slice(-220).trim();
      }
      txStatus(mine.next >= buffer.duration - 0.2 ? 'Transcript complete.' : 'Transcribing…');
      txSync();
    }).catch(function (err) {
      if (mine !== tx) return;
      // The box clears with it: a refusal is something to read and retry on
      // purpose, not a tick over a pump that has stopped.
      mine.on = false;
      txStatus(err.message || 'Transcription failed.');
      txSync();
    }).then(function () { mine.busy = false; });
  }

  // The line under the picture is whichever segment the playhead is inside.
  var txShown = -1;

  function txFollow() {
    if (!tx || !tx.segments.length) return;
    var pos = position();
    var at = -1;
    for (var i = 0; i < tx.segments.length; i++) {
      var seg = tx.segments[i];
      if (seg.s > pos + 0.15) break;
      if (pos <= seg.e + 0.35) { at = i; break; }
    }
    if (at === txShown) return;
    txShown = at;
    el.caption.textContent = at < 0 ? '' : tx.segments[at].t;
  }

  // --- share ---------------------------------------------------------------------
  //
  // The link is this page's URL with the state in its hash. `v=3` is the
  // format; `t=` lists the playlist as clip ids (or `d` for the demo), `i=`
  // says which track it opens on, `flt=`, `ec=` and `rv=` carry the effects,
  // `vol=` and `p=` the volume and pitch, and `ti=` and `no=` the sender's own
  // words. v2 links, which carried a single `a=` track, still open.
  //
  // A share with a title or a note is wrapped in a preview card on the Worker
  // (`/s/<id>`), because messaging apps read a page's meta tags and a fragment
  // never reaches a server. The card forwards to the same hash with `s=<id>`
  // added, so the card can be deleted along with the audio.

  var shareId = null;     // the preview card wrapping the current link, if any
  var ttlDays = 30;
  var delArmed = false;

  function shareTitle() { return el.shareTitle.value.trim().slice(0, MAX_TITLE); }
  function shareNote() { return el.shareNote.value.trim().slice(0, MAX_NOTE); }

  function encodeState() {
    var parts = ['v=3'];
    var type = filterType();
    parts.push('flt=' + [type ? FILTER_CODE[type] : 'off', el.freq.value, String(+filterQ().toFixed(2))].join(','));
    if (el.echoOn.checked) parts.push('ec=' + [el.echoTime.value, el.echoFb.value, el.echoMix.value].join(','));
    if (el.revOn.checked) parts.push('rv=' + [el.revSize.value, el.revPre.value, el.revMix.value].join(','));
    parts.push('vol=' + el.volume.value);
    if (Math.round(num(el.pitch))) parts.push('p=' + Math.round(num(el.pitch)));

    // Only tracks that are somewhere a link can point: a file that never left
    // this browser is left out.
    var refs = [];
    var at = -1;
    queue.forEach(function (entry, i) {
      if (!entry.ref) return;
      if (i === current) at = refs.length;
      refs.push(entry.ref === 'demo' ? 'd' : entry.ref.slice(5));
    });
    if (refs.length) {
      parts.push('t=' + refs.join(','));
      if (at > 0) parts.push('i=' + at);
      if (at >= 0 && queue[current].name) parts.push('n=' + encodeURIComponent(queue[current].name));
    }
    if (shareTitle()) parts.push('ti=' + encodeURIComponent(shareTitle()));
    if (shareNote()) parts.push('no=' + encodeURIComponent(shareNote()));
    return parts.join('&');
  }

  function decodeState(hash) {
    var out = {};
    hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var eq = kv.indexOf('=');
      if (eq < 1) return;
      try { out[kv.slice(0, eq)] = decodeURIComponent(kv.slice(eq + 1)); }
      catch (e) { out[kv.slice(0, eq)] = kv.slice(eq + 1); }
    });
    return out;
  }

  // A number a stranger put in a URL, held to the slider's own range.
  function inRange(text, lo, hi, fallback) {
    var v = parseFloat(text);
    return isFinite(v) ? clamp(v, lo, hi) : fallback;
  }

  function applyState(s) {
    if (s.v !== '2' && s.v !== '3') return;

    var flt = (s.flt || '').split(',');
    if (s.flt && flt.length >= 3) {
      var type = flt[0] === 'off' ? '' : (FILTER_FROM_CODE[flt[0]] || '');
      el.filterType.value = type;
      el.freq.value = inRange(flt[1], 0, 1000, num(el.freq));
      var q = parseFloat(flt[2]);
      if (isFinite(q)) el.q.value = qToSlider(type || 'lowpass', q);
    }
    var ec = (s.ec || '').split(',');
    if (s.ec && ec.length >= 3) {
      el.echoTime.value = inRange(ec[0], 20, 1500, num(el.echoTime));
      el.echoFb.value = inRange(ec[1], 0, 0.9, num(el.echoFb));
      el.echoMix.value = inRange(ec[2], 0, 1, num(el.echoMix));
      el.echoOn.checked = true;
    }
    var rv = (s.rv || '').split(',');
    if (s.rv && rv.length >= 3) {
      el.revSize.value = inRange(rv[0], 0.2, 6, num(el.revSize));
      el.revPre.value = inRange(rv[1], 0, 200, num(el.revPre));
      el.revMix.value = inRange(rv[2], 0, 1, num(el.revMix));
      el.revOn.checked = true;
    }
    if (s.vol !== undefined) el.volume.value = inRange(s.vol, 0, 1, num(el.volume));
    if (s.p !== undefined) el.pitch.value = inRange(s.p, -12, 12, 0);
    applyFilter();
    applyEcho();
    applyReverb();
    applyVolume();
    applyPitch();
    wire();

    if (s.t) restoreQueue(s.t, parseInt(s.i, 10) || 0, s.n);
    else if (s.a) restoreQueue(s.a === 'demo' ? 'd' : s.a.replace(/^clip:/, ''), 0, s.n);
    if (s.s && CLIP_ID.test(s.s)) shareId = s.s;
    showSenderWords(s.ti, s.no);
  }

  function restoreQueue(list, index, name) {
    var entries = [];
    String(list).split(',').slice(0, MAX_QUEUE).forEach(function (token) {
      if (token === 'd') entries.push(newEntry({ ref: 'demo', name: DEMO_NAME }));
      else if (CLIP_ID.test(token)) entries.push(newEntry({ ref: 'clip:' + token }));
    });
    if (!entries.length) return;
    if (!(index >= 0 && index < entries.length)) index = 0;
    if (name && !entries[index].name) entries[index].name = name;
    queue = entries;
    el.shared.hidden = false;
    el.sharedDetail.textContent = entries.length > 1
      ? 'Press play for their ' + entries.length + ' track playlist with their settings.'
      : 'Press play to hear "' + (entries[index].name || 'their track') + '" with their settings.';
    playIndex(index, false);
    labelClips();
  }

  // The sender's title and note, shown at the top and put back into the share
  // fields so forwarding the page on keeps them. Both are a stranger's text,
  // so they only ever land in textContent.
  function showSenderWords(title, note) {
    var t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    var n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
    if (!t && !n) return;
    if (t) { el.sharedTitle.textContent = t; el.shareTitle.value = t; }
    if (n) { el.sharedNote.textContent = n; el.shareNote.value = n; }
    el.shared.hidden = false;
  }

  function resetShare() {
    el.shareOut.hidden = true;
    el.shareStatus.textContent = '';
  }

  // The upload key lifts the Worker's size limit. It is kept for this tab only
  // and only ever sent as a header.
  function uploadKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }

  function uploadClip(file) {
    var headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-Clip-Name': encodeURIComponent(file.name) };
    if (uploadKey()) headers['X-Clip-Key'] = uploadKey();
    // The delete password can only be set as the clip goes up.
    if (el.sharePass.value) headers['X-Clip-Lock'] = el.sharePass.value;
    return fetch(API + '/clip', { method: 'POST', headers: headers, body: file }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) throw new Error(data.error || 'Upload failed.');
        return data;
      });
    });
  }

  // Uploads one file at a time (the route is rate limited per minute), then
  // hands over the link.
  function runShare() {
    var pending = queue.filter(function (entry) { return entry.file && !entry.ref; });
    if (!queue.length) return;
    el.shareBtn.disabled = true;
    (function next(at) {
      if (at >= pending.length) {
        el.shareBtn.disabled = false;
        finishShare(pending.length ? 'Ready. This link works for ' + ttlDays + ' days.' : 'Ready.');
        return;
      }
      el.shareStatus.textContent = pending.length > 1
        ? 'Uploading ' + (at + 1) + ' of ' + pending.length + '…'
        : 'Uploading your track…';
      uploadClip(pending[at].file).then(function (data) {
        pending[at].ref = 'clip:' + data.id;
        pending[at].file = null;
        pending[at].locked = Boolean(data.locked);
        if (data.expiresInDays) ttlDays = data.expiresInDays;
        if (data.name) renameEntry(pending[at], data.name);
        renderQueue();
        next(at + 1);
      }).catch(function (err) {
        el.shareBtn.disabled = false;
        renderQueue();
        // Whatever went up keeps its ref, so a retry only sends the rest.
        el.shareStatus.textContent = (err.message || 'Upload failed.') +
          (at ? ' The ' + at + ' before it are already uploaded.' : '');
      });
    })(0);
  }

  // With no title and no note the link is this page's URL with the hash; with
  // either, a preview card on the Worker that forwards to the same hash. If
  // the card cannot be made the plain link is handed over instead.
  function finishShare(okText) {
    var hash = encodeState();
    var plain = location.origin + location.pathname + '#' + hash;
    if (!shareTitle() && !shareNote()) {
      shareId = null;
      showLink(plain, hash, okText);
      return;
    }
    el.shareStatus.textContent = 'Making the preview card…';
    var headers = { 'Content-Type': 'application/json' };
    if (el.sharePass.value) headers['X-Clip-Lock'] = el.sharePass.value;
    fetch(API + '/share', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ hash: hash, title: shareTitle(), note: shareNote() })
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok || !data.url) throw new Error(data.error || 'Could not make the preview card.');
        return data;
      });
    }).then(function (data) {
      shareId = data.id;
      showLink(data.url, hash, okText + ' It previews with your title and note.');
    }).catch(function (err) {
      shareId = null;
      showLink(plain, hash, (err.message || 'Could not make the preview card.') + ' The link still works, without the preview.');
    });
  }

  function showLink(url, hash, status) {
    el.shareLink.value = url;
    el.shareOut.hidden = false;
    el.shareStatus.textContent = status;
    el.shareLink.focus();
    el.shareLink.select();
    // The address bar keeps the state itself, so a reload survives.
    history.replaceState(null, '', '#' + hash);
    syncDanger();
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  // --- deleting from the cloud ---------------------------------------------------
  //
  // The clip id in a link is the whole permission unless the uploader set a
  // password, so anyone the link reached can take the tracks down. The button
  // asks twice rather than opening a dialog.

  function anyLocked() {
    return queue.some(function (entry) { return clipIdOf(entry) && entry.locked; });
  }

  function syncDanger() {
    var any = uploadedIds().length > 0 || Boolean(shareId);
    el.danger.hidden = !any;
    el.delPass.hidden = !(anyLocked() || el.sharePass.value);
    if (!any) disarmDelete();

    // A lock is fixed when the clip is written, so the field closes once
    // anything in the queue is up.
    var uploaded = uploadedIds().length > 0;
    el.sharePass.disabled = uploaded;
    el.lockHint.textContent = !uploaded
      ? 'Without a password, anyone holding the link can delete the tracks. Set it before you make the link; it cannot be added or recovered afterwards.'
      : anyLocked()
        ? 'These tracks are password protected. Deleting them asks for it, and it cannot be changed now they are up.'
        : 'These tracks are already uploaded, so a password can no longer be attached. Delete them and share again to set one.';
  }

  function disarmDelete() {
    delArmed = false;
    el.delBtn.textContent = 'Delete from the cloud';
    el.delNote.textContent = 'Takes the uploaded tracks down for everyone. Anyone holding the link can do this too.';
  }

  // Answers with why, not only whether: a delete refused for want of a password
  // is the one failure the page can do something about.
  function deleteAt(url, pass) {
    var headers = {};
    if (pass) headers['X-Clip-Lock'] = pass;
    return fetch(url, { method: 'DELETE', headers: headers }).then(function (resp) {
      if (resp.ok || resp.status === 404) return { ok: true };
      var locked = resp.status === 401 || resp.status === 403;
      return resp.json().catch(function () { return {}; }).then(function (data) {
        return { ok: false, locked: locked, error: data.error || '' };
      });
    }).catch(function () { return { ok: false, locked: false, error: '' }; });
  }

  function runDelete() {
    var ids = uploadedIds();
    if (!ids.length && !shareId) return;
    if (!delArmed) {
      delArmed = true;
      el.delBtn.textContent = ids.length
        ? 'Really delete ' + ids.length + (ids.length === 1 ? ' track?' : ' tracks?')
        : 'Really delete this link?';
      el.delNote.textContent = 'This cannot be undone. Press again to confirm.';
      return;
    }
    var pass = el.delPass.value || el.sharePass.value;
    el.delBtn.disabled = true;
    el.delBtn.textContent = 'Deleting…';

    var jobs = ids.map(function (id) {
      return deleteAt(API + '/clip/' + id, pass).then(function (r) { r.id = id; return r; });
    });
    var card = shareId;
    if (card) jobs.push(deleteAt(API + '/share/' + card, pass));

    Promise.all(jobs).then(function (results) {
      var clips = results.slice(0, ids.length);
      var cardResult = card ? results[results.length - 1] : null;
      var gone = clips.filter(function (r) { return r.ok; }).length;
      var refused = results.filter(function (r) { return r.locked; });
      el.delBtn.disabled = false;
      disarmDelete();

      if (refused.length && !gone) {
        el.delPass.hidden = false;
        el.delPass.focus();
        el.shareStatus.textContent = refused[0].error || 'That link is password protected.';
        el.delNote.textContent = pass
          ? 'That password does not match. Everything is still up.'
          : 'Enter the password that was set when this link was made.';
        return;
      }

      // A ref that no longer resolves must not go into the next link. A clip
      // that refused the password is still up, so it keeps its ref.
      var kept = {};
      clips.forEach(function (r) { if (!r.ok && r.locked) kept[r.id] = true; });
      queue.forEach(function (entry) {
        var id = clipIdOf(entry);
        if (id && !kept[id]) { entry.ref = null; entry.file = null; entry.locked = false; }
      });
      if (!cardResult || cardResult.ok) shareId = null;
      resetShare();
      renderQueue();
      el.shareStatus.textContent = !ids.length ? 'That link is dead now.'
        : gone === ids.length ? 'Deleted. That link is dead now.'
        : 'Deleted ' + gone + ' of ' + ids.length + '. Try again for the rest.';
      el.delNote.textContent = 'The tracks are still loaded here, and can be shared again.';
    });
  }

  // --- wiring ----------------------------------------------------------------------

  el.file.addEventListener('change', function () {
    takeFiles(el.file.files);
    el.file.value = '';   // so the same file can be chosen again
  });
  el.demo.addEventListener('click', function () {
    addTracks([newEntry({ ref: 'demo', name: DEMO_NAME })], current < 0);
  });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) takeFiles(e.dataTransfer.files);
  });

  el.play.addEventListener('click', togglePlay);
  el.stop.addEventListener('click', stop);
  el.prev.addEventListener('click', function () { step(-1); });
  el.next.addEventListener('click', function () { step(1); });
  el.seek.addEventListener('input', function () { seek(num(el.seek)); });
  el.volume.addEventListener('input', applyVolume);

  el.filterType.addEventListener('change', function () {
    var type = filterType();
    if (ARRIVAL_Q[type] !== undefined) el.q.value = qToSlider(type, ARRIVAL_Q[type]);
    applyFilter();
    wire();
  });
  el.freq.addEventListener('input', applyFilter);
  el.q.addEventListener('input', applyFilter);
  el.echoOn.addEventListener('change', wire);
  [el.echoTime, el.echoFb, el.echoMix].forEach(function (input) { input.addEventListener('input', applyEcho); });
  el.revOn.addEventListener('change', function () { applyReverb(); wire(); });
  [el.revSize, el.revPre, el.revMix].forEach(function (input) { input.addEventListener('input', applyReverb); });
  el.pitch.addEventListener('input', applyPitch);

  el.txOn.addEventListener('change', function () {
    if (!tx) return;
    if (el.txOn.checked) { txBegin(); return; }
    tx.on = false;
    txStatus(tx.segments.length ? 'Stopped. The text so far is kept.' : '');
    txSync();
  });
  el.txCopy.addEventListener('click', function () {
    var text = tx ? tx.segments.map(function (seg) { return seg.t; }).join('\n') : '';
    copyText(text, function (ok) { txStatus(ok ? 'Copied.' : 'Could not copy.'); });
  });

  el.shareBtn.addEventListener('click', runShare);
  el.shareCopy.addEventListener('click', function () {
    el.shareLink.select();
    copyText(el.shareLink.value, function (ok) { el.shareStatus.textContent = ok ? 'Copied.' : 'Could not copy.'; });
  });
  el.sharePass.addEventListener('input', syncDanger);
  el.delBtn.addEventListener('click', runDelete);
  el.key.addEventListener('input', function () {
    try {
      if (el.key.value.trim()) sessionStorage.setItem(KEY_STORE, el.key.value.trim());
      else sessionStorage.removeItem(KEY_STORE);
    } catch (e) {}
  });

  // --- boot ------------------------------------------------------------------------

  applyVolume();
  applyFilter();
  applyEcho();
  applyReverb();
  applyPitch();
  disarmDelete();
  syncDanger();
  txSync();
  try {
    if (uploadKey()) { el.key.value = uploadKey(); el.key.parentNode.open = true; }
  } catch (e) {}

  if (location.hash.length > 1) {
    // A hand-edited hash must not take the page down with it.
    try { applyState(decodeState(location.hash)); }
    catch (err) { console.warn('Could not read the shared state:', err); }
  }

  setInterval(txPump, 500);
  draw();

  // For the tests, which drive the page in jsdom.
  window.signalShare = {
    encodeState: encodeState, decodeState: decodeState, applyState: applyState,
    addTracks: addTracks, removeAt: removeAt, moveAt: moveAt, playIndex: playIndex, newEntry: newEntry,
    txPump: txPump, txFollow: txFollow, seek: seek, togglePlay: togglePlay,
    state: function () { return { queue: queue, current: current, playing: playing, position: position(), tx: tx, shareId: shareId }; },
    endTrack: function () { if (source && source.onended) source.onended(); }
  };
})();
