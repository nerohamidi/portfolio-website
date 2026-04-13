---
layout: page
title: Projects
permalink: /projects/
---

Most of these projects are on my GitHub, but for some of them I was not able to publish them due to rules from the class. Feel free to email me to learn more about any of my projects.

<div class="project-filters" role="group" aria-label="Project category filters">
  <button type="button" class="project-filter-btn is-active" data-filter="all">All</button>
  <button type="button" class="project-filter-btn" data-filter="software">Software Projects</button>
  <button type="button" class="project-filter-btn" data-filter="ml">ML Projects</button>
  <button type="button" class="project-filter-btn" data-filter="hardware">Hardware Projects</button>
  <button type="button" class="project-filter-btn" data-filter="dsp">DSP</button>
  <button type="button" class="project-filter-btn" data-filter="hwsw">HW/SW Systems</button>
</div>

<div class="project-list">

<article class="project-card" data-categories="hardware dsp hwsw software">
  <h2>Real-Time Audio Spectrum Analyzer</h2>
  <p class="project-tags"><em>C · STM32 ARM MCU · HW Design/Validation · DSP</em></p>
  <ul>
    <li>Designed and integrated a single-supply (9 V) mixed-signal hardware platform from scratch: gain-controlled mic preamp, 5-pole 5 kHz Butterworth anti-aliasing filter, ADC re-biasing circuit, and an analog clipping detector with LED indication.</li>
    <li>Developed bare-metal embedded C firmware using DMA-driven 12-bit ADC sampling at 10 kHz for deterministic, low-latency signal acquisition.</li>
    <li>Implemented and validated a floating-point FFT pipeline with IIR low-pass filtering using CMSIS-DSP and the MCU FPU.</li>
    <li>Diagnosed analog front-end deviations from SPICE simulation by systematically probing the signal chain with an oscilloscope; resolved the discrepancy by replacing electrolytic capacitors with ceramic to eliminate leakage current effects.</li>
    <li>Verified timing, voltage, and signal behavior using datasheets and lab instrumentation (oscilloscope, power supply, multimeter).</li>
  </ul>
</article>

<article class="project-card" data-categories="software hwsw hardware">
  <h2>Real-Time Camera Metric Pipeline</h2>
  <p class="project-tags"><em>Modern C++ OOP · Embedded Linux · ARM · Prometheus · Grafana</em></p>
  <ul>
    <li>Built a modular, object-oriented C++ telemetry service on embedded Linux using polymorphic class design to expose live camera and system metrics via a 15-second Prometheus scrape interval.</li>
    <li>Integrated a Raspberry Pi camera sensor for continuous stream health monitoring during extended operation.</li>
    <li>Designed Grafana dashboards and alerting rules to detect anomalies such as frame stalls and bandwidth drops during deployments.</li>
    <li>Deployed and validated the system across heterogeneous ARM platforms (Raspberry Pi 5, Arduino Uno R4/Q) using Git-based, command-line driven workflows, iterating on reliability through metric-driven debugging.</li>
  </ul>
</article>

<article class="project-card" data-categories="dsp software hwsw">
  <h2>LiDAR &amp; Multi-Sensor SLAM for Differential-Drive Robot</h2>
  <p class="project-tags"><em>Python · C++ · Sensors · DSP</em></p>
  <ul>
    <li>Built a SLAM pipeline for a differential-drive robot using 1081-beam LiDAR scans.</li>
    <li>Processed raw LiDAR range measurements into Cartesian point clouds via calibration and coordinate transforms.</li>
    <li>Registered consecutive scans using 2D Iterative Closest Point (ICP) with MSE-based convergence criteria to estimate relative motion.</li>
    <li>Fused wheel odometry with scan-matching constraints through nonlinear least-squares optimization (GTSAM) for improved state estimation and trajectory consistency.</li>
  </ul>
</article>

<article class="project-card" data-categories="dsp hardware">
  <h2>Communication &amp; DSP Lab</h2>
  <p class="project-tags"><em>MATLAB · Lab Instrumentation · Analog/Digital Communications</em></p>
  <ul>
    <li>Implemented a delta modulation (DPCM) encoder/decoder in MATLAB: generated bi-level DM signals, reconstructed audio via accumulation and low-pass filtering, and analyzed compression-fidelity tradeoffs at various step sizes.</li>
    <li>Verified the Nyquist sampling theorem using hardware signal chains (pulse generator, analog switch, LPF reconstruction), identifying aliasing onset by sweeping message frequency beyond f<sub>s</sub>/2.</li>
    <li>Built PLL-based and zero-crossing FM demodulators using VCOs, comparators, and tunable LPFs.</li>
    <li>Implemented a digital quadrature FM demodulator in MATLAB using I/Q mixing, LPF, and an arctangent discriminator with a 32-tap FIR filter.</li>
  </ul>
</article>

<article class="project-card" data-categories="hardware">
  <h2>Digital Clock on FPGA</h2>
  <p class="project-tags"><em>Verilog · Basys 3 FPGA</em></p>
  <ul>
    <li>Designed a multi-mode digital clock in Verilog featuring BCD counters, a clock divider, a time-multiplexed 7-segment display driver, and alarm comparator logic.</li>
    <li>Synthesized and verified the full design on Basys 3 FPGA hardware, validating mode transitions and timing behavior on real silicon.</li>
  </ul>
</article>

<article class="project-card" data-categories="ml software dsp">
  <h2>OCR ML Model Robustness Evaluation</h2>
  <p class="project-tags"><em>Python · MATLAB · PyTorch · DSP</em></p>
  <ul>
    <li>Designed an automated Python evaluation pipeline to benchmark transformer-based OCR models (TrOCR, PARSeq) on 200+ real-world image samples across three distortion types, computing character error rate (CER) and word error rate (WER).</li>
    <li>Built and compared six preprocessing pipelines — including CNN-based dehazing (DehazeNet), Wiener-filter super-resolution (WSD-SR), and combined multi-stage approaches — to quantify their impact on model robustness.</li>
    <li>Analyzed results to identify that visually similar restoration techniques failed due to non-linear distortion geometry and missing atmospheric priors.</li>
    <li>Co-authored a 10-page technical report with quantitative tables, qualitative visual comparisons, and actionable recommendations; presented findings to faculty and peers.</li>
  </ul>
</article>

<article class="project-card" data-categories="ml software">
  <h2>Machine Learning Projects</h2>
  <p class="project-tags"><em>Python · NumPy · PyTorch · HuggingFace · Pandas · scikit-learn</em></p>
  <ul>
    <li>Implemented LASSO regression via ISTA from scratch in NumPy, tuning regularization across a sweep of λ values and evaluating precision, recall, and fitting loss to select optimal sparsity-accuracy tradeoffs.</li>
    <li>Applied the LASSO model to a real-world GWAS dataset (1,279 features, 539 samples) using Pandas and scikit-learn for data loading, preprocessing, and train/validation/test splitting.</li>
    <li>Implemented core ML algorithms from first principles in NumPy: PCA for dimensionality reduction on image data, K-means clustering with custom centroid initialization and convergence logic, and a 2-layer neural network with manual forward/backward propagation and gradient descent.</li>
    <li>Trained and evaluated deep learning models in PyTorch: a CNN classifier on 60K MNIST samples, an LSTM sequence model for multi-class language prediction across 18 categories, and a CBOW word embedding model.</li>
    <li>Applied pre-trained transformer models (BERT) via HuggingFace for tokenization and feature extraction, gaining practical experience with modern NLP architectures.</li>
  </ul>
</article>

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
})();
</script>
