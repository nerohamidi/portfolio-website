// Share cards for Signal Share.
//
// Everything a share carries lives in the URL *hash*, which never reaches a
// server: that is what lets the page be static. It is also why a plain share link
// can never preview. iMessage, Slack and the rest fetch the URL and read its
// meta tags, and a fragment is not part of what they fetch — so a link to the
// static page can only ever unfurl as the page's own generic title.
//
// A share with a title or a note is therefore wrapped: the record is stored here,
// the link points at `/s/<id>` on this Worker, and that route answers with a real
// HTML document carrying og:title and og:description before it forwards the
// visitor on to the page with the full hash. The hash is not shortened or hidden
// by this — it travels inside the record and is put back in the address bar on
// arrival, so the wrapper adds a preview and takes nothing away.

import { newId, ttlDays, makeLock, checkLock, lockMeta } from './clips.js';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

const MAX_TITLE = 80;
const MAX_NOTE = 300;
// Ten tracks of ids, the filter, and the opening name comes to a little over 300
// characters. The ceiling is loose enough not to be a limit anyone meets and
// tight enough that a record cannot be used as free storage.
const MAX_HASH = 2000;
// The hash is put back in a browser's address bar, so it may only hold what a
// fragment may hold. Anything outside this is a sign the record was not written
// by the page.
const HASH_RE = /^[A-Za-z0-9=&,.:~_%+\-*!()'$@/?]+$/;

// A record is a few hundred bytes, so bytes are not the risk here; object count
// is. The clip survey only walks `clips/`, so nothing else bounds this prefix,
// and a rate limit of a dozen a minute per address is a bound on bursts rather
// than on a month of them. Two list pages is a real count, not an estimate.
const MAX_SHARES = 2000;
const SHARE_LIST_PAGES = 2;

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  // Control characters would survive into a meta tag and into the page's own
  // note, where a newline in the middle of an attribute is at best noise.
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);
}

// Escapes for both an element body and a double-quoted attribute, which is where
// most of these end up. The title and note are visitor-written text going into a
// document this Worker serves, so nothing here may reach the page unescaped.
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The destination is chosen here, never sent by the client. A client-supplied
// redirect target would turn this route into an open redirect wearing whatever
// title the sender typed, which is the exact shape of a phishing link.
export function shareTarget(origin, env) {
  const path = env.SHARE_PATH || '/portfolio-website/playroom/audio/';
  return origin.replace(/\/+$/, '') + path;
}

export async function handleCreateShare(request, env, origin, headers) {
  if (!env.CLIPS) {
    return json({ error: 'Share links are not configured.' }, 503, headers);
  }

  if (env.SHARE_LINKS) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.SHARE_LINKS.limit({ key: ip });
    if (!success) {
      return json({ error: 'Too many links from here. Wait a minute and try again.' }, 429, headers);
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400, headers);
  }

  const hash = typeof body?.hash === 'string' ? body.hash.replace(/^#/, '') : '';
  if (!hash || hash.length > MAX_HASH || !HASH_RE.test(hash)) {
    return json({ error: 'That link could not be made.' }, 400, headers);
  }

  const title = clean(body?.title, MAX_TITLE);
  const note = clean(body?.note, MAX_NOTE);
  if (!title && !note) {
    // Without either there is nothing to preview, and the plain hash link is
    // strictly better: it costs no storage and cannot expire.
    return json({ error: 'A share card needs a title or a note.' }, 400, headers);
  }

  if (await sharesFull(env)) {
    return json({
      error: 'Too many share cards right now. They expire on their own, so try again later.',
    }, 507, headers);
  }

  const id = newId();
  const record = {
    hash,
    title,
    note,
    base: shareTarget(origin, env),
    createdAt: new Date().toISOString(),
  };

  // The same lock the clips get, on the same terms: set once, at creation, by
  // whoever made the link. A card that outlived its own audio would keep
  // advertising a playlist that is not there.
  const password = request.headers.get('x-clip-lock');
  if (password) Object.assign(record, await makeLock(password, env));

  try {
    await env.CLIPS.put(`share/${id}`, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch {
    return json({ error: 'Could not save that link.' }, 502, headers);
  }

  const ttl = ttlDays(env);
  return json({
    id,
    url: new URL(request.url).origin + '/s/' + id,
    title,
    note,
    locked: Boolean(password),
    expiresInDays: ttl,
  }, 200, headers);
}

// Counts what is live rather than keeping a running total: the lifecycle rule
// deletes records without telling the Worker, so a counter would climb forever
// and eventually refuse a link into an empty prefix.
async function sharesFull(env) {
  const cap = Math.max(1, Number(env.SHARE_MAX_OBJECTS) || MAX_SHARES);
  const cutoff = Date.now() - ttlDays(env) * 86400000;
  let count = 0;
  let cursor;
  for (let page = 0; page < SHARE_LIST_PAGES; page++) {
    let listed;
    try {
      listed = await env.CLIPS.list({ prefix: 'share/', limit: 1000, cursor });
    } catch {
      // A failed count must not be a refusal: the rate limit above still holds.
      return false;
    }
    for (const obj of listed.objects) {
      if (obj.uploaded && obj.uploaded.getTime() < cutoff) continue;
      count += 1;
    }
    if (!listed.truncated) return count >= cap;
    cursor = listed.cursor;
  }
  // The walk ran out of pages, so there are at least SHARE_LIST_PAGES thousand
  // records. That is past any sensible ceiling on its own.
  return true;
}

async function readShare(env, id) {
  if (!ID_RE.test(id)) return null;
  const obj = await env.CLIPS.get(`share/${id}`);
  if (!obj) return null;
  // The lifecycle rule reclaims the space; this makes the TTL true from the
  // moment it is set, and on any object the rule has not swept yet.
  if (obj.uploaded && Date.now() - obj.uploaded.getTime() > ttlDays(env) * 86400000) return null;
  try {
    const parsed = JSON.parse(await obj.text());
    return parsed && typeof parsed.hash === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// `url` is where a visitor is sent; `self` is this card's own address. The two
// are not interchangeable in the tags below: og:url and the canonical link have
// to name the card, because an unfurler that re-fetches what og:url says would
// otherwise land on the static page and read its generic tags instead of these.
function page({ title, note, url, self, siteTitle }) {
  const heading = title || siteTitle;
  const summary = note || 'A playlist shared from Signal Share.';
  // JSON.stringify, not the escaper above: this one lands inside a script, where
  // an apostrophe is syntax and `&#39;` is not.
  const js = JSON.stringify(url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)}</title>
<meta name="description" content="${esc(summary)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteTitle)}">
<meta property="og:title" content="${esc(heading)}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:url" content="${esc(self)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(heading)}">
<meta name="twitter:description" content="${esc(summary)}">
<link rel="canonical" href="${esc(self)}">
<!-- Belt and braces: the script sends a browser on immediately, the refresh
     covers one with scripting off. An unfurler reads the tags above and follows
     neither, which is the whole point of answering with a document instead of a
     redirect. -->
<meta http-equiv="refresh" content="0; url=${esc(url)}">
<style>
  body { margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center;
         background: #111; color: #ddd; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #999; }
  a { color: #6cb6ff; }
</style>
</head>
<body>
<main>
  <h1>${esc(heading)}</h1>
  <p>${esc(summary)}</p>
  <p><a href="${esc(url)}">Open it</a></p>
</main>
<script>location.replace(${js});</script>
</body>
</html>`;
}

export async function handleShareCard(request, env, id, headers) {
  const siteTitle = env.SHARE_SITE_TITLE || 'Signal Share';
  if (!env.CLIPS) return new Response('Not found', { status: 404, headers });

  const record = await readShare(env, id);
  if (!record) {
    return new Response('That link has expired or never existed.', {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // The card's own id is appended to the hash on the way through, so the page
  // knows which record it arrived by and a recipient's delete can take the card
  // down along with the audio. It cannot be in the stored hash: the id does not
  // exist until the record has been written.
  const url = (record.base || shareTarget(request.headers.get('Origin') || '', env)) +
    '#' + record.hash + '&s=' + id;
  const html = page({
    title: record.title,
    note: record.note,
    url,
    self: new URL(request.url).origin + '/s/' + id,
    siteTitle,
  });

  return new Response(request.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
      // Short. An unfurler caches on its own for far longer, and a card whose
      // clips have since been deleted should stop being served promptly.
      'Cache-Control': 'public, max-age=300',
      // Nothing here is embeddable, and the page runs one line of its own script.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

export async function handleDeleteShare(request, env, id, headers) {
  if (!env.CLIPS) return json({ error: 'Share links are not configured.' }, 503, headers);
  if (!ID_RE.test(id)) return json({ error: 'Not found' }, 404, headers);

  const record = await readShare(env, id);
  if (!record) return json({ error: 'That link is already gone.' }, 404, headers);

  const verdict = await checkLock(lockMeta(record), request.headers.get('x-clip-lock'));
  if (verdict !== 'ok') {
    return json({
      error: verdict === 'missing'
        ? 'That link is password protected.'
        : 'That password does not match.',
      locked: true,
    }, verdict === 'missing' ? 401 : 403, headers);
  }

  try {
    await env.CLIPS.delete(`share/${id}`);
  } catch {
    return json({ error: 'Could not delete that link.' }, 502, headers);
  }
  return json({ deleted: true, id }, 200, headers);
}
