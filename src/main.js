import { addTorrent, downloadFile, formatSize } from './torrent.js'

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

async function loadCatalog() {
  if (catalog.length) return catalog
  const url = `${import.meta.env.BASE_URL}catalog.json`
  dlog('GET ' + url)
  const res = await fetch(url)
  if (!res.ok) {
    derr('catalog HTTP ' + res.status)
    throw new Error(`failed to load catalog.json: ${res.status}`)
  }
  catalog = await res.json()
  dok('catalog loaded: ' + catalog.length + ' entries')
  return catalog
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
let activeRowState = new WeakMap() // file -> { row, progressCell, handle, status }
let currentTorrent = null
let currentFiles = []
let currentSort = { key: 'name', dir: 1 }
let progressTimer = null

function clearViewState() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
  activeRowState = new WeakMap()
  currentTorrent = null
  currentFiles = []
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
    <div id="table-host"></div>
  `
  const statusHost = view.querySelector('#status-host')
  const tableHost = view.querySelector('#table-host')

  if (!entry.magnet) {
    statusHost.innerHTML = `
      <div class="banner warn">
        No magnet link is configured for <strong>${escapeHtml(entry.title)}</strong> yet.
        Add one to <code class="placeholder-magnet">public/catalog.json</code> for the
        <code class="placeholder-magnet">${escapeHtml(slug)}</code> entry.
      </div>
    `
    return
  }

  statusHost.innerHTML = `
    <div class="banner info" id="loading-banner">Connecting to swarm and fetching torrent metadata…</div>
  `
  const webSeeds = entry.web_seeds || (entry.web_seed ? [entry.web_seed] : [])
  dlog('addTorrent for ' + slug)

  let torrent
  try {
    torrent = await addTorrent(entry.magnet, { webSeeds })
    dok('torrent ready: ' + torrent.infoHash + ' files=' + torrent.files.length + ' size=' + formatSize(torrent.length))
  } catch (err) {
    derr('addTorrent failed: ' + (err.message || err))
    statusHost.innerHTML = `<div class="banner error">Failed to add torrent: ${escapeHtml(err.message || String(err))}</div>`
    return
  }

  currentTorrent = torrent
  currentFiles = torrent.files.slice()

  renderStatusBar(statusHost, torrent)
  renderTable(tableHost)

  // Periodic updates for swarm stats and per-file progress
  progressTimer = setInterval(() => {
    updateStatusBar(statusHost, torrent)
    updateActiveRows()
  }, PROGRESS_REFRESH_MS)
}

function renderStatusBar(host, torrent) {
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
  updateStatusBar(host, torrent)
}

function updateStatusBar(host, torrent) {
  const bar = host.querySelector('.status-bar')
  if (!bar) return
  const peers = torrent.numPeers || 0
  const dotClass = peers > 0 ? 'live' : (torrent.ready ? 'warn' : '')
  bar.querySelector('.files').innerHTML = `<span class="dot ${dotClass}"></span>${torrent.files.length} files`
  bar.querySelector('.size').textContent = `· ${formatSize(torrent.length)} total`
  bar.querySelector('.peers').textContent = `· ${peers} peer${peers === 1 ? '' : 's'}`
  bar.querySelector('.rate').textContent = `· ↓ ${formatSize(torrent.downloadSpeed)}/s`
}

function renderTable(host) {
  const table = document.createElement('table')
  table.className = 'file-table'
  table.innerHTML = `
    <thead>
      <tr>
        <th class="col-name" data-sort="name">Name <span class="arrow">▲</span></th>
        <th class="col-size" data-sort="size">Size <span class="arrow">▲</span></th>
        <th class="col-progress">Progress</th>
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
      renderRows(table)
    })
  })

  renderRows(table)
}

function renderRows(table) {
  const tbody = table.querySelector('tbody')
  tbody.innerHTML = ''

  // Update header sort indicators
  table.querySelectorAll('thead th').forEach((th) => {
    th.classList.remove('sorted')
    const arrow = th.querySelector('.arrow')
    if (!arrow) return
    if (th.dataset.sort === currentSort.key) {
      th.classList.add('sorted')
      arrow.textContent = currentSort.dir > 0 ? '▲' : '▼'
    }
  })

  const filter = currentFilter.toLowerCase()
  const filtered = filter
    ? currentFiles.filter((f) => f.name.toLowerCase().includes(filter))
    : currentFiles.slice()

  filtered.sort((a, b) => {
    let cmp = 0
    if (currentSort.key === 'size') cmp = a.length - b.length
    else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return cmp * currentSort.dir
  })

  if (!filtered.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td colspan="3" class="empty" style="border:none">No files match.</td>`
    tbody.appendChild(tr)
    return
  }

  for (const file of filtered) {
    const tr = document.createElement('tr')
    tr.dataset.name = file.name
    tr.innerHTML = `
      <td class="col-name"><span class="icon">📦</span><span class="fname"></span></td>
      <td class="col-size"></td>
      <td class="col-progress"></td>
    `
    tr.querySelector('.fname').textContent = file.name
    tr.querySelector('.col-size').textContent = formatSize(file.length)

    // Restore visible state if this file is mid-download or done
    const state = activeRowState.get(file)
    const progressCell = tr.querySelector('.col-progress')
    if (state) {
      state.row = tr
      state.progressCell = progressCell
      applyRowState(file, state)
    } else if (file.done) {
      progressCell.textContent = 'done'
      tr.classList.add('done')
    }

    tr.addEventListener('click', () => onRowClick(file, tr, progressCell))
    tbody.appendChild(tr)
  }
}

function onRowClick(file, row, progressCell) {
  const state = activeRowState.get(file)
  if (state && state.status === 'downloading') {
    // Cancel
    state.handle.cancel()
    state.status = 'cancelled'
    progressCell.textContent = 'cancelled'
    row.classList.remove('downloading')
    activeRowState.delete(file)
    return
  }
  if (file.done && (!state || state.status === 'done')) {
    // Already saved this session — re-trigger download via blob (cheap)
    file.blob().then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    })
    return
  }

  // Start a new download
  const newState = { row, progressCell, handle: null, status: 'downloading', progress: 0 }
  activeRowState.set(file, newState)
  row.classList.add('downloading')
  renderProgress(progressCell, 0)

  newState.handle = downloadFile(currentTorrent, file, ({ progress, done, error }) => {
    if (error) {
      newState.status = 'error'
      progressCell.textContent = 'error'
      row.classList.remove('downloading')
      return
    }
    newState.progress = progress
    if (done) {
      newState.status = 'done'
      progressCell.textContent = 'done'
      row.classList.remove('downloading')
      row.classList.add('done')
    } else {
      renderProgress(progressCell, progress)
    }
  })
}

function renderProgress(cell, fraction) {
  const pct = Math.max(0, Math.min(100, fraction * 100))
  cell.innerHTML = `<span class="bar"><span style="width:${pct.toFixed(1)}%"></span></span><span class="pct">${pct.toFixed(0)}%</span>`
}

function applyRowState(file, state) {
  const { row, progressCell, status, progress } = state
  if (status === 'downloading') {
    row.classList.add('downloading')
    renderProgress(progressCell, progress || file.progress || 0)
  } else if (status === 'done') {
    row.classList.add('done')
    progressCell.textContent = 'done'
  } else if (status === 'error') {
    progressCell.textContent = 'error'
  } else if (status === 'cancelled') {
    progressCell.textContent = 'cancelled'
  }
}

function updateActiveRows() {
  // Walk currentFiles; if a file has an active state, refresh its progress text.
  for (const file of currentFiles) {
    const state = activeRowState.get(file)
    if (!state || state.status !== 'downloading' || !state.progressCell) continue
    state.progress = file.progress
    renderProgress(state.progressCell, file.progress)
  }
}

// ---------- Filter ----------

filterInput.addEventListener('input', () => {
  currentFilter = filterInput.value.trim()
  const table = view.querySelector('.file-table')
  if (table) renderRows(table)
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
route()
