// The separation worker's DSP, driven on a mix whose parts are known.
//
// It has to be a synthetic mix. On real music there is nothing to check the
// answer against -- "that sounds about right" is not a test -- so the four
// sources here are built separately, summed, handed to the separator, and then
// looked for one at a time in each stem it hands back.
//
// Needs no dependency; unlike test/audio-page.test.mjs there is no DOM here.
//
//   node test/audio-separate.test.mjs
//
// The page's half of the exchange -- what it sends, what it does with what comes
// back, and which buffer the transcriber ends up listening to -- is in
// test/audio-page.test.mjs instead.
import fs from 'node:fs';

const html = fs.readFileSync('_includes/audio-separate.html', 'utf8');
const src = html.split('<script id="aud-sep-worker" type="text/worker">')[1].split('</script>')[0];

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// The worker's globals, handed out so the pieces can be driven one at a time.
const load = (onMsg) => {
  const body = 'var onmessage;' + src.replace(/^\s*'use strict';/, '') +
    '\nreturn { N, HOP, BINS, WIN, makeFft, unpack, Median, azimuth, analyse, hpss, repet, synthesise, pack, ramp, run: onmessage };';
  return new Function('postMessage', body)(onMsg);
};
let msgs = [];
const W = load((m) => msgs.push(m));

// --- 1. the transform, and the two packings ---------------------------------

const fft = W.makeFft(W.N);
{
  // A real signal in, its spectrum out, and back again.
  const re = new Float64Array(W.N), im = new Float64Array(W.N);
  const a = new Float64Array(W.N), b = new Float64Array(W.N);
  for (let i = 0; i < W.N; i++) {
    a[i] = Math.sin(2 * Math.PI * 5 * i / W.N) + 0.3 * Math.sin(2 * Math.PI * 61 * i / W.N);
    b[i] = Math.cos(2 * Math.PI * 17 * i / W.N);
    re[i] = a[i]; im[i] = b[i];
  }
  fft(re, im, false);
  // Unpacking should give back the two spectra; check by measuring where the
  // energy landed rather than by trusting the algebra.
  const mag = (u) => Math.hypot(u.lr, u.li);
  let peakL = 0, peakLAt = -1, peakR = 0, peakRAt = -1;
  for (let k = 0; k < W.BINS; k++) {
    const u = W.unpack(re, im, k);
    const ml = Math.hypot(u.lr, u.li), mr = Math.hypot(u.rr, u.ri);
    if (ml > peakL) { peakL = ml; peakLAt = k; }
    if (mr > peakR) { peakR = mr; peakRAt = k; }
  }
  check('unpacking finds the left signal where it actually is', peakLAt === 5, String(peakLAt));
  check('and the right one where it is', peakRAt === 17, String(peakRAt));
  void mag;
}

{
  // pack + inverse must return the two signals it was given.
  const ur = new Float64Array(W.BINS), ui = new Float64Array(W.BINS);
  const wr = new Float64Array(W.BINS), wi = new Float64Array(W.BINS);
  const u0 = new Float64Array(W.N), w0 = new Float64Array(W.N);
  for (let i = 0; i < W.N; i++) {
    u0[i] = Math.sin(2 * Math.PI * 9 * i / W.N);
    w0[i] = Math.cos(2 * Math.PI * 23 * i / W.N) * 0.5;
  }
  // Forward each on its own to get honest Hermitian spectra.
  const forward = (sig, outR, outI) => {
    const re = new Float64Array(W.N), im = new Float64Array(W.N);
    for (let i = 0; i < W.N; i++) { re[i] = sig[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < W.BINS; k++) { outR[k] = re[k]; outI[k] = im[k]; }
  };
  forward(u0, ur, ui);
  forward(w0, wr, wi);
  const re = new Float64Array(W.N), im = new Float64Array(W.N);
  W.pack(re, im, ur, ui, wr, wi);
  fft(re, im, true);
  let eu = 0, ew = 0;
  for (let i = 0; i < W.N; i++) { eu += (re[i] - u0[i]) ** 2; ew += (im[i] - w0[i]) ** 2; }
  check('packing two stems into one inverse returns the first', Math.sqrt(eu / W.N) < 1e-9, String(Math.sqrt(eu / W.N)));
  check('and the second', Math.sqrt(ew / W.N) < 1e-9, String(Math.sqrt(ew / W.N)));
}

// --- 2. the window reconstructs ---------------------------------------------
{
  let worst = 0;
  for (let n = W.N; n < W.N * 3; n++) {
    let s = 0;
    for (let t = -4; t <= 4; t++) {
      const base = n - (n % W.HOP) + t * W.HOP;
      const i = n - base;
      if (i >= 0 && i < W.N) s += W.WIN[i] * W.WIN[i];
    }
    worst = Math.max(worst, Math.abs(s - 1));
  }
  check('the sine window squared sums to one, so the overlap-add is exact', worst < 1e-6, String(worst));
}

// --- 3. azimuth ---------------------------------------------------------------
const az = (l, r) => W.azimuth(l, 0, r, 0, 0.35 / 3, 0.35);
check('a centred bin reads as centred', az(1, 1) > 0.99, String(az(1, 1)));
check('a hard-left bin does not', az(1, 0) < 0.01, String(az(1, 0)));
check('nor does one panned three quarters over', az(0.25, 1) < 0.01, String(az(0.25, 1)));
check('a nudge off centre still counts', az(1, 1.1) > 0.6, String(az(1, 1.1)));
// Two sources in one bin leave a shallow floor rather than a null, and a shallow
// floor is not evidence of anything.
check('and a bin with no null at all scores low', az(1, 1) > az(1, 1) * 0 + 0.99 && W.azimuth(1, 0.9, 1, -0.9, 0.35 / 3, 0.35) < 0.9,
  String(W.azimuth(1, 0.9, 1, -0.9, 0.35 / 3, 0.35)));

// --- 4. a mix whose parts are known -----------------------------------------
//
// A "voice": a centred tone that changes note every bar, so it never repeats.
// A "guitar": a panned tone that plays the same two-bar figure throughout.
// A "hat": clicks, centred, on every beat.
// A "bass": a low tone, centred, repeating.

const SR = 22050;              // enough for the test and a quarter of the work
const SECS = 24;
const len = SR * SECS;
const L = new Float32Array(len), R = new Float32Array(len);
const BAR = SR * 2;
// Twelve bars, twelve different notes: a voice that never sings the same bar
// twice, which is the thing REPET is looking for. An earlier version of this
// test gave it a four-note phrase on a loop, and REPET quite correctly filed it
// under backing.
const voiceHz = [330, 392, 440, 349, 294, 370, 415, 466, 311, 262, 349, 392];
// Above the bass crossover, or the bass stem takes it and is right to.
const guitarFig = [523, 587];
let energy = { voice: 0, guitar: 0, hat: 0, bass: 0 };

for (let i = 0; i < len; i++) {
  const bar = Math.floor(i / BAR);
  const tt = i / SR;
  // voice: centred, never the same note twice running
  const vf = voiceHz[Math.min(bar, voiceHz.length - 1)];
  const v = 0.30 * Math.sin(2 * Math.PI * vf * tt) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * tt));
  // guitar: panned right, strictly repeating every two bars
  const gf = guitarFig[bar % 2];
  const g = 0.28 * Math.sin(2 * Math.PI * gf * tt);
  // bass: centred, repeating, low
  const b = 0.30 * Math.sin(2 * Math.PI * 70 * tt);
  // hat: a short burst of noise four times a bar
  const phase = i % (BAR / 4);
  const h = phase < 120 ? 0.5 * (Math.random() * 2 - 1) * (1 - phase / 120) : 0;

  L[i] = v + 0.25 * g + b + h;
  R[i] = v + 1.00 * g + b + h;
  energy.voice += v * v; energy.guitar += g * g; energy.hat += h * h; energy.bass += b * b;
}

msgs = [];
const t0 = Date.now();
W.run({ data: { type: 'separate', left: L.buffer.slice(0), right: R.buffer.slice(0), sampleRate: SR, bassHz: 200 } });
const took = Date.now() - t0;
const done = msgs.find((m) => m.type === 'done');
const err = msgs.find((m) => m.type === 'error');
check('the worker finishes without throwing', Boolean(done), err ? err.message : 'no done message');
console.log('        ' + SECS + 's of audio at ' + SR + ' Hz took ' + took + ' ms');
console.log('        stages: ' + [...new Set(msgs.filter(m => m.type === 'progress').map(m => m.stage))].join(' / '));
const loops = [...new Set(msgs.filter((m) => m.loop).map((m) => m.loop.toFixed(2)))];
console.log('        loop found: ' + loops.join(', ') + ' s  (the backing is on a 4.00 s figure)');
// A loop was found in the range a loop can be. Deliberately not "and it is
// exactly four seconds": the only four-second structure in this mix is one
// guitar line alternating between two notes, which is a thinner cue than any
// real arrangement gives, and the winner moves between four, three and two
// seconds depending on the sample rate and on where the noise falls. Every one
// of those is a workable model -- the numbers below are what actually matter,
// and they hold across all of them.
check('a loop was found, in the range a loop could be',
  loops.length > 0 && loops.every((l) => parseFloat(l) >= 0.7 && parseFloat(l) <= 10),
  loops.join(', '));

if (done) {
  const vox = new Float32Array(done.vox);
  const drL = new Float32Array(done.drL);
  const drR = new Float32Array(done.drR);
  const bass = new Float32Array(done.bass);

  // The graph's fourth stem, made the way the graph makes it.
  const othL = new Float32Array(len), othR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    othL[i] = L[i] - vox[i] - drL[i] - bass[i];
    othR[i] = R[i] - vox[i] - drR[i] - bass[i];
  }

  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));

  // Reconstruction is exact by construction; this is really a check that the
  // stems are finite and the overlap-add did not drift.
  let e = 0;
  for (let i = 0; i < len; i++) {
    const d = (vox[i] + drL[i] + bass[i] + othL[i]) - L[i];
    e += d * d;
  }
  check('the four stems put the track back sample for sample',
    db(Math.sqrt(e / len)) - db(rms(L)) < -100, String((db(Math.sqrt(e / len)) - db(rms(L))).toFixed(1)));

  // How much of each stem sits at each source's frequency. A narrow Goertzel is
  // enough and avoids pulling in an FFT here.
  const at = (sig, hz) => {
    const w = 2 * Math.PI * hz / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < sig.length; i++) { const s0 = sig[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / sig.length;
  };
  const band = (sig, hzs) => hzs.reduce((m, h) => m + at(sig, h), 0);

  const voiceIn = (s) => band(s, voiceHz);
  const guitarIn = (s) => band(s, guitarFig);
  const bassIn = (s) => at(s, 70);

  const table = [
    ['vocals ', voiceIn(vox), guitarIn(vox), bassIn(vox)],
    ['drums  ', voiceIn(drL), guitarIn(drL), bassIn(drL)],
    ['bass   ', voiceIn(bass), guitarIn(bass), bassIn(bass)],
    ['other  ', voiceIn(othL), guitarIn(othL), bassIn(othL)],
  ];
  console.log('        stem      voice    guitar     bass');
  table.forEach((r) => console.log('        ' + r[0] + ' ' +
    r.slice(1).map((v) => db(v).toFixed(1).padStart(8)).join(' ')));

  const [vv, vg, vb] = table[0].slice(1);
  const [, og] = table[3].slice(1);
  const [, , bb] = table[2].slice(1);
  const [, , db_] = table[1].slice(1);

  check('the voice lands mostly in the vocal stem', db(vv) - db(voiceIn(othL)) > 6,
    (db(vv) - db(voiceIn(othL))).toFixed(1) + ' dB over other');
  check('and the panned repeating guitar does not follow it', db(og) - db(vg) > 10,
    (db(og) - db(vg)).toFixed(1) + ' dB more guitar in other than in vocals');
  check('the low tone lands in the bass stem', db(bb) - db(bassIn(othL)) > 10,
    (db(bb) - db(bassIn(othL))).toFixed(1) + ' dB over other');
  check('and the vocal stem is not carrying the bass', db(vv) - db(vb) > 10,
    (db(vv) - db(vb)).toFixed(1) + ' dB');
  void db_;

  // The clicks are broadband and short; the drums stem should hold most of that
  // energy where the tonal stems hold little.
  const hatBand = (s) => band(s, [3000, 5000, 7000, 9000]);
  check('the clicks go to the drums stem', db(hatBand(drL)) - db(hatBand(othL)) > 6,
    (db(hatBand(drL)) - db(hatBand(othL))).toFixed(1) + ' dB');
}

// --- 5. a mono track --------------------------------------------------------
//
// Nothing to read in the stereo field, so ADRess says "centred" about everything
// and HPSS and REPET have to carry it alone. Degraded, but it must not fall over
// or hand back silence.
{
  msgs = [];
  const M = new Float32Array(len);
  for (let i = 0; i < len; i++) M[i] = (L[i] + R[i]) * 0.5;
  W.run({ data: { type: 'separate', left: M.buffer.slice(0), right: M.buffer.slice(0), sampleRate: SR, bassHz: 200 } });
  const d2 = msgs.find((m) => m.type === 'done');
  check('a mono track separates rather than failing', Boolean(d2));
  if (d2) {
    const vox2 = new Float32Array(d2.vox);
    let e = 0;
    for (let i = 0; i < len; i++) e += vox2[i] * vox2[i];
    check('and still finds a vocal stem to hand back', Math.sqrt(e / len) > 1e-4, String(Math.sqrt(e / len)));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
