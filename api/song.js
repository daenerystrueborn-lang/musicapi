/**
 * GET /api/song?q=<search query or YouTube URL>
 *
 * Uses the bundled yt-dlp binary (bin/yt-dlp) to resolve a search query
 * or YouTube link into a direct, playable audio stream URL — WITHOUT
 * downloading the audio itself. This keeps execution well under Vercel's
 * 10s Hobby-plan limit, since yt-dlp with --dump-json + --no-download
 * only extracts metadata and stream URLs, it never pulls the media file.
 *
 * The caller (the bot) is responsible for actually downloading the
 * bytes from the returned audioUrl.
 *
 * Response shape:
 * {
 *   title: string,
 *   artist: string | null,
 *   duration: number,        // seconds
 *   thumbnail: string | null,
 *   audioUrl: string,        // direct, time-limited stream URL
 *   sourceUrl: string        // the youtube.com/watch?v=... URL
 * }
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const execFileAsync = promisify(execFile)

// Path to the bundled static yt-dlp binary (see bin/README.md for how it
// gets there). Vercel includes files referenced like this in the function
// bundle automatically when using the Node.js runtime.
const YTDLP_PATH = path.join(process.cwd(), 'bin', 'yt-dlp')

// YouTube increasingly blocks anonymous/datacenter requests with
// "Sign in to confirm you're not a bot". Passing real browser cookies
// (exported from a logged-in YouTube session) makes yt-dlp look like an
// authenticated browser instead of an anonymous script, which avoids this.
//
// Cookies are read from cookies.txt committed at the project root (only
// safe because this repo is private — never commit this to a public repo).
// See README.md for how to set this up.
//
// yt-dlp writes updated cookies back to whatever file it's pointed at
// after each run — but Vercel's deployed bundle (process.cwd()) is
// read-only at runtime, which crashes yt-dlp with an OSError. So we copy
// the committed cookies.txt into /tmp (the one writable directory in a
// Vercel function) on each cold start, and point yt-dlp at that copy.
const COOKIES_SOURCE_PATH = path.join(process.cwd(), 'cookies.txt')
const COOKIES_TMP_PATH    = path.join(os.tmpdir(), 'cookies.txt')

function getCookiesPath() {
  if (!fs.existsSync(COOKIES_SOURCE_PATH)) return null
  if (!fs.existsSync(COOKIES_TMP_PATH)) {
    fs.copyFileSync(COOKIES_SOURCE_PATH, COOKIES_TMP_PATH)
  }
  return COOKIES_TMP_PATH
}

function isYouTubeUrl(str) {
  return /(?:youtube\.com|youtu\.be)/i.test(str)
}

function isBotBlocked(message) {
  return /Sign in to confirm/i.test(message || '')
}

export default async function handler(req, res) {
  const q = (req.query.q || '').toString().trim()

  if (!q) {
    return res.status(400).json({ error: 'missing ?q= search query or YouTube URL' })
  }

  if (!fs.existsSync(YTDLP_PATH)) {
    return res.status(500).json({ error: 'yt-dlp binary not found — see bin/README.md' })
  }

  // yt-dlp accepts "ytsearch1:<query>" to search and take the top result,
  // or a direct URL if one was passed in.
  const target = isYouTubeUrl(q) ? q : `ytsearch1:${q}`

  const args = [
    target,
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    // The "web" client (yt-dlp's default) requires a PO token that only
    // real browser JS can generate — something yt-dlp can't produce on
    // its own, which is what causes "Sign in to confirm you're not a
    // bot" and "page needs to be reloaded" on server IPs. The android
    // client uses a different auth path that doesn't require this token,
    // so it often works from datacenter IPs where the web client won't.
    '--extractor-args', 'youtube:player_client=android',
  ]

  const cookies = getCookiesPath()
  if (cookies) {
    args.push('--cookies', cookies)
  }

  try {
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      args,
      {
        timeout: 8_500, // stay under Vercel's 10s Hobby limit with margin
        maxBuffer: 10 * 1024 * 1024,
      },
    )

    // ytsearch1: with --dump-json prints one JSON object per line;
    // a direct URL also prints exactly one line.
    const line = stdout.trim().split('\n')[0]
    const info = JSON.parse(line)

    const audioUrl = info.url || info.requested_formats?.[0]?.url
    if (!audioUrl) {
      return res.status(502).json({ error: 'no audio stream URL found for this result' })
    }

    return res.status(200).json({
      title:     info.track || info.title || q,
      artist:    info.artist || info.uploader || null,
      duration:  info.duration ?? null,
      thumbnail: info.thumbnail || null,
      audioUrl,
      sourceUrl: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
    })
  } catch (e) {
    const timedOut  = e.killed || e.signal === 'SIGTERM'
    const botBlocked = isBotBlocked(e.message)
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? 'extraction timed out'
        : botBlocked
          ? 'YouTube is blocking this request as a bot — refresh cookies.txt (see README.md)'
          : (e.message || 'extraction failed'),
    })
  }
}
