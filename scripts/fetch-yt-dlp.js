/**
 * Runs during `vercel build` (via the "build" npm script). Downloads the
 * static, self-contained yt-dlp Linux binary into bin/yt-dlp and makes it
 * executable, so api/song.js can call it as a subprocess at runtime.
 *
 * We fetch a fresh binary on every build rather than committing it to git,
 * since yt-dlp ships frequent updates to keep up with YouTube's changes —
 * an old binary is the most common cause of extraction breaking.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
const BIN_DIR   = path.join(process.cwd(), 'bin')
const BIN_PATH  = path.join(BIN_DIR, 'yt-dlp')

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // GitHub release downloads redirect (302) to the actual asset URL
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, dest))
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`download failed: HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        writeFileSync(dest, Buffer.concat(chunks))
        resolve()
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true })
  console.log('Downloading yt-dlp binary...')
  await download(YTDLP_URL, BIN_PATH)
  chmodSync(BIN_PATH, 0o755)
  console.log('yt-dlp binary ready at', BIN_PATH)
}

main().catch((e) => {
  console.error('Failed to fetch yt-dlp:', e)
  process.exit(1)
})
