---
layout: page
title: Projects
permalink: /projects/
---

Most of these projects are on my GitHub, but for some of them I was not able to publish them due to rules from the class. Feel free to email me to learn more about any of my projects.

---

## LiDAR & Multi-Sensor SLAM for Differential-Drive Robot
*Python · C++ · Sensors · DSP*

Built a SLAM pipeline for a differential-drive robot using 1081-beam LiDAR scans. Processed raw range measurements into Cartesian point clouds, registered consecutive scans via 2D ICP with MSE-based convergence, and fused odometry with scan-matching constraints using nonlinear least-squares optimization (GTSAM) for improved state estimation.

---

## Real-Time Audio Spectrum Analyzer
*C · STM32 ARM MCU · HW Design/Validation · DSP*

Designed and built a mixed-signal hardware platform from scratch: gain-controlled mic preamp, 5-pole 5 kHz Butterworth anti-aliasing filter, ADC re-biasing circuit, and analog clipping detector with LED indication — all on a single 9 V supply. Wrote bare-metal C firmware with DMA-driven 12-bit ADC sampling at 10 kHz, and implemented a floating-point FFT pipeline with IIR low-pass filtering using CMSIS-DSP and the MCU FPU.

---

## Real-Time Camera Metric Pipeline
*Modern C++ · Embedded Linux · ARM · Prometheus · Grafana*

Built a modular, object-oriented C++ telemetry service on embedded Linux to expose live camera and system metrics via a 15 s Prometheus scrape interval. Integrated a Raspberry Pi camera sensor for continuous stream health monitoring, designed Grafana dashboards with alerting rules, and deployed across heterogeneous ARM platforms (Raspberry Pi 5, Arduino Uno Q).

---

## OCR ML Model Robustness Evaluation
*Python · MATLAB · DSP*

Designed an automated evaluation pipeline to benchmark transformer-based OCR models across image datasets using character error rate (CER) and accuracy. Compared classical and learning-based image pre-processing methods (WSD-SR, DehazeNet) to quantify their impact on model robustness.

---

## ML Course Projects
*Python · NumPy · PyTorch*

Implemented a range of ML projects including CNN-based character recognition, K-means clustering on sign-language datasets, and LSTM sequence modeling for name prediction.
