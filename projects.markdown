---
layout: page
title: Projects
permalink: /projects/
---

Most of these projects are on my GitHub, but for some of them I was not able to publish them due to rules from the class. Feel free to email me to learn more about any of my projects.

---

## Real-Time Audio Spectrum Analyzer
*C · STM32 ARM MCU · HW Design/Validation · DSP*

Designed and integrated a single-supply (9 V) mixed-signal hardware platform from scratch: gain-controlled mic preamp, 5-pole 5 kHz Butterworth anti-aliasing filter, ADC re-biasing circuit, and an analog clipping detector with LED indication. Developed bare-metal embedded C firmware using DMA-driven 12-bit ADC sampling at 10 kHz for deterministic, low-latency signal acquisition, then implemented and validated a floating-point FFT pipeline with IIR low-pass filtering using CMSIS-DSP and the MCU FPU. Diagnosed analog front-end deviations from SPICE simulation by systematically probing the signal chain with an oscilloscope, and resolved the discrepancy by replacing electrolytic capacitors with ceramic to eliminate leakage current effects. Verified timing, voltage, and signal behavior using datasheets and lab instrumentation (oscilloscope, power supply, multimeter).

---

## Real-Time Camera Metric Pipeline
*Modern C++ OOP · Embedded Linux · ARM · Prometheus · Grafana*

Built a modular, object-oriented C++ telemetry service on embedded Linux using polymorphic class design to expose live camera and system metrics via a 15-second Prometheus scrape interval. Integrated a Raspberry Pi camera sensor for continuous stream health monitoring during extended operation, and designed Grafana dashboards with alerting rules to detect anomalies such as frame stalls and bandwidth drops. Deployed and validated the system across heterogeneous ARM platforms (Raspberry Pi 5, Arduino Uno R4/Q) using Git-based, command-line driven workflows, iterating on reliability through metric-driven debugging.

---

## LiDAR & Multi-Sensor SLAM for Differential-Drive Robot
*Python · C++ · Sensors · DSP*

Built a SLAM pipeline for a differential-drive robot using 1081-beam LiDAR scans. Processed raw range measurements into Cartesian point clouds via calibration and coordinate transforms, then registered consecutive scans using 2D Iterative Closest Point (ICP) with MSE-based convergence criteria to estimate relative motion. Fused wheel odometry with scan-matching constraints through nonlinear least-squares optimization (GTSAM) for improved state estimation and trajectory consistency.

---

## Communication & DSP Lab
*MATLAB · Lab Instrumentation · Analog/Digital Communications*

Implemented a delta modulation (DPCM) encoder/decoder in MATLAB: generated bi-level DM signals, reconstructed audio via accumulation and low-pass filtering, and analyzed compression-fidelity tradeoffs at various step sizes. Verified the Nyquist sampling theorem using hardware signal chains (pulse generator, analog switch, LPF reconstruction), identifying aliasing onset by sweeping message frequency beyond f<sub>s</sub>/2. Built PLL-based and zero-crossing FM demodulators using VCOs, comparators, and tunable LPFs, and implemented a digital quadrature FM demodulator in MATLAB using I/Q mixing, LPF, and an arctangent discriminator with a 32-tap FIR filter.

---

## Digital Clock on FPGA
*Verilog · Basys 3 FPGA*

Designed a multi-mode digital clock in Verilog featuring BCD counters, a clock divider, a time-multiplexed 7-segment display driver, and alarm comparator logic. Synthesized and verified the full design on Basys 3 FPGA hardware, validating mode transitions and timing behavior on real silicon.

---

## OCR ML Model Robustness Evaluation
*Python · MATLAB · PyTorch · DSP*

Designed an automated Python evaluation pipeline to benchmark transformer-based OCR models (TrOCR, PARSeq) on 200+ real-world image samples across three distortion types, computing character error rate (CER) and word error rate (WER). Built and compared six preprocessing pipelines — including CNN-based dehazing (DehazeNet), Wiener-filter super-resolution (WSD-SR), and combined multi-stage approaches — to quantify their impact on model robustness. Analyzed results to identify that visually similar restoration techniques failed due to non-linear distortion geometry and missing atmospheric priors. Co-authored a 10-page technical report with quantitative tables, qualitative visual comparisons, and actionable recommendations, and presented findings to faculty and peers.

---

## Machine Learning Projects
*Python · NumPy · PyTorch · HuggingFace · Pandas · scikit-learn*

Implemented LASSO regression via ISTA from scratch in NumPy, tuning regularization across a sweep of λ values and evaluating precision, recall, and fitting loss to select optimal sparsity-accuracy tradeoffs; applied the model to a real-world GWAS dataset (1,279 features, 539 samples) using Pandas and scikit-learn for data loading, preprocessing, and train/validation/test splitting. Implemented core ML algorithms from first principles in NumPy: PCA for dimensionality reduction on image data, K-means clustering with custom centroid initialization and convergence logic, and a 2-layer neural network with manual forward/backward propagation and gradient descent. Trained and evaluated deep learning models in PyTorch: a CNN classifier on 60K MNIST samples, an LSTM sequence model for multi-class language prediction across 18 categories, and a CBOW word embedding model. Applied pre-trained transformer models (BERT) via HuggingFace for tokenization and feature extraction, gaining practical experience with modern NLP architectures.
