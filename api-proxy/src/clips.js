// Shareable audio clips for the signal playground.
//
// The playground loads uploads with URL.createObjectURL, which yields a blob: URL
// that exists only inside the tab that created it. Putting the bytes in R2 under an
// unguessable key is what turns "I loaded a song" into something a link can carry.

const MAX_BYTES = 12 * 1024 * 1024;
// What the override key raises the per-file cap to. It is not unlimited: the
// upload is buffered whole before it reaches R2 (see the note in handleUpload), so
// this has to stay well inside a Worker's memory.
const MAX_BYTES_UNLOCKED = 50 * 1024 * 1024;
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

// Digests are compared rather than the keys themselves: they are always the same
// length, so the walk below leaks nothing about how long the real key is, and it
// finishes in the same time whether the first byte differs or the last.
async function keyMatches(supplied, secret) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Three answers rather than a boolean. A wrong key has to be told apart from no
// key at all: someone who typed one is expecting the larger ceiling, and silently
// giving them the usual limit would report a 12 MB error they cannot explain.
export async function checkUploadKey(request, env) {
  const supplied = request.headers.get('x-clip-key');
  if (!supplied) return 'none';
  // No secret configured means there is no override to grant. Treating an absent
  // secret as "anything matches" would be the worst possible way to fail.
  if (!env.CLIP_ADMIN_KEY) return 'invalid';
  return (await keyMatches(supplied, env.CLIP_ADMIN_KEY)) ? 'valid' : 'invalid';
}

// --- the delete password ------------------------------------------------------
//
// A clip id is the read permission and, on its own, the delete permission too:
// whoever the link reaches can take the track down for everyone. That is the
// right default for something sent to one friend and the wrong one for something
// forwarded on, so an uploader may lock it. The lock is set once, at upload, by
// the only person who is definitely the owner. It is never added to a clip that
// is already up: a recipient who could lock someone else's clip could not delete
// it, but could stop the uploader deleting it either.
//
// The lock bounds deletion and nothing else. The clip still expires on its own
// after CLIP_TTL_DAYS, so a forgotten password costs a wait, never a permanent
// object in the bucket.

// PBKDF2 over a user-chosen password, salted per clip. The iteration count is
// stored beside the hash rather than assumed, so it can be raised later without
// invalidating every lock already written. It is deliberately modest: an attacker
// needs the 128-bit id before a guess is even possible, the rate limiter on the
// delete route shapes online guessing, and a Worker has a CPU budget per request
// that a hundred thousand rounds would eat into. The stretching is here for the
// case this cannot otherwise defend: a leak of the bucket's metadata, where a
// password reused from somewhere else must not fall out in plaintext.
const LOCK_ITERATIONS = 50000;
// Bounds the work one request can ask for. Nothing legitimate is near it.
const MAX_PASSWORD = 200;

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(text) {
  const out = new Uint8Array(Math.floor(text.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return toHex(new Uint8Array(bits));
}

function lockIterations(env) {
  return Math.max(1000, Math.round(envNum(env && env.CLIP_LOCK_ITERATIONS, LOCK_ITERATIONS) || LOCK_ITERATIONS));
}

// The three fields a lock is made of, ready to be spread into R2 custom metadata
// or into a share record. Both are string maps, so both store it the same way.
export async function makeLock(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = lockIterations(env);
  return {
    lockSalt: toHex(salt),
    lockIter: String(iterations),
    lockHash: await derive(String(password).slice(0, MAX_PASSWORD), salt, iterations),
  };
}

// Pulls the lock out of whatever it was stored on, so a clip's customMetadata
// and a share record's own JSON can be checked by the same function.
export function lockMeta(source) {
  if (!source) return null;
  if (!source.lockHash || !source.lockSalt) return null;
  return { salt: source.lockSalt, hash: source.lockHash, iterations: Number(source.lockIter) || LOCK_ITERATIONS };
}

// Three answers, not a boolean: "no password was sent" is a different thing to
// say than "that password is wrong", and the page shows a field for the first
// and an error for the second.
export async function checkLock(meta, supplied) {
  if (!meta) return 'ok';
  if (!supplied) return 'missing';
  const attempt = await derive(String(supplied).slice(0, MAX_PASSWORD), fromHex(meta.salt), meta.iterations);
  // Both sides are fixed-length hex of the same digest, so the walk leaks
  // nothing and takes the same time whichever character differs.
  if (attempt.length !== meta.hash.length) return 'bad';
  let diff = 0;
  for (let i = 0; i < attempt.length; i++) diff |= attempt.charCodeAt(i) ^ meta.hash.charCodeAt(i);
  return diff === 0 ? 'ok' : 'bad';
}

export function newId() {
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
export function envNum(value, fallback) {
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
export function ttlDays(env) {
  return envNum(env.CLIP_TTL_DAYS, TTL_DAYS);
}

function maxBytes(env, unlocked) {
  if (unlocked) {
    return envNum(env.CLIP_MAX_BYTES_UNLOCKED, MAX_BYTES_UNLOCKED) || MAX_BYTES_UNLOCKED;
  }
  return envNum(env.CLIP_MAX_BYTES, MAX_BYTES) || MAX_BYTES;
}

function tooLargeError(max) {
  return `That clip is over the ${Math.round(max / (1024 * 1024))} MB limit.`;
}

function quotaError(survey, uploader, size, limits, unlocked) {
  // The bucket ceiling holds for a keyed upload too. It is the line between R2's
  // free tier and a bill, which is not something an override should step over by
  // accident; the per-uploader share below is the one the key is for.
  if (!survey.complete || survey.count >= limits.objects || survey.bytes + size > limits.total) {
    return 'The clip library is full right now. Clips expire on their own, so try again later.';
  }
  if (unlocked) return null;
  if ((survey.perUploader.get(uploader) || 0) + size > limits.perUploader) {
    return 'You have hit your share limit. Your older clips expire on their own.';
  }
  return null;
}

export async function handleUpload(request, env, ctx, headers) {
  if (!env.CLIPS) {
    return json({ error: 'Clip storage is not configured.' }, 503, headers);
  }

  const key = await checkUploadKey(request, env);
  const unlocked = key === 'valid';

  // The limiter runs before the refusal below, so guessing at the key is throttled
  // exactly the way a flood of uploads is. A key that checks out skips it: the
  // point of the override is to get a batch through in one go.
  if (env.CLIP_UPLOADS && !unlocked) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.CLIP_UPLOADS.limit({ key: ip });
    if (!success) {
      return json({ error: 'Too many uploads from here. Wait a minute and try again.' }, 429, headers);
    }
  }

  if (key === 'invalid') {
    return json({ error: 'That upload key was not recognised.' }, 403, headers);
  }

  // Reject on the declared length before reading a byte, so an oversized upload
  // costs one round trip instead of a full transfer.
  const max = maxBytes(env, unlocked);
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > max) {
    return json({ error: tooLargeError(max) }, 413, headers);
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
  const early = quotaError(survey, uploader, declared || 0, limits, unlocked);
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
  const full = quotaError(survey, uploader, buf.byteLength, limits, unlocked);
  if (full) return json({ error: full }, 507, headers);

  const id = newId();
  const name = decodeName(request.headers.get('x-clip-name'));

  // Set here or never. The uploader is the only caller who is certainly the
  // owner, so this is the one moment a lock can be attached without letting a
  // recipient lock a clip that is not theirs.
  const password = request.headers.get('x-clip-lock');
  const lock = password ? await makeLock(password, env) : null;

  try {
    await env.CLIPS.put(`clips/${id}`, buf, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { name, uploadedAt: new Date().toISOString(), up: uploader, ...lock },
    });
  } catch {
    return json({ error: 'Could not store that clip.' }, 502, headers);
  }

  const ttl = ttlDays(env);
  const expiresAt = new Date(Date.now() + ttl * 86400000).toISOString();
  return json({ id, name, expiresAt, expiresInDays: ttl, locked: Boolean(lock) }, 200, headers);
}

export async function handleFetchClip(request, env, id, headers) {
  if (!env.CLIPS) return new Response('Clip storage is not configured.', { status: 503, headers });
  if (!ID_RE.test(id)) return new Response('Not found', { status: 404, headers });

  // A playlist asks for one HEAD per track just to label its rows, so a HEAD is
  // served from metadata rather than by reading the object and throwing the bytes
  // away.
  const headOnly = request.method === 'HEAD';
  const object = headOnly
    ? await env.CLIPS.head(`clips/${id}`)
    : await env.CLIPS.get(`clips/${id}`, {
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

  // The name the clip was uploaded under. A playlist shows a row per track before
  // any of them have played, and this is the only place that name is kept.
  const stored = object.customMetadata && object.customMetadata.name;
  if (stored) out.set('x-clip-name', encodeURIComponent(stored));

  // Whether a delete will ask for a password. Only that a lock exists, never any
  // part of it: the page uses this to show a password field before the visitor
  // presses a button that would otherwise fail for no visible reason.
  if (lockMeta(object.customMetadata)) out.set('x-clip-locked', '1');

  if (headOnly) {
    out.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers: out });
  }

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

// The link is the permission, unless the uploader set one of their own. A clip id
// is 128 random bits, so it cannot be arrived at by guessing, and by default
// whoever the sharer sent it to can take the clip down again — the link does not
// only grant listening, it grants deleting, and it deletes for everyone rather
// than just for the caller. An uploader who does not want that sets a password at
// upload time, and this route then asks for it.
//
// Either way the clip expires on its own after CLIP_TTL_DAYS. The password moves
// the delete button behind a check; it does not make anything permanent.
export async function handleDeleteClip(request, env, id, headers) {
  if (!env.CLIPS) return json({ error: 'Clip storage is not configured.' }, 503, headers);
  if (!ID_RE.test(id)) return json({ error: 'Not found' }, 404, headers);

  const object = await env.CLIPS.head(`clips/${id}`);

  // Before the password is checked, so guessing at one is throttled the same way
  // a flood of deletes is. An id that is not locked at all costs a limiter call
  // it does not need, which is cheaper than a route where the limit only applies
  // to the requests an attacker is making.
  if (env.CLIP_DELETES) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.CLIP_DELETES.limit({ key: ip });
    if (!success) {
      return json({ error: 'Too many deletes from here. Wait a minute and try again.' }, 429, headers);
    }
  }

  // Checked against the clip's own metadata, so a clip whose audio is already
  // gone cannot be used to sweep a locked one: with no object there is no lock to
  // read, and all that is left under the id is an orphaned transcript.
  const lock = lockMeta(object && object.customMetadata);
  if (lock) {
    const verdict = await checkLock(lock, request.headers.get('x-clip-lock'));
    if (verdict !== 'ok') {
      return json({
        error: verdict === 'missing'
          ? 'That clip is password protected. Enter the password to delete it.'
          : 'That password does not match.',
        locked: true,
      }, verdict === 'missing' ? 401 : 403, headers);
    }
  }

  // The cached transcript goes with the audio, whether or not the audio is still
  // there. An expired clip can outlive its own bytes as text, and a delete that
  // left that readable would not be a delete.
  const keys = [`clips/${id}`];
  let cursor;
  let truncated = true;
  let pages = 0;
  while (truncated && pages < MAX_LIST_PAGES) {
    const listed = await env.CLIPS.list({ prefix: `tx/c/${id}/`, limit: 1000, cursor });
    for (const obj of listed.objects) keys.push(obj.key);
    truncated = listed.truncated;
    cursor = listed.cursor;
    pages += 1;
  }

  try {
    await env.CLIPS.delete(keys);
  } catch {
    return json({ error: 'Could not delete that clip.' }, 502, headers);
  }

  // Reported missing only after the sweep, so a retry of a half-finished delete
  // still clears whatever was left behind rather than being turned away at the door.
  if (!object) return json({ error: 'That clip is already gone.' }, 404, headers);
  return json({ deleted: true, id }, 200, headers);
}
