---
layout: page
title: About
permalink: /about/
---

I'm an ECE graduate student at UC San Diego, graduating December 2027, interested in the mathematical foundations of statistical signal processing and machine learning. My work sits at the intersection of estimation theory, embedded systems, and ML. I like building things that process real-world signals under real-world constraints, and I care that every model I ship is one I can defend mathematically. I also work in digital IC design, applying circuit-level intuition from analog and digital coursework to implementing signal processing in silicon.

Based in San Diego, CA. U.S. Citizen.

**[nero.hamidi@gmail.com](mailto:nero.hamidi@gmail.com)** · [LinkedIn](https://www.linkedin.com/in/nero-hamidi) · [GitHub](https://github.com/nerohamidi)

---

## Experience

<div class="edu-list">

<div class="edu-entry">
  <div class="edu-school">Qualcomm</div>
  <div class="edu-degree">Software Engineering Intern — Algorithms / Data</div>
  <div class="edu-dates">Jun 2026 – Sep 2026</div>
  <ul>
    <li>Own the internal Python tool a Snapdragon chip design team uses to collect, filter, and analyze large volumes of diagnostic data, carrying it from first design to something other engineers run day to day.</li>
    <li>Wrote its algorithmic core over NumPy, SciPy, and Cython: an STRtree spatial search that maps each diagnostic record onto the chip feature it came from.</li>
    <li>Cut tool runtime 3× with Python free-threading after reworking the data structures to share no mutable state.</li>
    <li>Wrote Tcl that pulls layout geometry and design metadata out of Cadence Innovus databases into an automated checker that flags design errors, then confirmed the results in the Innovus GUI.</li>
    <li>Ship into a large shared Linux repo where every push triggers GitLab CI, with pyproject packaging, uv, and pytest.</li>
  </ul>
</div>

<div class="edu-entry">
  <div class="edu-school">UC San Diego</div>
  <div class="edu-degree">Student Researcher</div>
  <div class="edu-dates">Jan 2026 – Present</div>
  <ul>
    <li>Benchmarked a Transformer encoder in PyTorch against the closed-form LMMSE estimator for recovering signals buried in noise; cut error 10.6 dB and beat the best causal linear filter by 1.9 dB.</li>
    <li>Priced the accuracy against the compute it costs: 34M multiply-accumulates per sample against 128.</li>
    <li>Caught a silent training collapse to a constant-mean predictor and traced it to the learning-rate schedule over 5 runs.</li>
  </ul>
</div>

<div class="edu-entry">
  <div class="edu-school">Therva</div>
  <div class="edu-degree">Technical Intern</div>
  <div class="edu-dates">Sep 2025 – Present</div>
  <ul>
    <li>Lead the embedded firmware for this early-stage startup's patent-pending thermal device, written in C++ on a dual-core ESP32. Therva won 2nd place ($25K) at the UCSD Startup Competition.</li>
    <li>Built its real-time closed-loop PID control with integrator anti-windup: a 500 ms update sets heater duty, applied as time-proportional relay switching over a 5 s window, with gains tuned from logged step responses.</li>
    <li>Wrote the drivers underneath it: 8× oversampled 12-bit ADC thermistor reads with low-pass filtering, debounced interrupt-driven encoder input, an I2C status display, and Wi-Fi setpoint control.</li>
    <li>Structured the firmware as a non-blocking timed loop, so sensing, encoder input, and the display refresh never stall the control update or the heater window.</li>
  </ul>
</div>

<div class="edu-entry">
  <div class="edu-school">theCoderSchool</div>
  <div class="edu-degree">Software Instructor</div>
  <div class="edu-dates">Mar 2022 – May 2026</div>
  <ul>
    <li>Taught data structures, algorithms, and object-oriented programming across Python, Java, C++, C#, and Lua.</li>
  </ul>
</div>

</div>

---

## Education

<div class="edu-list">

<div class="edu-entry">
  <div class="edu-school">University of California, San Diego</div>
  <div class="edu-degree">M.S. in Electrical and Computer Engineering — Signal &amp; Image Processing</div>
  <div class="edu-dates">Expected December 2027</div>
</div>

<div class="edu-entry">
  <div class="edu-school">San Diego State University</div>
  <div class="edu-degree">B.S. in Electrical Engineering, Minor in Computer Science</div>
  <div class="edu-dates">2022 – 2025</div>
  <div class="edu-awards">William E. Leonhard Jr. Scholarship · Tau Beta Pi Invitee · Dean's List</div>
</div>

</div>

---

## Skills

**Programming & Systems:** Python, C/C++ (C++17), Tcl, SQL, Java, JavaScript, Bash, MIPS & x86 Assembly, Verilog, Git/GitHub, Jupyter

**Embedded & Hardware:** ESP32, STM32 ARM MCU (Cortex-M4), FPGA (Basys 3), Embedded Linux, interrupts, DMA, ADC/DAC, I2C, UART, mixed-signal design, LTspice, ADS, Cadence, oscilloscope, signal generator, multimeter

**Signal Processing & Estimation:** Estimation theory (Kalman filtering, LMMSE/Wiener), random processes, time-series analysis, maximum likelihood, MATLAB, Simulink, DSP, Digital Image Processing, FIR/IIR filter design, FFT, FM/PLL demodulation

**Machine Learning & Data:** PyTorch, NumPy, SciPy, pandas, scikit-learn, HuggingFace Transformers, Cython, Matplotlib

**Software Engineering & DevOps:** GitLab CI/CD, pyproject packaging, uv, pytest, multithreading, TCP sockets, profiling & performance tuning, Prometheus, Grafana, Linux CLI workflows

**IC Design:** Verilog, Tcl, Cadence Virtuoso, Spectre, Innovus, LTspice, VLSI design, standard-cell layout, DRC/LVS, analog & digital circuit design, circuit simulation

---

## Coursework

<div class="course-filters" role="group" aria-label="Course category filters">
  <button type="button" class="project-filter-btn is-active" data-filter="all">All</button>
  <button type="button" class="project-filter-btn" data-filter="sw">Software</button>
  <button type="button" class="project-filter-btn" data-filter="ml">ML</button>
  <button type="button" class="project-filter-btn" data-filter="hw">Hardware</button>
  <button type="button" class="project-filter-btn" data-filter="dsp">DSP</button>
</div>

<ul class="course-grid">
  <li class="course-item" data-categories="hw">
    <span class="course-code">ECE 165</span>
    <span class="course-title">Digital Circuit Design</span>
  </li>
  <li class="course-item" data-categories="hw">
    <span class="course-code">Compe 572</span>
    <span class="course-title">VLSI Circuit Design</span>
  </li>
  <li class="course-item" data-categories="hw">
    <span class="course-code">Compe 470</span>
    <span class="course-title">Digital Circuits</span>
  </li>
  <li class="course-item" data-categories="hw">
    <span class="course-code">Compe 470L</span>
    <span class="course-title">Digital Logic Library Lab</span>
  </li>
  <li class="course-item" data-categories="hw">
    <span class="course-code">EE 430</span>
    <span class="course-title">Analysis &amp; Design of Electronic Circuits</span>
  </li>
  <li class="course-item" data-categories="dsp hw">
    <span class="course-code">EE 458</span>
    <span class="course-title">Analog &amp; Pulse Communication Systems</span>
  </li>
  <li class="course-item" data-categories="dsp hw">
    <span class="course-code">EE 458L</span>
    <span class="course-title">Communications &amp; DSP Laboratory</span>
  </li>
  <li class="course-item" data-categories="sw hw">
    <span class="course-code">Compe 375</span>
    <span class="course-title">Embedded Systems Programming</span>
  </li>
  <li class="course-item" data-categories="sw">
    <span class="course-code">CS 210</span>
    <span class="course-title">Data Structures</span>
  </li>
  <li class="course-item" data-categories="sw">
    <span class="course-code">CS 420</span>
    <span class="course-title">Advanced Programming Languages</span>
  </li>
  <li class="course-item" data-categories="sw">
    <span class="course-code">CS 583</span>
    <span class="course-title">3D Game Programming</span>
  </li>
  <li class="course-item" data-categories="dsp">
    <span class="course-code">EE 410</span>
    <span class="course-title">Signals &amp; Systems</span>
  </li>
  <li class="course-item" data-categories="dsp ml">
    <span class="course-code">ECE 251A</span>
    <span class="course-title">Statistical Signal Processing</span>
  </li>
  <li class="course-item" data-categories="dsp">
    <span class="course-code">ECE 253</span>
    <span class="course-title">Digital Image Processing</span>
  </li>
  <li class="course-item" data-categories="dsp">
    <span class="course-code">ECE 161B</span>
    <span class="course-title">Digital Signal Processing</span>
  </li>
  <li class="course-item" data-categories="ml">
    <span class="course-code">EE 300</span>
    <span class="course-title">EE Statistics</span>
  </li>
  <li class="course-item" data-categories="ml">
    <span class="course-code">ECE 269</span>
    <span class="course-title">Graduate Linear Algebra</span>
  </li>
  <li class="course-item" data-categories="ml">
    <span class="course-code">CS 549</span>
    <span class="course-title">Machine Learning</span>
  </li>
  <li class="course-item" data-categories="ml">
    <span class="course-code">ECE 228</span>
    <span class="course-title">ML for Physical Applications</span>
  </li>
  <li class="course-item" data-categories="ml dsp sw">
    <span class="course-code">ECE 276A</span>
    <span class="course-title">Sensing &amp; Estimation in Robotics</span>
  </li>
  <li class="course-item" data-categories="ml sw">
    <span class="course-code">ECE 208</span>
    <span class="course-title">Computational Evolutionary Biology</span>
  </li>
  <li class="course-item" data-categories="hw ml">
    <span class="course-code">Fall 2026</span>
    <span class="course-title">Low Power VLSI for Machine Learning (in progress)</span>
  </li>
  <li class="course-item" data-categories="ml sw">
    <span class="course-code">Fall 2026</span>
    <span class="course-title">Reinforcement Learning for Robotics (in progress)</span>
  </li>
  <li class="course-item" data-categories="dsp">
    <span class="course-code">Fall 2026</span>
    <span class="course-title">Multirate Signal Processing (in progress)</span>
  </li>
</ul>

<script>
(function () {
  var buttons = document.querySelectorAll('.course-filters .project-filter-btn');
  var items = document.querySelectorAll('.course-item');
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var filter = btn.getAttribute('data-filter');
      buttons.forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      items.forEach(function (item) {
        var cats = (item.getAttribute('data-categories') || '').split(/\s+/);
        var show = filter === 'all' || cats.indexOf(filter) !== -1;
        item.style.display = show ? '' : 'none';
      });
    });
  });
})();
</script>
