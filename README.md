# song-api

A tiny Vercel API that turns a search query (or YouTube link) into a direct,
playable audio stream URL — fast, using `yt-dlp` under the hood. It does
**not** download the audio itself; that keeps it well under Vercel's
10-second Hobby-plan execution limit.

## How it works

`GET /api/song?q=<query>` runs `yt-dlp --dump-json --no-download` against
either a `ytsearch1:` query or a direct YouTube URL, and returns:

```json
{
  "title": "Never Gonna Give You Up",
  "artist": "Rick Astley",
  "duration": 213,
  "thumbnail": "https://...",
  "audioUrl": "https://... (direct, time-limited stream link)",
  "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

Your bot then downloads `audioUrl` itself (a normal HTTP GET, same as any
other file download) and does whatever conversion/sending it already does.

**Important:** `audioUrl` is a signed, time-limited link direct from
YouTube's CDN — it expires after a while and is meant to be used
immediately, not stored. Always call `/api/song` fresh for each request
rather than caching the URL.

## Deploying

1. Push this folder to a GitHub repo (or a subfolder of one).
2. Import it into Vercel as a new project.
3. No environment variables are needed.
4. Deploy. During the build, `scripts/fetch-yt-dlp.js` downloads the
   latest static `yt-dlp` Linux binary into `bin/yt-dlp` and marks it
   executable — this happens fresh on every deploy, so you always get
   the latest yt-dlp (important, since YouTube changes things and old
   yt-dlp versions stop working).
5. Once deployed, test it directly in your browser:
   `https://your-project.vercel.app/api/song?q=never gonna give you up`

## Calling it from your bot

```js
const res = await fetch(
  `https://your-project.vercel.app/api/song?q=${encodeURIComponent(query)}`
)
if (!res.ok) {
  const { error } = await res.json()
  throw new Error(error || 'song-api request failed')
}
const song = await res.json()
// song.audioUrl -> download this yourself, same as your existing fetchBuffer()
```

## Fixing "Sign in to confirm you're not a bot"

YouTube has been aggressively blocking anonymous requests from cloud/server
IPs (like Vercel's) with this error. The fix is to give yt-dlp real browser
cookies so it looks like a logged-in session instead of an anonymous bot.

**⚠️ This only works safely because this repo is private.** The cookies
file is a real, live YouTube session — anyone with it can access that
account's session. Never commit it to a public repo. If this repo is ever
made public, remove `cookies.txt` and rotate (re-export) the cookies first.

> **Note on multiple accounts:** trying several cookie files per request
> was considered, to fall back to a backup account if one gets blocked.
> It doesn't fit Vercel Hobby's 10-second function limit though — each
> yt-dlp attempt needs most of that budget on its own, so splitting time
> across several attempts just causes timeouts. Stick to one cookies.txt;
> if it gets flagged, replace it with a fresh export (steps below).

**1. Install a cookie export extension** in Chrome or Firefox — search for
   "Get cookies.txt LOCALLY" (a well-reviewed, open-source extension).

**2. Log into YouTube** in that browser — ideally a secondary/throwaway
   Google account rather than your main one, since this session will live
   on a server.

**3. On youtube.com, click the extension and export cookies** as
   `cookies.txt` (Netscape format).

**4. Place that file at the project root**, i.e. `vercel-song-api/cookies.txt`
   (same folder as `package.json` and `vercel.json`).

**5. Commit and push it to your repo.**
   ```
   git add cookies.txt
   git commit -m "add yt-dlp cookies"
   git push
   ```

**6. Vercel auto-redeploys.** `song.js` automatically picks up
   `cookies.txt` from the project root — no environment variable or extra
   config needed.

**Cookies expire eventually** (Google periodically invalidates sessions).
If the bot-detection error comes back after a while, just repeat steps 1-5
with a fresh export to replace the file.

## Limitations / things to know

- **Hobby plan timeout (10s):** extraction is given an internal 8s budget
  with a bit of safety margin. Occasionally a slow YouTube response could
  still time out — the bot should treat a `504` response as "try again"
  rather than a hard failure.
- **No caching:** every call re-runs yt-dlp fresh. If you expect heavy
  reuse of the same songs, consider adding a short-lived cache (e.g.
  Vercel KV) mapping query → last resolved audioUrl + expiry, to cut
  down repeat extractions. Not included here to keep this simple — ask
  if you want it added.
- **Rate limiting:** this hits YouTube directly via yt-dlp, same as any
  scraper. Heavy traffic from one Vercel deployment could eventually get
  rate-limited or blocked by YouTube. There's no bulletproof fix for
  this; it's the same tradeoff every YouTube-downloader tool has.
- **audioUrl format:** usually `m4a`/AAC audio (YouTube's typical adaptive
  audio format.) Your existing `toAudio()` conversion step should handle
  turning this into MP3, same as it currently does for the `nayan`/`ytdl`
  fallback paths in your bot.
