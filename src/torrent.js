import WebTorrent from 'webtorrent/dist/webtorrent.min.js'
import streamSaver from 'streamsaver'

const dlog = (m) => window.dlog && window.dlog('[wt] ' + m)
const dok = (m) => window.dok && window.dok('[wt] ' + m)
const dwarn = (m) => window.dwarn && window.dwarn('[wt] ' + m)
const derr = (m) => window.derr && window.derr('[wt] ' + m)

dok('torrent.js loaded; WebTorrent type=' + (typeof WebTorrent))

// Public WSS trackers — added to every torrent so browser peers can find each other
// even when the magnet's own announce list is HTTP/UDP-only (typical of IA torrents).
export const WSS_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
]

let _client = null
export function getClient() {
  if (!_client) {
    try {
      _client = new WebTorrent()
      dok('client created; WEBRTC_SUPPORT=' + WebTorrent.WEBRTC_SUPPORT)
    } catch (err) {
      derr('client init failed: ' + (err.message || err))
      throw err
    }
    _client.on('error', (err) => derr('client error: ' + (err.message || err)))
    _client.on('warning', (err) => dwarn('client warning: ' + (err.message || err)))
  }
  return _client
}

const _torrentsByHash = new Map()
const _addPromises = new Map() // torrentId (magnet/hash) -> Promise<Torrent>

const METADATA_WARN_MS = 30_000

// Default-on seeding: after a download completes the tab keeps the pieces
// selected and serves them to other browsers in the swarm. The opt-out
// destroys completed torrents so the tab stops uploading.
let _seedingEnabled = true
export function isSeedingEnabled() { return _seedingEnabled }
export function setSeedingEnabled(enabled) {
  _seedingEnabled = !!enabled
  dlog('seeding=' + _seedingEnabled)
  if (!_seedingEnabled) {
    for (const [, t] of Array.from(_torrentsByHash.entries())) {
      // Only tear down torrents that aren't actively pulling pieces — leaving
      // an in-flight download alone; it'll clean itself up on completion via
      // downloadFile's end handler.
      if (t.progress >= 1 || (t.downloadSpeed || 0) < 1024) _destroyTorrent(t)
    }
  }
}

function _destroyTorrent(torrent) {
  const hash = torrent.infoHash
  const id = torrent._romSeekerTorrentId
  try { torrent.destroy() } catch {}
  if (hash) _torrentsByHash.delete(hash)
  if (id) _addPromises.delete(id)
  dlog('destroyed torrent ' + (hash || id || '?'))
}

export function addTorrent(torrentId, opts = {}) {
  if (_addPromises.has(torrentId)) return _addPromises.get(torrentId)
  const p = _doAdd(torrentId, opts)
  _addPromises.set(torrentId, p)
  // If the add fails, drop the cached promise so a retry can happen.
  p.catch(() => _addPromises.delete(torrentId))
  return p
}

async function _doAdd(torrentId, { webSeeds = [], torrentFile = null } = {}) {
  const client = getClient()

  // Genesis path: fetch the .torrent file ourselves (metadata only, ~50 KB)
  // and hand the bytes to WebTorrent. This sidesteps the chicken-and-egg of
  // "browser needs metadata to peer, but can only get metadata from a peer."
  // The actual data still rides the swarm — the .torrent file is just the
  // file list + piece hashes. WebTorrent in the browser can't fetch HTTP
  // .torrent URLs itself (Node-only feature), so we do it here.
  let addArg = torrentId
  if (torrentFile) {
    try {
      dlog('fetching .torrent ' + torrentFile)
      const res = await fetch(torrentFile, { cache: 'force-cache' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const buf = new Uint8Array(await res.arrayBuffer())
      dok('.torrent fetched: ' + buf.byteLength + ' bytes')
      addArg = buf
    } catch (err) {
      dwarn('.torrent fetch failed (' + (err.message || err) + '); falling back to magnet')
    }
  }

  return new Promise((resolve, reject) => {
    const opts = {
      announce: WSS_TRACKERS,
      // BEP-19 web seeds — IA serves these with permissive CORS, so the
      // browser can pull pieces over HTTPS as a bootstrap until other browser
      // peers join the swarm.
      urlList: webSeeds,
    }
    const existing = _findExisting(client, torrentId)
    if (existing) {
      if (existing.ready) return resolve(existing)
      existing.on('ready', () => resolve(existing))
      existing.on('error', reject)
      return
    }
    const argDesc = addArg instanceof Uint8Array
      ? '<.torrent ' + addArg.byteLength + 'B>'
      : String(addArg).slice(0, 100)
    dlog('client.add ' + argDesc)
    if (webSeeds.length) dlog('  webSeeds=' + webSeeds.join(', '))
    const startedAt = Date.now()
    let settled = false

    // Soft warning instead of a hard reject: late peers (or a slow .torrent
    // mirror) shouldn't tear down the whole add(). The page stays alive and
    // can still pick up peers and pieces whenever they show up.
    const warnTimer = setTimeout(() => {
      if (settled) return
      const peers = torrent.numPeers || 0
      dwarn('still waiting for metadata after ' + METADATA_WARN_MS / 1000 + 's; peers=' + peers +
            ' (will keep listening for late peers and web seeds)')
    }, METADATA_WARN_MS)

    const torrent = client.add(addArg, opts, (t) => {
      settled = true
      clearTimeout(warnTimer)
      t._romSeekerTorrentId = torrentId
      dok('torrent ready cb infoHash=' + t.infoHash + ' files=' + t.files.length +
          ' (after ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's)')
      _attachDiagnostics(t)
      resolve(t)
    })
    torrent.on('infoHash', () => dlog('infoHash event ' + torrent.infoHash))
    torrent.on('metadata', () => {
      // Deselect everything so prefetch doesn't trigger a multi-GB download.
      // Files become "selected" only when the user clicks a row — and they
      // *stay* selected after the download completes, which is what keeps
      // the tab seeding pieces to other browsers in the swarm.
      dlog('metadata event; deselecting all (download is opt-in per file)')
      torrent.deselect(0, torrent.pieces.length - 1, false)
      for (const f of torrent.files) f.deselect()
      _torrentsByHash.set(torrent.infoHash, torrent)
    })
    torrent.on('wire', (wire, addr) => dlog('wire ' + (addr || '?')))
    torrent.on('noPeers', (announceType) => dwarn('noPeers: ' + announceType))
    torrent.on('warning', (err) => dwarn('torrent warning: ' + (err.message || err)))
    torrent.on('error', (err) => {
      settled = true
      clearTimeout(warnTimer)
      derr('torrent error: ' + (err.message || err))
      reject(err)
    })
  })
}

// Periodic + event-based logging so a stuck download surfaces useful state
// (peer count, bytes flowing, web seed activity) instead of a silent 0 B/s.
function _attachDiagnostics(torrent) {
  let lastDownloaded = 0
  const tick = setInterval(() => {
    if (torrent.destroyed) return clearInterval(tick)
    const got = torrent.downloaded || 0
    const delta = got - lastDownloaded
    if (delta > 0) {
      dlog('progress: +' + (delta / 1024).toFixed(1) + ' KB · total ' +
        (got / 1024 / 1024).toFixed(2) + ' MB · ' +
        ((torrent.downloadSpeed || 0) / 1024).toFixed(1) + ' KB/s · ' +
        torrent.numPeers + ' peers')
      lastDownloaded = got
    }
  }, 5000)
  torrent.once('close', () => clearInterval(tick))
  torrent.on('verified', (idx) => dlog('piece verified ' + idx))
  torrent.on('verify', (idx) => dlog('verify failed for piece ' + idx))
  torrent.on('done', () => dok('torrent done'))
}

function _findExisting(_client, magnetOrHash) {
  // Look up by infoHash in our own map. WebTorrent v2's client.get() is
  // async (returns a Promise), so we can't use it synchronously here.
  // Hex hashes only — base32 magnets get parsed inside WebTorrent itself,
  // and a duplicate add will be caught by client.add()'s _infoHash check.
  const m = /xt=urn:btih:([0-9a-f]{40})/i.exec(magnetOrHash || '')
  let hash = m ? m[1].toLowerCase() : null
  if (!hash && /^[0-9a-f]{40}$/i.test(magnetOrHash || '')) hash = magnetOrHash.toLowerCase()
  if (!hash) return null
  return _torrentsByHash.get(hash) || null
}

/**
 * Download a single file from the torrent to disk via StreamSaver.
 * Returns an object with `cancel()` to abort.
 */
export function downloadFile(torrent, file, onProgress) {
  // Mark this single file as wanted; leave the others deselected.
  file.select()

  const writeStream = streamSaver.createWriteStream(file.name, {
    size: file.length,
  })
  const writer = writeStream.getWriter()

  let cancelled = false
  let lastReported = -1

  const tickProgress = () => {
    if (cancelled) return
    const pct = file.progress
    if (pct !== lastReported) {
      lastReported = pct
      onProgress && onProgress({ progress: pct, downloaded: file.downloaded, done: file.done })
    }
  }
  const intervalId = setInterval(tickProgress, 500)

  ;(async () => {
    try {
      const stream = file.createReadStream()
      stream.on('data', async (chunk) => {
        if (cancelled) return
        // Backpressure: pause node-style stream while writer is busy.
        stream.pause()
        try {
          await writer.write(chunk)
          if (!cancelled) stream.resume()
        } catch (err) {
          if (!cancelled) console.warn('[download] writer error:', err)
          cancelled = true
          try { stream.destroy() } catch {}
        }
      })
      stream.on('end', async () => {
        clearInterval(intervalId)
        if (!cancelled) {
          try { await writer.close() } catch {}
          tickProgress()
          onProgress && onProgress({ progress: 1, downloaded: file.length, done: true })
          // Honor the user's seeding preference: opt-out destroys the torrent
          // now that they have what they came for.
          if (!_seedingEnabled) _destroyTorrent(torrent)
        }
      })
      stream.on('error', async (err) => {
        clearInterval(intervalId)
        console.warn('[download] read error:', err)
        try { await writer.abort(err) } catch {}
        onProgress && onProgress({ progress: file.progress, downloaded: file.downloaded, done: false, error: err })
      })
    } catch (err) {
      clearInterval(intervalId)
      console.warn('[download] setup error:', err)
      try { await writer.abort(err) } catch {}
      onProgress && onProgress({ progress: 0, downloaded: 0, done: false, error: err })
    }
  })()

  return {
    cancel() {
      cancelled = true
      clearInterval(intervalId)
      try { writer.abort() } catch {}
      file.deselect()
    },
  }
}

export function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`
}
