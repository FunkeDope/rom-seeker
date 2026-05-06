import WebTorrent from 'webtorrent/dist/webtorrent.min.js'
import parseTorrent from 'parse-torrent'
import { getTorrentState, markSelected, markDeselected, markDone, isDone } from './storage.js'

const dlog = (m) => window.dlog && window.dlog('[wt] ' + m)
const dok = (m) => window.dok && window.dok('[wt] ' + m)
const dwarn = (m) => window.dwarn && window.dwarn('[wt] ' + m)
const derr = (m) => window.derr && window.derr('[wt] ' + m)

dok('torrent.js loaded; WebTorrent type=' + (typeof WebTorrent))

// Public WSS trackers — added to every torrent so browser peers can find each
// other even when the magnet's own announce list is HTTP/UDP-only.
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
const _addPromises = new Map()
const _doneListeners = new Map() // file -> handler, so we don't double-bind

const METADATA_WARN_MS = 30_000

let _seedingEnabled = true
export function isSeedingEnabled() { return _seedingEnabled }
export function setSeedingEnabled(enabled) {
  _seedingEnabled = !!enabled
  dlog('seeding=' + _seedingEnabled)
  if (!_seedingEnabled) {
    for (const [, t] of Array.from(_torrentsByHash.entries())) {
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
  p.catch(() => _addPromises.delete(torrentId))
  return p
}

async function _doAdd(torrentId, { webSeeds = [], torrentFile = null } = {}) {
  const client = getClient()

  let addArg = torrentId
  let pieceCount = 0
  if (torrentFile) {
    try {
      dlog('fetching .torrent ' + torrentFile)
      const res = await fetch(torrentFile, { cache: 'force-cache' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const buf = new Uint8Array(await res.arrayBuffer())
      dok('.torrent fetched: ' + buf.byteLength + ' bytes')

      // Pre-parse so we can scrub the urlList before webtorrent ingests it.
      // Three transformations:
      //  - drop garbage entries (relative paths like "/1/items/" — webtorrent
      //    rejects them but with a warning per torrent, noisy)
      //  - upgrade http:// → https:// for any web seed. Mixed-content is the
      //    sole reason browsers block http web seeds from an https page.
      //  - drop IA per-CDN hosts (ia604704.us.archive.org etc.). They never
      //    serve Access-Control-Allow-Origin so they're useless from a
      //    browser, AND the host baked into the .torrent is often stale (IA
      //    moves items between CDN nodes). Catalog should pin the
      //    archive.org/cors/ endpoint instead.
      try {
        const parsed = await parseTorrent(buf)
        const before = (parsed.urlList || []).slice()
        const seen = new Set()
        const cleaned = []
        for (const u of before) {
          let v = u
          if (/^http:\/\/.+/i.test(v)) v = v.replace(/^http:/i, 'https:')
          if (!/^https:\/\/.+/i.test(v)) continue
          if (/^https:\/\/ia\d+\.us\.archive\.org\//i.test(v)) continue
          if (seen.has(v)) continue
          seen.add(v)
          cleaned.push(v)
        }
        for (const u of webSeeds) {
          let v = u
          if (/^http:\/\/.+/i.test(v)) v = v.replace(/^http:/i, 'https:')
          if (/^https:\/\/.+/i.test(v) && !seen.has(v)) { seen.add(v); cleaned.push(v) }
        }
        parsed.urlList = cleaned
        const dropped = before.filter((u) => {
          const v = /^http:\/\/.+/i.test(u) ? u.replace(/^http:/i, 'https:') : u
          return !cleaned.includes(v)
        })
        const upgraded = before.filter((u) => /^http:\/\/.+/i.test(u))
        if (dropped.length) dlog('dropped non-http(s) web seed(s): ' + dropped.join(', '))
        if (upgraded.length) dlog('http→https upgraded ' + upgraded.length + ' web seed(s)')
        dlog('final urlList: ' + cleaned.join(', '))
        addArg = parsed
        pieceCount = parsed.pieces ? parsed.pieces.length : 0
      } catch (err) {
        dwarn('parse-torrent failed (' + (err.message || err) + '); using raw bytes')
        addArg = buf
        pieceCount = _piecesCountFromTorrent(buf)
      }
      if (pieceCount) dlog('parsed pieces=' + pieceCount)
    } catch (err) {
      dwarn('.torrent fetch failed (' + (err.message || err) + '); falling back to magnet')
    }
  }

  return new Promise((resolve, reject) => {
    const opts = {
      announce: WSS_TRACKERS,
      // urlList isn't needed when we pre-parsed: we baked the cleaned list
      // into the parsed object's urlList field above. Set empty to avoid
      // webtorrent re-adding caller-supplied URLs that didn't survive the
      // https filter.
      urlList: addArg === torrentId ? webSeeds : [],
      // Start with no pieces selected. Multi-GB catalog torrents would
      // otherwise auto-download in full; the user opts in per file.
      deselect: true,
    }
    // Provide an all-zero startup bitfield (= we have nothing) so webtorrent
    // takes the bitfield-verify fast path on add instead of hashing every
    // piece individually. On a 17k-file torrent that's the difference
    // between ~30s and "instant" page load. We do NOT use skipVerify here:
    // skipVerify also marks every piece as *verified*, which lies — file.done
    // flips true on every file and file.blob() throws because the chunk
    // store is empty. The bitfield path leaves verification semantics
    // intact: pieces stay marked as not-present, file.done starts false,
    // download proceeds normally.
    if (pieceCount) {
      opts.startupBitfield = new Uint8Array(Math.ceil(pieceCount / 8))
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
      : (addArg && addArg.infoHash)
        ? '<parsed ' + addArg.infoHash.slice(0, 8) + ' ' + (addArg.urlList?.length || 0) + ' webseeds>'
        : String(addArg).slice(0, 100)
    dlog('client.add ' + argDesc)
    if (addArg && addArg.urlList && addArg.urlList.length) dlog('  webSeeds=' + addArg.urlList.join(', '))
    else if (webSeeds.length) dlog('  webSeeds=' + webSeeds.join(', '))
    const startedAt = Date.now()
    let settled = false

    const warnTimer = setTimeout(() => {
      if (settled) return
      const peers = torrent.numPeers || 0
      dwarn('still waiting for metadata after ' + METADATA_WARN_MS / 1000 + 's; peers=' + peers)
    }, METADATA_WARN_MS)

    const torrent = client.add(addArg, opts, (t) => {
      settled = true
      clearTimeout(warnTimer)
      t._romSeekerTorrentId = torrentId
      _torrentsByHash.set(t.infoHash, t)
      dok('torrent ready cb infoHash=' + t.infoHash + ' files=' + t.files.length +
          ' (after ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's)')
      _attachDiagnostics(t)
      _restoreSelections(t)
      resolve(t)
    })
    torrent.on('infoHash', () => dlog('infoHash event ' + torrent.infoHash))
    torrent.on('metadata', () => {
      dlog('metadata event (deselect:true so nothing auto-downloads)')
      _torrentsByHash.set(torrent.infoHash, torrent)
    })
    torrent.on('wire', (wire, addr) => {
      // For webseeds the URL lives on the WebConn (peer.conn.url) not on the
      // protocol Wire that 'wire' actually emits. Walk through.
      const kind = wire?.type
        || (wire?.peer?.type === 'webSeed' ? 'webSeed' : null)
        || 'peer'
      const url = wire?.url
        || wire?.peer?.conn?.url
        || wire?.conn?.url
        || addr
        || '?'
      dlog('wire ' + kind + ' ' + String(url).slice(0, 80))
    })
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

// Re-arm any selections the user made before a refresh. WebTorrent's chunk
// store (OPFS in modern browsers) already has the pieces; we just need to
// tell the torrent which files the user still wants so it keeps requesting
// any missing pieces and emits 'done' once they're all in.
function _restoreSelections(torrent) {
  const state = getTorrentState(torrent.infoHash)
  if (!state.selected.length && !state.done.length) return
  let restored = 0
  for (const path of state.selected) {
    const file = torrent.files.find((f) => f.path === path || f.name === path)
    if (file && !file.done) {
      file.select()
      _bindDoneHandler(torrent, file)
      restored++
    }
  }
  // Also bind a 'done' handler to any file that's already complete so
  // subsequent state stays consistent; webtorrent emits 'done' on next tick
  // for a freshly-loaded already-complete file.
  for (const path of state.done) {
    const file = torrent.files.find((f) => f.path === path || f.name === path)
    if (file) _bindDoneHandler(torrent, file)
  }
  if (restored) dok('restored ' + restored + ' selection(s) for ' + torrent.infoHash.slice(0, 8))
}

function _bindDoneHandler(torrent, file) {
  if (_doneListeners.has(file)) return
  const handler = () => {
    markDone(torrent.infoHash, file.path)
    dok('file done: ' + file.name)
  }
  _doneListeners.set(file, handler)
  if (file.done) handler()
  else file.once('done', handler)
}

// Periodic + event-based logging so a stuck download surfaces useful state.
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
  torrent.on('done', () => dok('torrent done'))
}

// Pull pieces.length out of a .torrent's bencoded bytes without dragging in
// the full parse-torrent module. The "pieces" field is a length-prefixed
// concat of 20-byte SHA1 hashes (`6:pieces<L>:<L bytes>`); count = L / 20.
function _piecesCountFromTorrent(bytes) {
  const needle = [0x36, 0x3a, 0x70, 0x69, 0x65, 0x63, 0x65, 0x73] // "6:pieces"
  outer: for (let i = 0; i < bytes.length - needle.length - 4; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    let p = i + needle.length
    let n = 0
    while (p < bytes.length && bytes[p] >= 0x30 && bytes[p] <= 0x39) {
      n = n * 10 + (bytes[p] - 0x30)
      p++
    }
    if (bytes[p] === 0x3a /* ':' */ && n > 0 && n % 20 === 0) return n / 20
  }
  return 0
}

function _findExisting(_client, magnetOrHash) {
  const m = /xt=urn:btih:([0-9a-f]{40})/i.exec(magnetOrHash || '')
  let hash = m ? m[1].toLowerCase() : null
  if (!hash && /^[0-9a-f]{40}$/i.test(magnetOrHash || '')) hash = magnetOrHash.toLowerCase()
  if (!hash) return null
  return _torrentsByHash.get(hash) || null
}

/**
 * Mark a file as wanted. WebTorrent's piece queue then requests pieces from
 * the swarm + web seed wires; pieces accumulate in the OPFS chunk store. On
 * file 'done' we read them back as a Blob and trigger a normal browser
 * download. Refresh-resume comes free because the pieces are already in OPFS
 * — _restoreSelections() re-arms file.select() on the freshly-added torrent
 * and any remaining pieces complete from there.
 *
 * Returns { cancel }.
 */
export function downloadFile(torrent, file, onProgress) {
  file.select()
  markSelected(torrent.infoHash, file.path)
  _bindDoneHandler(torrent, file)

  let cancelled = false
  let saved = false
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

  const onDone = async () => {
    if (cancelled || saved) return
    saved = true
    clearInterval(intervalId)
    try {
      const blob = await file.blob()
      _triggerSave(blob, file.name)
      onProgress && onProgress({ progress: 1, downloaded: file.length, done: true })
    } catch (err) {
      derr('blob() failed for ' + file.name + ': ' + (err.message || err))
      onProgress && onProgress({ progress: file.progress, downloaded: file.downloaded, done: false, error: err })
    }
  }
  if (file.done) onDone()
  else file.once('done', onDone)

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      clearInterval(intervalId)
      file.removeListener('done', onDone)
      file.deselect()
      markDeselected(torrent.infoHash, file.path)
    },
  }
}

function _triggerSave(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Aggregate stats across every torrent in the client — feeds the persistent
// status bar so progress is visible even when the user is on another page.
export function getGlobalStats() {
  const client = _client
  if (!client) return { torrents: 0, downloading: 0, done: 0, peers: 0, speed: 0 }
  let downloading = 0
  let done = 0
  let peers = 0
  let speed = 0
  for (const t of client.torrents) {
    peers += t.numPeers || 0
    speed += t.downloadSpeed || 0
    const state = getTorrentState(t.infoHash)
    done += state.done.length
    // Files in the persisted "selected" list that aren't yet done.
    const doneSet = new Set(state.done)
    for (const p of state.selected) if (!doneSet.has(p)) downloading++
  }
  return { torrents: client.torrents.length, downloading, done, peers, speed }
}

export function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`
}
