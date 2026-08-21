---
layout: page
title: Learn about Nero
permalink: /playroom/chatbot/
---

<div class="chatbot-container">
  <div class="chatbot-messages" id="chatbot-messages">
    <div class="chatbot-msg chatbot-msg-bot">
      <div class="chatbot-msg-name">Nero Bot</div>
      <div class="chatbot-msg-text">Hey! I'm an AI that knows about Nero's background, projects, and skills. Ask me anything — like "What projects has Nero worked on?" or "What programming languages does Nero know?"</div>
    </div>
  </div>
  <form class="chatbot-input" id="chatbot-form" autocomplete="off">
    <input type="text" id="chatbot-field" placeholder="Ask about Nero..." aria-label="Message" />
    <button type="submit" id="chatbot-send">Send</button>
  </form>
</div>

<script>
(function () {
  var API_URL = 'https://nero-chatbot-proxy.nero-chatbot.workers.dev';

  // No system prompt here on purpose. The Worker owns it, so it never reaches the browser.
  // Each history entry is { role: 'user' | 'model', text: '...' }.
  var history = [];
  var messagesEl = document.getElementById('chatbot-messages');
  var formEl = document.getElementById('chatbot-form');
  var fieldEl = document.getElementById('chatbot-field');
  var sendBtn = document.getElementById('chatbot-send');

  function addMessage(text, isUser) {
    var msg = document.createElement('div');
    msg.className = 'chatbot-msg ' + (isUser ? 'chatbot-msg-user' : 'chatbot-msg-bot');
    var name = document.createElement('div');
    name.className = 'chatbot-msg-name';
    name.textContent = isUser ? 'You' : 'Nero Bot';
    var bubble = document.createElement('div');
    bubble.className = 'chatbot-msg-text';
    bubble.textContent = text;
    msg.appendChild(name);
    msg.appendChild(bubble);
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function addLoading() {
    var msg = document.createElement('div');
    msg.className = 'chatbot-msg chatbot-msg-bot';
    msg.id = 'chatbot-loading';
    var name = document.createElement('div');
    name.className = 'chatbot-msg-name';
    name.textContent = 'Nero Bot';
    var bubble = document.createElement('div');
    bubble.className = 'chatbot-msg-text chatbot-typing';
    bubble.innerHTML = '<span></span><span></span><span></span>';
    msg.appendChild(name);
    msg.appendChild(bubble);
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeLoading() {
    var el = document.getElementById('chatbot-loading');
    if (el) el.remove();
  }

  async function sendMessage(text) {
    history.push({ role: 'user', text: text });
    addMessage(text, true);
    fieldEl.value = '';
    fieldEl.disabled = true;
    sendBtn.disabled = true;
    addLoading();

    try {
      var resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });

      var data = await resp.json().catch(function () { return {}; });

      if (!resp.ok || !data.reply) {
        throw new Error(data.error || 'The assistant is unavailable right now.');
      }

      history.push({ role: 'model', text: data.reply });
      removeLoading();
      addMessage(data.reply, false);
    } catch (err) {
      removeLoading();
      addMessage('Sorry, something went wrong: ' + err.message, false);
      // Drop the failed turn so the next request isn't sent with a dangling question.
      history.pop();
    }

    fieldEl.disabled = false;
    sendBtn.disabled = false;
    fieldEl.focus();
  }

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = fieldEl.value.trim();
    if (!text) return;
    sendMessage(text);
  });

  fieldEl.focus();
})();
</script>
