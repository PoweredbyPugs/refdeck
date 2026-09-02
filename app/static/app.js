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
  sel: new Set(),
  selAnchor: null,
  selSticky: false,
  gridUndo: [],
  lastUndoScope: 'board',
  typeFilter: '',
  extActive: new Set(),
  treeExpanded: new Set(),
  treeChildren: new Map(),
  palIndex: 0,
  palItems: [],
  view: localStorage.getItem('refdeck.view') || 'masonry',
  sidebarHidden: localStorage.getItem('refdeck.sidebarHidden') === '1',
  zen: false,
  previewIndex: null,
  previewItem: null,
  pvDetailsOpen: false,
  contextIndex: null,
  pv: { scale: 1, x: 0, y: 0, rot: 0, flipX: false, flipY: false },
  pvDepth: { on: false, split: 0.5 },
  pv360: null,
  pv360Loading: false,
  masonryNext: 0,
  contextItem: null,
  filter: '',
  sort: 'name',
  collections: [],
  collectionId: null,
  pickItem: null,
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
  await refreshRoots()
  $('tree').onclick = event => {
    const row = event.target.closest('.trow')
    if (!row) return
    if (event.target.closest('.caret')) { toggleNode(row.dataset.root, row.dataset.path); return }
    selectFolder(row.dataset.root, row.dataset.path)
  }
  $('tree').addEventListener('contextmenu', event => {
    const row = event.target.closest('.trow')
    if (!row) return
    event.preventDefault()
    openTreeCtx(event, row.dataset.root, row.dataset.path)
  })
  $('tctx').onclick = event => {
    const button = event.target.closest('button[data-t]')
    $('tctx').hidden = true
    if (!button) return
    const { root, path } = state.tctxTarget
    if (button.dataset.t === 'open') selectFolder(root, path)
    if (button.dataset.t === 'drill') selectFolder(root, path, true)
    if (button.dataset.t === 'flat') selectFolder(root, path, false)
    if (button.dataset.t === 'rescan') { api(`/api/scan/${encodeURIComponent(root)}`, { method: 'POST' }).then(pollScan) }
  }
  let searchTimer
  $('searchBox').oninput = event => {
    state.filter = event.target.value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(resetGrid, 250)
  }
  $('sortSelect').onchange = event => { state.sort = event.target.value; resetGrid() }
  $('drillToggle').onclick = () => setDrill(!state.drill)
  $('drillToggle').classList.toggle('active', state.drill)
  document.querySelectorAll('#typeSeg button').forEach(b => b.onclick = () => setTypeFilter(b.dataset.type))
  document.querySelector('#typeSeg button[data-type=""]').classList.add('active')
  renderExtFilters()
  $('paletteInput').oninput = () => renderPalette($('paletteInput').value)
  $('paletteInput').onkeydown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1) }
    if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1) }
    if (event.key === 'Enter') { event.preventDefault(); runPalette(state.palIndex) }
    if (event.key === 'Escape') { event.preventDefault(); closePalette() }
    event.stopPropagation()
  }
  $('paletteList').onclick = event => {
    const row = event.target.closest('.palRow')
    if (row) runPalette(+row.dataset.pi)
  }
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      $('palette').hidden ? openPalette() : closePalette()
    }
  })
  $('newCollection').onclick = newCollection
  $('newBoard').onclick = () => { state.currentBoard = { id: null, title: 'Untitled board', document: { items: [], viewport: { x: 0, y: 0, scale: 1 } } }; state.selectedBoard.clear(); setCanvas(0, 0, 1); renderBoard(); resetBoardHistory() }
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
  $('boardTitle').onchange = () => { state.currentBoard.title = $('boardTitle').value || 'Untitled board'; recordBoard() }
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
      await refreshRoots()
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
    if (!item) return
    if (event.shiftKey) { event.preventDefault(); gridSelRange(idx); return }
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); gridSelToggle(idx); return }
    const button = event.target.closest('button[data-action]')
    if (button) {
      if (button.dataset.action === 'preview') openPreviewAt(idx)
      if (button.dataset.action === 'board') addToBoard(item)
      if (button.dataset.action === 'collect') openCollectionPicker(event, item)
      return
    }
    if (state.selSticky) { gridSelToggle(idx); return }
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
    // right-clicking a selected item applies board/collect/delete to the whole selection
    const multi = state.sel.has(state.contextIndex)
    const targets = multi
      ? [...state.sel].sort((a, b) => a - b).map(i => state.gridFiles[i]).filter(Boolean)
      : [item]
    if (button.dataset.ctx === 'preview') openPreviewAt(state.contextIndex)
    if (button.dataset.ctx === 'board') targets.forEach(t => addToBoard(t))
    if (button.dataset.ctx === 'collect') openCollectionPicker(event, multi ? targets : item)
    if (button.dataset.ctx === 'uncollect') removeFromCollection(item)
    if (button.dataset.ctx === 'depth') generateDepthFor(item)
    if (button.dataset.ctx === 'delete') {
      if (!multi) { clearGridSel(); gridSelToggle(state.contextIndex) }
      deleteGridSelection()
    }
    if (button.dataset.ctx === 'original') window.open(mediaUrl(normalizeExplorerItem(item)), '_blank')
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('#ctxMenu')) $('ctxMenu').hidden = true
    if (!event.target.closest('#bctx')) $('bctx').hidden = true
    if (!event.target.closest('#tctx')) $('tctx').hidden = true
    if (!event.target.closest('#cpick')) $('cpick').hidden = true
    if (!event.target.closest('#palette')) closePalette()
  })
  $('cpick').onclick = async event => {
    const button = event.target.closest('button[data-cid]')
    $('cpick').hidden = true
    if (!button || !state.pickItem) return
    let cid = button.dataset.cid
    if (cid === 'new') {
      const title = prompt('Collection name?')
      if (!title) return
      const created = await api('/api/collections', { method: 'POST', headers, body: JSON.stringify({ title }) })
      cid = created.id
    }
    const picks = (Array.isArray(state.pickItem) ? state.pickItem : [state.pickItem]).map(normalizeExplorerItem)
    for (const n of picks) {
      await api(`/api/collections/${cid}/items`, {
        method: 'POST', headers,
        body: JSON.stringify({ path: `${n.root}/${n.path}`, media_type: n.media_type })
      })
    }
    await loadCollections()
    if (state.collectionId) renderCollectionGrid()
    $('status').textContent = picks.length > 1 ? `saved ${picks.length} to collection` : 'saved to collection'
  }
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
    if (event.key === '3') { event.preventDefault(); pv360Toggle() }
    if (state.pv360) return  // flat-image keys below would act on the hidden img
    if (event.ctrlKey && event.key === 'ArrowUp') { event.preventDefault(); pvZoom(1.25) }
    if (event.ctrlKey && event.key === 'ArrowDown') { event.preventDefault(); pvZoom(0.8) }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); pvZoom(1.25) }
    if (event.key === '-') { event.preventDefault(); pvZoom(0.8) }
    if (event.key === '0') { event.preventDefault(); pvResetZoom() }
    if (event.key.toLowerCase() === 'i') { event.preventDefault(); pvDetailsToggle() }
    if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); pvRotate(event.shiftKey ? -1 : 1) }
    if (event.key.toLowerCase() === 'h' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); pvFlip('x') }
    if (event.key.toLowerCase() === 'v' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); pvFlip('y') }
    if (event.key === '1') { event.preventDefault(); pvOriginalSize() }
    if (event.key.toLowerCase() === 'm' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); toggleDepthCompare() }
    if (event.key === '/') { event.preventDefault(); $('preview').close(); openPalette() }
  })
  $('preview').addEventListener('cancel', event => {
    // first Esc leaves the 360 viewer, second closes the preview
    if (state.pv360) { event.preventDefault(); pv360Destroy() }
  })
  $('preview').addEventListener('close', () => {
    pv360Destroy()
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
    if (action === 'rotcw') pvRotate(1)
    if (action === 'rotccw') pvRotate(-1)
    if (action === 'fliph') pvFlip('x')
    if (action === 'flipv') pvFlip('y')
    if (action === 'onesize') pvOriginalSize()
    if (action === 'pano') pv360Toggle()
    if (action === 'depth') toggleDepthCompare()
    if (action === 'depthcopy') copyDepthToClipboard()
    if (action === 'depthsave') downloadDepth()
    if (action === 'details') pvDetailsToggle()
    if (action === 'close') $('preview').close()
    if (!item) return
    if (action === 'board') addToBoard(item)
    if (action === 'collect') openCollectionPicker(event, item)
    if (action === 'original') window.open(mediaUrl(normalizeExplorerItem(item)), '_blank')
  }
  $('previewBody').addEventListener('wheel', event => {
    if (state.pv360) return  // Photo Sphere Viewer owns wheel/drag while active
    event.preventDefault()
    pvZoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.9 : 1.1)
  }, { passive: false })
  $('previewBody').onmousedown = event => {
    if (state.pv360) return
    if (event.button !== 0) return
    if (pvMedia()?.tagName === 'VIDEO' && state.pv.scale <= 1) return
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
  resetBoardHistory()
  pollScan()
}

function handleKeys(event) {
  if (event.target.closest('input, textarea, select, dialog')) return
  const key = event.key.toLowerCase()
  const mod = event.metaKey || event.ctrlKey || event.altKey
  if (!mod && key === 'c') { event.preventDefault(); setMode(state.mode === 'canvas' ? 'split' : 'canvas') }
  if (!mod && key === 'e') { event.preventDefault(); setMode(state.mode === 'explorer' ? 'split' : 'explorer') }
  if (!mod && key === 'd') { event.preventDefault(); setDrill(!state.drill) }
  if (!mod && key === 'f') { event.preventDefault(); setSidebarHidden(!state.sidebarHidden) }
  if (!mod && key === 'z') { event.preventDefault(); setZen(!state.zen) }
  if (!mod && key === 'n') { event.preventDefault(); addNoteAt(viewportCenterWorld()) }
  if (!mod && key === '/') { event.preventDefault(); openPalette() }
  if (event.key === 'Escape') {
    if (state.zen) { setZen(false); return }
    if (state.sel.size) { clearGridSel(); return }
    setMode('split'); clearSelection()
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (state.sel.size) { deleteGridSelection(); return }
    deleteSelectedBoardItem()
  }
  if (event.key === ']') { moveSelectedLayer(1) }
  if (event.key === '[') { moveSelectedLayer(-1) }
  if ((event.metaKey || event.ctrlKey) && key === 's') { event.preventDefault(); saveBoard() }
  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoBoard()
    else if (state.lastUndoScope === 'grid' && state.gridUndo.length) undoGridDelete()
    else undoBoard()
  }
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

async function refreshRoots() {
  state.roots = await api('/api/roots')
  if (!state.roots.some(r => r.name === state.root)) {
    state.root = state.roots[0]?.name
    state.path = ''
    if (state.root) { state.treeExpanded.add(treeKey(state.root, '')); browse() }
  }
  renderTree()
}

const treeKey = (root, path) => `${root}\x00${path}`

async function ensureChildren(root, path) {
  const key = treeKey(root, path)
  if (!state.treeChildren.has(key)) {
    try {
      const listing = await api(`/api/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
      state.treeChildren.set(key, listing.dirs)
    } catch {
      state.treeChildren.set(key, [])
    }
  }
  return state.treeChildren.get(key)
}

async function toggleNode(root, path) {
  const key = treeKey(root, path)
  if (state.treeExpanded.has(key)) state.treeExpanded.delete(key)
  else { state.treeExpanded.add(key); await ensureChildren(root, path) }
  renderTree()
}

function renderTree() {
  const rows = []
  const walk = (root, path, depth) => {
    if (!state.treeExpanded.has(treeKey(root, path))) return
    for (const dir of state.treeChildren.get(treeKey(root, path)) || []) {
      rows.push(treeRowHtml(root, dir.path, dir.name, depth))
      walk(root, dir.path, depth + 1)
    }
  }
  for (const r of state.roots) {
    rows.push(treeRowHtml(r.name, '', r.name, 0, r.online))
    walk(r.name, '', 1)
  }
  $('tree').innerHTML = rows.join('')
}

function treeRowHtml(root, path, name, depth, online = null) {
  const selected = root === state.root && path === state.path
  const expanded = state.treeExpanded.has(treeKey(root, path))
  const dot = online === null ? '' : `<span class="dot ${online ? 'on' : 'off'}"></span>`
  return `<div class="trow ${selected ? 'selected' : ''} ${depth === 0 ? 'rootRow' : ''}" data-root="${h(root)}" data-path="${h(path)}" style="padding-left:${4 + depth * 14}px" title="${h(root)}/${h(path)}">` +
    `<span class="caret">${expanded ? '▾' : '▸'}</span><span class="tname">${h(name)}</span>${dot}</div>`
}

async function selectFolder(root, path, drill = null) {
  state.root = root
  state.path = path
  state.treeExpanded.add(treeKey(root, ''))
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    state.treeExpanded.add(treeKey(root, acc))
  }
  if (drill !== null && drill !== state.drill) {
    state.drill = drill
    localStorage.setItem('refdeck.drill', drill ? '1' : '0')
    $('drillToggle').classList.toggle('active', drill)
  }
  await browse()
}

function openTreeCtx(event, root, path) {
  state.tctxTarget = { root, path }
  const rows = [['open', 'Open'], ['drill', 'Drill down here', 'D']]
  if (state.drill) rows.push(['flat', 'Open flat (this folder only)'])
  if (path === '') rows.push(['rescan', 'Rescan drive'])
  const menu = $('tctx')
  menu.innerHTML = rows.map(([action, label, kbd]) =>
    `<button data-t="${action}">${label}${kbd ? `<kbd>${kbd}</kbd>` : ''}</button>`).join('')
  menu.hidden = false
  menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
  menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
}

async function browse() {
  state.collectionId = null
  renderCollections()
  const listing = await api(`/api/browse?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`)
  state.subtreeCount = listing.media_count
  $('pathLabel').textContent = `${state.root}/${state.path}`
  state.treeChildren.set(treeKey(state.root, state.path), listing.dirs)
  state.treeExpanded.add(treeKey(state.root, state.path))
  renderTree()
  await resetGrid()
}

async function resetGrid() {
  clearGridSel()
  if (state.collectionId) { renderCollectionGrid(); return }
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
  menu.querySelector('[data-ctx="uncollect"]').style.display = item.collectionItemId ? '' : 'none'
  menu.querySelector('[data-ctx="delete"]').style.display = item.collectionItemId ? 'none' : ''
  menu.querySelector('[data-ctx="depth"]').style.display = item.media_type === 'image' ? '' : 'none'
  menu.hidden = false
  menu.style.left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px'
  menu.style.top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px'
}

async function loadMore() {
  if (state.gridLoading || !state.root || state.collectionId) return
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
  if (state.collectionId) {
    hint.hidden = state.gridTotal !== 0
    if (!hint.hidden) hint.textContent = 'Empty collection — right-click any file → Save to collection.'
    return
  }
  if (state.gridTotal === 0 && !state.drill && !state.filter && state.subtreeCount > 0) {
    hint.hidden = false
    hint.innerHTML = `No media in this folder — <b>${state.subtreeCount}</b> items in subfolders. <button id="hintDrill">Drill down</button>`
    $('hintDrill').onclick = () => setDrill(true)
  } else if (state.gridTotal === 0) {
    hint.hidden = false
    hint.textContent = state.filter ? 'No matches.' : 'No media here.'
  } else hint.hidden = true
}

function setTypeFilter(type) {
  state.typeFilter = type
  state.extActive.clear()
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('active', b.dataset.type === type))
  renderExtFilters()
  resetGrid()
}

function setSort(sort) {
  state.sort = sort
  $('sortSelect').value = sort
  resetGrid()
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

function gridSelToggle(idx) {
  if (!state.gridFiles[idx]) return
  if (state.sel.has(idx)) state.sel.delete(idx)
  else state.sel.add(idx)
  state.selAnchor = idx
  if (state.sel.size >= 3) state.selSticky = true
  if (!state.sel.size) state.selSticky = false
  syncGridSel()
}

function gridSelRange(idx) {
  const from = state.selAnchor ?? idx
  const [a, b] = from < idx ? [from, idx] : [idx, from]
  for (let i = a; i <= b; i++) if (state.gridFiles[i]) state.sel.add(i)
  if (state.sel.size >= 3) state.selSticky = true
  syncGridSel()
}

function clearGridSel() {
  if (!state.sel.size && state.selAnchor === null) return
  state.sel.clear()
  state.selAnchor = null
  state.selSticky = false
  syncGridSel()
}

function syncGridSel() {
  document.querySelectorAll('#grid [data-idx]').forEach(el =>
    el.classList.toggle('sel', state.sel.has(+el.dataset.idx)))
  if (state.sel.size) {
    $('status').textContent = `${state.sel.size} selected — ⌫ delete · esc clear`
  } else if ($('status').textContent.includes('selected')) {
    $('status').textContent = 'ready'
  }
}

async function deleteGridSelection() {
  const items = [...state.sel].sort((a, b) => a - b).map(i => state.gridFiles[i]).filter(Boolean)
  if (!items.length) return
  if (state.collectionId) {
    for (const it of items) {
      if (it.collectionItemId) await api(`/api/collections/items/${it.collectionItemId}`, { method: 'DELETE' })
    }
    clearGridSel()
    await loadCollections()
    renderCollectionGrid()
    $('status').textContent = `removed ${items.length} from collection`
    return
  }
  if (!confirm(`Delete ${items.length} file${items.length === 1 ? '' : 's'}?`)) return
  const byRoot = new Map()
  ;[...state.sel].forEach(i => {
    if (!state.gridFiles[i]) return
    const n = normalizeExplorerItem(state.gridFiles[i])
    if (!byRoot.has(n.root)) byRoot.set(n.root, { paths: [], idxByPath: new Map() })
    byRoot.get(n.root).paths.push(n.path)
    byRoot.get(n.root).idxByPath.set(n.path, i)
  })
  let deleted = 0
  const errors = []
  const undoBatches = []
  const hideIdx = []
  try {
    for (const [root, batch] of byRoot) {
      const res = await api('/api/files/delete', { method: 'POST', headers, body: JSON.stringify({ root, paths: batch.paths }) })
      deleted += res.deleted.length
      if (res.deleted.length) undoBatches.push({ root, items: res.deleted })
      res.deleted.forEach(d => hideIdx.push(batch.idxByPath.get(d.path)))
      errors.push(...Object.values(res.errors))
    }
  } catch (err) {
    errors.push(err.message)
  }
  if (undoBatches.length) {
    state.gridUndo.push(undoBatches)
    state.lastUndoScope = 'grid'
  }
  clearGridSel()
  removeGridItems(hideIdx)
  $('status').textContent = errors.length
    ? `deleted ${deleted} — ${errors.length} failed: ${errors[0]}`
    : `deleted ${deleted} — ⌘Z to undo`
}

// hide deleted tiles in place — no reload, no scroll jump. gridFiles keeps
// null holes so data-idx stays valid; gridOffset shrinks with the server's
// row count so the next page doesn't skip files.
function removeGridItems(indices) {
  indices.forEach(i => {
    if (i == null || !state.gridFiles[i]) return
    state.gridFiles[i] = null
    document.querySelector(`#grid [data-idx="${i}"]`)?.remove()
    state.gridTotal--
    state.gridOffset--
  })
  $('mediaCount').textContent = `${state.gridFiles.filter(Boolean).length}/${state.gridTotal} items`
}

async function undoGridDelete() {
  const batches = state.gridUndo.pop()
  if (!batches) return
  if (!state.gridUndo.length) state.lastUndoScope = 'board'
  let restored = 0
  const errors = []
  for (const b of batches) {
    try {
      const res = await api('/api/files/restore', { method: 'POST', headers, body: JSON.stringify({ root: b.root, items: b.items }) })
      restored += res.restored.length
      errors.push(...Object.values(res.errors))
    } catch (err) {
      errors.push(err.message)
    }
  }
  await resetGrid()
  $('status').textContent = errors.length
    ? `restored ${restored} — ${errors.length} failed: ${errors[0]}`
    : `restored ${restored}`
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
      if (!f) return  // deleted hole — keep data-idx aligned
      const frag = document.createElement('template')
      frag.innerHTML = `<div class="mItem" draggable="true" data-idx="${start + i}" title="${h(f.name)}"><img src="${thumbUrl(f)}" loading="lazy" /></div>`
      cols[state.masonryNext++ % cols.length].append(frag.content)
    })
    if (state.sel.size) syncGridSel()
    return
  }
  const frag = document.createElement('template')
  if (state.view === 'list') {
    frag.innerHTML = files.map((f, i) => !f ? '' : `
      <div class="lrow" draggable="true" data-idx="${start + i}">
        <img src="${thumbUrl(f)}" loading="lazy" />
        <span class="lname" title="${h(f.path)}">${h(f.name)}</span>
        <span class="lmeta">${h(f.media_type)}</span>
        <span class="lmeta">${formatBytes(f.size)}</span>
        <span class="lmeta">${new Date(f.mtime * 1000).toLocaleDateString()}</span>
      </div>`).join('')
  } else {
    frag.innerHTML = files.map((f, i) => !f ? '' : `
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
  if (state.sel.size) syncGridSel()
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
  state.pvDepth = { on: false, split: 0.5 }
  pv360Destroy()
  $('pvPanoBtn').hidden = true
  pvResetZoom()
  $('previewBody').innerHTML = normalized.media_type === 'video'
    ? `<video src="${mediaUrl(normalized)}" controls autoplay></video>`
    : `<img src="${previewUrl(normalized)}" draggable="false" />`
  renderPvDetails()
  const media = pvMedia()
  if (media) {
    const update = () => { renderPvDetails(); pvApply(); $('pvPanoBtn').hidden = !pvIs360() }
    media.tagName === 'VIDEO' ? media.addEventListener('loadedmetadata', update) : media.addEventListener('load', update)
  }
  if (!$('preview').open) $('preview').showModal()
}

// --- 360 panoramas — equirectangular photos are exactly 2:1 ---

function pvIs360() {
  const media = pvMedia()
  return !!media && media.tagName === 'IMG' && media.naturalWidth > 0
    && Math.abs(media.naturalWidth - 2 * media.naturalHeight) <= 4
}

function pv360Destroy() {
  if (state.pv360) { state.pv360.destroy(); state.pv360 = null }
  document.getElementById('pv360')?.remove()
  const media = pvMedia()
  if (media) media.style.visibility = ''
  if ($('preview').open && state.previewItem) $('status').textContent = 'ready'
}

async function pv360Toggle() {
  if (state.pv360) { pv360Destroy(); return }
  if (state.pv360Loading || !pvIs360()) return
  const item = normalizeExplorerItem(state.previewItem)
  const holder = document.createElement('div')
  holder.id = 'pv360'
  $('previewBody').appendChild(holder)
  pvMedia().style.visibility = 'hidden'
  $('status').textContent = 'loading 360 viewer…'
  state.pv360Loading = true
  try {
    const { Viewer } = await import('/vendor/psv-core.module.js')
    state.pv360 = new Viewer({
      container: holder,
      panorama: previewUrl(item),
      navbar: ['zoom', 'fullscreen'],
      loadingTxt: 'loading panorama…'
    })
    $('status').textContent = `360 — drag to look around · 3 or Esc exits`
  } catch (err) {
    $('status').textContent = `360 viewer failed: ${err.message || err}`
    pv360Destroy()
  } finally {
    state.pv360Loading = false
  }
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
  if (!media) return
  const { x, y, scale, rot, flipX, flipY } = state.pv
  // when rotated 90/270 the fitted content's dims swap — auto-refit so the
  // whole image stays visible at 100% zoom
  let base = 1
  const nw = media.naturalWidth || media.videoWidth, nh = media.naturalHeight || media.videoHeight
  if (rot % 180 !== 0 && nw && nh) {
    const body = $('previewBody')
    const vw = body.clientWidth, vh = body.clientHeight
    const s0 = Math.min(vw / nw, vh / nh)
    base = Math.min(vw / (nh * s0), vh / (nw * s0))
  }
  const s = scale * base
  const transform = `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${s * (flipX ? -1 : 1)}, ${s * (flipY ? -1 : 1)})`
  media.style.transform = transform
  const depthOverlay = $('previewBody').querySelector('#pvDepth')
  if (depthOverlay) depthOverlay.style.transform = transform
}

function pvZoomAt(clientX, clientY, factor) {
  // keep the point under the cursor fixed: translate is outermost (screen
  // space), so t' = (1-f)(cursor-center) + f·t regardless of rotation/flip
  const rect = $('previewBody').getBoundingClientRect()
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
  const next = clamp(state.pv.scale * factor, 0.05, 40)
  const f = next / state.pv.scale
  state.pv.x = (1 - f) * (clientX - cx) + f * state.pv.x
  state.pv.y = (1 - f) * (clientY - cy) + f * state.pv.y
  state.pv.scale = next
  pvApply()
}

function pvZoom(factor) {
  const rect = $('previewBody').getBoundingClientRect()
  pvZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function pvRotate(quarterTurns) {
  state.pv.rot = ((state.pv.rot + quarterTurns * 90) % 360 + 360) % 360
  pvApply()
}

function pvFlip(axis) {
  if (axis === 'x') state.pv.flipX = !state.pv.flipX
  else state.pv.flipY = !state.pv.flipY
  pvApply()
}

function pvResetZoom() {
  state.pv = { scale: 1, x: 0, y: 0, rot: 0, flipX: false, flipY: false }
  pvApply()
}

function pvOriginalSize() {
  const media = pvMedia()
  if (!media) return
  const nw = media.naturalWidth || media.videoWidth, nh = media.naturalHeight || media.videoHeight
  if (!nw || !nh) return
  const body = $('previewBody')
  const fitScale = Math.min(body.clientWidth / nw, body.clientHeight / nh)
  state.pv.scale = clamp(1 / fitScale, 0.05, 40)
  state.pv.x = 0
  state.pv.y = 0
  pvApply()
  $('status').textContent = `1:1 — ${nw}×${nh}`
}

function depthUrlFor(item) {
  const n = normalizeExplorerItem(item)
  return `/api/depth?root=${encodeURIComponent(n.root)}&path=${encodeURIComponent(n.path)}`
}

async function fetchDepth(item) {
  $('status').textContent = 'generating depth map… (first run downloads the model)'
  const res = await fetch(depthUrlFor(item))
  if (!res.ok) {
    let detail
    try { detail = (await res.json()).detail } catch { /* keep generic */ }
    $('status').textContent = detail || 'depth generation failed'
    return null
  }
  $('status').textContent = 'depth map saved to Depth drive'
  refreshRoots()
  return { blob: await res.blob(), name: res.headers.get('X-Depth-Name') || 'depth.png' }
}

async function generateDepthFor(item) {
  if (!item || item.media_type !== 'image') { $('status').textContent = 'depth maps are for images'; return }
  await fetchDepth(item)
}

function positionDepthDivider() {
  const body = $('previewBody')
  const overlay = body.querySelector('#pvDepth')
  const divider = body.querySelector('#pvDivider')
  if (!overlay || !divider) return
  const pct = state.pvDepth.split * 100
  overlay.style.clipPath = `inset(0 ${100 - pct}% 0 0)`
  divider.style.left = `calc(${pct}% - 1px)`
}

async function toggleDepthCompare() {
  const item = state.previewItem
  if (!item || item.media_type !== 'image') { $('status').textContent = 'depth maps are for images'; return }
  const body = $('previewBody')
  const existing = body.querySelector('#pvDepth')
  if (existing) {
    existing.remove()
    body.querySelector('#pvDivider')?.remove()
    state.pvDepth.on = false
    return
  }
  const depth = await fetchDepth(item)
  if (!depth) return
  const overlay = document.createElement('img')
  overlay.id = 'pvDepth'
  overlay.draggable = false
  overlay.src = URL.createObjectURL(depth.blob)
  const divider = document.createElement('div')
  divider.id = 'pvDivider'
  body.append(overlay, divider)
  state.pvDepth.on = true
  positionDepthDivider()
  pvApply()
  divider.onmousedown = event => {
    event.stopPropagation()
    event.preventDefault()
    document.onmousemove = move => {
      const rect = body.getBoundingClientRect()
      state.pvDepth.split = clamp((move.clientX - rect.left) / rect.width, 0.02, 0.98)
      positionDepthDivider()
    }
    document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null }
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
}

async function copyDepthToClipboard() {
  const depth = await fetchDepth(state.previewItem)
  if (!depth) return
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': depth.blob })])
    $('status').textContent = 'depth map copied to clipboard'
  } catch {
    downloadBlob(depth.blob, depth.name)
    $('status').textContent = 'clipboard needs HTTPS — downloaded the depth map instead'
  }
}

async function downloadDepth() {
  const depth = await fetchDepth(state.previewItem)
  if (depth) downloadBlob(depth.blob, depth.name)
}

async function previewNav(direction) {
  if (state.previewIndex === null) return
  let next = state.previewIndex + direction
  while (next >= 0 && next < state.gridFiles.length && !state.gridFiles[next]) next += direction  // skip deleted holes
  if (next < 0) return
  if (next >= state.gridFiles.length) {
    if (state.gridFiles.length >= state.gridTotal) return
    await loadMore()
    if (next >= state.gridFiles.length || !state.gridFiles[next]) return
  }
  state.previewIndex = next
  renderPreview(state.gridFiles[next])
}

async function newCollection() {
  const title = prompt('Collection name?')
  if (!title) return
  const created = await api('/api/collections', { method: 'POST', headers, body: JSON.stringify({ title }) })
  await loadCollections()
  openCollection(created.id)
}

async function loadCollections() {
  state.collections = await api('/api/collections')
  renderCollections()
}

function fmtShortDate(ts) {
  if (!ts) return ''
  const d = new Date(ts.replace(' ', 'T') + 'Z')
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderCollections() {
  $('collections').innerHTML = state.collections.map(c => `
    <div class="row crow ${c.id === state.collectionId ? 'selected' : ''}" data-collectionid="${c.id}">
      <span class="cname">${h(c.title)}</span>
      <span class="cdate" title="last save">${fmtShortDate(c.updated_at)}</span>
      <button class="mini" data-delcollection="${c.id}">✕</button>
    </div>`).join('') || '<div class="hint">Right-click any file → Save to collection.</div>'
  document.querySelectorAll('[data-collectionid]').forEach(row => row.onclick = () => openCollection(+row.dataset.collectionid))
  document.querySelectorAll('[data-delcollection]').forEach(b => b.onclick = async event => {
    event.stopPropagation()
    if (!confirm('Delete this collection?')) return
    await api(`/api/collections/${b.dataset.delcollection}`, { method: 'DELETE' })
    const wasOpen = state.collectionId === +b.dataset.delcollection
    await loadCollections()
    if (wasOpen) { state.collectionId = null; browse() }
  })
}

function openCollection(id) {
  state.collectionId = id
  if (state.view !== 'masonry') { state.view = 'masonry'; syncViewButtons() }
  renderCollectionGrid()
  renderCollections()
}

function renderCollectionGrid() {
  const col = state.collections.find(c => c.id === state.collectionId)
  if (!col) { state.collectionId = null; return }
  state.gridFiles = []
  state.gridOffset = 0
  state.subtreeCount = 0
  prepareGrid()
  const mapped = col.items.map(it => ({ ...itemFromCollection(it), size: 0, mtime: 0, collectionItemId: it.id }))
  state.gridTotal = mapped.length
  appendCards(mapped)
  $('mediaCount').textContent = `${mapped.length} items`
  $('pathLabel').textContent = `collection · ${col.title}`
  renderGridHint()
}

async function removeFromCollection(item) {
  if (!item?.collectionItemId) return
  await api(`/api/collections/items/${item.collectionItemId}`, { method: 'DELETE' })
  await loadCollections()
  if (state.collectionId) renderCollectionGrid()
}

function openCollectionPicker(event, item) {
  if (!item) return
  state.pickItem = item
  const menu = $('cpick')
  menu.innerHTML = state.collections.map(c =>
    `<button data-cid="${c.id}">${h(c.title)}</button>`).join('') +
    '<button data-cid="new">+ New collection…</button>'
  const host = document.querySelector('dialog[open]') || document.body
  if (menu.parentElement !== host) host.appendChild(menu)
  menu.hidden = false
  menu.style.left = Math.min(event.clientX, window.innerWidth - 230) + 'px'
  menu.style.top = Math.min(event.clientY, window.innerHeight - 320) + 'px'
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
    resetBoardHistory()
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
    await refreshRoots()
  })
}

let scanTimer
async function pollScan() {
  const status = await api('/api/scan/status')
  const active = Object.entries(status).filter(([, s]) => s.state !== 'idle')
  if (active.length) {
    $('status').textContent = active
      .map(([name, s]) => s.state === 'scanning' ? `scanning ${name}… ${s.files} files` : `caching thumbnails for ${name} (${s.files} files)…`)
      .join(' · ')
    clearTimeout(scanTimer)
    scanTimer = setTimeout(pollScan, 3000)
  } else if (/^(scanning|caching)/.test($('status').textContent)) {
    $('status').textContent = 'scan complete'
    refreshRoots()
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
  recordBoard()
}

function fetchRatio(item) {
  if (item.ar) return
  const apply = (w, hgt) => {
    if (!w || !hgt) return
    item.ar = w / hgt
    item.h = Math.round(item.w / item.ar)
    renderBoard()
    scheduleAutosave()
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

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function renderMarkdown(text) {
  if (!text || !text.trim()) return '<span class="hint">Double-click to edit</span>'
  const lines = h(text).split('\n')
  const out = []
  let inCode = false
  let listTag = null
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null } }
  const openList = tag => { if (listTag !== tag) { closeList(); out.push(`<${tag}>`); listTag = tag } }
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(line + '\n'); continue }
    const heading = line.match(/^(#{1,3})\s+(.*)/)
    if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`); continue }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); continue }
    const quote = line.match(/^&gt;\s?(.*)/)
    if (quote) { closeList(); out.push(`<blockquote>${mdInline(quote[1])}</blockquote>`); continue }
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (bullet) { openList('ul'); out.push(`<li>${mdInline(bullet[1])}</li>`); continue }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/)
    if (numbered) { openList('ol'); out.push(`<li>${mdInline(numbered[1])}</li>`); continue }
    closeList()
    if (line.trim() === '') out.push('<div class="mdgap"></div>')
    else out.push(`<p>${mdInline(line)}</p>`)
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('')
}

function addNoteAt(point) {
  state.currentBoard.document.items.push({
    type: 'note', text: '', x: Math.round(point.x), y: Math.round(point.y), w: 220, h: 120
  })
  const idx = state.currentBoard.document.items.length - 1
  state.selectedBoard = new Set([idx])
  state.editingNote = idx
  renderBoard()
  recordBoard()
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
  recordBoard()
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
  recordBoard()
}

function commitNoteEdit() {
  // save the live textarea value before anything rebuilds the board DOM —
  // mousedown handlers re-render before blur fires, destroying unsaved text
  if (state.editingNote === null) return
  const editor = $('board').querySelector('.noteEdit')
  const item = state.currentBoard.document.items[state.editingNote]
  if (editor && item && item.text !== editor.value) {
    item.text = editor.value
    recordBoard()
  }
}

function boardSnapshot() {
  return structuredClone({ title: state.currentBoard.title, items: state.currentBoard.document.items })
}

function resetBoardHistory() {
  state.boardHistory = [boardSnapshot()]
  state.boardFuture = []
}

function recordBoard() {
  state.boardHistory.push(boardSnapshot())
  if (state.boardHistory.length > 100) state.boardHistory.shift()
  state.boardFuture = []
  state.lastUndoScope = 'board'
  scheduleAutosave()
}

function applySnapshot(snap) {
  state.currentBoard.title = snap.title
  state.currentBoard.document.items = structuredClone(snap.items)
  state.selectedBoard.clear()
  state.editingNote = null
  renderBoard()
  scheduleAutosave()
}

function undoBoard() {
  const history = state.boardHistory
  if (!history || history.length < 2) return
  state.boardFuture.push(history.pop())
  applySnapshot(history[history.length - 1])
}

function redoBoard() {
  const snap = state.boardFuture?.pop()
  if (!snap) return
  state.boardHistory.push(snap)
  applySnapshot(snap)
}

let autosaveTimer
function scheduleAutosave() {
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(autoSaveBoard, 600)
}

async function autoSaveBoard() {
  state.currentBoard.title = $('boardTitle').value || 'Untitled board'
  state.currentBoard.document.viewport = state.canvas
  const isNew = state.currentBoard.id == null
  try {
    const saved = await api('/api/boards', { method: 'POST', headers, body: JSON.stringify(state.currentBoard) })
    state.currentBoard.id = saved.id  // keep the local document authoritative — edits may have landed mid-request
    $('status').textContent = 'saved'
    if (isNew) loadBoards()
  } catch (err) {
    $('status').textContent = `autosave failed: ${err.message}`
  }
}

function renderBoard() {
  commitNoteEdit()
  $('boardTitle').value = state.currentBoard.title || 'Untitled board'
  const items = state.currentBoard.document.items || []
  $('board').innerHTML = items.map((it, idx) => {
    const sel = state.selectedBoard.has(idx) ? 'selected' : ''
    const style = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px`
    if (it.type === 'note') {
      const body = state.editingNote === idx
        ? `<textarea class="noteEdit">${h(it.text)}</textarea>`
        : renderMarkdown(it.text)
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
      scheduleAutosave()
    }
    media.tagName === 'VIDEO' ? media.addEventListener('loadedmetadata', adopt) : media.addEventListener('load', adopt)
  })
  const editor = $('board').querySelector('.noteEdit')
  if (editor) {
    editor.focus()
    editor.onblur = () => {
      commitNoteEdit()
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
    document.onmouseup = () => {
      document.onmousemove = null
      document.onmouseup = null
      renderBoard()
      if (item.w !== startW || item.h !== startH) recordBoard()
    }
  }
  el.onmousedown = event => {
    if (event.button !== 0 || event.target.closest('.rsz, .noteEdit')) return
    event.stopPropagation()
    event.preventDefault()
    if (state.editingNote !== null && state.editingNote !== idx) {
      commitNoteEdit()
      state.editingNote = null
      renderBoard()
    }
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
    document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; if (moved) recordBoard() }
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
  recordBoard()
}

function clearSelection() {
  commitNoteEdit()
  state.editingNote = null
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
  recordBoard()
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
  recordBoard()
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
  clearTimeout(autosaveTimer)
  await autoSaveBoard()
  await loadBoards()
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes, idx = 0
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx++ }
  return `${value.toFixed(idx ? 1 : 0)} ${units[idx]}`
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

function buildCommands() {
  const c = []
  const add = (name, run, kbd) => c.push({ name, run, kbd })
  add('View: Masonry gallery', () => setView('masonry'))
  add('View: Cards', () => setView('cards'))
  add('View: File list', () => setView('list'))
  add(state.drill ? 'Drill down: turn off' : 'Drill down: turn on', () => setDrill(!state.drill), 'D')
  add(state.sidebarHidden ? 'Sidebar: show' : 'Sidebar: hide', () => setSidebarHidden(!state.sidebarHidden), 'F')
  add(state.zen ? 'Zen mode: exit' : 'Zen mode: enter', () => setZen(!state.zen), 'Z')
  add('Mode: Explorer only', () => setMode('explorer'), 'E')
  add('Mode: Split view', () => setMode('split'), 'Esc')
  add('Mode: Canvas only', () => setMode('canvas'), 'C')
  add('Filter: everything', () => setTypeFilter(''))
  add('Filter: images only', () => setTypeFilter('image'))
  add('Filter: videos only', () => setTypeFilter('video'))
  add('Sort: by name', () => setSort('name'))
  add('Sort: newest first', () => setSort('date'))
  add('Sort: by type', () => setSort('type'))
  add('Sort: by size', () => setSort('size'))
  add('Board: new board', () => $('newBoard').click())
  add('Board: save board', saveBoard, '⌘S')
  add('Board: add note', () => addNoteAt(viewportCenterWorld()), 'N')
  add('Board: select all items', () => { state.selectedBoard = new Set(state.currentBoard.document.items.map((_, i) => i)); renderBoard() })
  add('Board: arrange (pack)', () => arrangeSelected(false))
  add('Board: arrange by size', () => arrangeSelected(true))
  add('Board: delete selection', deleteSelectedBoardItem, '⌫')
  add('New collection', newCollection)
  add('Open settings', openSettings)
  for (const r of state.roots) {
    add(`Go to drive: ${r.name}`, () => selectFolder(r.name, ''))
    add(`Rescan drive: ${r.name}`, () => api(`/api/scan/${encodeURIComponent(r.name)}`, { method: 'POST' }).then(pollScan))
  }
  return c
}

function openPalette() {
  $('ctxMenu').hidden = true
  $('bctx').hidden = true
  $('tctx').hidden = true
  $('palette').hidden = false
  $('paletteInput').value = ''
  renderPalette('')
  $('paletteInput').focus()
}

function closePalette() {
  $('palette').hidden = true
}

function renderPalette(query) {
  const q = query.trim().toLowerCase()
  const all = buildCommands()
  let items
  if (!q) items = all.slice(0, 14)
  else {
    items = all
      .map(cmd => ({ cmd, pos: cmd.name.toLowerCase().indexOf(q) }))
      .filter(x => x.pos >= 0)
      .sort((a, b) => a.pos - b.pos)
      .map(x => x.cmd)
      .slice(0, 12)
    items.push({ name: `Search files for “${query.trim()}”`, kbd: '⏎', run: () => {
      state.filter = query.trim()
      $('searchBox').value = query.trim()
      resetGrid()
    } })
  }
  state.palItems = items
  state.palIndex = 0
  $('paletteList').innerHTML = items.map((cmd, i) =>
    `<div class="palRow ${i === 0 ? 'sel' : ''}" data-pi="${i}">${h(cmd.name)}${cmd.kbd ? `<kbd>${h(cmd.kbd)}</kbd>` : ''}</div>`).join('')
}

function movePalette(direction) {
  if (!state.palItems.length) return
  state.palIndex = clamp(state.palIndex + direction, 0, state.palItems.length - 1)
  document.querySelectorAll('.palRow').forEach((row, i) => row.classList.toggle('sel', i === state.palIndex))
  document.querySelector('.palRow.sel')?.scrollIntoView({ block: 'nearest' })
}

function runPalette(index) {
  const cmd = state.palItems[index]
  closePalette()
  if (cmd) cmd.run()
}

init().catch(err => { $('status').textContent = err.message; console.error(err) })
