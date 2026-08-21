---
layout: page
title: Projects
permalink: /projects/
---

Most of these projects are on my GitHub; a few stay private because of course rules. Email me if you want to hear more about any of them.

<div class="project-filters" role="group" aria-label="Project category filters">
  <button type="button" class="project-filter-btn is-active" data-filter="all">All</button>
  <button type="button" class="project-filter-btn" data-filter="software">Software</button>
  <button type="button" class="project-filter-btn" data-filter="ml">ML</button>
  <button type="button" class="project-filter-btn" data-filter="hardware">Hardware</button>
  <button type="button" class="project-filter-btn" data-filter="dsp">DSP</button>
  <button type="button" class="project-filter-btn" data-filter="hwsw">HW/SW Systems</button>
</div>

<div class="project-list">

<article class="project-card" data-categories="ml software dsp">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Adaptive Kalman Filtering for Market Microstructure Noise</h2>
      <p class="project-tags"><em>Python · NumPy · SciPy · pandas · Estimation Theory</em></p>
      <p class="project-summary">Crypto prices jitter every second with noise that hides the real price. This project builds a statistical filter that tracks the underlying price of Bitcoin and Ethereum through that noise, then tests whether the estimate is good enough to trade on.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Wrote a Kalman filter from scratch in Python and fit its noise parameters to 45 million price updates by maximum likelihood.</li>
      <li>Real data broke the textbook assumption that noise looks the same at every moment, so the filter re-estimates its noise level as market volatility shifts. The adaptive version fit months of unseen data far better on both coins.</li>
      <li>94 automated tests check the code against exact hand-derived solutions.</li>
      <li>Backtested a mean-reversion trading signal on 5 held-out months with realistic costs: the edge (about 0.1 basis points per trade) was smaller than the cost of trading (about 0.5), so the signal would not make money in practice.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/kalman_signature.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/kalman_signature.png' | relative_url }}" alt="Realized-volatility signature plot for BTC and ETH" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/kalman_adaptive_btc.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/kalman_adaptive_btc.png' | relative_url }}" alt="Adaptive-Q Kalman filter diagnostics on BTC" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="ml dsp software">
  <div class="project-head">
    <div class="project-head-text">
      <h2>ECG Denoising at Negative SNR: LMMSE vs. Transformer</h2>
      <p class="project-tags"><em>Python · PyTorch · NumPy/SciPy · Statistical Signal Processing</em></p>
      <p class="project-summary">Heart-signal (ECG) recordings buried under noise louder than the signal itself. This project pits a classical statistical filter against a Transformer neural network to see how much of the heartbeat each can recover, where the network's advantage comes from, and what it costs to compute.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Tested both on standard MIT-BIH hospital recordings with noise added at −8.5 dB, meaning more noise energy than signal.</li>
      <li>The Transformer cut the error to under a tenth of the raw input (a 10.6 dB gain), 1.9 dB beyond the best causal classical filter.</li>
      <li>Also computed the ceiling for any linear filter. The network's remaining 24% margin comes from nonlinearity, not from seeing more context.</li>
      <li>The classical filter's strength is cost: 128 multiply-accumulate operations per sample against 34 million for the Transformer, roughly 265,000 times less compute to land within 1.9 dB of it. It is closed form, needs no training, and its coefficients can be read directly.</li>
      <li>Swept filter memory from 8 to 128 samples; a silent training collapse at 128 traced back to the learning rate, confirmed with 5 controlled runs.</li>
      <li>Spotted that the given normalization left the classical baseline unable to fit a nonzero mean, and derived the affine correction, worth 2.5 dB.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/ecg_waveforms.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/ecg_waveforms.png' | relative_url }}" alt="ECG denoising: noisy observation, LMMSE and Transformer estimates vs ground truth" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/ecg_nmse_sweep.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/ecg_nmse_sweep.png' | relative_url }}" alt="NMSE vs context length P for LMMSE and Transformer" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="hardware dsp hwsw software">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Real-Time Audio Spectrum Analyzer</h2>
      <p class="project-tags"><em>C · STM32 ARM MCU · HW Design/Validation · DSP</em></p>
      <p class="project-summary">A device that listens through a microphone and shows, live, which frequencies are in a sound and how strong they are. Built end to end: the analog circuit, the microcontroller firmware, and the signal processing in between.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Designed the analog front end from scratch on a single 9 V supply: a gain-controlled mic preamp, a 5-pole 5 kHz anti-aliasing filter, level shifting for the ADC, and an LED that warns when the input clips.</li>
      <li>Bare-metal C firmware captures audio at 10 kHz using DMA, keeping the timing deterministic.</li>
      <li>A floating-point FFT with IIR smoothing (CMSIS-DSP, on the chip's FPU) turns each batch of samples into a spectrum.</li>
      <li>When the built circuit disagreed with the SPICE simulation, probed the chain with an oscilloscope and traced it to leaky electrolytic capacitors. Ceramic replacements fixed it.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/audio_spectrum_image.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/audio_spectrum_image.png' | relative_url }}" alt="Audio spectrum analyzer schematic" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="software hwsw hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Real-Time Camera Metric Pipeline</h2>
      <p class="project-tags"><em>C++17 · Embedded Linux · Multithreading · TCP Sockets · Prometheus · Grafana</em></p>
      <p class="project-summary">A monitoring service that watches a Raspberry Pi camera around the clock and raises an alert when the video stream degrades.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>A C++17 exporter polls two Linux media servers over HTTP each second, differencing byte counters into rates.</li>
      <li>It serves them from a <code>/metrics</code> endpoint on raw TCP sockets. The poll loop and the socket server run on separate threads, with the shared snapshot behind a mutex so a scrape never reads a half-written update.</li>
      <li>Grafana dashboards chart the stream in real time. Alert rules make failure loud: a stalled stream shows up as a falling frame rate rather than a black screen.</li>
      <li>Deployed and debugged over SSH on Raspberry Pi 5 and Arduino Uno (R4 and Q) hardware.</li>
    </ul>
    <div class="project-media">
      <div class="project-video">
        <iframe src="https://drive.google.com/file/d/1CeahDCygqzYuBNiazsKlBZ-9BN5L3j2f/preview" allow="autoplay" allowfullscreen title="Camera metric pipeline demo"></iframe>
      </div>
    </div>
  </div>
</article>

<article class="project-card" data-categories="software ml">
  <div class="project-head">
    <div class="project-head-text">
      <h2>This Site &amp; Its Grounded LLM Chat Assistant</h2>
      <p class="project-tags"><em>JavaScript · Jekyll · Gemini API · Cloudflare Workers</em></p>
      <p class="project-summary">The site you're reading, plus the chatbot in the playroom that answers questions about my background. Calling the model was the easy part. The work was keeping it honest and keeping the API key out of the browser.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Shipped a browser chat UI that holds multi-turn history and is grounded on a curated profile, so the model says it doesn't know instead of inventing a job I never had.</li>
      <li>Moved the model API key off the client into a Cloudflare Worker proxy after realizing a build-time secret was still reaching users' browsers.</li>
      <li>The proxy gates requests by an origin allowlist and answers CORS preflight.</li>
      <li>Static Jekyll site on GitHub Pages. The filters, image lightbox, and the interactive signal playground are all vanilla JavaScript, no framework.</li>
    </ul>
  </div>
</article>

<article class="project-card" data-categories="dsp software hwsw">
  <div class="project-head">
    <div class="project-head-text">
      <h2>LiDAR &amp; Multi-Sensor SLAM for Differential-Drive Robot</h2>
      <p class="project-tags"><em>Python · C++ · Sensors · DSP</em></p>
      <p class="project-summary">Software that lets a two-wheeled robot work out where it is while building a map of its surroundings, using a spinning laser scanner (LiDAR).</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Turns raw laser ranges (1,081 beams per scan) into 2D point clouds through calibration and coordinate transforms.</li>
      <li>Estimates the robot's motion by aligning each new scan against the previous one (Iterative Closest Point).</li>
      <li>Fuses wheel odometry with the scan alignments in a nonlinear least-squares optimizer (GTSAM), so small errors don't snowball into a warped map.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/SLAM_img1.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/SLAM_img1.png' | relative_url }}" alt="SLAM point cloud visualization" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/SLAM_img2.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/SLAM_img2.png' | relative_url }}" alt="SLAM trajectory estimate" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="dsp hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Communication &amp; DSP Lab</h2>
      <p class="project-tags"><em>MATLAB · Lab Instrumentation · Analog/Digital Communications</em></p>
      <p class="project-summary">Hands-on labs building the core pieces of radio and audio communication systems, on bench hardware and in MATLAB.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Built a delta-modulation audio encoder/decoder in MATLAB and measured how step size trades compression against sound quality.</li>
      <li>Demonstrated the Nyquist sampling limit on real hardware, sweeping a signal's frequency upward until aliasing appeared past half the sampling rate.</li>
      <li>Built two FM radio demodulators from analog parts (one phase-locked-loop, one zero-crossing), then a fully digital version in MATLAB using I/Q mixing and an arctangent discriminator.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/comm_img1.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/comm_img1.png' | relative_url }}" alt="Communication lab figure 1" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/comm_img2.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/comm_img2.png' | relative_url }}" alt="Communication lab figure 2" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/comm_img3.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/comm_img3.png' | relative_url }}" alt="Communication lab figure 3" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/comm_img4.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/comm_img4.png' | relative_url }}" alt="Communication lab figure 4" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Digital Clock on FPGA</h2>
      <p class="project-tags"><em>Verilog · Basys 3 FPGA</em></p>
      <p class="project-summary">An alarm clock implemented not as software but as a digital logic circuit, written in Verilog and running on an FPGA.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Counters keep the time, a time-multiplexed driver runs the 7-segment display, and comparator logic fires the alarm.</li>
      <li>Synthesized and tested on a Basys 3 board, checking mode changes and timing on the real hardware.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/dig_clock_img.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/dig_clock_img.png' | relative_url }}" alt="Digital clock on Basys 3 FPGA" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Full Adder IC Design using Pseudo-NMOS Logic</h2>
      <p class="project-tags"><em>Cadence Virtuoso</em></p>
      <p class="project-summary">A 1-bit adder, one of the basic building blocks inside a processor, designed at the level of individual transistors: schematics, physical layout, and simulation.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Built the AND, OR, and XOR gates in pseudo-NMOS logic to keep the layout compact; every layout passed DRC and LVS checks with zero errors.</li>
      <li>The assembled adder simulated at 0.96 ns (carry) and 0.60 ns (sum) propagation delay, driving 50 fF loads at 5 V.</li>
    </ul>
  </div>
</article>

<article class="project-card" data-categories="hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Digital Integrated Circuit Design</h2>
      <p class="project-tags"><em>Cadence Virtuoso · Spectre · Verilog · 45nm CMOS PDK</em></p>
      <p class="project-summary">Coursework designing digital chips on a modern 45-nanometer process, from transistor sizing to physical layout.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Sizing inverters for symmetric switching, characterizing a ring oscillator across supply voltages, and optimizing logic gates with logical effort, all simulated in Cadence Spectre.</li>
      <li>Laying out standard cells in Virtuoso with DRC/LVS verification and post-layout extraction.</li>
    </ul>
  </div>
</article>

<article class="project-card" data-categories="ml software dsp">
  <div class="project-head">
    <div class="project-head-text">
      <h2>OCR ML Model Robustness Evaluation</h2>
      <p class="project-tags"><em>Python · MATLAB · PyTorch · DSP</em></p>
      <p class="project-summary">Modern AI models can read text from photos, until the photo is hazy, blurred, or shot through a wet lens. This project measures how much that damage hurts and whether image-restoration techniques actually help.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Shot a paired 100-image dataset: the same scenes clean, then through a water droplet on the camera lens.</li>
      <li>Scored two Transformer OCR models (TrOCR, PARSeq) on it by character and word error rate. Read accuracy fell from 0.93 to 0.63 under the droplet.</li>
      <li>CNN dehazing (DehazeNet) and Wiener-filter super-resolution, run alone and cascaded both ways, recovered none of it.</li>
      <li>Traced that to the restorations' assumptions: droplet blur is not linear motion blur, and an indoor scene has no haze to remove.</li>
      <li>Co-wrote a 10-page report and presented the findings to faculty.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/OCR_img1.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/OCR_img1.png' | relative_url }}" alt="OCR robustness evaluation figure 1" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/OCR_img2.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/OCR_img2.png' | relative_url }}" alt="OCR robustness evaluation figure 2" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="ml software">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Machine Learning Projects</h2>
      <p class="project-tags"><em>Python · NumPy · PyTorch · HuggingFace · Pandas · scikit-learn</em></p>
      <p class="project-summary">Course projects implementing the core machine-learning algorithms by hand in NumPy to understand the math, plus applied work in PyTorch and HuggingFace.</p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Wrote LASSO regression from scratch (via ISTA) and applied it to a real genetics dataset: 1,279 features, 539 samples.</li>
      <li>Implemented PCA, K-means, and a two-layer neural network with hand-coded backpropagation, all in plain NumPy.</li>
      <li>In PyTorch: a CNN digit classifier trained on 60K MNIST images, an LSTM sequence model classifying language across 18 categories, and a CBOW word-embedding model.</li>
      <li>Used pre-trained BERT through HuggingFace for tokenization and feature extraction.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/ML_proj_img1.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/ML_proj_img1.png' | relative_url }}" alt="ML project figure 1" loading="lazy">
      </a>
      <a class="project-thumb" href="{{ '/assets/images/projects/ML_proj_img2.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/ML_proj_img2.png' | relative_url }}" alt="ML project figure 2" loading="lazy">
      </a>
    </div>
  </div>
</article>

</div>

<div class="project-lightbox" id="project-lightbox" hidden>
  <button type="button" class="project-lightbox-close" aria-label="Close image">&times;</button>
  <img class="project-lightbox-img" alt="">
</div>

<script>
(function () {
  var buttons = document.querySelectorAll('.project-filter-btn');
  var cards = document.querySelectorAll('.project-card');
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var filter = btn.getAttribute('data-filter');
      buttons.forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      cards.forEach(function (card) {
        var cats = (card.getAttribute('data-categories') || '').split(/\s+/);
        var show = filter === 'all' || cats.indexOf(filter) !== -1;
        card.style.display = show ? '' : 'none';
      });
    });
  });

  var lightbox = document.getElementById('project-lightbox');
  var lightboxImg = lightbox ? lightbox.querySelector('.project-lightbox-img') : null;
  var lightboxClose = lightbox ? lightbox.querySelector('.project-lightbox-close') : null;

  function openLightbox(src, alt) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    if (!lightbox || !lightboxImg) return;
    lightbox.hidden = true;
    lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  document.querySelectorAll('.project-thumb').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var img = a.querySelector('img');
      openLightbox(a.getAttribute('href'), img ? img.alt : '');
    });
  });

  if (lightbox) {
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) closeLightbox();
    });
  }
  if (lightboxClose) {
    lightboxClose.addEventListener('click', closeLightbox);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
  });

  document.querySelectorAll('.project-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('.project-card');
      if (!card) return;
      var body = card.querySelector('.project-body');
      var icon = btn.querySelector('.project-toggle-icon');
      var label = btn.querySelector('.project-toggle-label');
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      var next = !expanded;
      btn.setAttribute('aria-expanded', String(next));
      if (body) body.hidden = !next;
      if (icon) icon.textContent = next ? '−' : '+';
      if (label) label.textContent = next ? 'Hide' : 'Details';
      card.classList.toggle('is-open', next);
    });
  });
})();
</script>
