---
layout: page
title: Playroom
permalink: /playroom/
---

Interactive tools and experiments. Click into one to explore.

<div class="playroom-grid">

<a class="playroom-card" href="{{ '/playroom/signals/' | relative_url }}">
  <div class="playroom-card-icon">
    <svg viewBox="0 0 120 40" preserveAspectRatio="none">
      <path d="M0,20 Q10,0 20,20 T40,20 T60,20 T80,20 T100,20 T120,20" fill="none" stroke="currentColor" stroke-width="2.5"/>
      <path d="M0,20 Q15,5 30,20 T60,20 T90,20 T120,20" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
    </svg>
  </div>
  <h2>Signal Playground</h2>
  <p>Build waveforms, add and convolve them, and watch what each operation does to the frequency domain.</p>
  <span class="playroom-card-tag">DSP</span>
</a>

<a class="playroom-card" href="{{ '/playroom/audio/' | relative_url }}">
  <div class="playroom-card-icon">
    <svg viewBox="0 0 120 40" preserveAspectRatio="none">
      <rect x="8" y="14" width="4" height="12" rx="2" fill="currentColor" opacity="0.45"/>
      <rect x="18" y="8" width="4" height="24" rx="2" fill="currentColor" opacity="0.65"/>
      <rect x="28" y="3" width="4" height="34" rx="2" fill="currentColor"/>
      <rect x="38" y="11" width="4" height="18" rx="2" fill="currentColor" opacity="0.65"/>
      <rect x="48" y="16" width="4" height="8" rx="2" fill="currentColor" opacity="0.45"/>
      <circle cx="86" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="2.5"/>
      <path d="M83,15 L92,20 L83,25 Z" fill="currentColor"/>
    </svg>
  </div>
  <h2>Signal Share</h2>
  <p>Load a track, pull the vocals and the band apart, filter each stem on its own, and send someone a link that opens on your exact settings.</p>
  <span class="playroom-card-tag">Audio</span>
</a>

<a class="playroom-card" href="{{ '/playroom/chatbot/' | relative_url }}">
  <div class="playroom-card-icon">
    <svg viewBox="0 0 120 40" preserveAspectRatio="none">
      <rect x="10" y="4" width="55" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"/>
      <rect x="55" y="20" width="55" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2.5"/>
      <line x1="18" y1="12" x2="50" y2="12" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
      <line x1="63" y1="28" x2="95" y2="28" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
    </svg>
  </div>
  <h2>Learn about Nero</h2>
  <p>Chat with an AI that knows about my background, projects, skills, and coursework.</p>
  <span class="playroom-card-tag">AI</span>
</a>

</div>
