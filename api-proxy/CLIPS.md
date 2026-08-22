# Shareable audio clips

Signal Share (`/playroom/audio/`, markup in `_includes/audio-app.html`, logic in
`_includes/audio-engine.html`) puts its control state in the URL hash and, when the
user has loaded their own audio, stores the file in R2 and puts its id in the hash too.
A share now carries a *playlist* of those ids rather than a single one. This Worker
serves both halves of that, plus the transcription the page runs while a track plays.

The wave playground at `/playroom/signals/` is a separate app and does not talk to this
Worker at all.

## Routes

| Route | Method | Notes |
|---|---|---|
| `/` | POST | The chatbot proxy. Unchanged. |
| `/clip` | POST | Upload. Origin-allowlisted, size and storage caps enforced, audio signature required, 12 uploads per minute per IP. Returns `{ id, name, expiresAt, expiresInDays }`. |
| `/clip/<id>` | GET, HEAD | Serves the clip. Readable from any origin, supports Range so the seek bar works. Both methods return `X-Clip-Name`; HEAD is answered from metadata without reading the object, which is how a restored playlist labels its rows. |
| `/transcribe` | POST | One window of 16 kHz mono WAV. Origin-allowlisted, 30 per minute per IP, bounded by a daily audio budget. Returns segments in track time. |
| `/transcript/<id>` | GET, HEAD | Every window already transcribed for a clip. Readable from any origin, like the clip itself. |

Uploads are validated by container signature (MP3, WAV, OGG, FLAC, MP4/M4A, AIFF, WebM,
CAF) rather than by the declared `Content-Type`, which is only a claim by the client.
Without that check the endpoint is a general-purpose file host.

Keys are 16 random bytes, base64url. That, not the origin check, is what protects a
clip: `GET /clip/<id>` deliberately answers any origin so a shared link works wherever
the recipient opens it.

## Playlists

A playlist is not stored anywhere. The hash carries `t=`, an ordered list of refs
(`d` for the demo, a bare 22-character id for a clip), and `i=`, the track it opens
on. Ten tracks is about 250 characters, which is why the list lives in the link
rather than in a manifest object with its own id, TTL and quota.

Names are not in the link. A clip already knows its own name from the upload, so a
restored playlist fires one HEAD per track and labels its rows from `X-Clip-Name`.
The only name in the hash is `n=`, the opening track's, so the note at the top of a
shared page can be specific before any audio has been fetched.

`v=3` marks the new format. `v=2` links, which carry a single `a=<ref>`, still open;
see `applyState` in the engine.

Sharing a playlist uploads each local file in turn, one request at a time. That is
what `MAX_QUEUE` in the engine and the upload rate limit have to agree about: a
playlist that cannot be uploaded inside one rate-limit window cannot be shared at
all.

## Transcription

The page cuts the decoded track into ~12 second windows, resamples each to 16 kHz
mono WAV, and posts it a little ahead of the playhead, so the words arrive in time
with the audio. Cuts land on the quietest 20 ms near the target length, because a
window that ends mid-word loses that word twice.

Whisper runs here rather than in the browser because the Web Speech API only ever
listens to a microphone; there is no way to hand it a file.

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

Workers AI's free allocation is 10,000 Neurons a day and
`@cf/openai/whisper-large-v3-turbo` costs 46.63 Neurons per audio minute, so free
is worth about 214 audio minutes.

| Var | Default | What it bounds |
|---|---|---|
| `TRANSCRIBE_MAX_DAILY_SECONDS` | 7200 | Audio transcribed per UTC day, across everyone. 120 minutes, so a full day still bills nothing. |
| `TRANSCRIBE_MAX_CHUNK_SECONDS` | 30 | One window. The page sends ~12s; the cap is what stops a hand-made request billing an album in one call. |

The counter lives at `tx/usage/<YYYY-MM-DD>` and is read, added to, and written
back. Two requests finishing together can each miss the other's increment, so the
stored total is a floor and a day's real spend can run slightly past it. The 90
minutes between the cap and the free allocation absorb far more than that; a
counter that could not drift would need a Durable Object, which is a lot of
machinery for a budget guard.

The rate limit is per IP and per minute, so it shapes bursts. The daily budget is
what actually bounds the bill.

## One-time setup

Already done for the live bucket; kept here for a rebuild or a second environment.

```bash
npx wrangler r2 bucket create nero-signal-clips --location=wnam
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-clips clips/ --expire-days 30
# Cached transcripts and the daily usage counters, which the clips/ rule does not reach.
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-transcripts tx/ --expire-days 30
npx wrangler deploy
```

`wrangler r2 object delete` hits the **local** dev store unless you pass `--remote`, and
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

R2 is memory-backed locally and resets on restart. The chatbot route needs
`GEMINI_API_KEY` and will return a 502 without it; the clip routes do not. Workers
AI always runs remotely, so `/transcribe` bills real Neurons even under
`--local`.

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

The transcription model is `MODEL` in `src/transcribe.js`. Window length, how far
ahead of the playhead the page works, and how many tracks a playlist holds are all
constants at the top of `_includes/audio-engine.html`.
