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
// Multiple cookie files are supported so one flagged/expired account
// doesn't take the whole thing down — cookies1.txt, cookies2.txt,
// cookies3.txt (any number works) are tried in order until one succeeds.
// Cookies are read from files committed at the project root (only safe
// because this repo is private — never commit these to a public repo).
// See README.md for how to add more.
function findCookieFiles() {
  const root = process.cwd()
  const candidates = ['cookies.txt', 'cookies1.txt', 'cookies2.txt', 'cookies3.txt']
  return candidates
    .map(name => path.join(root, name))
    .filter(p => fs.existsSync(p))
}

function isYouTubeUrl(str) {
  return /(?:youtube\.com|youtu\.be)/i.test(str)
}

function isBotBlocked(message) {
  return /Sign in to confirm/i.test(message || '')
}

async function runYtDlp(target, cookiePath, timeoutMs) {
  const args = [
    target,
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
  ]
  if (cookiePath) args.push('--cookies', cookiePath)

  const { stdout } = await execFileAsync(YTDLP_PATH, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  })

  const line = stdout.trim().split('\n')[0]
  return JSON.parse(line)
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

  const cookieFiles = findCookieFiles()
  // Always try at least once, even with no cookies at all, so a fresh
  // deployment with no cookie files yet still attempts a plain request.
  const attempts = cookieFiles.length ? cookieFiles : [null]

  // Vercel Hobby caps functions at 10s total. Split the remaining budget
  // evenly across attempts so trying several cookies can't itself cause
  // a hard timeout with no useful error returned.
  const DEADLINE_MS  = 9_000
  const started      = Date.now()
  const perAttemptMs = Math.max(2_000, Math.floor(DEADLINE_MS / attempts.length))

  let lastError = null

  for (let i = 0; i < attempts.length; i++) {
    const remaining = DEADLINE_MS - (Date.now() - started)
    if (remaining < 1_500) break // not enough time left to bother trying

    const cookiePath = attempts[i]
    try {
      const info = await runYtDlp(target, cookiePath, Math.min(perAttemptMs, remaining))

      const audioUrl = info.url || info.requested_formats?.[0]?.url
      if (!audioUrl) {
        lastError = new Error('no audio stream URL found for this result')
        continue
      }

      return res.status(200).json({
        title:     info.track || info.title || q,
        artist:    info.artist || info.uploader || null,
        duration:  info.duration ?? null,
        thumbnail: info.thumbnail || null,
        audioUrl,
        sourceUrl: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
        // helpful while testing multiple cookie files — remove if you'd
        // rather not expose which account served the request
        cookieUsed: cookiePath ? path.basename(cookiePath) : null,
      })
    } catch (e) {
      lastError = e
      // Only worth trying the next cookie file if this one was specifically
      // bot-blocked or expired — other errors (bad query, network blip)
      // won't be fixed by switching accounts, but we try anyway since it's
      // cheap and harmless.
      continue
    }
  }

  const timedOut   = lastError?.killed || lastError?.signal === 'SIGTERM'
  const botBlocked = isBotBlocked(lastError?.message)

  return res.status(timedOut ? 504 : 500).json({
    error: timedOut
      ? 'extraction timed out'
      : botBlocked
        ? 'YouTube blocked all available cookie accounts as bots — add fresh cookies (see README.md)'
        : (lastError?.message || 'extraction failed'),
    attemptsTried: attempts.length,
  })
}
