// Shareable audio clips for the signal playground.
//
// The playground loads uploads with URL.createObjectURL, which yields a blob: URL
// that exists only inside the tab that created it. Putting the bytes in R2 under an
// unguessable key is what turns "I loaded a song" into something a link can carry.

const MAX_BYTES = 12 * 1024 * 1024;
const TTL_DAYS = 30;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

// R2's free tier is 10 GB-month. The ceiling sits below it so a bucket that stays
// full for a whole month still bills nothing, and so a clip already in flight when
// the check ran cannot tip it over.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
// One person filling the pool would lock everyone else out, which the global cap
// alone does not prevent.
const MAX_PER_UPLOADER_BYTES = 200 * 1024 * 1024;
// Bounds the survey below, and is reached long before the byte ceiling only if
// something is uploading a great many tiny files.
const MAX_OBJECTS = 4000;
const MAX_LIST_PAGES = 10;

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Checked instead of trusting Content-Type: the browser sends whatever the client
// claims, so the declared type is an assertion, not evidence. This endpoint is open
// to anyone on the page, and without a real check it is a general file host.
function sniffAudio(bytes) {
  function ascii(off, str) {
    if (off + str.length > bytes.length) return false;
    for (let i = 0; i < str.length; i++) {
      if (bytes[off + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }

  if (ascii(0, 'ID3')) return 'audio/mpeg';
  // MP3 frame sync: 0xFF then the top three bits of the next byte.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (ascii(4, 'ftyp')) return 'audio/mp4';
  if (ascii(0, 'FORM') && (ascii(8, 'AIFF') || ascii(8, 'AIFC'))) return 'audio/aiff';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (ascii(0, 'caff')) return 'audio/x-caf';
  return null;
}

function newId() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeName(header) {
  if (!header) return 'clip';
  try {
    return decodeURIComponent(header).slice(0, 80) || 'clip';
  } catch {
    return 'clip';
  }
}

// A stable per-uploader key that is not the address itself. Salting it keeps a
// dump of the bucket's metadata from being reversed against a list of candidate IPs.
async function hashUploader(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const salt = env.CLIP_SALT || 'signal-playground';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + ip));
  const bytes = new Uint8Array(digest).slice(0, 8);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Usage is measured by listing rather than by keeping a running counter. A counter
// would drift: the lifecycle rule deletes objects without telling the Worker, so the
// total would climb forever and eventually refuse uploads into an empty bucket.
// One list call per upload is well inside the free Class A allowance.
async function surveyBucket(env) {
  const cutoff = Date.now() - ttlDays(env) * 86400000;
  const perUploader = new Map();
  const expired = [];
  let bytes = 0;
  let count = 0;
  let cursor;
  let truncated = true;
  let pages = 0;

  while (truncated && pages < MAX_LIST_PAGES) {
    const listed = await env.CLIPS.list({
      prefix: 'clips/',
      limit: 1000,
      cursor,
      include: ['customMetadata'],
    });

    for (const obj of listed.objects) {
      // Already past its TTL. The lifecycle rule has not swept it yet, but the space
      // is on its way back, so it should not block a new upload.
      if (obj.uploaded && obj.uploaded.getTime() < cutoff) {
        if (expired.length < 1000) expired.push(obj.key);
        continue;
      }
      bytes += obj.size;
      count += 1;
      const who = obj.customMetadata && obj.customMetadata.up;
      if (who) perUploader.set(who, (perUploader.get(who) || 0) + obj.size);
    }

    truncated = listed.truncated;
    cursor = listed.cursor;
    pages += 1;
  }

  // truncated still set means the page guard stopped the walk early, so the totals
  // below are a floor, not a measurement.
  return { bytes, count, expired, perUploader, complete: !truncated };
}

// The constants above are the fallback. Overriding them through wrangler vars means
// the ceiling can be lowered without a code change or a redeploy of the logic.
function envNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function quotaLimits(env) {
  return {
    total: envNum(env.CLIP_MAX_TOTAL_BYTES, MAX_TOTAL_BYTES) || MAX_TOTAL_BYTES,
    perUploader: envNum(env.CLIP_MAX_PER_UPLOADER_BYTES, MAX_PER_UPLOADER_BYTES) || MAX_PER_UPLOADER_BYTES,
    objects: envNum(env.CLIP_MAX_OBJECTS, MAX_OBJECTS) || MAX_OBJECTS,
  };
}

// Shortening this is the most direct way to hold storage down, since it decides how
// long every clip occupies the bucket. It must stay in step with the bucket's
// lifecycle rule, which is what actually reclaims the space; see CLIPS.md.
function ttlDays(env) {
  return envNum(env.CLIP_TTL_DAYS, TTL_DAYS);
}

function maxBytes(env) {
  return envNum(env.CLIP_MAX_BYTES, MAX_BYTES) || MAX_BYTES;
}

function tooLargeError(max) {
  return `That clip is over the ${Math.round(max / (1024 * 1024))} MB limit.`;
}

function quotaError(survey, uploader, size, limits) {
  if (!survey.complete || survey.count >= limits.objects || survey.bytes + size > limits.total) {
    return 'The clip library is full right now. Clips expire on their own, so try again later.';
  }
  if ((survey.perUploader.get(uploader) || 0) + size > limits.perUploader) {
    return 'You have hit your share limit. Your older clips expire on their own.';
  }
  return null;
}

export async function handleUpload(request, env, ctx, headers) {
  if (!env.CLIPS) {
    return json({ error: 'Clip storage is not configured.' }, 503, headers);
  }

  // Reject on the declared length before reading a byte, so an oversized upload
  // costs one round trip instead of a full transfer.
  const max = maxBytes(env);
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > max) {
    return json({ error: tooLargeError(max) }, 413, headers);
  }

  if (env.CLIP_UPLOADS) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.CLIP_UPLOADS.limit({ key: ip });
    if (!success) {
      return json({ error: 'Too many uploads from here. Wait a minute and try again.' }, 429, headers);
    }
  }

  const uploader = await hashUploader(request, env);
  const survey = await surveyBucket(env);

  // Reclaim whatever the lifecycle rule has not caught yet. Not awaited: the survey
  // already discounted these bytes, so the decision does not wait on the delete.
  if (survey.expired.length && ctx) {
    ctx.waitUntil(env.CLIPS.delete(survey.expired).catch(() => {}));
  }

  // Checked against the declared length first, so a full bucket refuses the upload
  // before pulling 12 MB across the wire.
  const limits = quotaLimits(env);
  const early = quotaError(survey, uploader, declared || 0, limits);
  if (early) return json({ error: early }, 507, headers);

  // Buffered rather than streamed on purpose. R2 needs a known length for a stream,
  // and the failure mode when it does not have one is silent truncation, which would
  // surface much later as a clip that plays halfway.
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return json({ error: 'Upload failed in transit.' }, 400, headers);
  }

  if (buf.byteLength === 0) return json({ error: 'That file is empty.' }, 400, headers);
  if (buf.byteLength > max) {
    return json({ error: tooLargeError(max) }, 413, headers);
  }

  const contentType = sniffAudio(new Uint8Array(buf, 0, Math.min(64, buf.byteLength)));
  if (!contentType) {
    return json({ error: 'That file does not look like audio.' }, 415, headers);
  }

  // Re-checked against the real size: a chunked upload declares no length, and a
  // dishonest Content-Length is not worth trusting either.
  const full = quotaError(survey, uploader, buf.byteLength, limits);
  if (full) return json({ error: full }, 507, headers);

  const id = newId();
  const name = decodeName(request.headers.get('x-clip-name'));

  try {
    await env.CLIPS.put(`clips/${id}`, buf, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { name, uploadedAt: new Date().toISOString(), up: uploader },
    });
  } catch {
    return json({ error: 'Could not store that clip.' }, 502, headers);
  }

  const ttl = ttlDays(env);
  const expiresAt = new Date(Date.now() + ttl * 86400000).toISOString();
  return json({ id, name, expiresAt, expiresInDays: ttl }, 200, headers);
}

export async function handleFetchClip(request, env, id, headers) {
  if (!env.CLIPS) return new Response('Clip storage is not configured.', { status: 503, headers });
  if (!ID_RE.test(id)) return new Response('Not found', { status: 404, headers });

  const object = await env.CLIPS.get(`clips/${id}`, {
    range: request.headers,
    onlyIf: request.headers,
  });

  if (object === null) return new Response('Not found', { status: 404, headers });

  // The lifecycle rule on the bucket is what actually reclaims storage; this check
  // makes the TTL true from the moment it is set, including on buckets configured
  // before the rule was added.
  const uploadedMs = object.uploaded ? object.uploaded.getTime() : 0;
  if (uploadedMs && Date.now() - uploadedMs > ttlDays(env) * 86400000) {
    if (object.body) object.body.cancel();
    return new Response('Clip expired', { status: 404, headers });
  }

  const out = new Headers(headers);
  object.writeHttpMetadata(out);
  out.set('etag', object.httpEtag);
  out.set('accept-ranges', 'bytes');

  // A precondition matched, so R2 returned metadata with no body.
  if (!object.body) return new Response(null, { status: 304, headers: out });

  let status = 200;
  if (request.headers.has('range') && object.range) {
    const size = object.size;
    let offset;
    let length;
    if (object.range.suffix !== undefined) {
      length = object.range.suffix;
      offset = size - length;
    } else {
      offset = object.range.offset || 0;
      length = object.range.length === undefined ? size - offset : object.range.length;
    }
    out.set('content-range', `bytes ${offset}-${offset + length - 1}/${size}`);
    out.set('content-length', String(length));
    status = 206;
  }

  return new Response(object.body, { status, headers: out });
}
