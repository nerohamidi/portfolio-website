# Shareable audio clips

Signal Share (`/playroom/audio/`, markup in `_includes/audio-app.html`, logic in
`_includes/audio-engine.html`) puts its control state in the URL hash and, when the
user has loaded their own audio, stores the file in R2 and puts its id in the hash too.
This Worker serves both halves of that.

The wave playground at `/playroom/signals/` is a separate app and does not talk to this
Worker at all.

## Routes

| Route | Method | Notes |
|---|---|---|
| `/` | POST | The chatbot proxy. Unchanged. |
| `/clip` | POST | Upload. Origin-allowlisted, size and storage caps enforced, audio signature required, 6 uploads per minute per IP. Returns `{ id, name, expiresAt, expiresInDays }`. |
| `/clip/<id>` | GET, HEAD | Serves the clip. Readable from any origin, supports Range so the seek bar works. |

Uploads are validated by container signature (MP3, WAV, OGG, FLAC, MP4/M4A, AIFF, WebM,
CAF) rather than by the declared `Content-Type`, which is only a claim by the client.
Without that check the endpoint is a general-purpose file host.

Keys are 16 random bytes, base64url. That, not the origin check, is what protects a
clip: `GET /clip/<id>` deliberately answers any origin so a shared link works wherever
the recipient opens it.

## One-time setup

Already done for the live bucket; kept here for a rebuild or a second environment.

```bash
npx wrangler r2 bucket create nero-signal-clips --location=wnam
npx wrangler r2 bucket lifecycle add nero-signal-clips expire-clips clips/ --expire-days 30
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
`GEMINI_API_KEY` and will return a 502 without it; the clip routes do not.

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
rather than expressing a daily quota. The storage caps above are what actually bound
the bill.
