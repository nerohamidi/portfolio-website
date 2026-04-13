---
layout: page
title: Projects
permalink: /projects/
---

Most of these projects are on my GitHub, but for some of them I was not able to publish them due to rules from the class. Feel free to email me to learn more about any of my projects.

<div class="project-filters" role="group" aria-label="Project category filters">
  <button type="button" class="project-filter-btn is-active" data-filter="all">All</button>
  <button type="button" class="project-filter-btn" data-filter="software">Software</button>
  <button type="button" class="project-filter-btn" data-filter="ml">ML</button>
  <button type="button" class="project-filter-btn" data-filter="hardware">Hardware</button>
  <button type="button" class="project-filter-btn" data-filter="dsp">DSP</button>
  <button type="button" class="project-filter-btn" data-filter="hwsw">HW/SW Systems</button>
</div>

<div class="project-list">

<article class="project-card" data-categories="hardware dsp hwsw software">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Real-Time Audio Spectrum Analyzer</h2>
      <p class="project-tags"><em>C · STM32 ARM MCU · HW Design/Validation · DSP</em></p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Designed and integrated a single-supply (9 V) mixed-signal hardware platform from scratch: gain-controlled mic preamp, 5-pole 5 kHz Butterworth anti-aliasing filter, ADC re-biasing circuit, and an analog clipping detector with LED indication.</li>
      <li>Developed bare-metal embedded C firmware using DMA-driven 12-bit ADC sampling at 10 kHz for deterministic, low-latency signal acquisition.</li>
      <li>Implemented and validated a floating-point FFT pipeline with IIR low-pass filtering using CMSIS-DSP and the MCU FPU.</li>
      <li>Diagnosed analog front-end deviations from SPICE simulation by systematically probing the signal chain with an oscilloscope; resolved the discrepancy by replacing electrolytic capacitors with ceramic to eliminate leakage current effects.</li>
      <li>Verified timing, voltage, and signal behavior using datasheets and lab instrumentation (oscilloscope, power supply, multimeter).</li>
    </ul>
    <div class="project-media">
      <object class="project-pdf" data="{{ '/assets/images/projects/audio_spectrum_image.pdf' | relative_url }}" type="application/pdf">
        <a href="{{ '/assets/images/projects/audio_spectrum_image.pdf' | relative_url }}" target="_blank" rel="noopener">View schematic PDF</a>
      </object>
    </div>
  </div>
</article>

<article class="project-card" data-categories="software hwsw hardware">
  <div class="project-head">
    <div class="project-head-text">
      <h2>Real-Time Camera Metric Pipeline</h2>
      <p class="project-tags"><em>Modern C++ OOP · Embedded Linux · ARM · Prometheus · Grafana</em></p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Built a modular, object-oriented C++ telemetry service on embedded Linux using polymorphic class design to expose live camera and system metrics via a 15-second Prometheus scrape interval.</li>
      <li>Integrated a Raspberry Pi camera sensor for continuous stream health monitoring during extended operation.</li>
      <li>Designed Grafana dashboards and alerting rules to detect anomalies such as frame stalls and bandwidth drops during deployments.</li>
      <li>Deployed and validated the system across heterogeneous ARM platforms (Raspberry Pi 5, Arduino Uno R4/Q) using Git-based, command-line driven workflows, iterating on reliability through metric-driven debugging.</li>
    </ul>
    <div class="project-media">
      <div class="project-video">
        <iframe src="https://drive.google.com/file/d/1CeahDCygqzYuBNiazsKlBZ-9BN5L3j2f/preview" allow="autoplay" allowfullscreen title="Camera metric pipeline demo"></iframe>
      </div>
    </div>
  </div>
</article>

<article class="project-card" data-categories="dsp software hwsw">
  <div class="project-head">
    <div class="project-head-text">
      <h2>LiDAR &amp; Multi-Sensor SLAM for Differential-Drive Robot</h2>
      <p class="project-tags"><em>Python · C++ · Sensors · DSP</em></p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Built a SLAM pipeline for a differential-drive robot using 1081-beam LiDAR scans.</li>
      <li>Processed raw LiDAR range measurements into Cartesian point clouds via calibration and coordinate transforms.</li>
      <li>Registered consecutive scans using 2D Iterative Closest Point (ICP) with MSE-based convergence criteria to estimate relative motion.</li>
      <li>Fused wheel odometry with scan-matching constraints through nonlinear least-squares optimization (GTSAM) for improved state estimation and trajectory consistency.</li>
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
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Implemented a delta modulation (DPCM) encoder/decoder in MATLAB: generated bi-level DM signals, reconstructed audio via accumulation and low-pass filtering, and analyzed compression-fidelity tradeoffs at various step sizes.</li>
      <li>Verified the Nyquist sampling theorem using hardware signal chains (pulse generator, analog switch, LPF reconstruction), identifying aliasing onset by sweeping message frequency beyond f<sub>s</sub>/2.</li>
      <li>Built PLL-based and zero-crossing FM demodulators using VCOs, comparators, and tunable LPFs.</li>
      <li>Implemented a digital quadrature FM demodulator in MATLAB using I/Q mixing, LPF, and an arctangent discriminator with a 32-tap FIR filter.</li>
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
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Designed a multi-mode digital clock in Verilog featuring BCD counters, a clock divider, a time-multiplexed 7-segment display driver, and alarm comparator logic.</li>
      <li>Synthesized and verified the full design on Basys 3 FPGA hardware, validating mode transitions and timing behavior on real silicon.</li>
    </ul>
    <div class="project-gallery">
      <a class="project-thumb" href="{{ '/assets/images/projects/dig_clock_img.png' | relative_url }}">
        <img src="{{ '/assets/images/projects/dig_clock_img.png' | relative_url }}" alt="Digital clock on Basys 3 FPGA" loading="lazy">
      </a>
    </div>
  </div>
</article>

<article class="project-card" data-categories="ml software dsp">
  <div class="project-head">
    <div class="project-head-text">
      <h2>OCR ML Model Robustness Evaluation</h2>
      <p class="project-tags"><em>Python · MATLAB · PyTorch · DSP</em></p>
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Designed an automated Python evaluation pipeline to benchmark transformer-based OCR models (TrOCR, PARSeq) on 200+ real-world image samples across three distortion types, computing character error rate (CER) and word error rate (WER).</li>
      <li>Built and compared six preprocessing pipelines — including CNN-based dehazing (DehazeNet), Wiener-filter super-resolution (WSD-SR), and combined multi-stage approaches — to quantify their impact on model robustness.</li>
      <li>Analyzed results to identify that visually similar restoration techniques failed due to non-linear distortion geometry and missing atmospheric priors.</li>
      <li>Co-authored a 10-page technical report with quantitative tables, qualitative visual comparisons, and actionable recommendations; presented findings to faculty and peers.</li>
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
    </div>
    <button type="button" class="project-toggle" aria-expanded="false">
      <span class="project-toggle-label">Details</span>
      <span class="project-toggle-icon" aria-hidden="true">+</span>
    </button>
  </div>
  <div class="project-body" hidden>
    <ul>
      <li>Implemented LASSO regression via ISTA from scratch in NumPy, tuning regularization across a sweep of λ values and evaluating precision, recall, and fitting loss to select optimal sparsity-accuracy tradeoffs.</li>
      <li>Applied the LASSO model to a real-world GWAS dataset (1,279 features, 539 samples) using Pandas and scikit-learn for data loading, preprocessing, and train/validation/test splitting.</li>
      <li>Implemented core ML algorithms from first principles in NumPy: PCA for dimensionality reduction on image data, K-means clustering with custom centroid initialization and convergence logic, and a 2-layer neural network with manual forward/backward propagation and gradient descent.</li>
      <li>Trained and evaluated deep learning models in PyTorch: a CNN classifier on 60K MNIST samples, an LSTM sequence model for multi-class language prediction across 18 categories, and a CBOW word embedding model.</li>
      <li>Applied pre-trained transformer models (BERT) via HuggingFace for tokenization and feature extraction, gaining practical experience with modern NLP architectures.</li>
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
