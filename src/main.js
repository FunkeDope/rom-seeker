// IMPORTANT: this side-effect import must come before ./torrent.js — it
// patches self.fetch for BEP-47 padding files and CORS-preflight headers,
// and webtorrent captures self.fetch at module-evaluation time.
import './fetch-patch.js'
import {
  addTorrent, downloadFile, formatSize,
  setSeedingEnabled, isSeedingEnabled,
  getGlobalStats, getClient,
} from './torrent.js'
import { getTorrentState } from './storage.js'

const SEEDING_PREF_KEY = 'rom-seeker:seeding'
const PAGE_SIZE = 100

const dlog = (m) => window.dlog && window.dlog(m)
const dok = (m) => window.dok && window.dok(m)
const dwarn = (m) => window.dwarn && window.dwarn(m)
const derr = (m) => window.derr && window.derr(m)

dok('main.js module loaded')

const view = document.getElementById('view')
const crumbs = document.getElementById('crumbs')
const filterInput = document.getElementById('filter')

let catalog = []
let currentFilter = ''

function resolveTorrentFile(entry) {
  const t = entry.torrent_file
  if (!t) return null
  if (/^https?:/i.test(t)) return t
  return `${import.meta.env.BASE_URL}${t}`
}

async function loadCatalog() {
  if (catalog.length) return catalog
  const url = `${import.meta.env.BASE_URL}catalog.json?v=${Date.now()}`
  dlog('GET ' + url)
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    derr('catalog HTTP ' + res.status)
    throw new Error(`failed to load catalog.json: ${res.status}`)
  }
  catalog = await res.json()
  dok('catalog loaded: ' + catalog.length + ' entries')
  prefetchCatalog(catalog)
  return catalog
}

let _prefetched = false
function prefetchCatalog(entries) {
  if (_prefetched) return
  _prefetched = true
  for (const entry of entries) {
    if (!entry.magnet && !entry.torrent_file) continue
    const webSeeds = entry.web_seeds || (entry.web_seed ? [entry.web_seed] : [])
    const torrentFile = resolveTorrentFile(entry)
    dlog('prefetch ' + entry.slug)
    addTorrent(entry.magnet || torrentFile, { webSeeds, torrentFile }).then(
      (t) => dok('prefetch ' + entry.slug + ' ready: files=' + t.files.length),
      (err) => dwarn('prefetch ' + entry.slug + ' failed: ' + (err.message || err)),
    )
  }
}

function setCrumbs(parts) {
  crumbs.innerHTML = ''
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = '/'
      crumbs.appendChild(sep)
    }
    if (p.href) {
      const a = document.createElement('a')
      a.href = p.href
      a.textContent = p.label
      crumbs.appendChild(a)
    } else {
      const s = document.createElement('span')
      s.textContent = p.label
      crumbs.appendChild(s)
    }
  })
}

function showFilter(visible) {
  filterInput.style.display = visible ? '' : 'none'
  if (!visible) { filterInput.value = ''; currentFilter = '' }
}

// ---------- Landing page ----------

async function renderLanding() {
  setCrumbs([{ label: 'Index' }])
  showFilter(false)

  let entries
  try {
    entries = await loadCatalog()
  } catch (err) {
    view.innerHTML = `<div class="banner error">Could not load catalog: ${err.message}</div>`
    return
  }

  const grid = document.createElement('div')
  grid.className = 'catalog-grid'
  for (const entry of entries) {
    const card = document.createElement('a')
    card.className = 'catalog-card'
    card.href = `#/c/${entry.slug}`
    card.innerHTML = `
      <p class="title"></p>
      <p class="subtitle"></p>
      <p class="meta">${entry.magnet ? '' : '<span class="placeholder-magnet">no magnet configured</span>'}</p>
    `
    card.querySelector('.title').textContent = entry.title
    card.querySelector('.subtitle').textContent = entry.subtitle || ''
    grid.appendChild(card)
  }

  view.innerHTML = ''
  const heading = document.createElement('div')
  heading.innerHTML = `
    <h1 class="page-title">Collections</h1>
    <p class="page-sub">Pick a collection. Files stream peer-to-peer to your browser.</p>
  `
  view.appendChild(heading)
  view.appendChild(grid)
}

// ---------- File index page ----------

const PROGRESS_REFRESH_MS = 500
let activeRowState = new WeakMap() // file -> { row, progressCell, handle, status, progress }
let currentTorrent = null
let currentFiles = []
let currentSort = { key: 'name', dir: 1 }
let currentStatusFilter = 'all' // 'all' | 'selected' | 'done'
let currentPage = 0
let progressTimer = null

function clearViewState() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
  activeRowState = new WeakMap()
  currentTorrent = null
  currentFiles = []
  currentPage = 0
  currentStatusFilter = 'all'
}

async function renderCollection(slug) {
  clearViewState()

  let entries
  try {
    entries = await loadCatalog()
  } catch (err) {
    view.innerHTML = `<div class="banner error">Could not load catalog: ${err.message}</div>`
    return
  }
  const entry = entries.find((e) => e.slug === slug)
  if (!entry) {
    view.innerHTML = `<div class="banner error">Unknown collection: ${slug}</div>`
    return
  }

  setCrumbs([
    { label: 'Index', href: '#/' },
    { label: entry.title },
  ])
  showFilter(true)

  view.innerHTML = `
    <h1 class="page-title">${escapeHtml(entry.title)}</h1>
    <p class="page-sub">${escapeHtml(entry.subtitle || '')}${entry.source ? ` · <a href="${escapeAttr(entry.source)}" target="_blank" rel="noopener">source</a>` : ''}</p>
    <div id="status-host"></div>
    <div id="toolbar-host"></div>
    <div id="table-host"></div>
    <div id="pager-host"></div>
  `
  const statusHost = view.querySelector('#status-host')
  const toolbarHost = view.querySelector('#toolbar-host')
  const tableHost = view.querySelector('#table-host')
  const pagerHost = view.querySelector('#pager-host')

  if (!entry.magnet && !entry.torrent_file) {
    statusHost.innerHTML = `
      <div class="banner warn">
        No torrent is configured for <strong>${escapeHtml(entry.title)}</strong> yet.
      </div>
    `
    return
  }

  statusHost.innerHTML = `
    <div class="banner info" id="loading-banner">Connecting to swarm and fetching torrent metadata…</div>
  `
  const webSeeds = entry.web_seeds || (entry.web_seed ? [entry.web_seed] : [])
  const torrentFile = resolveTorrentFile(entry)
  dlog('addTorrent for ' + slug + (torrentFile ? ' (.torrent + magnet)' : ' (magnet)'))

  let torrent
  try {
    torrent = await addTorrent(entry.magnet || torrentFile, { webSeeds, torrentFile })
    dok('torrent ready: ' + torrent.infoHash + ' files=' + torrent.files.length + ' size=' + formatSize(torrent.length))
  } catch (err) {
    derr('addTorrent failed: ' + (err.message || err))
    statusHost.innerHTML = `<div class="banner error">Failed to add torrent: ${escapeHtml(err.message || String(err))}</div>`
    return
  }

  currentTorrent = torrent
  currentFiles = torrent.files.slice()

  renderPerTorrentStatus(statusHost, torrent)
  renderToolbar(toolbarHost)

  // Re-arm the UI handles for any selections persisted from a previous
  // session BEFORE rendering the table — so renderRows picks up the
  // activeRowState entries and shows mid-download files as downloading.
  // The torrent itself was already re-selected by _restoreSelections() in
  // torrent.js; this only attaches save-on-done handlers + UI state.
  rearmRestoredSelections()

  renderTable(tableHost, pagerHost)

  progressTimer = setInterval(() => {
    updatePerTorrentStatus(statusHost, torrent)
    updateActiveRows()
  }, PROGRESS_REFRESH_MS)
}

function rearmRestoredSelections() {
  if (!currentTorrent) return
  const state = getTorrentState(currentTorrent.infoHash)
  const doneSet = new Set(state.done)
  for (const path of state.selected) {
    if (doneSet.has(path)) continue
    const file = currentFiles.find((f) => f.path === path || f.name === path)
    if (!file || file.done) continue
    if (activeRowState.has(file)) continue
    _startFileDownload(file, /* visible row may not exist yet */ null, null)
  }
}

function renderPerTorrentStatus(host, torrent) {
  host.innerHTML = ''
  const bar = document.createElement('div')
  bar.className = 'status-bar'
  bar.innerHTML = `
    <span class="files"></span>
    <span class="size"></span>
    <span class="peers"></span>
    <span class="rate"></span>
  `
  host.appendChild(bar)
  updatePerTorrentStatus(host, torrent)
}

function updatePerTorrentStatus(host, torrent) {
  const bar = host.querySelector('.status-bar')
  if (!bar) return
  const peers = torrent.numPeers || 0
  const dotClass = peers > 0 ? 'live' : (torrent.ready ? 'warn' : '')
  bar.querySelector('.files').innerHTML = `<span class="dot ${dotClass}"></span>${torrent.files.length} files`
  bar.querySelector('.size').textContent = `· ${formatSize(torrent.length)} total`
  bar.querySelector('.peers').textContent = `· ${peers} peer${peers === 1 ? '' : 's'}`
  bar.querySelector('.rate').textContent = `· ↓ ${formatSize(torrent.downloadSpeed)}/s`
}

function renderToolbar(host) {
  host.innerHTML = `
    <div class="toolbar">
      <label class="status-filter">
        Show:
        <select id="status-filter-select">
          <option value="all">all files</option>
          <option value="selected">downloading / queued</option>
          <option value="done">done</option>
        </select>
      </label>
      <span class="toolbar-meta" id="toolbar-meta"></span>
    </div>
  `
  const sel = host.querySelector('#status-filter-select')
  sel.value = currentStatusFilter
  sel.addEventListener('change', () => {
    currentStatusFilter = sel.value
    currentPage = 0
    const tableHost = view.querySelector('#table-host')
    const pagerHost = view.querySelector('#pager-host')
    renderTable(tableHost, pagerHost)
  })
}

function applyFilter(files) {
  let result = files
  const text = currentFilter.toLowerCase()
  if (text) result = result.filter((f) => f.name.toLowerCase().includes(text))
  if (currentStatusFilter === 'selected') {
    const state = currentTorrent ? getTorrentState(currentTorrent.infoHash) : { selected: [], done: [] }
    const sel = new Set(state.selected)
    const dn = new Set(state.done)
    result = result.filter((f) => sel.has(f.path) && !dn.has(f.path))
  } else if (currentStatusFilter === 'done') {
    const state = currentTorrent ? getTorrentState(currentTorrent.infoHash) : { selected: [], done: [] }
    const dn = new Set(state.done)
    result = result.filter((f) => f.done || dn.has(f.path))
  }
  return result
}

function applySort(files) {
  const sorted = files.slice()
  sorted.sort((a, b) => {
    let cmp = 0
    if (currentSort.key === 'size') cmp = a.length - b.length
    else if (currentSort.key === 'progress') cmp = (a.progress || 0) - (b.progress || 0)
    else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return cmp * currentSort.dir
  })
  return sorted
}

function renderTable(host, pagerHost) {
  const table = document.createElement('table')
  table.className = 'file-table'
  table.innerHTML = `
    <thead>
      <tr>
        <th class="col-name" data-sort="name">Name <span class="arrow">▲</span></th>
        <th class="col-size" data-sort="size">Size <span class="arrow">▲</span></th>
        <th class="col-progress" data-sort="progress">Progress <span class="arrow">▲</span></th>
      </tr>
    </thead>
    <tbody></tbody>
  `
  host.innerHTML = ''
  host.appendChild(table)

  table.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort
      if (currentSort.key === key) currentSort.dir *= -1
      else { currentSort.key = key; currentSort.dir = 1 }
      currentPage = 0
      renderRows(table, pagerHost)
    })
  })

  renderRows(table, pagerHost)
}

function renderRows(table, pagerHost) {
  const tbody = table.querySelector('tbody')
  tbody.innerHTML = ''

  table.querySelectorAll('thead th').forEach((th) => {
    th.classList.remove('sorted')
    const arrow = th.querySelector('.arrow')
    if (!arrow) return
    if (th.dataset.sort === currentSort.key) {
      th.classList.add('sorted')
      arrow.textContent = currentSort.dir > 0 ? '▲' : '▼'
    }
  })

  const filtered = applyFilter(currentFiles)
  const sorted = applySort(filtered)

  // Toolbar meta: total / showing
  const meta = view.querySelector('#toolbar-meta')
  if (meta) {
    meta.textContent = `${sorted.length.toLocaleString()} of ${currentFiles.length.toLocaleString()} files`
  }

  if (!sorted.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td colspan="3" class="empty" style="border:none">No files match.</td>`
    tbody.appendChild(tr)
    if (pagerHost) pagerHost.innerHTML = ''
    return
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  if (currentPage >= totalPages) currentPage = totalPages - 1
  const pageStart = currentPage * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, sorted.length)
  const visible = sorted.slice(pageStart, pageEnd)

  for (const file of visible) {
    const tr = document.createElement('tr')
    tr.dataset.name = file.name
    tr.innerHTML = `
      <td class="col-name"><span class="icon">📦</span><span class="fname"></span></td>
      <td class="col-size"></td>
      <td class="col-progress"></td>
    `
    tr.querySelector('.fname').textContent = file.name
    tr.querySelector('.col-size').textContent = formatSize(file.length)

    const state = activeRowState.get(file)
    const progressCell = tr.querySelector('.col-progress')
    if (state) {
      state.row = tr
      state.progressCell = progressCell
      applyRowState(file, state)
    } else if (file.done) {
      renderDoneCell(progressCell)
      tr.classList.add('done')
    } else {
      // Restored mid-download (selected pre-refresh, pieces in flight,
      // no in-memory state object): show current file.progress so the row
      // doesn't look idle.
      const persisted = currentTorrent ? getTorrentState(currentTorrent.infoHash) : { selected: [] }
      if (persisted.selected.includes(file.path)) {
        tr.classList.add('downloading')
        renderProgress(progressCell, file.progress || 0)
      }
    }

    tr.addEventListener('click', () => onRowClick(file, tr, progressCell))
    tbody.appendChild(tr)
  }

  if (pagerHost) renderPager(pagerHost, sorted.length, totalPages)
}

function renderPager(host, total, totalPages) {
  if (totalPages <= 1) { host.innerHTML = ''; return }
  host.innerHTML = `
    <div class="pager">
      <button class="pg first" type="button" title="first page">«</button>
      <button class="pg prev" type="button" title="previous page">‹</button>
      <span class="pg-info">page <input class="pg-input" type="number" min="1" max="${totalPages}" /> of ${totalPages.toLocaleString()}</span>
      <button class="pg next" type="button" title="next page">›</button>
      <button class="pg last" type="button" title="last page">»</button>
    </div>
  `
  const input = host.querySelector('.pg-input')
  input.value = String(currentPage + 1)
  const goto = (n) => {
    const next = Math.max(0, Math.min(totalPages - 1, n))
    if (next === currentPage) return
    currentPage = next
    const table = view.querySelector('.file-table')
    if (table) renderRows(table, host)
  }
  host.querySelector('.first').addEventListener('click', () => goto(0))
  host.querySelector('.prev').addEventListener('click', () => goto(currentPage - 1))
  host.querySelector('.next').addEventListener('click', () => goto(currentPage + 1))
  host.querySelector('.last').addEventListener('click', () => goto(totalPages - 1))
  input.addEventListener('change', () => goto((parseInt(input.value, 10) || 1) - 1))
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') goto((parseInt(input.value, 10) || 1) - 1) })

  host.querySelector('.first').disabled = currentPage === 0
  host.querySelector('.prev').disabled = currentPage === 0
  host.querySelector('.next').disabled = currentPage >= totalPages - 1
  host.querySelector('.last').disabled = currentPage >= totalPages - 1
}

function _startFileDownload(file, row, progressCell) {
  const newState = { row, progressCell, handle: null, status: 'downloading', progress: 0 }
  activeRowState.set(file, newState)
  if (row) row.classList.add('downloading')
  if (progressCell) renderProgress(progressCell, 0)

  newState.handle = downloadFile(currentTorrent, file, ({ progress, done, error }) => {
    if (error) {
      newState.status = 'error'
      if (newState.progressCell) newState.progressCell.textContent = 'error'
      if (newState.row) newState.row.classList.remove('downloading')
      return
    }
    newState.progress = progress
    if (done) {
      newState.status = 'done'
      if (newState.progressCell) renderDoneCell(newState.progressCell)
      if (newState.row) {
        newState.row.classList.remove('downloading')
        newState.row.classList.add('done')
      }
    } else if (newState.progressCell) {
      renderProgress(newState.progressCell, progress)
    }
  })
}

function onRowClick(file, row, progressCell) {
  const state = activeRowState.get(file)
  if (state && state.status === 'downloading') {
    state.handle.cancel()
    state.status = 'cancelled'
    progressCell.textContent = 'cancelled'
    row.classList.remove('downloading')
    activeRowState.delete(file)
    return
  }
  if (file.done) {
    // Already complete in this session or restored from a previous one —
    // re-trigger the save dialog from the cached blob.
    file.blob().then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }).catch((err) => derr('blob() failed: ' + (err.message || err)))
    return
  }
  _startFileDownload(file, row, progressCell)
}

function renderProgress(cell, fraction) {
  if (!cell) return
  const pct = Math.max(0, Math.min(100, (fraction || 0) * 100))
  cell.innerHTML = `<span class="bar"><span style="width:${pct.toFixed(1)}%"></span></span><span class="pct">${pct.toFixed(0)}%</span>`
}

function renderDoneCell(cell) {
  if (!cell) return
  if (!isSeedingEnabled()) {
    cell.textContent = 'done'
    return
  }
  const peers = currentTorrent ? (currentTorrent.numPeers || 0) : 0
  cell.innerHTML = `<span class="seeding-dot"></span>seeding · ${peers} peer${peers === 1 ? '' : 's'}`
}

function applyRowState(file, state) {
  const { row, progressCell, status, progress } = state
  if (!row || !progressCell) return
  if (status === 'downloading') {
    row.classList.add('downloading')
    renderProgress(progressCell, progress || file.progress || 0)
  } else if (status === 'done') {
    row.classList.add('done')
    renderDoneCell(progressCell)
  } else if (status === 'error') {
    progressCell.textContent = 'error'
  } else if (status === 'cancelled') {
    progressCell.textContent = 'cancelled'
  }
}

function updateActiveRows() {
  for (const file of currentFiles) {
    const state = activeRowState.get(file)
    if (!state || !state.progressCell) continue
    if (state.status === 'downloading') {
      state.progress = file.progress
      renderProgress(state.progressCell, file.progress)
    } else if (state.status === 'done') {
      renderDoneCell(state.progressCell)
    }
  }
}

// ---------- Filter input ----------

filterInput.addEventListener('input', () => {
  currentFilter = filterInput.value.trim()
  currentPage = 0
  const table = view.querySelector('.file-table')
  const pagerHost = view.querySelector('#pager-host')
  if (table) renderRows(table, pagerHost)
})

// ---------- Router ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;') }

function route() {
  const hash = location.hash || '#/'
  dlog('route ' + hash)
  const m = /^#\/c\/([^/]+)\/?$/.exec(hash)
  if (m) {
    renderCollection(decodeURIComponent(m[1])).catch((e) => derr('renderCollection threw: ' + (e.message || e)))
  } else {
    clearViewState()
    renderLanding().catch((e) => derr('renderLanding threw: ' + (e.message || e)))
  }
}

window.addEventListener('hashchange', route)

// ---------- Seeding toggle ----------

function initSeedingToggle() {
  try {
    const saved = localStorage.getItem(SEEDING_PREF_KEY)
    if (saved === 'false') setSeedingEnabled(false)
  } catch {}
  const cb = document.getElementById('seed-toggle')
  if (!cb) return
  cb.checked = isSeedingEnabled()
  cb.addEventListener('change', () => {
    setSeedingEnabled(cb.checked)
    try { localStorage.setItem(SEEDING_PREF_KEY, String(cb.checked)) } catch {}
    updateActiveRows()
  })
}

// ---------- Persistent global status bar ----------
//
// Always visible at the bottom of the page, on every view. Aggregates state
// across every torrent the client knows about so the user can see ongoing
// downloads even after navigating away from the file list.

function initGlobalStatusBar() {
  const bar = document.getElementById('global-status')
  if (!bar) return
  const summary = bar.querySelector('.gs-summary')
  const stats = bar.querySelector('.gs-stats')
  const tick = () => {
    const s = getGlobalStats()
    if (!s.torrents) {
      bar.classList.add('idle')
      summary.textContent = 'idle · no torrents loaded'
      stats.textContent = ''
      return
    }
    bar.classList.toggle('idle', s.downloading === 0 && s.speed === 0)
    const dlText = s.downloading > 0
      ? `${s.downloading.toLocaleString()} downloading`
      : 'no active downloads'
    const dotClass = s.speed > 0 ? 'live' : (s.peers > 0 ? 'warn' : '')
    summary.innerHTML = `<span class="gs-dot ${dotClass}"></span>${dlText} · ${s.done.toLocaleString()} done`
    stats.textContent = `${s.peers} peer${s.peers === 1 ? '' : 's'} · ↓ ${formatSize(s.speed)}/s`
  }
  tick()
  setInterval(tick, 1000)
}

initSeedingToggle()
initGlobalStatusBar()
route()
