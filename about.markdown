---
layout: page
title: About
permalink: /about/
---

I'm an ECE graduate student at UC San Diego specializing in Signal & Image Processing, with a growing interest in IC design. My work sits at the intersection of embedded systems, DSP, and machine learning — I like building things that process real-world signals under real-world constraints. I'm drawn to IC design because it connects the circuit-level intuition I've built through analog and digital coursework to the challenge of implementing signal processing and ML in silicon.

**[nehamidi@ucsd.edu](mailto:nehamidi@ucsd.edu)** · [LinkedIn](https://www.linkedin.com/in/nero-hamidi) · [GitHub](https://github.com/nerohamidi)

---

## Education

<div class="edu-list">

<div class="edu-entry">
  <div class="edu-school">University of California, San Diego</div>
  <div class="edu-degree">M.S. in Electrical and Computer Engineering — Signal &amp; Image Processing</div>
  <div class="edu-dates">Sep 2025 – Jun 2027</div>
</div>

<div class="edu-entry">
  <div class="edu-school">San Diego State University</div>
  <div class="edu-degree">B.S. in Electrical Engineering, Minor in Computer Science</div>
  <div class="edu-dates">Aug 2022 – Jun 2025</div>
  <div class="edu-awards">William E. Leonhard Jr. Scholarship · Tau Beta Pi Invitee · Dean's List</div>
</div>

</div>

---

## Skills

**Programming & Systems:** C/C++, Python, Java, MIPS & x86 Assembly, Verilog, Git/GitHub, Visual Studio, Jupyter

**Embedded & Hardware:** STM32 ARM MCU, FPGA (Basys 3), Embedded Linux, DMA, ADC/DAC, mixed-signal design, LTspice, ADS, Cadence, oscilloscope, signal generator, multimeter

**Signal Processing:** MATLAB, Simulink, DSP, Digital Image Processing, FIR/IIR filter design, FFT, FM/PLL demodulation

**Machine Learning & Data:** Python, PyTorch, scikit-learn, NumPy, Pandas, HuggingFace Transformers, SQL

**Observability & Tooling:** Prometheus, Grafana, Git/GitHub, Linux CLI workflows

**IC Design:** Verilog, LTspice, Cadence, VLSI design, analog & digital circuit design, circuit simulation, schematic design

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
  <li class="course-item" data-categories="dsp">
    <span class="course-code">ECE 251A</span>
    <span class="course-title">Digital Signal Processing I</span>
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
