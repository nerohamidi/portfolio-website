// The signal playground. Three waves are drawn on one canvas, each in time or in
// frequency; they can be combined by adding, subtracting or convolving, and any
// of them can be sounded as a tone.

(function () {
  var TAU = 2 * Math.PI;
  // The sliders run from 0.1 to 1 Hz, slow enough to watch. A tone is the same
  // number a thousand times faster, so it can be heard.
  var TONE_SCALE = 1000;
  var OPS = ['+', '−', '∗'];      // add, subtract, convolve
  var DASHES = [[], [6, 4], [2, 3]];        // how W1, W2 and W3 are told apart when overlaid
  var TIME_ROW = 110;                       // canvas pixels for a wave drawn in time
  var FREQ_ROW = 200;                       // and for one drawn in frequency

  var canvas = document.getElementById('scope');
  var ctx = canvas.getContext('2d');
  var combineOn = document.getElementById('combine-on');
  var combineView = document.getElementById('combine-view');
  var combineTone = document.getElementById('combine-tone');
  var opButtons = document.querySelectorAll('#combine .op');

  // One record per wave: its controls, and its oscillator while a tone sounds.
  var waves = Array.prototype.map.call(document.querySelectorAll('.wave'), function (box, i) {
    var w = {
      name: 'W' + (i + 1),
      on: box.querySelector('.on'),
      freq: box.querySelector('.freq'),
      amp: box.querySelector('.amp'),
      type: box.querySelector('.type'),
      view: box.querySelector('.view'),
      tone: box.querySelector('.tone'),
      outputs: box.querySelectorAll('output'),
      osc: null,
      gain: null
    };
    w.freq.addEventListener('input', function () { showValues(w); retune(w); rebuildCombinedTone(); });
    w.amp.addEventListener('input', function () { showValues(w); retune(w); rebuildCombinedTone(); });
    w.type.addEventListener('change', function () { retune(w); rebuildCombinedTone(); });
    w.on.addEventListener('change', rebuildCombinedTone);
    w.view.addEventListener('click', function () { toggle(w.view); });
    w.tone.addEventListener('click', function () { toggleTone(w); });
    showValues(w);
    return w;
  });

  var ops = ['+', '+'];       // between W1 and W2, and between W2 and W3
  var audio = null;           // the AudioContext, made on the first tone
  var combinedSource = null;  // the combined tone, while it sounds
  var startTime = performance.now();

  function pressed(button) { return button.getAttribute('aria-pressed') === 'true'; }

  function toggle(button) {
    var on = !pressed(button);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.textContent = button.textContent.replace(on ? 'frequency' : 'time', on ? 'time' : 'frequency');
    return on;
  }

  function showValues(w) {
    w.outputs[0].value = Number(w.freq.value).toFixed(2) + ' Hz';
    w.outputs[1].value = Number(w.amp.value).toFixed(2);
  }

  function isOn(w) { return w.on.checked; }
  function freqOf(w) { return Number(w.freq.value); }
  function ampOf(w) { return Number(w.amp.value); }

  // --- the maths ---------------------------------------------------------------

  // One sample of a unit wave at a given angle.
  function shape(type, angle) {
    var p = ((angle % TAU) + TAU) % TAU;
    switch (type) {
      case 'cos': return Math.cos(angle);
      case 'square': return p < Math.PI ? 1 : -1;
      case 'sawtooth': return p / Math.PI - 1;
      case 'triangle': return p < Math.PI ? 2 * p / Math.PI - 1 : 3 - 2 * p / Math.PI;
      default: return Math.sin(angle);
    }
  }

  // The Fourier series of each shape: which multiples of the fundamental it
  // holds, how strong, and at what phase. Only the first `count` are returned.
  function harmonics(type, amp, count) {
    var out = [];
    var n, sign;
    switch (type) {
      case 'cos':
        out.push({ n: 1, mag: amp, phase: 0 });
        break;
      case 'square':
        for (n = 1; n <= count; n += 2) out.push({ n: n, mag: amp * 4 / (n * Math.PI), phase: -Math.PI / 2 });
        break;
      case 'sawtooth':
        for (n = 1; n <= count; n++) {
          sign = n % 2 ? 1 : -1;
          out.push({ n: n, mag: amp * 2 / (n * Math.PI), phase: sign * -Math.PI / 2 });
        }
        break;
      case 'triangle':
        for (n = 1; n <= count; n += 2) {
          sign = ((n - 1) / 2) % 2 ? -1 : 1;
          out.push({ n: n, mag: amp * 8 / (n * n * Math.PI * Math.PI), phase: sign * -Math.PI / 2 });
        }
        break;
      default:
        out.push({ n: 1, mag: amp, phase: -Math.PI / 2 });
    }
    return out;
  }

  function wrapPhase(phase) {
    while (phase > Math.PI) phase -= TAU;
    while (phase < -Math.PI) phase += TAU;
    return phase;
  }

  function phaseLabel(phase) {
    var p = wrapPhase(phase);
    var quarters = Math.round(p / (Math.PI / 4));
    if (Math.abs(p - quarters * Math.PI / 4) > 0.01) return (p / Math.PI).toFixed(2) + 'π';
    var names = { 0: '0', 1: 'π/4', 2: 'π/2', 3: '3π/4', 4: 'π' };
    return (quarters < 0 ? '−' : '') + names[Math.abs(quarters)];
  }

  // Linear convolution of two arrays, trimmed to the length of the first and
  // scaled back to the first one's peak, so the result stays in the same units
  // as its inputs. Both inputs here are a screen or a period wide.
  function convolve(a, b) {
    var full = new Float32Array(a.length + b.length - 1);
    var i, j;
    for (i = 0; i < a.length; i++) {
      for (j = 0; j < b.length; j++) full[i + j] += a[i] * b[j];
    }
    var start = Math.floor(b.length / 2);
    var out = full.subarray(start, start + a.length);
    var peakIn = 0, peakOut = 0;
    for (i = 0; i < a.length; i++) peakIn = Math.max(peakIn, Math.abs(a[i]));
    for (i = 0; i < out.length; i++) peakOut = Math.max(peakOut, Math.abs(out[i]));
    if (peakOut > 0) for (i = 0; i < out.length; i++) out[i] *= peakIn / peakOut;
    return out;
  }

  // Runs W1 op W2 op W3 over sample arrays, skipping waves that are off. `make`
  // returns the samples of one wave, or null if it is off.
  function combineSamples(make) {
    var result = null;
    waves.forEach(function (w, i) {
      var samples = make(w, i);
      if (!samples) return;
      if (!result) { result = samples; return; }
      var op = ops[i - 1];
      if (op === '∗') { result = convolve(result, samples); return; }
      var out = new Float32Array(Math.max(result.length, samples.length));
      var sign = op === '+' ? 1 : -1;
      for (var k = 0; k < out.length; k++) {
        out[k] = result[k % result.length] + sign * samples[k % samples.length];
      }
      result = out;
    });
    return result;
  }

  // --- drawing -------------------------------------------------------------------

  var colours = { fg: '#111', muted: '#666', line: '#ccc' };

  function readColours() {
    var style = getComputedStyle(document.documentElement);
    colours.fg = style.getPropertyValue('--fg').trim() || colours.fg;
    colours.muted = style.getPropertyValue('--muted').trim() || colours.muted;
    colours.line = style.getPropertyValue('--line').trim() || colours.line;
  }
  readColours();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColours);

  function text(str, x, y, align, colour) {
    ctx.fillStyle = colour || colours.muted;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = align || 'left';
    ctx.fillText(str, x, y);
  }

  // The samples of one wave across the screen at time t, as pixels of deflection.
  function timeSamples(w, width, rowHeight, t) {
    var f = freqOf(w);
    var cycles = f * 10;                       // 0.1 Hz fits one cycle on screen, 1 Hz ten
    var scale = rowHeight * 0.2 * ampOf(w);
    var out = new Float32Array(width + 1);
    for (var x = 0; x <= width; x++) {
      out[x] = scale * shape(w.type.value, TAU * cycles * x / width - TAU * f * t);
    }
    return out;
  }

  function drawTime(samples, top, rowHeight, width, dash, lineWidth) {
    var mid = top + rowHeight / 2;
    ctx.strokeStyle = colours.line;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    ctx.strokeStyle = colours.fg;
    ctx.lineWidth = lineWidth || 1.5;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    for (var x = 0; x <= width; x++) {
      var y = mid - samples[x];
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // A frequency axis from -1 to 1 Hz, drawn at y, with its ticks.
  function drawAxis(y, width, label) {
    var margin = 30;
    var pxPerHz = (width - 2 * margin) / 2;
    var centre = width / 2;
    ctx.strokeStyle = colours.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, y);
    ctx.lineTo(width - margin, y);
    for (var f = -1; f <= 1.001; f += 0.25) {
      var x = centre + f * pxPerHz;
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + 3);
    }
    ctx.stroke();
    text('-1', centre - pxPerHz, y + 14, 'center');
    text('0', centre, y + 14, 'center');
    text('1 Hz', centre + pxPerHz, y + 14, 'center');
    text(label, width - margin, y - 6, 'right');
    return { centre: centre, pxPerHz: pxPerHz, margin: margin };
  }

  // Magnitude spikes above one axis and phase stems on another, for a list of
  // { n, mag, phase } harmonics of a fundamental at `f` Hz.
  function drawSpectrum(items, f, sign, top, rowHeight, width, dash, showLabels) {
    var magAxis = top + rowHeight * 0.5;
    var phaseAxis = top + rowHeight * 0.85;
    var spikeScale = Math.min(60, rowHeight * 0.32);
    var stemScale = rowHeight * 0.1;
    var axis = drawAxis(magAxis, width, '|X(f)|');
    drawAxis(phaseAxis, width, '∠X(f)');
    text('±π', axis.margin - 4, phaseAxis - stemScale + 4, 'right');

    ctx.setLineDash(dash || []);
    items.forEach(function (h, k) {
      var hz = f * h.n;
      var right = axis.centre + hz * axis.pxPerHz;
      var left = axis.centre - hz * axis.pxPerHz;
      if (right > width - axis.margin) return;
      var height = Math.min(spikeScale * h.mag, rowHeight * 0.45);
      var phase = wrapPhase(h.phase + (sign < 0 ? Math.PI : 0));

      ctx.strokeStyle = colours.fg;
      ctx.lineWidth = k === 0 ? 2 : 1.2;
      [right, left].forEach(function (x, side) {
        ctx.beginPath();
        ctx.moveTo(x, magAxis);
        ctx.lineTo(x, magAxis - height);
        ctx.stroke();
        // A real signal's spectrum is symmetric in magnitude and odd in phase.
        var ph = side ? -phase : phase;
        var stem = phaseAxis - (ph / Math.PI) * stemScale;
        ctx.beginPath();
        ctx.moveTo(x, phaseAxis);
        ctx.lineTo(x, stem);
        ctx.stroke();
        ctx.fillStyle = colours.fg;
        ctx.beginPath();
        ctx.arc(x, stem, 2.5, 0, TAU);
        ctx.fill();
        if (showLabels && k < 3) {
          text(h.mag.toFixed(2), x, magAxis - height - 5, 'center', colours.fg);
          text((side ? '-' : '') + hz.toFixed(2), x, magAxis + 14, 'center', colours.fg);
          text(phaseLabel(ph), x, ph >= 0 ? stem - 6 : stem + 14, 'center', colours.fg);
        }
      });
    });
    ctx.setLineDash([]);
  }

  function draw() {
    var t = (performance.now() - startTime) / 1000;
    var showCombined = combineOn.checked;
    var rows = waves.map(function (w) { return pressed(w.view) ? FREQ_ROW : TIME_ROW; });
    if (showCombined) rows.push(pressed(combineView) ? FREQ_ROW : TIME_ROW);
    var height = rows.reduce(function (a, b) { return a + b; }, 0);

    var width = canvas.clientWidth;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = height + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    var top = 0;
    waves.forEach(function (w, i) {
      var rowHeight = rows[i];
      if (i) {
        ctx.strokeStyle = colours.line;
        ctx.beginPath();
        ctx.moveTo(0, top);
        ctx.lineTo(width, top);
        ctx.stroke();
      }
      text(w.name + (isOn(w) ? '' : ' (off)'), 8, top + 14, 'left', colours.fg);
      if (isOn(w)) {
        if (pressed(w.view)) {
          drawSpectrum(harmonics(w.type.value, ampOf(w), 15), freqOf(w), 1, top, rowHeight, width, [], true);
        } else {
          drawTime(timeSamples(w, width, rowHeight, t), top, rowHeight, width);
        }
      }
      top += rowHeight;
    });

    if (!showCombined) return;
    var rowHeight = rows[3];
    ctx.strokeStyle = colours.line;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(width, top);
    ctx.stroke();
    var names = waves.map(function (w, i) { return (i ? ' ' + ops[i - 1] + ' ' : '') + w.name; }).join('');
    text(names, 8, top + 14, 'left', colours.fg);

    if (pressed(combineView)) {
      // Each wave's lines, overlaid, with a subtracted wave's phase turned by π.
      // Convolution would multiply the spectra; it is drawn the same way here.
      waves.forEach(function (w, i) {
        if (!isOn(w)) return;
        var sign = i && ops[i - 1] === '−' ? -1 : 1;
        drawSpectrum(harmonics(w.type.value, ampOf(w), 15), freqOf(w), sign, top, rowHeight, width, DASHES[i], false);
        text(w.name, 8, top + 30 + i * 14, 'left', colours.fg);
        ctx.setLineDash(DASHES[i]);
        ctx.strokeStyle = colours.fg;
        ctx.beginPath();
        ctx.moveTo(34, top + 26 + i * 14);
        ctx.lineTo(70, top + 26 + i * 14);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    } else {
      var samples = combineSamples(function (w) {
        return isOn(w) ? timeSamples(w, width, rowHeight, t) : null;
      });
      if (samples) drawTime(samples, top, rowHeight, width, [], 2.5);
    }
  }

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }

  // --- tones -------------------------------------------------------------------

  function ensureAudio() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function oscType(type) { return type === 'sin' || type === 'cos' ? 'sine' : type; }

  function toggleTone(w) {
    if (w.osc) {
      w.osc.stop();
      w.osc.disconnect();
      w.gain.disconnect();
      w.osc = null;
      w.gain = null;
      w.tone.setAttribute('aria-pressed', 'false');
      return;
    }
    ensureAudio();
    w.osc = audio.createOscillator();
    w.gain = audio.createGain();
    w.osc.connect(w.gain);
    w.gain.connect(audio.destination);
    retune(w);
    w.osc.start();
    w.tone.setAttribute('aria-pressed', 'true');
  }

  // Keeps a sounding tone in step with its sliders.
  function retune(w) {
    if (!w.osc) return;
    w.osc.type = oscType(w.type.value);
    w.osc.frequency.value = freqOf(w) * TONE_SCALE;
    w.gain.gain.value = ampOf(w) * 0.15;
  }

  // One period of each wave at the audio rate, combined the same way the picture is.
  function combinedBuffer() {
    var rate = audio.sampleRate;
    var samples = combineSamples(function (w) {
      if (!isOn(w)) return null;
      var f = freqOf(w) * TONE_SCALE;
      var n = Math.round(rate / f);
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) out[i] = ampOf(w) * shape(w.type.value, TAU * f * i / rate);
      return out;
    });
    if (!samples) return null;
    var buffer = audio.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  function stopCombinedTone() {
    if (!combinedSource) return;
    combinedSource.stop();
    combinedSource.disconnect();
    combinedSource = null;
    combineTone.setAttribute('aria-pressed', 'false');
  }

  function startCombinedTone() {
    ensureAudio();
    var buffer = combinedBuffer();
    if (!buffer) return;
    var gain = audio.createGain();
    gain.gain.value = 0.15;
    combinedSource = audio.createBufferSource();
    combinedSource.buffer = buffer;
    combinedSource.loop = true;
    combinedSource.connect(gain);
    gain.connect(audio.destination);
    combinedSource.start();
    combineTone.setAttribute('aria-pressed', 'true');
  }

  function rebuildCombinedTone() {
    if (!combinedSource) return;
    stopCombinedTone();
    startCombinedTone();
  }

  // --- wiring ------------------------------------------------------------------

  Array.prototype.forEach.call(opButtons, function (button, i) {
    button.addEventListener('click', function () {
      ops[i] = OPS[(OPS.indexOf(ops[i]) + 1) % OPS.length];
      button.textContent = ops[i];
      rebuildCombinedTone();
    });
  });

  combineOn.addEventListener('change', function () {
    if (!combineOn.checked) stopCombinedTone();
  });
  combineView.addEventListener('click', function () { toggle(combineView); });
  combineTone.addEventListener('click', function () {
    if (combinedSource) stopCombinedTone();
    else if (combineOn.checked) startCombinedTone();
  });

  loop();
})();
