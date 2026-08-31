const state = {
  roots: [],
  root: null,
  path: '',
  subtreeCount: 0,
  gridFiles: [],
  gridTotal: 0,
  gridOffset: 0,
  gridLoading: false,
  drill: localStorage.getItem('refdeck.drill') === '1',
  typeFilter: '',
  extActive: new Set(),
  view: localStorage.getItem('refdeck.view') || 'masonry',
  sidebarHidden: localStorage.getItem('refdeck.sidebarHidden') === '1',
  zen: false,
  previewIndex: null,
  previewItem: null,
  pvDetailsOpen: false,
  contextIndex: null,
  pv: { scale: 1, x: 0, y: 0 },
  masonryNext: 0,
  contextItem: null,
  filter: '',
  sort: 'name',
  collections: [],
  selectedCollectionId: null,
  currentBoard: { id: null, title: 'Untitled board', document: { items: [], viewport: { x: 0, y: 0, scale: 1 } } },
  selectedBoard: new Set(),
  editingNote: null,
  mode: 'split',
  canvas: { x: 0, y: 0, scale: 1 }
}

const PAGE = 200
const EXT_GROUPS = {
  image: [['jpg', 'jpg,jpeg'], ['png', 'png'], ['gif', 'gif'], ['webp', 'webp'],
          ['psd', 'psd'], ['tiff', 'tif,tiff'], ['heic', 'heic,heif'], ['bmp', 'bmp']],
  video: [['mp4', 'mp4,m4v'], ['mov', 'mov'], ['mkv', 'mkv'], ['webm', 'webm'],
          ['avi', 'avi'], ['mts', 'mts,m2ts']]
}
const $ = id => document.getElementById(id)
const headers = { 'Content-Type': 'application/json' }
const h = text => String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
const mediaUrl = item => `/api/media?root=${encodeURIComponent(item.root || state.root)}&path=${encodeURIComponent(item.path)}`
const thumbUrl = item => `/api/thumb?root=${encodeURIComponent(item.root || state.root)}&path=${encodeURIComponent(item.path)}`
const previewUrl = item => `/api/preview?root=${encodeURIComponent(item.root || state.root)}&path=${encodeURIComponent(item.path)}`

async function api(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) {
    let detail
    try { detail = JSON.parse(await res.text()).detail } catch { /* raw text below */ }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function init() {
  await refreshRootSelect()
  $('rootSelect').onchange = () => { state.root = $('rootSelect').value; state.path = ''; browse() }
  $('upButton').onclick = () => { state.path = state.path.split('/').slice(0, -1).join('/'); browse() }
  let searchTimer
  $('searchBox').oninput = event => {
    state.filter = event.target.value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(resetGrid, 250)
  }
  $('sortSelect').onchange = event => { state.sort = event.target.value; resetGrid() }
  $('drillToggle').onclick = () => setDrill(!state.drill)
  $('drillToggle').classList.toggle('active', state.drill)
  document.querySelectorAll('#typeSeg button').forEach(b => b.onclick = () => {
    state.typeFilter = b.dataset.type
    state.extActive.clear()
    document.querySelectorAll('#typeSeg button').forEach(x => x.classList.toggle('active', x === b))
    renderExtFilters()
    resetGrid()
  })
  document.querySelector('#typeSeg button[data-type=""]').classList.add('active')
  renderExtFilters()
  $('newCollection').onclick = newCollection
  $('newBoard').onclick = () => { state.currentBoard = { id: null, title: 'Untitled board', document: { items: [], viewport: { x: 0, y: 0, scale: 1 } } }; state.selectedBoard.clear(); setCanvas(0, 0, 1); renderBoard() }
  $('addNote').onclick = () => addNoteAt(viewportCenterWorld())
  document.querySelectorAll('#alignSeg button').forEach(b => b.onclick = () => alignSelected(b.dataset.align))
  $('boardViewport').addEventListener('contextmenu', event => {
    event.preventDefault()
    if (event.ctrlKey) return  // ctrl+drag is marquee select; suppress macOS ctrl-click menu
    const itemEl = event.target.closest('.boardItem')
    openBoardCtx(event, itemEl ? +itemEl.dataset.idx : null)
  })
  $('bctx').onclick = event => {
    const button = event.target.closest('button[data-b]')
    $('bctx').hidden = true
    if (!button) return
    const action = button.dataset.b
    const idx = state.bctxIndex
    const items = state.currentBoard.document.items
    const item = idx !== null ? items[idx] : null
    if (action === 'note') addNoteAt(state.bctxWorld)
    if (action === 'selectall') { state.selectedBoard = new Set(items.map((_, i) => i)); renderBoard() }
    if (action.startsWith('align-')) alignSelected(action.slice(6))
    if (action === 'dist-h') distributeSelected('h')
    if (action === 'dist-v') distributeSelected('v')
    if (action === 'arrange') arrangeSelected(false)
    if (action === 'arrange-size') arrangeSelected(true)
    if (!item) return
    if (action === 'preview' && item.type !== 'note') preview(item)
    if (action === 'edit' && item.type === 'note') { state.editingNote = idx; renderBoard() }
    if (action === 'front') moveSelectedLayer(1)
    if (action === 'back') moveSelectedLayer(-1)
    if (action === 'delete') deleteSelectedBoardItem()
  }
  $('saveBoard').onclick = saveBoard
  $('modeExplorer').onclick = () => setMode('explorer')
  $('modeSplit').onclick = () => setMode('split')
  $('modeCanvas').onclick = () => setMode('canvas')
  $('zenToggle').onclick = () => setZen(!state.zen)
  syncModeSeg()
  $('zoomOut').onclick = () => zoomAtCenter(0.82)
  $('zoomIn').onclick = () => zoomAtCenter(1.22)
  $('zoomReset').onclick = () => setCanvas(0, 0, 1)
  $('bringForward').onclick = () => moveSelectedLayer(1)
  $('sendBackward').onclick = () => moveSelectedLayer(-1)
  $('deleteBoardItem').onclick = deleteSelectedBoardItem
  $('openSettings').onclick = openSettings
  $('closeSettings').onclick = () => $('settings').close()
  $('mountForm').onsubmit = async event => {
    event.preventDefault()
    const body = Object.fromEntries(new FormData(event.target))
    $('mountError').textContent = ''
    try {
      await api('/api/mounts', { method: 'POST', headers, body: JSON.stringify(body) })
      event.target.reset()
      await renderSettings()
      await refreshRootSelect()
      pollScan()
    } catch (err) { $('mountError').textContent = err.message }
  }
  $('viewMasonry').onclick = () => setView('masonry')
  $('viewGrid').onclick = () => setView('cards')
  $('viewList').onclick = () => setView('list')
  syncViewButtons()
  $('toggleSidebar').onclick = () => setSidebarHidden(!state.sidebarHidden)
  applySidebar()
  $('grid').onclick = event => {
    const itemEl = event.target.closest('[data-idx]')
    if (!itemEl) return
    const idx = +itemEl.dataset.idx
    const item = state.gridFiles[idx]
    const button = event.target.closest('button[data-action]')
    if (button) {
      if (button.dataset.action === 'preview') openPreviewAt(idx)
      if (button.dataset.action === 'board') addToBoard(item)
      if (button.dataset.action === 'collect') addToSelectedCollection(item)
      return
    }
    if (state.view !== 'cards') openPreviewAt(idx)
  }
  $('grid').addEventListener('contextmenu', event => {
    const itemEl = event.target.closest('[data-idx]')
    if (!itemEl) return
    event.preventDefault()
    state.contextIndex = +itemEl.dataset.idx
    openCtxMenu(event, state.gridFiles[state.contextIndex])
  })
  $('ctxMenu').onclick = event => {
    const button = event.target.closest('button[data-ctx]')
    $('ctxMenu').hidden = true
    if (!button || !state.contextItem) return
    const item = state.contextItem
    if (button.dataset.ctx === 'preview') openPreviewAt(state.contextIndex)
    if (button.dataset.ctx === 'board') addToBoard(item)
    if (button.dataset.ctx === 'collect') addToSelectedCollection(item)
    if (button.dataset.ctx === 'original') window.open(mediaUrl(normalizeExplorerItem(item)), '_blank')
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('#ctxMenu')) $('ctxMenu').hidden = true
    if (!event.target.closest('#bctx')) $('bctx').hidden = true
  })
  $('gridScroll').addEventListener('scroll', () => { $('ctxMenu').hidden = true }, { passive: true })
  $('grid').addEventListener('dragstart', event => {
    const itemEl = event.target.closest('[data-idx]')
    if (!itemEl) return
    event.dataTransfer.setData('application/json', JSON.stringify(normalizeExplorerItem(state.gridFiles[+itemEl.dataset.idx])))
    event.dataTransfer.effectAllowed = 'copy'
  })
  let resizeTimer
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => { if (state.view === 'masonry') renderLoaded() }, 200)
  })
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && state.gridFiles.length < state.gridTotal) loadMore()
  }, { root: $('gridScroll'), rootMargin: '600px' }).observe($('gridSentinel'))
  document.addEventListener('keydown', event => {
    if (!$('preview').open) return
    if (event.key === 'ArrowRight' && !event.ctrlKey) { event.preventDefault(); previewNav(1) }
    if (event.key === 'ArrowLeft' && !event.ctrlKey) { event.preventDefault(); previewNav(-1) }
    if (event.ctrlKey && event.key === 'ArrowUp') { event.preventDefault(); pvZoom(1.25) }
    if (event.ctrlKey && event.key === 'ArrowDown') { event.preventDefault(); pvZoom(0.8) }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); pvZoom(1.25) }
    if (event.key === '-') { event.preventDefault(); pvZoom(0.8) }
    if (event.key === '0') { event.preventDefault(); pvResetZoom() }
    if (event.key.toLowerCase() === 'i') { event.preventDefault(); pvDetailsToggle() }
  })
  $('preview').addEventListener('close', () => {
    $('previewBody').innerHTML = ''  // removes any <video>, stopping playback
    state.previewIndex = null
    state.previewItem = null
    $('pvMenu').hidden = true
  })
  $('preview').addEventListener('contextmenu', event => {
    event.preventDefault()
    const menu = $('pvMenu')
    menu.hidden = false
    menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
    menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
  })
  $('preview').addEventListener('click', event => {
    if (!event.target.closest('#pvMenu')) $('pvMenu').hidden = true
  })
  $('pvMenu').onclick = event => {
    const button = event.target.closest('button[data-pv]')
    $('pvMenu').hidden = true
    if (!button) return
    const action = button.dataset.pv
    const item = state.previewItem
    if (action === 'prev') previewNav(-1)
    if (action === 'next') previewNav(1)
    if (action === 'zoomin') pvZoom(1.25)
    if (action === 'zoomout') pvZoom(0.8)
    if (action === 'zoomreset') pvResetZoom()
    if (action === 'details') pvDetailsToggle()
    if (action === 'close') $('preview').close()
    if (!item) return
    if (action === 'board') addToBoard(item)
    if (action === 'collect') addToSelectedCollection(item)
    if (action === 'original') window.open(mediaUrl(normalizeExplorerItem(item)), '_blank')
  }
  $('previewBody').addEventListener('wheel', event => {
    if (!event.ctrlKey) return
    event.preventDefault()
    pvZoom(event.deltaY > 0 ? 0.9 : 1.1)
  }, { passive: false })
  $('previewBody').onmousedown = event => {
    if (state.pv.scale <= 1 || event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX, startY = event.clientY, origin = { ...state.pv }
    $('previewBody').classList.add('panning')
    document.onmousemove = move => {
      state.pv.x = origin.x + move.clientX - startX
      state.pv.y = origin.y + move.clientY - startY
      pvApply()
    }
    document.onmouseup = () => {
      $('previewBody').classList.remove('panning')
      document.onmousemove = null
      document.onmouseup = null
    }
  }
  document.addEventListener('mousemove', event => {
    if (!state.zen) return
    if (event.clientY <= 10) document.body.classList.add('peek-top')
    else if (event.clientY > 200) document.body.classList.remove('peek-top')
    if (event.clientX <= 10) document.body.classList.add('peek-left')
    else if (event.clientX > 300) document.body.classList.remove('peek-left')
  }, { passive: true })
  document.addEventListener('keydown', handleKeys)
  setupBoardViewport()
  if (state.root) await browse()
  await loadCollections()
  await loadBoards()
  renderBoard()
  pollScan()
}

function handleKeys(event) {
  if (event.target.closest('input, textarea, select, dialog')) return
  const key = event.key.toLowerCase()
  if (key === 'c') { event.preventDefault(); setMode(state.mode === 'canvas' ? 'split' : 'canvas') }
  if (key === 'e') { event.preventDefault(); setMode(state.mode === 'explorer' ? 'split' : 'explorer') }
  if (key === 'd') { event.preventDefault(); setDrill(!state.drill) }
  if (key === 'f') { event.preventDefault(); setSidebarHidden(!state.sidebarHidden) }
  if (key === 'z') { event.preventDefault(); setZen(!state.zen) }
  if (key === 'n') { event.preventDefault(); addNoteAt(viewportCenterWorld()) }
  if (event.key === 'Escape') {
    if (state.zen) { setZen(false); return }
    setMode('split'); clearSelection()
  }
  if (event.key === 'Delete' || event.key === 'Backspace') { deleteSelectedBoardItem() }
  if (event.key === ']') { moveSelectedLayer(1) }
  if (event.key === '[') { moveSelectedLayer(-1) }
  if ((event.metaKey || event.ctrlKey) && key === 's') { event.preventDefault(); saveBoard() }
}

function setMode(mode) {
  state.mode = mode
  document.body.classList.toggle('mode-canvas', mode === 'canvas')
  document.body.classList.toggle('mode-explorer', mode === 'explorer')
  syncModeSeg()
  if (state.view === 'masonry') renderLoaded()
}

function syncModeSeg() {
  $('modeExplorer').classList.toggle('active', state.mode === 'explorer')
  $('modeSplit').classList.toggle('active', state.mode === 'split')
  $('modeCanvas').classList.toggle('active', state.mode === 'canvas')
}

function setZen(on) {
  state.zen = on
  document.body.classList.toggle('zen', on)
  document.body.classList.remove('peek-top', 'peek-left')
  $('zenToggle').classList.toggle('active', on)
  if (state.view === 'masonry') renderLoaded()
}

async function refreshRootSelect() {
  state.roots = await api('/api/roots')
  $('rootSelect').innerHTML = state.roots.map(r => `<option ${r.name === state.root ? 'selected' : ''}>${h(r.name)}</option>`).join('')
  if (!state.roots.some(r => r.name === state.root)) {
    state.root = state.roots[0]?.name
    state.path = ''
    if (state.root) browse()
  }
}

async function browse() {
  const listing = await api(`/api/browse?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`)
  state.subtreeCount = listing.media_count
  $('pathLabel').textContent = `${state.root}/${state.path}`
  $('dirList').innerHTML = listing.dirs.map(d => `<div class="row" data-path="${h(d.path)}">📁 ${h(d.name)}</div>`).join('')
  document.querySelectorAll('#dirList .row').forEach(row => row.onclick = () => { state.path = row.dataset.path; browse() })
  await resetGrid()
}

async function resetGrid() {
  state.gridFiles = []
  state.gridTotal = 0
  state.gridOffset = 0
  prepareGrid()
  await loadMore()
}

function prepareGrid() {
  const grid = $('grid')
  grid.className = state.view
  grid.innerHTML = ''
  if (state.view === 'masonry') buildMasonryColumns()
}

function buildMasonryColumns() {
  const grid = $('grid')
  const cols = Math.max(2, Math.floor(grid.clientWidth / 240) || 2)
  state.masonryNext = 0
  grid.innerHTML = Array.from({ length: cols }, () => '<div class="mcol"></div>').join('')
}

function renderLoaded() {
  prepareGrid()
  appendDOM(state.gridFiles, 0)
}

function setView(view) {
  state.view = view
  localStorage.setItem('refdeck.view', view)
  syncViewButtons()
  renderLoaded()
}

function setSidebarHidden(hidden) {
  state.sidebarHidden = hidden
  localStorage.setItem('refdeck.sidebarHidden', hidden ? '1' : '0')
  applySidebar()
  if (state.view === 'masonry') renderLoaded()
}

function applySidebar() {
  document.body.classList.toggle('hide-sidebar', state.sidebarHidden)
  $('toggleSidebar').classList.toggle('active', state.sidebarHidden)
}

function syncViewButtons() {
  $('viewMasonry').classList.toggle('active', state.view === 'masonry')
  $('viewGrid').classList.toggle('active', state.view === 'cards')
  $('viewList').classList.toggle('active', state.view === 'list')
}

function openCtxMenu(event, item) {
  state.contextItem = item
  const menu = $('ctxMenu')
  menu.hidden = false
  menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
  menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
}

async function loadMore() {
  if (state.gridLoading || !state.root) return
  state.gridLoading = true
  try {
    const exts = [...state.extActive].map(key =>
      (EXT_GROUPS[state.typeFilter] || []).find(([k]) => k === key)?.[1]).filter(Boolean).join(',')
    const params = new URLSearchParams({
      root: state.root, path: state.path, recursive: state.drill ? '1' : '0',
      query: state.filter.trim(), sort: state.sort, limit: PAGE, offset: state.gridOffset,
      type: state.typeFilter, exts
    })
    const page = await api(`/api/files?${params}`)
    state.gridTotal = page.total
    state.gridOffset += page.files.length
    appendCards(page.files)
    $('mediaCount').textContent = `${state.gridFiles.length}/${state.gridTotal} items`
    renderGridHint()
  } finally { state.gridLoading = false }
}

function renderGridHint() {
  const hint = $('gridHint')
  if (state.gridTotal === 0 && !state.drill && !state.filter && state.subtreeCount > 0) {
    hint.hidden = false
    hint.innerHTML = `No media in this folder — <b>${state.subtreeCount}</b> items in subfolders. <button id="hintDrill">Drill down</button>`
    $('hintDrill').onclick = () => setDrill(true)
  } else if (state.gridTotal === 0) {
    hint.hidden = false
    hint.textContent = state.filter ? 'No matches.' : 'No media here.'
  } else hint.hidden = true
}

function renderExtFilters() {
  const groups = EXT_GROUPS[state.typeFilter] || []
  $('extFilters').innerHTML = groups.map(([key]) =>
    `<button class="chip ${state.extActive.has(key) ? 'active' : ''}" data-extgroup="${key}">${key}</button>`).join('')
  document.querySelectorAll('[data-extgroup]').forEach(chip => chip.onclick = () => {
    const key = chip.dataset.extgroup
    state.extActive.has(key) ? state.extActive.delete(key) : state.extActive.add(key)
    renderExtFilters()
    resetGrid()
  })
}

function setDrill(on) {
  state.drill = on
  localStorage.setItem('refdeck.drill', on ? '1' : '0')
  $('drillToggle').classList.toggle('active', on)
  resetGrid()
}

function appendCards(files) {
  const start = state.gridFiles.length
  state.gridFiles.push(...files)
  appendDOM(files, start)
}

function appendDOM(files, start) {
  const grid = $('grid')
  if (state.view === 'masonry') {
    const cols = grid.querySelectorAll('.mcol')
    if (!cols.length) return
    files.forEach((f, i) => {
      const frag = document.createElement('template')
      frag.innerHTML = `<div class="mItem" draggable="true" data-idx="${start + i}" title="${h(f.name)}"><img src="${thumbUrl(f)}" loading="lazy" /></div>`
      cols[state.masonryNext++ % cols.length].append(frag.content)
    })
    return
  }
  const frag = document.createElement('template')
  if (state.view === 'list') {
    frag.innerHTML = files.map((f, i) => `
      <div class="lrow" draggable="true" data-idx="${start + i}">
        <img src="${thumbUrl(f)}" loading="lazy" />
        <span class="lname" title="${h(f.path)}">${h(f.name)}</span>
        <span class="lmeta">${h(f.media_type)}</span>
        <span class="lmeta">${formatBytes(f.size)}</span>
        <span class="lmeta">${new Date(f.mtime * 1000).toLocaleDateString()}</span>
      </div>`).join('')
  } else {
    frag.innerHTML = files.map((f, i) => `
      <div class="card" draggable="true" data-idx="${start + i}">
        <img src="${thumbUrl(f)}" loading="lazy" />
        <div class="name" title="${h(f.path)}">${h(f.name)}</div>
        <div class="meta">${h(f.media_type)} · ${formatBytes(f.size)}</div>
        <div class="actions">
          <button data-action="preview">Preview</button>
          <button data-action="board">Board</button>
          <button data-action="collect">Collect</button>
        </div>
      </div>`).join('')
  }
  grid.append(frag.content)
}

function normalizeExplorerItem(item) {
  return { root: item.root || state.root, path: item.path, media_type: item.media_type, name: item.name || item.path.split('/').pop() }
}

function preview(item) {
  state.previewIndex = null
  renderPreview(item)
}

function openPreviewAt(idx) {
  state.previewIndex = idx
  renderPreview(state.gridFiles[idx])
}

function renderPreview(item) {
  const normalized = normalizeExplorerItem(item)
  state.previewItem = item
  pvResetZoom()
  $('previewBody').innerHTML = normalized.media_type === 'video'
    ? `<video src="${mediaUrl(normalized)}" controls autoplay></video>`
    : `<img src="${previewUrl(normalized)}" draggable="false" />`
  renderPvDetails()
  const media = pvMedia()
  if (media) {
    const update = () => renderPvDetails()
    media.tagName === 'VIDEO' ? media.addEventListener('loadedmetadata', update) : media.addEventListener('load', update)
  }
  if (!$('preview').open) $('preview').showModal()
}

function pvDetailsToggle() {
  state.pvDetailsOpen = !state.pvDetailsOpen
  renderPvDetails()
}

function formatDuration(seconds) {
  if (!isFinite(seconds)) return null
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function renderPvDetails() {
  const panel = $('pvDetails')
  panel.hidden = !state.pvDetailsOpen
  if (panel.hidden || !state.previewItem) return
  const item = state.previewItem
  const normalized = normalizeExplorerItem(item)
  const media = pvMedia()
  const rows = [['Name', normalized.name], ['Location', `${normalized.root}/${normalized.path}`], ['Type', item.media_type]]
  if (item.size) rows.push(['Size', formatBytes(item.size)])
  if (item.mtime) rows.push(['Modified', new Date(item.mtime * 1000).toLocaleString()])
  if (media?.tagName === 'IMG' && media.naturalWidth) {
    rows.push(['Dimensions', `${media.naturalWidth} × ${media.naturalHeight}`])
    rows.push(['Aspect', (media.naturalWidth / media.naturalHeight).toFixed(3)])
    if (item.media_type === 'image' && normalized.path.match(/\.(psd|heic|heif|tif|tiff)$/i))
      rows.push(['Note', 'converted preview — dimensions may be capped at 2048'])
  }
  if (media?.tagName === 'VIDEO' && media.videoWidth) {
    rows.push(['Dimensions', `${media.videoWidth} × ${media.videoHeight}`])
    const duration = formatDuration(media.duration)
    if (duration) rows.push(['Duration', duration])
  }
  panel.innerHTML = `<dl>${rows.map(([label, value]) => `<dt>${h(label)}</dt><dd>${h(value)}</dd>`).join('')}</dl>`
}

function pvMedia() { return $('previewBody').firstElementChild }

function pvApply() {
  const media = pvMedia()
  if (media) media.style.transform = `translate(${state.pv.x}px, ${state.pv.y}px) scale(${state.pv.scale})`
  $('previewBody').classList.toggle('zoomed', state.pv.scale > 1)
}

function pvZoom(factor) {
  state.pv.scale = clamp(state.pv.scale * factor, 0.2, 10)
  if (state.pv.scale <= 1.001) { state.pv.x = 0; state.pv.y = 0 }
  pvApply()
}

function pvResetZoom() {
  state.pv = { scale: 1, x: 0, y: 0 }
  pvApply()
}

async function previewNav(direction) {
  if (state.previewIndex === null) return
  const next = state.previewIndex + direction
  if (next < 0) return
  if (next >= state.gridFiles.length) {
    if (state.gridFiles.length >= state.gridTotal) return
    await loadMore()
    if (next >= state.gridFiles.length) return
  }
  state.previewIndex = next
  renderPreview(state.gridFiles[next])
}

async function newCollection() {
  const title = prompt('Collection name?')
  if (!title) return
  const created = await api('/api/collections', { method: 'POST', headers, body: JSON.stringify({ title }) })
  state.selectedCollectionId = created.id
  await loadCollections()
}

async function loadCollections() {
  state.collections = await api('/api/collections')
  if (!state.selectedCollectionId && state.collections.length) state.selectedCollectionId = state.collections[0].id
  renderCollections()
}

function renderCollections() {
  $('collections').innerHTML = state.collections.map(c => `
    <div class="row ${c.id === state.selectedCollectionId ? 'selected' : ''}" data-collectionid="${c.id}">
      <button class="mini" data-delcollection="${c.id}">✕</button>
      ${h(c.title)} (${c.items.length})
    </div>`).join('')
  document.querySelectorAll('[data-collectionid]').forEach(row => row.onclick = () => { state.selectedCollectionId = +row.dataset.collectionid; renderCollections() })
  document.querySelectorAll('[data-delcollection]').forEach(b => b.onclick = async event => {
    event.stopPropagation()
    if (!confirm('Delete this collection?')) return
    await api(`/api/collections/${b.dataset.delcollection}`, { method: 'DELETE' })
    if (state.selectedCollectionId === +b.dataset.delcollection) state.selectedCollectionId = null
    await loadCollections()
  })
  const selected = selectedCollection()
  if (!selected) {
    $('collectionDetail').innerHTML = '<div class="hint">Create a collection, then use Collect on media cards.</div>'
    return
  }
  $('collectionDetail').innerHTML = `
    <div class="hint">Selected: ${h(selected.title)}</div>
    ${selected.items.map(item => collectionItemHtml(item)).join('') || '<div class="hint">Empty. Use Collect on media cards.</div>'}`
  document.querySelectorAll('[data-removeitem]').forEach(b => b.onclick = async () => { await api(`/api/collections/items/${b.dataset.removeitem}`, { method: 'DELETE' }); await loadCollections() })
  document.querySelectorAll('[data-boarditem]').forEach(b => addCollectionButtonHandler(b, addToBoard))
  document.querySelectorAll('[data-previewitem]').forEach(b => addCollectionButtonHandler(b, preview))
}

function collectionItemHtml(item) {
  const media = itemFromCollection(item)
  return `
    <div class="collectionItem">
      <div class="name">${h(media.name)}</div>
      <div class="actions">
        <button data-previewitem="${item.id}">Preview</button>
        <button data-boarditem="${item.id}">Board</button>
        <button data-removeitem="${item.id}">Remove</button>
      </div>
    </div>`
}

function addCollectionButtonHandler(button, fn) {
  button.onclick = () => {
    const selected = selectedCollection()
    const item = selected?.items.find(x => String(x.id) === String(button.dataset.boarditem || button.dataset.previewitem))
    if (item) fn(itemFromCollection(item))
  }
}

function selectedCollection() {
  return state.collections.find(c => c.id === state.selectedCollectionId)
}

async function addToSelectedCollection(item) {
  if (!state.collections.length) await newCollection()
  const selected = selectedCollection()
  if (!selected) return
  const normalized = normalizeExplorerItem(item)
  await api(`/api/collections/${selected.id}/items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: `${normalized.root}/${normalized.path}`, media_type: normalized.media_type })
  })
  await loadCollections()
  $('status').textContent = `added to ${selected.title}`
}

function itemFromCollection(item) {
  const slash = item.path.indexOf('/')
  const root = slash > -1 ? item.path.slice(0, slash) : state.root
  const path = slash > -1 ? item.path.slice(slash + 1) : item.path
  return { root, path, media_type: item.media_type, name: path.split('/').pop() }
}

async function loadBoards() {
  const boards = await api('/api/boards')
  $('boards').innerHTML = boards.map(b => `<div class="row" data-boardid="${b.id}"><button class="mini" data-delboard="${b.id}">✕</button>${h(b.title)}</div>`).join('')
  document.querySelectorAll('[data-boardid]').forEach(row => row.onclick = async () => {
    state.currentBoard = await api(`/api/boards/${row.dataset.boardid}`)
    const viewport = state.currentBoard.document.viewport || { x: 0, y: 0, scale: 1 }
    setCanvas(viewport.x || 0, viewport.y || 0, viewport.scale || 1)
    state.selectedBoard.clear()
    renderBoard()
  })
  document.querySelectorAll('[data-delboard]').forEach(b => b.onclick = async event => {
    event.stopPropagation()
    if (!confirm('Delete this board?')) return
    await api(`/api/boards/${b.dataset.delboard}`, { method: 'DELETE' })
    if (state.currentBoard.id === +b.dataset.delboard) $('newBoard').click()
    await loadBoards()
  })
}

async function openSettings() {
  await renderSettings()
  $('settings').showModal()
}

async function renderSettings() {
  const [rootList, mountList] = await Promise.all([api('/api/roots'), api('/api/mounts')])
  state.roots = rootList
  $('rootList').innerHTML = rootList.map(r => `
    <div class="settingsRow">
      <span class="dot ${r.online ? 'on' : 'off'}"></span>
      <span class="grow">${h(r.name)} <small>${r.media_count} files</small></span>
      <button data-rescan="${h(r.name)}" ${r.online ? '' : 'disabled'}>Rescan</button>
    </div>`).join('')
  document.querySelectorAll('[data-rescan]').forEach(b => b.onclick = async () => {
    await api(`/api/scan/${encodeURIComponent(b.dataset.rescan)}`, { method: 'POST' })
    pollScan()
  })
  $('mountList').innerHTML = mountList.map(m => `
    <div class="settingsRow">
      <span class="dot ${m.online ? 'on' : 'off'}"></span>
      <span class="grow">${h(m.name)} <small>//${h(m.server)}/${h(m.share)}</small>${m.error ? `<div class="hint">${h(m.error)}</div>` : ''}</span>
      <button data-unmount="${m.id}">Remove</button>
    </div>`).join('') || '<div class="hint">No mounts yet.</div>'
  document.querySelectorAll('[data-unmount]').forEach(b => b.onclick = async () => {
    if (!confirm('Unmount and remove this share?')) return
    await api(`/api/mounts/${b.dataset.unmount}`, { method: 'DELETE' })
    await renderSettings()
    await refreshRootSelect()
  })
}

let scanTimer
async function pollScan() {
  const status = await api('/api/scan/status')
  const active = Object.entries(status).filter(([, s]) => s.state !== 'idle')
  if (active.length) {
    $('status').textContent = active
      .map(([name, s]) => s.state === 'scanning' ? `scanning ${name}…` : `caching thumbnails for ${name} (${s.files} files)…`)
      .join(' · ')
    clearTimeout(scanTimer)
    scanTimer = setTimeout(pollScan, 3000)
  } else if (/^(scanning|caching)/.test($('status').textContent)) {
    $('status').textContent = 'scan complete'
    refreshRootSelect()
  }
}

function setupBoardViewport() {
  const viewport = $('boardViewport')
  const board = $('board')
  // ctrl/cmd + drag anywhere = marquee selection (capture phase so items don't swallow it)
  viewport.addEventListener('mousedown', event => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    event.stopPropagation()
    startMarquee(event, viewport)
  }, true)
  viewport.ondragover = event => { event.preventDefault(); board.classList.add('dropTarget') }
  viewport.ondragleave = () => board.classList.remove('dropTarget')
  viewport.ondrop = event => {
    event.preventDefault()
    board.classList.remove('dropTarget')
    const raw = event.dataTransfer.getData('application/json')
    if (!raw) return
    try { addToBoard(JSON.parse(raw), screenToWorld(event.clientX, event.clientY)) } catch { return }
  }
  viewport.onwheel = event => {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    zoomAtPoint(event.clientX, event.clientY, factor)
  }
  viewport.onmousedown = event => {
    if (event.target !== viewport && event.target !== board) return
    clearSelection()
    const startX = event.clientX, startY = event.clientY, startCanvas = { ...state.canvas }
    viewport.classList.add('dragging')
    document.onmousemove = move => setCanvas(startCanvas.x + move.clientX - startX, startCanvas.y + move.clientY - startY, startCanvas.scale)
    document.onmouseup = () => { viewport.classList.remove('dragging'); document.onmousemove = null; document.onmouseup = null }
  }
}

function startMarquee(event, viewport) {
  const viewRect = viewport.getBoundingClientRect()
  const additive = event.shiftKey
  const startX = event.clientX, startY = event.clientY
  const box = document.createElement('div')
  box.id = 'marquee'
  viewport.appendChild(box)
  let rect = null
  document.onmousemove = move => {
    const x1 = Math.min(startX, move.clientX), y1 = Math.min(startY, move.clientY)
    const x2 = Math.max(startX, move.clientX), y2 = Math.max(startY, move.clientY)
    rect = [x1, y1, x2, y2]
    Object.assign(box.style, {
      left: (x1 - viewRect.left) + 'px', top: (y1 - viewRect.top) + 'px',
      width: (x2 - x1) + 'px', height: (y2 - y1) + 'px'
    })
  }
  document.onmouseup = () => {
    document.onmousemove = null
    document.onmouseup = null
    box.remove()
    if (!rect) { if (!additive) clearSelection(); return }
    const a = screenToWorld(rect[0], rect[1])
    const b = screenToWorld(rect[2], rect[3])
    const hit = new Set(additive ? state.selectedBoard : [])
    state.currentBoard.document.items.forEach((it, i) => {
      if (it.x < b.x && it.x + it.w > a.x && it.y < b.y && it.y + it.h > a.y) hit.add(i)
    })
    state.selectedBoard = hit
    renderBoard()
  }
}

function addToBoard(item, point = null) {
  const normalized = normalizeExplorerItem(item)
  const drop = point || { x: 80 + Math.random() * 160, y: 80 + Math.random() * 120 }
  const boardItem = {
    root: normalized.root,
    path: normalized.path,
    media_type: normalized.media_type,
    name: normalized.name,
    x: Math.round(drop.x),
    y: Math.round(drop.y),
    w: 260,
    h: 190
  }
  state.currentBoard.document.items.push(boardItem)
  state.selectedBoard = new Set([state.currentBoard.document.items.length - 1])
  fetchRatio(boardItem)
  renderBoard()
}

function fetchRatio(item) {
  if (item.ar) return
  const apply = (w, hgt) => {
    if (!w || !hgt) return
    item.ar = w / hgt
    item.h = Math.round(item.w / item.ar)
    renderBoard()
  }
  if (item.media_type === 'video') {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => apply(video.videoWidth, video.videoHeight)
    video.src = mediaUrl(item)
  } else {
    const img = new Image()
    img.onload = () => apply(img.naturalWidth, img.naturalHeight)
    img.src = previewUrl(item)
  }
}

function addNoteAt(point) {
  state.currentBoard.document.items.push({
    type: 'note', text: '', x: Math.round(point.x), y: Math.round(point.y), w: 220, h: 120
  })
  const idx = state.currentBoard.document.items.length - 1
  state.selectedBoard = new Set([idx])
  state.editingNote = idx
  renderBoard()
}

function viewportCenterWorld() {
  const rect = $('boardViewport').getBoundingClientRect()
  return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function openBoardCtx(event, idx) {
  state.bctxIndex = idx
  state.bctxWorld = screenToWorld(event.clientX, event.clientY)
  if (idx !== null && !state.selectedBoard.has(idx)) { state.selectedBoard = new Set([idx]); renderBoard() }
  const item = idx !== null ? state.currentBoard.document.items[idx] : null
  const count = state.selectedBoard.size
  const rows = []
  if (!item) {
    rows.push(['note', 'Add note here', 'N'], ['selectall', 'Select all'])
    if (count >= 2) rows.push(['arrange', 'Arrange selection'], ['arrange-size', 'Arrange by size'])
  } else {
    if (count === 1 && item.type === 'note') rows.push(['edit', 'Edit note'])
    if (count === 1 && item.type !== 'note') rows.push(['preview', 'Preview'])
    if (count === 1) rows.push(['front', 'Bring forward', ']'], ['back', 'Send backward', '['])
    if (count >= 2) rows.push(
      ['align-left', 'Align left'], ['align-right', 'Align right'],
      ['align-top', 'Align top'], ['align-bottom', 'Align bottom'],
      ['align-centerv', 'Align vertical centers'], ['align-centerh', 'Align horizontal centers'],
      ['dist-h', 'Distribute horizontally'], ['dist-v', 'Distribute vertically'],
      ['arrange', 'Arrange (pack)'], ['arrange-size', 'Arrange by size'])
    rows.push(['delete', count > 1 ? `Delete ${count} items` : 'Delete', '⌫'])
  }
  const menu = $('bctx')
  menu.innerHTML = rows.map(([action, label, kbd]) =>
    `<button data-b="${action}">${label}${kbd ? `<kbd>${kbd}</kbd>` : ''}</button>`).join('')
  menu.hidden = false
  menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
  menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
}

function distributeSelected(axis) {
  const items = state.currentBoard.document.items
  const selected = [...state.selectedBoard].map(i => items[i]).filter(Boolean)
  if (selected.length < 3) return
  if (axis === 'h') {
    selected.sort((a, b) => a.x - b.x)
    const left = Math.min(...selected.map(it => it.x))
    const right = Math.max(...selected.map(it => it.x + it.w))
    const gap = (right - left - selected.reduce((s, it) => s + it.w, 0)) / (selected.length - 1)
    let cursor = left
    for (const it of selected) { it.x = Math.round(cursor); cursor += it.w + gap }
  } else {
    selected.sort((a, b) => a.y - b.y)
    const top = Math.min(...selected.map(it => it.y))
    const bottom = Math.max(...selected.map(it => it.y + it.h))
    const gap = (bottom - top - selected.reduce((s, it) => s + it.h, 0)) / (selected.length - 1)
    let cursor = top
    for (const it of selected) { it.y = Math.round(cursor); cursor += it.h + gap }
  }
  renderBoard()
}

function arrangeSelected(bySize) {
  const all = state.currentBoard.document.items
  const idxs = state.selectedBoard.size >= 2 ? [...state.selectedBoard] : all.map((_, i) => i)
  const selected = idxs.map(i => all[i]).filter(Boolean)
  if (selected.length < 2) return
  const ROW = 220, GAP = 12
  const anchorX = Math.min(...selected.map(it => it.x))
  const anchorY = Math.min(...selected.map(it => it.y))
  const scaled = selected.map(it => ({ it, w: Math.round((it.w / it.h) * ROW) }))
  if (bySize) scaled.sort((a, b) => (b.it.w * b.it.h) - (a.it.w * a.it.h))
  const totalW = scaled.reduce((s, x) => s + x.w + GAP, 0)
  const targetW = Math.max(500, Math.round(Math.sqrt(totalW * (ROW + GAP)) * 1.2))
  let x = anchorX, y = anchorY
  for (const { it, w } of scaled) {
    if (x > anchorX && x + w > anchorX + targetW) { x = anchorX; y += ROW + GAP }
    it.x = Math.round(x)
    it.y = Math.round(y)
    it.h = ROW
    it.w = w
    x += w + GAP
  }
  renderBoard()
}

function renderBoard() {
  $('boardTitle').value = state.currentBoard.title || 'Untitled board'
  const items = state.currentBoard.document.items || []
  $('board').innerHTML = items.map((it, idx) => {
    const sel = state.selectedBoard.has(idx) ? 'selected' : ''
    const style = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px`
    if (it.type === 'note') {
      const body = state.editingNote === idx
        ? `<textarea class="noteEdit">${h(it.text)}</textarea>`
        : h(it.text || 'Double-click to edit')
      return `<div class="boardItem note ${sel}" data-idx="${idx}" style="${style}">${body}<div class="rsz"></div></div>`
    }
    const url = it.media_type === 'video' ? mediaUrl(it) : previewUrl(it)
    const media = it.media_type === 'video' ? `<video src="${url}" muted loop></video>` : `<img src="${url}" draggable="false" />`
    return `<div class="boardItem media ${sel}" data-idx="${idx}" style="${style}" title="${h(it.name || it.path)}">${media}<div class="rsz"></div></div>`
  }).join('')
  document.querySelectorAll('.boardItem').forEach(el => makeBoardItemInteractive(el))
  // legacy items saved without a ratio: adopt the real one as media loads
  document.querySelectorAll('.boardItem.media').forEach(el => {
    const item = items[+el.dataset.idx]
    if (!item || item.ar) return
    const media = el.querySelector('img, video')
    const adopt = () => {
      const w = media.naturalWidth || media.videoWidth, hgt = media.naturalHeight || media.videoHeight
      if (!w || !hgt || item.ar) return
      item.ar = w / hgt
      item.h = Math.round(item.w / item.ar)
      el.style.height = item.h + 'px'
    }
    media.tagName === 'VIDEO' ? media.addEventListener('loadedmetadata', adopt) : media.addEventListener('load', adopt)
  })
  const editor = $('board').querySelector('.noteEdit')
  if (editor) {
    editor.focus()
    editor.onblur = () => {
      const item = state.currentBoard.document.items[state.editingNote]
      if (item) item.text = editor.value
      state.editingNote = null
      renderBoard()
    }
    editor.onkeydown = event => {
      event.stopPropagation()
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') editor.blur()
      if (event.key === 'Escape') { event.preventDefault(); editor.blur() }
    }
    editor.onmousedown = event => event.stopPropagation()
  }
  updateBoardControls()
  applyCanvasTransform()
}

function makeBoardItemInteractive(el) {
  const idx = +el.dataset.idx
  const items = state.currentBoard.document.items
  el.ondblclick = event => {
    event.stopPropagation()
    const item = items[idx]
    if (item.type === 'note') { state.editingNote = idx; renderBoard() }
    else preview(item)
  }
  el.querySelector('.rsz').onmousedown = event => {
    event.stopPropagation()
    event.preventDefault()
    const item = items[idx]
    const startX = event.clientX, startY = event.clientY, startW = item.w, startH = item.h
    document.onmousemove = move => {
      const dw = (move.clientX - startX) / state.canvas.scale
      const dh = (move.clientY - startY) / state.canvas.scale
      item.w = Math.max(40, Math.round(startW + dw))
      item.h = item.ar ? Math.max(24, Math.round(item.w / item.ar)) : Math.max(40, Math.round(startH + dh))
      el.style.width = item.w + 'px'
      el.style.height = item.h + 'px'
    }
    document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; renderBoard() }
  }
  el.onmousedown = event => {
    if (event.button !== 0 || event.target.closest('.rsz, .noteEdit')) return
    event.stopPropagation()
    event.preventDefault()
    if (event.shiftKey) {
      state.selectedBoard.has(idx) ? state.selectedBoard.delete(idx) : state.selectedBoard.add(idx)
      renderBoard()
      return
    }
    if (!state.selectedBoard.has(idx)) { state.selectedBoard = new Set([idx]); renderBoard() }
    const startX = event.clientX, startY = event.clientY
    const starts = new Map([...state.selectedBoard].map(i => [i, { x: items[i].x, y: items[i].y }]))
    let moved = false
    document.onmousemove = move => {
      const dx = (move.clientX - startX) / state.canvas.scale
      const dy = (move.clientY - startY) / state.canvas.scale
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
      if (!moved) return
      for (const [i, start] of starts) {
        items[i].x = Math.round(start.x + dx)
        items[i].y = Math.round(start.y + dy)
        const node = $('board').querySelector(`[data-idx="${i}"]`)
        if (node) { node.style.left = items[i].x + 'px'; node.style.top = items[i].y + 'px' }
      }
    }
    document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null }
  }
}

function alignSelected(edge) {
  const items = state.currentBoard.document.items
  const selected = [...state.selectedBoard].map(i => items[i]).filter(Boolean)
  if (selected.length < 2) return
  const minX = Math.min(...selected.map(it => it.x))
  const maxRight = Math.max(...selected.map(it => it.x + it.w))
  const minY = Math.min(...selected.map(it => it.y))
  const maxBottom = Math.max(...selected.map(it => it.y + it.h))
  for (const it of selected) {
    if (edge === 'left') it.x = minX
    if (edge === 'right') it.x = maxRight - it.w
    if (edge === 'top') it.y = minY
    if (edge === 'bottom') it.y = maxBottom - it.h
    if (edge === 'centerv') it.x = Math.round((minX + maxRight) / 2 - it.w / 2)
    if (edge === 'centerh') it.y = Math.round((minY + maxBottom) / 2 - it.h / 2)
  }
  renderBoard()
}

function clearSelection() {
  state.selectedBoard.clear()
  renderBoard()
}

function deleteSelectedBoardItem() {
  if (!state.selectedBoard.size) return
  const doomed = [...state.selectedBoard].sort((a, b) => b - a)
  for (const idx of doomed) state.currentBoard.document.items.splice(idx, 1)
  state.selectedBoard.clear()
  state.editingNote = null
  renderBoard()
}

function moveSelectedLayer(direction) {
  if (state.selectedBoard.size !== 1) return
  const idx = [...state.selectedBoard][0]
  const items = state.currentBoard.document.items
  if (!items[idx]) return
  const next = clamp(idx + direction, 0, items.length - 1)
  if (next === idx) return
  const [item] = items.splice(idx, 1)
  items.splice(next, 0, item)
  state.selectedBoard = new Set([next])
  renderBoard()
}

function setCanvas(x, y, scale) {
  state.canvas = { x, y, scale: clamp(scale, 0.1, 10) }
  applyCanvasTransform()
}

function applyCanvasTransform() {
  const board = $('board')
  if (!board) return
  board.style.transform = `translate(${state.canvas.x}px, ${state.canvas.y}px) scale(${state.canvas.scale})`
  $('zoomReset').textContent = `${Math.round(state.canvas.scale * 100)}%`
}

function zoomAtCenter(factor) {
  const rect = $('boardViewport').getBoundingClientRect()
  zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function zoomAtPoint(clientX, clientY, factor) {
  const before = screenToWorld(clientX, clientY)
  const nextScale = clamp(state.canvas.scale * factor, 0.1, 10)
  const rect = $('boardViewport').getBoundingClientRect()
  const nextX = clientX - rect.left - before.x * nextScale
  const nextY = clientY - rect.top - before.y * nextScale
  setCanvas(nextX, nextY, nextScale)
}

function screenToWorld(clientX, clientY) {
  const rect = $('boardViewport').getBoundingClientRect()
  return {
    x: (clientX - rect.left - state.canvas.x) / state.canvas.scale,
    y: (clientY - rect.top - state.canvas.y) / state.canvas.scale
  }
}

function updateBoardControls() {
  const none = state.selectedBoard.size === 0
  $('deleteBoardItem').disabled = none
  $('bringForward').disabled = state.selectedBoard.size !== 1
  $('sendBackward').disabled = state.selectedBoard.size !== 1
  document.querySelectorAll('#alignSeg button').forEach(b => b.disabled = state.selectedBoard.size < 2)
}

async function saveBoard() {
  state.currentBoard.title = $('boardTitle').value || 'Untitled board'
  state.currentBoard.document.viewport = state.canvas
  state.currentBoard = await api('/api/boards', { method: 'POST', headers, body: JSON.stringify(state.currentBoard) })
  await loadBoards()
  $('status').textContent = `saved ${state.currentBoard.title}`
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes, idx = 0
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx++ }
  return `${value.toFixed(idx ? 1 : 0)} ${units[idx]}`
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

init().catch(err => { $('status').textContent = err.message; console.error(err) })
