#!/usr/bin/env node
// Download .torrent files referenced in public/catalog.json into
// public/torrents/<slug>.torrent so the runtime can fetch them same-origin.
//
// Why: Internet Archive's synthesized `<id>_archive.torrent` URL does not
// reliably include CORS headers, so a browser fetch from github.io to
// archive.org fails before the bytes ever arrive. Bundling the .torrent as
// a same-origin asset removes that dependency at runtime.
//
// Run on a machine with archive.org access (this sandbox is IP-blocked, but
// any normal dev box or CI runner works), then commit the resulting files.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CATALOG = join(ROOT, 'public', 'catalog.json')
const OUT_DIR = join(ROOT, 'public', 'torrents')

const argv = process.argv.slice(2)
const force = argv.includes('--force')

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'))
  await mkdir(OUT_DIR, { recursive: true })

  let downloaded = 0
  let skipped = 0
  let failed = 0

  for (const entry of catalog) {
    if (!entry.torrent_file_source) continue
    if (!entry.torrent_file) {
      console.warn(`  [skip] ${entry.slug}: torrent_file_source set but torrent_file (local path) missing`)
      skipped++
      continue
    }
    const outPath = join(ROOT, 'public', entry.torrent_file)
    if (existsSync(outPath) && !force) {
      console.log(`  [keep] ${entry.slug}: ${entry.torrent_file} already present (use --force to refetch)`)
      skipped++
      continue
    }
    process.stdout.write(`  [get ] ${entry.slug}: ${entry.torrent_file_source} ... `)
    try {
      const res = await fetch(entry.torrent_file_source, {
        headers: { 'User-Agent': 'rom-seeker fetch-torrents' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 100 || buf[0] !== 0x64 /* 'd' */) {
        throw new Error(`response is not a bencoded .torrent (${buf.length} bytes)`)
      }
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, buf)
      console.log(`${buf.length} bytes`)
      downloaded++
    } catch (err) {
      console.log(`FAILED: ${err.message}`)
      failed++
    }
  }

  console.log(`\n${downloaded} downloaded, ${skipped} skipped, ${failed} failed`)
  if (failed) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
