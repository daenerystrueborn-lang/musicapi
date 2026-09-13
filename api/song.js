/**
 * GET /api/song?q=<search query or YouTube URL>
 *
 * Resolves a search query into a direct, playable audio stream URL —
 * WITHOUT downloading the audio itself, keeping execution well under
 * Vercel's 10s Hobby-plan limit.
 *
 * Tries multiple sources in order, same idea as spotDL's provider chain
 * (spotDL/spotify-downloader): SoundCloud first, since it doesn't
 * enforce YouTube-style bot detection / PO tokens, then YouTube as a
 * fallback since it's the most likely to be blocked. Both are extracted
 * with the same bundled yt-dlp binary, using its `scsearch:`/`ytsearch:`
 * search prefixes. (Bandcamp was considered too, matching spotDL's
 * provider list, but yt-dlp has no generic Bandcamp search — only
 * direct-URL extraction — so it's not usable here for a text query.)
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
 *   sourceUrl: string,       // the source page URL
 *   source: string           // which provider served this: soundcloud | youtube
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
  return /Sign in to confirm|page needs to be reloaded/i.test(message || '')
}

async function runYtDlp(target, extraArgs, timeoutMs) {
  const args = [
    target,
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--no-playlist',
    ...extraArgs,
  ]

  const { stdout } = await execFileAsync(YTDLP_PATH, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  })

  const line = stdout.trim().split('\n')[0]
  return JSON.parse(line)
}

function buildResponse(info, q, sourceName) {
  const audioUrl = info.url || info.requested_formats?.[0]?.url
  if (!audioUrl) return null

  return {
    title:     info.track || info.title || q,
    artist:    info.artist || info.uploader || null,
    duration:  info.duration ?? null,
    thumbnail: info.thumbnail || (Array.isArray(info.thumbnails) ? info.thumbnails.at(-1)?.url : null) || null,
    audioUrl,
    sourceUrl: info.webpage_url || null,
    source:    sourceName,
  }
}

// Each source: a function that builds the yt-dlp target + args for that
// provider, given the raw query. Order matches spotDL's approach of
// trying non-YouTube sources first, since SoundCloud and Bandcamp don't
// enforce YouTube's PO-token/bot-detection wall.
function buildSources(q, cookies) {
  const sources = []

  // Direct YouTube link → skip straight to YouTube, no point searching
  // SoundCloud/Bandcamp for a URL the user already gave us.
  if (isYouTubeUrl(q)) {
    sources.push({
      name: 'youtube',
      target: q,
      args: [
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '--extractor-args', 'youtube:player_client=android',
        ...(cookies ? ['--cookies', cookies] : []),
      ],
    })
    return sources
  }

  sources.push({
    name: 'soundcloud',
    target: `scsearch1:${q}`,
    args: ['-f', 'bestaudio/best'],
  })

  sources.push({
    name: 'youtube',
    target: `ytsearch1:${q}`,
    args: [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--extractor-args', 'youtube:player_client=android',
      ...(cookies ? ['--cookies', cookies] : []),
    ],
  })

  return sources
}

export default async function handler(req, res) {
  const q = (req.query.q || '').toString().trim()

  if (!q) {
    return res.status(400).json({ error: 'missing ?q= search query or YouTube URL' })
  }

  if (!fs.existsSync(YTDLP_PATH)) {
    return res.status(500).json({ error: 'yt-dlp binary not found — see bin/README.md' })
  }

  const cookies = getCookiesPath()
  const sources = buildSources(q, cookies)

  // Vercel Hobby caps functions at 10s total. Split the remaining budget
  // across sources so trying several can't itself cause a hard timeout
  // with no useful error returned. SoundCloud/Bandcamp are usually fast
  // (no bot-wall to fight), so give YouTube — the least reliable, tried
  // last — whatever's left.
  const DEADLINE_MS = 9_000
  const started      = Date.now()

  let lastError  = null
  let lastSource = null

  for (let i = 0; i < sources.length; i++) {
    const remaining = DEADLINE_MS - (Date.now() - started)
    if (remaining < 1_200) break // not enough time left to bother trying

    const src = sources[i]
    const remainingSources = sources.length - i
    const budget = Math.min(remaining, Math.max(1_500, Math.floor(remaining / remainingSources)))

    try {
      const info = await runYtDlp(src.target, src.args, budget)
      const result = buildResponse(info, q, src.name)
      if (result) {
        return res.status(200).json(result)
      }
      lastError  = new Error(`${src.name}: no audio stream URL found`)
      lastSource = src.name
    } catch (e) {
      lastError  = e
      lastSource = src.name
      continue
    }
  }

  const timedOut   = lastError?.killed || lastError?.signal === 'SIGTERM'
  const botBlocked = isBotBlocked(lastError?.message)

  return res.status(timedOut ? 504 : 500).json({
    error: timedOut
      ? 'extraction timed out across all sources'
      : botBlocked
        ? 'YouTube blocked the request as a bot, and other sources also failed — refresh cookies.txt (see README.md)'
        : (lastError?.message || 'extraction failed on all sources'),
    lastSourceTried: lastSource,
    sourcesTried: sources.map(s => s.name),
  })
}
