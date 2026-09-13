// The chatbot page. The Worker holds the system prompt and the API key; this
// page only sends the conversation so far and shows what comes back.

(function () {
  var API = 'https://nero-chatbot-proxy.nhamidi.workers.dev';

  var log = document.getElementById('log');
  var form = document.getElementById('ask');
  var field = document.getElementById('question');
  var send = document.getElementById('send');

  // Every turn so far, as { role: 'user' | 'model', text }.
  var history = [];

  function say(who, text) {
    var p = document.createElement('p');
    var b = document.createElement('b');
    b.textContent = who + ':';
    p.appendChild(b);
    p.appendChild(document.createTextNode(' ' + text));
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  async function ask(text) {
    history.push({ role: 'user', text: text });
    say('You', text);
    field.value = '';
    field.disabled = true;
    send.disabled = true;
    var waiting = say('Bot', '…');

    try {
      var resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data.reply) throw new Error(data.error || 'The assistant is unavailable right now.');
      history.push({ role: 'model', text: data.reply });
      waiting.remove();
      say('Bot', data.reply);
    } catch (err) {
      waiting.remove();
      say('Bot', 'Sorry, something went wrong: ' + err.message);
      history.pop(); // Drop the failed turn so it is not resent with the next one.
    }

    field.disabled = false;
    send.disabled = false;
    field.focus();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = field.value.trim();
    if (text) ask(text);
  });

  field.focus();
})();
