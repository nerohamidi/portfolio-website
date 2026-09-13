# Portfolio website

Plain HTML, one stylesheet, and three scripts. No build step: what is in the
repository is what is served.

```
index.html                 home
about/                     experience, education, skills, coursework
projects/                  project list
playroom/                  the three tools
  signals/                 wave playground        (assets/js/signals.js)
  audio/                   Signal Share           (assets/js/audio.js)
  chatbot/                 chat about Nero        (assets/js/chat.js)
assets/style.css           the only stylesheet
assets/images, audio       project figures and the demo track
api-proxy/                 the Cloudflare Worker behind the chatbot and Signal Share
test/                      tests for Signal Share's page logic
```

## Hosting

GitHub Pages serves the `main` branch at
<https://nerohamidi.github.io/portfolio-website/>. Pages runs Jekyll over the
repository, which for plain HTML means copying files; `_config.yml` only lists
what to leave out (the Worker source, tests, resumes).

Pushing to `main` deploys. Links inside the site are relative, so it also works
served from any directory.

## Working locally

Any static file server will do. The Worker accepts requests from
`http://localhost:4000`, so use that port if the chatbot or Signal Share's
uploads are needed:

```
python3 -m http.server 4000
```

## Tests

```
npm install      # jsdom, for the page tests
npm test
```

`test/audio.test.mjs` drives Signal Share's real script in jsdom: the link
format, the playlist, sharing, deleting and the transcript pump. The Worker's
own tests are in `api-proxy/test`; see `api-proxy/CLIPS.md` for the routes
and how the Worker is deployed.
