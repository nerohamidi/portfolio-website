# Shareable audio clips

Signal Share (`/playroom/audio/`, markup in `_includes/audio-app.html`, logic in
`_includes/audio-engine.html`) puts its control state in the URL hash and, when the
user has loaded their own audio, stores the file in R2 and puts its id in the hash too.
A share now carries a *playlist* of those ids rather than a single one. This Worker
serves both halves of that, plus the preview card a titled share links through, plus
the transcription the page runs when a listener asks for one.

The wave playground at `/playroom/signals/` is a separate app and does not talk to this
Worker at all.

## Routes

| Route | Method | Notes |
|---|---|---|
| `/` | POST | The chatbot proxy. Unchanged. |
| `/clip` | POST | Upload. Origin-allowlisted, size and storage caps enforced, audio signature required, 12 uploads per minute per IP. `X-Clip-Lock` sets the delete password. Returns `{ id, name, expiresAt, expiresInDays, locked }`. |
| `/clip/<id>` | GET, HEAD | Serves the clip. Readable from any origin, supports Range so the seek bar works. Both methods return `X-Clip-Name`, and `X-Clip-Locked: 1` when a delete will ask for a password; HEAD is answered from metadata without reading the object, which is how a restored playlist labels its rows. |
| `/clip/<id>` | DELETE | Removes the clip and every cached transcript window under `tx/c/<id>/`. Open to any origin, like the read; 10 per minute per IP. Asks for `X-Clip-Lock` if the clip was uploaded with one: 401 with no password, 403 with the wrong one. Returns `{ deleted: true, id }`, or 404 if the audio was already gone — the transcript sweep still runs first, so a retry finishes a half-done delete. |
| `/share` | POST | Files a preview card: `{ hash, title, note }`, plus `X-Clip-Lock` for the same password. Origin-allowlisted, 12 a minute per IP. Returns `{ id, url, locked, expiresInDays }`. |
| `/s/<id>` | GET, HEAD | The card. An HTML document carrying the sender's title and note as `og:` tags, which forwards a browser on to the page with the full hash. Open to everyone: this is the URL that gets forwarded around. |
| `/share/<id>` | DELETE | Removes a card. Same password rules as the clip delete. |
| `/transcribe` | POST | One window of 16 kHz mono WAV. Origin-allowlisted, 30 per minute per IP, bounded by a daily audio budget. Returns segments in track time. |
| `/transcript/<id>` | GET, HEAD | Every window already transcribed for a clip. Readable from any origin, like the clip itself. |

Uploads are validated by container signature (MP3, WAV, OGG, FLAC, MP4/M4A, AIFF, WebM,
CAF) rather than by the declared `Content-Type`, which is only a claim by the client.
Without that check the endpoint is a general-purpose file host.

Keys are 16 random bytes, base64url. That, not the origin check, is what protects a
clip: `GET /clip/<id>` deliberately answers any origin so a shared link works wherever
the recipient opens it.

**By default the link is also the delete permission.** `DELETE /clip/<id>` asks for
nothing beyond the id, so anyone the link reaches can take the clip down, and it goes
down for everyone rather than just for them. 128 random bits cannot be guessed at, so
the clip is safe from strangers; it is not safe from a recipient. Sending someone a
link is handing them the delete button, and the page says so beside the button.

### The delete password

That trade is right for something sent to one person and wrong for something forwarded
on, so an uploader may set a password: `X-Clip-Lock` on `POST /clip`, stored as PBKDF2
over a random 16-byte salt, with the salt and the iteration count kept beside the hash
in the clip's custom metadata. `DELETE /clip/<id>` then asks for the same header, and
answers 401 with no password and 403 with a wrong one — the page shows a field for the
first and an error for the second, so a recipient is never left guessing which it was.

**Set at upload or never.** There is deliberately no route that adds a lock to a clip
that is already up. Such a route could only be authorised by the id, which is exactly
what a recipient has, so it would let whoever was sent a link lock the *uploader* out
of their own clip. Locking nothing is a smaller failure than that. The page enforces
the same rule from the other side by disabling the field once anything in the queue has
been uploaded.

The iteration count is modest — 50,000, in `CLIP_LOCK_ITERATIONS` — because it is not
the thing standing between an attacker and the clip. The 128-bit id is, and
`CLIP_DELETES` (10 a minute per IP, checked *before* the password) is what shapes
online guessing. The stretching is there for the one case neither covers: a leak of the
bucket's metadata, where a password someone reused elsewhere must not fall out of it in
plaintext. Because the count is stored per clip, raising it later leaves every lock
already written working.

**A lock bounds deletion and nothing else.** The clip still expires after
`CLIP_TTL_DAYS`, and the lifecycle rule still sweeps it, so a forgotten password costs
a wait rather than a permanent object in the bucket. It also does not make the audio
private: `GET /clip/<id>` is unchanged, because a shared link has to play for whoever
opens it.

### The upload key

`X-Clip-Key` on `POST /clip`, compared against the `CLIP_ADMIN_KEY` secret. A request
that carries a valid key uploads up to `CLIP_MAX_BYTES_UNLOCKED` instead of
`CLIP_MAX_BYTES`, skips the per-minute rate limit, and is exempt from the per-uploader
byte cap. It is **not** exempt from the bucket-wide ceiling: that is the line between
R2's free tier and a bill, which no override should cross by accident.

Comparison is over SHA-256 digests of both sides, so it takes the same time whichever
byte differs and reveals nothing about the key's length. A key that is sent and does not
match is refused with 403 rather than quietly falling back to the normal ceiling, so a
mistyped key does not surface as a confusing 12 MB error — and that refusal happens
*after* the rate limiter, so guessing is throttled like any other upload.

With no `CLIP_ADMIN_KEY` set there is no override at all: any key sent is treated as
wrong. An absent secret must never read as "anything matches".

The page keeps the key in `sessionStorage`, never `localStorage`, and never puts it in
a share hash. It is sent as a request header and nowhere else.

## Playlists

A playlist is not stored anywhere. The hash carries `t=`, an ordered list of refs
(`d` for the demo, a bare 22-character id for a clip), and `i=`, the track it opens
on. Ten tracks is about 250 characters, which is why the list lives in the link
rather than in a manifest object with its own id, TTL and quota.

Names are not in the link. A clip already knows its own name from the upload, so a
restored playlist fires one HEAD per track and labels its rows from `X-Clip-Name`.
The only name in the hash is `n=`, the opening track's, so the note at the top of a
shared page can be specific before any audio has been fetched.

The sender's own words ride along too: `ti=` for the title and `no=` for the note,
and `s=` for the card the link arrived by, which the card itself appends on the way
through. `v=3` marks the format. `v=2` links, which carry a single `a=<ref>`, still
open; see `applyState` in the engine.

Sharing a playlist uploads each local file in turn, one request at a time. That is
what `MAX_QUEUE` in the engine and the upload rate limit have to agree about: a
playlist that cannot be uploaded inside one rate-limit window cannot be shared at
all.

## Preview cards

A hash never reaches a server. That is what lets the page be static, and it is also
why a link straight at it cannot preview: iMessage, Slack and the rest fetch the URL
and read its meta tags, and the fragment is not part of what they fetch. A plain share
link therefore unfurls as whatever `/playroom/audio/` says about itself and nothing
about what was shared.

So a share with a title or a note is wrapped. `POST /share` stores
`{ hash, title, note, base }` at `share/<id>`, and the link handed over points at
`/s/<id>` here instead. That route answers with a real HTML document carrying
`og:title` and `og:description`, and forwards a browser on to
`base + '#' + hash + '&s=' + id`. An unfurler reads the tags and stops; a person lands
on the same page they would have without the card.

Answering with a document rather than a `302` is the whole trick: a redirect would send
the unfurler to the static page, which is back to having nothing to say.

Three things this route must never become:

- **An open redirect.** The destination is `SHARE_PATH` appended to the allowlisted
  `Origin` that asked for the card, recorded at creation. Nothing in the request body
  is used for it. A caller-chosen destination would be a phishing link wearing a title
  its sender picked.
- **An injection.** Title and note are a stranger's text going into a document this
  Worker serves. Both are stripped of control characters, length-capped, and escaped
  for `&<>"'`; the one place a URL lands inside a `<script>` uses `JSON.stringify`,
  where `&#39;` would be wrong.
- **Free storage.** A record is a few hundred bytes, so the risk is object count, not
  bytes; the clip survey only walks `clips/`, so nothing else bounds this prefix.
  `SHARE_MAX_OBJECTS` (2000, counted by listing) and `SHARE_LINKS` (12 a minute per IP)
  are what hold it.

A card expires with everything else, and the page deletes it alongside the audio: a
card that outlived its tracks would go on advertising a playlist that is not there.
Without a title or a note no card is filed at all — the plain hash link costs no
storage and cannot expire, so it is strictly the better link when there is nothing to
preview.

## Transcription

**Nothing is transcribed until the toggle is ticked.** Not on load, not on a track
change, not on a preference remembered from last time — the press is the only thing
that starts any of it, and it is per track and per visit. There was a version of this
that remembered the choice in `localStorage` and carried it across tracks; it meant a
box ticked once could send a later track's audio to this Worker on its own, which is
not a thing to do quietly with someone's files. The lookup at `/transcript/<id>` waits
for the same press: it costs nothing, but it still tells a server which clip someone is
playing.

Once it is on, the page cuts the decoded track into ~12 second windows, resamples each
to 16 kHz mono WAV, and posts it a little ahead of the playhead, so the words arrive in
time with the audio. Cuts land on the quietest 20 ms near the target length, because a
window that ends mid-word loses that word twice.

The model runs here rather than in the browser because the Web Speech API only ever
listens to a microphone; there is no way to hand it a file.

**Gemini does the transcribing**, the same provider the chatbot half of this Worker
already uses, so the whole thing needs one credential (`GEMINI_API_KEY`) and no Workers
AI binding. It is asked for JSON against a `responseSchema` of `{ text, start, end }`
segments rather than for prose, because a caption that scrolls with the audio needs
timings and a paragraph would have to be parsed back apart. `propertyOrdering` puts
`text` first: a start and an end decided before the words are written are timings for a
line that does not exist yet.

The model is told to return an empty array when there is no intelligible speech.
Silence is where a transcriber invents, and a filtered or instrumental passage is
mostly silence as far as it is concerned — an invented line is worse than a gap,
because it scrolls past under the audio as if it had been heard. Timings that come back
outside the window are dropped rather than clamped, for the same reason.

Word-level timings do not come back from this model. The page spreads a line over its
own span when they are missing, so the caption still arrives a word at a time; see
`txSpreadWords` in the engine.

The Worker measures each window's duration from its RIFF header rather than
trusting a query parameter, which is also the format check: nothing that is not a
measurable WAV reaches the model.

Windows belonging to a clip are cached at `tx/c/<clipId>/<n>`, so the first person
to play a shared link pays for the transcription and everyone after them reads it
back for nothing. The cache is only written after a `head()` confirms the clip
exists, or an invented id would be a way to write objects into the bucket. Local
files have no id, are never cached, and are never uploaded unless the listener asks
for a transcript.

### The daily budget

Gemini bills audio at 32 tokens a second, so the cap below is about 230,000 input
tokens of audio a day across everyone.

| Var | Default | What it bounds |
|---|---|---|
| `TRANSCRIBE_MAX_DAILY_SECONDS` | 7200 | Audio transcribed per UTC day, across everyone. 120 minutes. |
| `TRANSCRIBE_MAX_CHUNK_SECONDS` | 30 | One window. The page sends ~12s; the cap is what stops a hand-made request billing an album in one call. |

The counter lives at `tx/usage/<YYYY-MM-DD>` and is read, added to, and written
back. Two requests finishing together can each miss the other's increment, so the
stored total is a floor and a day's real spend can run slightly past it — by at most
one window per request in flight, which is seconds of audio. A counter that could not
drift would need a Durable Object, which is a lot of machinery for a budget guard.

The rate limit is per IP and per minute, so it shapes bursts. The daily budget is
what actually bounds the bill.

## One-time setup

Already done for the live bucket; kept here for a rebuild or a second environment.

```bash
npx wrangler r2 bucket create nero-signal-clips --location=wnam
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-clips clips/ --expire-days 30
# Cached transcripts and the daily usage counters, which the clips/ rule does not reach.
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-transcripts tx/ --expire-days 30
# Preview cards, which neither rule above reaches.
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-shares share/ --expire-days 30
# Transcription and the chatbot share this one.
npx wrangler secret put GEMINI_API_KEY
# Optional. Without it the upload key is simply unavailable and every key is refused.
npx wrangler secret put CLIP_ADMIN_KEY
npx wrangler deploy
```

`DELETE /clip/<id>` is the supported way to remove a clip, and it clears the cached
transcript with it. `wrangler r2 object delete` hits the **local** dev store unless you pass `--remote`, and
it reports success either way. `bucket info` also lags, so it can report zero objects
while the bucket is still serving them. Confirm a real deletion with a request to
`/clip/<id>`.

The lifecycle rule is what reclaims storage. The Worker also refuses to serve anything
older than the TTL, and discounts those objects when measuring usage, so the TTL holds
even before the rule is added and on any object the rule has not swept yet. Keep
`--expire-days` and `CLIP_TTL_DAYS` in agreement.

## Local development

```bash
npx wrangler dev --local
```

R2 is memory-backed locally and resets on restart. The chatbot route and
`/transcribe` both need `GEMINI_API_KEY` — the first returns 502 without it, the
second 503 — and both call the real API even under `--local`, so a window transcribed
in development costs the same as one in production. The clip and share routes need no
credential at all.

`SHARE_PATH` is what a card appends to the allowlisted origin that asked for it, so it
has to match wherever the page is actually served: `/portfolio-website/playroom/audio/`
for both the live site and `jekyll serve`, which honours the same `baseurl`.

Tests are plain Node, no runner:

```bash
node test/worker.test.mjs   # the chatbot proxy
node test/audio.test.mjs    # clips, transcription, the transcript cache
```

The page's own logic has a harness at `../test/audio-page.test.mjs`, which drives
the real engine in jsdom and needs `npm install jsdom`.

## Storage caps

R2's free tier is 10 GB-month. Four limits keep the bucket under it, all checked
before an upload is stored:

| Var | Default | What it bounds |
|---|---|---|
| `CLIP_MAX_BYTES` | 12 MiB | One clip. |
| `CLIP_MAX_TOTAL_BYTES` | 8 GiB | The whole bucket. Sits under 10 GB so a bucket that stays full all month still bills nothing. |
| `CLIP_MAX_PER_UPLOADER_BYTES` | 200 MiB | One uploader, so a single person cannot take the whole pool and lock everyone else out. |
| `CLIP_MAX_OBJECTS` | 4000 | Object count, which also bounds the survey below. |
| `CLIP_TTL_DAYS` | 30 | How long a clip occupies the bucket. The most direct lever on storage. |

Set them in `wrangler.toml`; `src/clips.js` carries the same numbers as fallbacks.
When a cap is hit the upload gets a `507` and a message the page shows the user.

Usage is measured by listing the bucket on each upload, not by keeping a counter. A
counter would drift: the lifecycle rule deletes objects without telling the Worker, so
the running total would climb forever and eventually refuse uploads into an empty
bucket. One list call per upload is far inside the free Class A allowance.

Objects past their TTL are excluded from the total and swept in the background, so a
lagging or missing lifecycle rule cannot wedge the bucket shut.

The survey only walks `clips/`, so transcripts and usage counters do not count
against `CLIP_MAX_OBJECTS`. Nothing under `tx/` can be written without a clip that
already exists, so that prefix is bounded by the clip caps above.

The check is a read followed by a write, so two uploads racing can each pass and
together land slightly over the ceiling, by at most one clip apiece. The 2 GB of
headroom between the 8 GiB cap and the 10 GB free tier absorbs far more than that.

Check real usage with:

```bash
npx wrangler r2 bucket info nero-signal-clips
```

## Other knobs

The audio signature list is `sniffAudio` in `src/clips.js`. The upload rate limit is in
`wrangler.toml`, where `period` must be either 10 or 60 seconds, so it caps bursts
rather than expressing a daily quota; it is 12 so that a full 10-track playlist can be
shared in one go. The storage caps above are what actually bound
the bill.

The transcription model is `TRANSCRIBE_MODEL` in `wrangler.toml`, with the same value
as a fallback in `src/transcribe.js`; it has to be a model that takes audio input, and
it is a separate choice from the chatbot's, which is `MODEL` in `src/index.js`. Window
length, how far ahead of the playhead the page works, and how many tracks a playlist
holds are all constants at the top of `_includes/audio-engine.html`.
