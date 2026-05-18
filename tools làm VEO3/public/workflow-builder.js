// === VEO3 Workflow Builder ===
const WFB = (() => {
  // ─── State ───
  let nodes = [], connections = [], selectedNode = null;
  let draggingNode = null, dragOffset = { x: 0, y: 0 };
  let connectingFrom = null, tempLine = null;
  let canvas = null, ctx = null, canvasEl = null;
  let pan = { x: 0, y: 0 }, zoom = 1;
  let isPanning = false, panStart = { x: 0, y: 0 };
  let nodeIdCounter = 0, savedWorkflows = [];
  let currentWorkflowId = null, currentWorkflowName = 'Untitled Workflow';
  let pendingConnect = null;
  let dialogShowAll = false;
  let copiedNodeData = null;      // legacy (single node) — kept for context-menu cut
  let _clipboard = null;           // { nodes: [...], connections: [...], anchorX, anchorY }
  let lastMouseWorldPos = { x: 0, y: 0 };
  let lastSavedJSON = '';
  //RESIZING NODES
  let resizingNode = null;
  let resizeStart = { y: 0, h: 0 };

  // ─── Multi-select state ───
  let selectedNodes = new Set(); // Set of node IDs
  let selectedConnections = new Set(); // Set of connection IDs selected by lasso
  let lasso = null;              // { startX, startY, endX, endY } in world coords
  let isLassoing = false;
  let lassoStart = { x: 0, y: 0 }; // world pos where lasso started
  let draggingMulti = false;
  let multiDragOffsets = {};     // nodeId -> { dx, dy } offset from drag origin

  // ─── Spinner animation ───
  let _spinAngle = 0;     // current radian angle for spinner arc
  let _spinActive = false; // true when any node is status==='running'
  let _spinLoopRunning = false; // separate dedicated spin-animation loop

  // ─── Undo / Redo stacks ───
  const _undoStack = [];   // Array of { nodes, connections } snapshots
  const _redoStack = [];
  const _MAX_UNDO = 60;

  function _pushUndoSnapshot() {
    const snap = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      connections: JSON.parse(JSON.stringify(connections))
    };
    _undoStack.push(snap);
    if (_undoStack.length > _MAX_UNDO) _undoStack.shift();
    _redoStack.length = 0; // clear redo on new action
  }

  // ─── Performance caches (declared early — used by _applySnapshot and render) ───
  const _heightCache = {};   // nodeId → cached pixel height
  let _connCacheDirty = true; // true = rebuild _frameConnCache on next render
  let _frameConnCache = null; // { byToNode, byRefPort } — O(1) connection lookup

  function _applySnapshot(snap) {
    nodes = snap.nodes.map(n => ({ ...n }));
    connections = snap.connections.map(c => ({ ...c }));
    _rebuildNodeMap();
    nodeIdCounter = 0;
    nodes.forEach(n => { const num = parseInt(n.id.replace('node_', '')); if (num > nodeIdCounter) nodeIdCounter = num; });
    selectedNode = null; selectedNodes.clear();
    // Clear all caches — topology may have changed completely after undo/redo
    Object.keys(_heightCache).forEach(k => delete _heightCache[k]);
    _connCacheDirty = true;
    hideNodeEditor(); _hideMultiSelectHint();
    markDirty();
  }

  // Performance: dirty flag & node map
  let _dirty = true;    // Only render when true
  let _nodeMap = {};    // id → node, for O(1) lookup
  let _lastCursorCheck = 0; // Throttle cursor hit-testing
  function markDirty() { _dirty = true; }
  function _rebuildNodeMap() {
    _nodeMap = {};
    for (const n of nodes) _nodeMap[n.id] = n;
  }
  // Wrap nodes/connections mutations to auto-mark dirty & rebuild map
  function _addNode(node) { nodes.push(node); _nodeMap[node.id] = node; markDirty(); }
  function _removeNode(id) { nodes = nodes.filter(n => n.id !== id); delete _nodeMap[id]; markDirty(); }
  function _addConn(conn) {
    connections.push(conn);
    _connCacheDirty = true;
    // Invalidate height cache for both endpoints so port count is recalculated
    delete _heightCache[conn.toNode];
    delete _heightCache[conn.fromNode];
    markDirty();
  }
  function _removeConn(id) {
    const dying = connections.find(c => c.id === id);
    if (dying) { delete _heightCache[dying.toNode]; delete _heightCache[dying.fromNode]; }
    connections = connections.filter(c => c.id !== id);
    _connCacheDirty = true;
    markDirty();
  }

  // Image cache for canvas previews (supports video thumbnails)
  const imgCache = {};
  function getCachedImg(url, mediaType) {
    if (!url) return null;
    const cacheKey = url;
    if (imgCache[cacheKey]) return imgCache[cacheKey];

    // Video: extract a thumbnail frame from the video
    const isVideo = mediaType === 'video' ||
      url.startsWith('data:video/') ||
      /\.(mp4|webm|mov)(\?|$)/i.test(url);

    if (isVideo) {
      // Create a placeholder image (loading state)
      const placeholder = new Image();
      imgCache[cacheKey] = placeholder; // prevent re-entry

      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;

      video.addEventListener('loadeddata', () => {
        // Seek to 1s or 25% of duration for a good frame
        video.currentTime = Math.min(1, video.duration * 0.25 || 0.5);
      });

      video.addEventListener('seeked', () => {
        try {
          const c = document.createElement('canvas');
          c.width = video.videoWidth || 320;
          c.height = video.videoHeight || 180;
          const cx = c.getContext('2d');
          cx.drawImage(video, 0, 0, c.width, c.height);
          const thumb = new Image();
          thumb.src = c.toDataURL('image/jpeg', 0.85);
          thumb.onload = () => {
            imgCache[cacheKey] = thumb; // replace placeholder with real thumb
          };
          // Cleanup video element
          video.src = '';
          video.load();
        } catch (e) {
          console.warn('Video thumb extract failed:', e);
        }
      });

      video.addEventListener('error', () => {
        console.warn('Video load failed for thumbnail:', url.substring(0, 80));
      });

      video.src = url;
      return placeholder; // return placeholder (no naturalWidth yet, will render emoji fallback initially)
    }

    // Image: normal path
    const im = new Image(); im.src = url; imgCache[cacheKey] = im;
    return im;
  }

  // ─── Constants ───
  const PORT_RADIUS = 7, PORT_SPACING = 28, HEADER_HEIGHT = 36, MAX_IMG_REFS = 5;

  // ─── Node Type Definitions ───
  const NODE_TYPES = {
    prompt: {
      label: '📄 Text / Prompt', category: 'input', color: '#8a5cf6', icon: 'notes',
      inputs: [{ name: 'text', type: 'string', color: '#a78bfa', optional: true }], outputs: [{ name: 'text', type: 'string', color: '#a78bfa' }],
      defaults: { text: '' }, width: 240, minH: 130
    },
    prompt_list: {
      label: '📝 Prompt List', category: 'input', color: '#6366f1', icon: 'format_list_bulleted',
      inputs: [{ name: 'text', type: 'string', color: '#a78bfa', optional: true }], outputs: [{ name: 'textList', type: 'string', color: '#a78bfa' }],
      defaults: { text: '' }, width: 280, minH: 100
    },
    gemini_prompt: {
      label: '🤖 Gemini Prompt', category: 'generate', color: '#84cc16', icon: 'smart_toy',
      inputs: [{ name: 'text', type: 'string', color: '#a78bfa', optional: true }],
      outputs: [{ name: 'text', type: 'string', color: '#a78bfa' }],
      defaults: { apiKey: '', promptTemplate: '', useAdditionalText: false, additionalText: 'Chỉ trả về prompt không kèm hướng dẫn, không kèm bất cứ điều gì' }, width: 280, minH: 110
    },
    upload_image: {
      label: '📤 Upload Media', category: 'input', color: '#06b6d4', icon: 'cloud_upload',
      inputs: [], outputs: [{ name: 'media', type: 'any', color: '#22d3ee' }],
      defaults: { imagePath: '', imageUrl: '' }, width: 220, minH: 90
    },
    frame: {
      label: '🔳 Khung Nhóm (Frame)', category: 'util', color: '#f59e0b', icon: 'crop_free',
      inputs: [], outputs: [],
      defaults: { width: 500, height: 400, name: 'Khung Nhóm' }, width: 500, minH: 400
    },
    generate_image: {
      label: '🖼️ Generate Image', category: 'generate', color: '#ec4899', icon: 'image',
      inputs: [{ name: 'prompt', type: 'string', color: '#a78bfa' }],
      outputs: [{ name: 'image', type: 'image', color: '#22d3ee' }],
      defaults: { ratio: 'landscape', quantity: 1, quality: '1080p', imageModel: 'imagen_4' }, width: 260, minH: 150
    },
    generate_video: {
      label: '🎬 Generate Video', category: 'generate', color: '#f97316', icon: 'movie',
      inputs: [{ name: 'prompt', type: 'string', color: '#a78bfa' }],
      outputs: [{ name: 'video', type: 'video', color: '#fb923c' }],
      defaults: { ratio: 'landscape', quantity: 1, quality: '1080p', videoModel: 'veo31_fast_lower', videoMode: 'FRAME' }, width: 280, minH: 120
    },
    merge_video: {
      label: '🎞️ Ghép Video (Merge)', category: 'generate', color: '#10b981', icon: 'merge',
      inputs: [{ name: 'video', type: 'video', color: '#fb923c' }],
      outputs: [{ name: 'video', type: 'video', color: '#fb923c' }],
      defaults: {}, width: 240, minH: 100
    },
    download: {
      label: '💾 Download', category: 'output', color: '#34d399', icon: 'download',
      inputs: [{ name: 'stream', type: 'any', color: '#86efac' }],
      outputs: [{ name: 'stream_out', type: 'any', color: '#86efac' }],
      defaults: { quality: 'native', directory: '' }, width: 230, minH: 100
    }
  };

  // ─── Dynamic Ports ───
  function getNodeInputPorts(node) {
    const def = NODE_TYPES[node.type];
    if (!def) return [];

    // Generate nodes + Gemini: prompt/text + up to MAX_IMG_REFS dynamic media slots
    if (node.type === 'generate_image' || node.type === 'generate_video' || node.type === 'gemini_prompt') {
      // Use _frameConnCache (O(1)) during render; fall back to filter during init
      const refConnCount = _frameConnCache
        ? (_frameConnCache.byRefPort[node.id] || 0)
        : connections.filter(c => c.toNode === node.id && c.toPort > 0).length;
      const maxRefs = node.type === 'generate_video' ? (node.config?.videoMode === 'REF' ? MAX_IMG_REFS : 2) : MAX_IMG_REFS;
      const showSlots = Math.min(refConnCount + 1, maxRefs);

      // Port 0 is always the Text/Prompt input
      const ports = [{
        name: node.type === 'gemini_prompt' ? 'text' : 'prompt',
        type: 'string',
        color: '#a78bfa',
        optional: true
      }];

      // Ports > 0 are dynamic media references
      for (let i = 0; i < showSlots; i++) {
        let portName = `ref img ${i + 1}`;
        let portType = 'image';
        let portColor = '#22d3ee';

        if (node.type === 'generate_video') {
          if (node.config?.videoMode === 'REF') {
            portName = `ref img ${i + 1}`;
          } else {
            portName = i === 0 ? 'Start Frame' : 'End Frame';
          }
        } else if (node.type === 'gemini_prompt') {
          portName = `media ${i + 1}`;
          portType = 'any'; // "any" allows connecting both images AND videos
          portColor = '#86efac';
        }

        ports.push({ name: portName, type: portType, color: portColor, optional: true });
      }
      return ports;
    }

    // Download/Merge: dynamic stream slots (always 1 empty at end)
    if (node.type === 'download' || node.type === 'merge_video') {
      // Use cache during render, fall back otherwise
      const sc = _frameConnCache
        ? (_frameConnCache.byToNode[node.id] || []).length
        : connections.filter(c => c.toNode === node.id).length;
      return Array.from({ length: sc + 1 }, (_, i) => ({
        name: node.type === 'merge_video' ? `video ${i + 1}` : `stream ${i + 1}`,
        type: node.type === 'merge_video' ? 'video' : 'any',
        color: node.type === 'merge_video' ? '#fb923c' : '#86efac',
        optional: true
      }));
    }

    return def.inputs;
  }

  function getNodeOutputPorts(node) {
    const def = NODE_TYPES[node.type];
    if (!def) return [];

    if (node.type === 'generate_image' || node.type === 'generate_video') {
      const mediaType = node.type === 'generate_image' ? 'image' : 'video';
      const portColor = def.outputs[0].color;
      const quantity = Math.max(1, Math.min(4, node.config?.quantity || 1));

      // T\u00ecm prompt_list n\u1ed1i v\u00e0o port 0 (n\u1ebfu c\u00f3) \u0111\u1ec3 \u0111\u1ebfm s\u1ed1 prompt
      let promptCount = 1;
      const textConn = connections.find(c => c.toNode === node.id && c.toPort === 0);
      if (textConn) {
        const fromNode = _nodeMap?.[textConn.fromNode];
        if (fromNode && fromNode.type === 'prompt_list') {
          const lines = (fromNode.config?.text || '').split('\n').map(s => s.trim()).filter(Boolean);
          if (lines.length > 1) promptCount = lines.length;
        }
      }

      const totalPorts = promptCount * quantity;
      if (totalPorts === 1) return def.outputs; // tr\u01b0\u1eddng h\u1ee3p \u0111\u01a1n gi\u1ea3n

      return Array.from({ length: totalPorts }, (_, i) => {
        const pIdx = Math.floor(i / quantity); // prompt th\u1ee9 m\u1ea5y (0-based)
        const mIdx = i % quantity;             // media th\u1ee9 m\u1ea5y trong prompt \u0111\u00f3
        let name;
        if (promptCount > 1 && quantity > 1) {
          name = `${mediaType} P${pIdx + 1}.${mIdx + 1}`; // e.g. "image P1.1"
        } else if (promptCount > 1) {
          name = `${mediaType} ${pIdx + 1}`;               // e.g. "image 1"
        } else {
          name = `${mediaType} ${mIdx + 1}`;               // e.g. "image 1"
        }
        return { name, type: mediaType, color: portColor };
      });
    }

    return def.outputs;
  }

  // ─── Dynamic Height ───
  function getNodeHeight(node) {
    if (node.type === 'frame') return (node.config && node.config.height) ? node.config.height : (NODE_TYPES.frame.height || 400);
    if (node.customHeight) return Math.max(node.customHeight, NODE_TYPES[node.type].minH);
    const def = NODE_TYPES[node.type];
    const inputs = getNodeInputPorts(node);
    const outputs = getNodeOutputPorts(node);
    const maxPorts = Math.max(inputs.length, outputs.length);
    // Port area: header + before-first-port gap + all ports + bottom gap
    let h = HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 18;
    // Extra content area below ports
    if (node.type === 'prompt' || node.type === 'prompt_list' || node.type === 'gemini_prompt') {
      const field = node.type === 'gemini_prompt' ? 'promptTemplate' : 'text';
      let text = node.config[field] || '';
      if (node.type === 'prompt_list') text = text.split('\n').map(s => s.trim()).filter(Boolean).map(s => '• ' + s).join('\n');
      if (!text) {
        if (node.type === 'prompt_list') text = 'Double click để nhập, mỗi prompt là 1 dòng';
        else text = 'Double click để nhập';
      }
      let ctxHeight = 0;
      if (typeof canvas !== 'undefined' && canvas.getContext) {
        const tCtx = canvas.getContext('2d');
        tCtx.save(); tCtx.font = '11px Inter,sans-serif';
        const lines = getWrappedLines(text, def.width - 20, tCtx);
        const maxLines = node._isExpanded ? lines.length : Math.min(lines.length, 4);
        ctxHeight = maxLines * 14;
        if (lines.length > 4) ctxHeight += 24; // Khoảng trống cho nút Expand
        tCtx.restore();
      } else {
        ctxHeight = Math.max(1, text.length / 30) * 14; // fallback
      }
      h += (node.type === 'gemini_prompt' ? 36 : 18) + ctxHeight;
    } else if (node.type === 'upload_image') {
      if (node.config?.imageUrl) {
        h += 130; // thumbnail
      } else {
        h += 40; // upload button height
      }
    } else if ((node.type === 'generate_image' || node.type === 'generate_video' || node.type === 'merge_video') && node.previewMedia && node.previewMedia.length > 0) {
      const ratio = node.config?.ratio || 'landscape';
      let r = 9 / 16;
      if (ratio === 'portrait') r = 16 / 9;
      else if (ratio === 'square') r = 1;
      else if (ratio === '4_3') r = 3 / 4;
      else if (ratio === '3_4') r = 4 / 3;
      const pad = 6;
      const maxThumbs = Math.min(node.previewMedia.length, 4);
      const thumbW = Math.floor((def.width - pad * 2 - (maxThumbs - 1) * 4) / maxThumbs);
      const thumbH = Math.min(Math.floor(thumbW * r), 500);
      // 32 = pill row height (PILL_H:20) + gap (12), 54 = info text + download btn area
      h += 32 + thumbH + 54;
    } else if (node.type === 'generate_image' || node.type === 'generate_video' || node.type === 'merge_video') {
      h += 32; // pill row only (no preview yet)
    } else {
      h += 22; // info text
    }
    return Math.max(h, def.minH);
  }

  // ─── Init ───
  function init() {
    canvasEl = document.getElementById('wfbCanvas');
    if (!canvasEl) return;
    canvas = canvasEl;
    ctx = canvas.getContext('2d');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);

    // ── rAF-throttled mousemove: raw events only store latest pos ──────────────
    // Actual handler runs at most once per animation frame (60fps max).
    // Without this, mousemove fires 120-240x/s on modern displays, each time
    // running O(N) collision detection. This single change halves drag lag.
    let _latestMouseEvent = null;
    let _mouseRafScheduled = false;
    function _flushMouse() {
      _mouseRafScheduled = false;
      if (_latestMouseEvent) {
        const ev = _latestMouseEvent;
        _latestMouseEvent = null;
        onMouseMove(ev);
      }
    }
    canvas.addEventListener('mousemove', (e) => {
      _latestMouseEvent = e;
      if (!_mouseRafScheduled) {
        _mouseRafScheduled = true;
        requestAnimationFrame(_flushMouse);
      }
    });

    // Auto save 3s
    setInterval(() => {
      if (nodes.length === 0 && !currentWorkflowId && connections.length === 0) return;
      if (!currentWorkflowId) currentWorkflowId = 'wf_' + Date.now();
      const wf = getWorkflowJSON();
      const checkStr = JSON.stringify({ ...wf, createdAt: null });
      if (lastSavedJSON !== '' && checkStr !== lastSavedJSON) {
        lastSavedJSON = checkStr;
        saveWorkflow(true);
      } else {
        lastSavedJSON = checkStr;
      }
    }, 3000);

    // Load saved download dir
    const savedDir = localStorage.getItem('wfb_download_dir') || '';
    if (savedDir) NODE_TYPES.download.defaults.directory = savedDir;

    // Inject dialog animation
    if (!document.getElementById('wfbStyles')) {
      const s = document.createElement('style');
      s.id = 'wfbStyles';
      s.textContent = `
        @keyframes wfbDialogIn { from{opacity:0;transform:scale(.95) translateY(-4px)} to{opacity:1;transform:scale(1) translateY(0)} }
        .wfb-conn-row{padding:7px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:0;transition:background .1s}
        .wfb-conn-row:hover{background:rgba(255,255,255,0.07)}
      `;
      document.head.appendChild(s);
    }

    // GPU compositing hint so browser doesn't defer canvas repaints
    canvasEl.style.willChange = 'transform';

    // Re-render when user switches back to this tab (rAF is throttled when hidden)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { _dirty = true; }
    });

    renderNodePalette();
    renderWorkflowList();
    loadWorkflowsFromStorage();
    requestAnimationFrame(renderLoop);
  }

  // ─── Spin Active Check & Trigger ───
  function _checkSpinActive() {
    const wasActive = _spinActive;
    _spinActive = nodes.some(n => n.status === 'running');
    if (_spinActive && !wasActive) _startSpinLoop(); // kick off spin loop when newly active
  }

  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    markDirty(); // Trigger render explicitly to prevent black screen void
  }

  // ─── Render Loop (dirty-flag based, frame-rate capped) ───
  let _lastRenderTime = 0;
  function renderLoop(ts) {
    try {
      if (_dirty && !document.hidden) {
        // Cap at 60fps — skip frame if less than ~14ms since last render
        if (ts - _lastRenderTime >= 14) {
          render();
          _lastRenderTime = ts;
          _dirty = false;
        }
      }
    } catch (e) {
      console.warn('[WFB] render error:', e);
    }
    requestAnimationFrame(renderLoop); // always reschedule so loop never stops
  }

  // Dedicated spin loop — runs only while a node is generating
  // Uses markDirty so the main renderLoop handles the actual draw (avoids double render)
  function _startSpinLoop() {
    if (_spinLoopRunning) return;
    _spinLoopRunning = true;
    let _lastSpinTime = 0;
    function spinFrame(ts) {
      if (!_spinActive) { _spinLoopRunning = false; return; } // stop when no running nodes
      // Throttle to ~30fps for spinner (imperceptible difference, halves render cost)
      if (ts - _lastSpinTime >= 33) {
        _lastSpinTime = ts;
        _spinAngle = (_spinAngle + 0.12) % (Math.PI * 2); // advance angle (faster since 30fps)
        _dirty = true; // let the main renderLoop draw it
      }
      requestAnimationFrame(spinFrame);
    }
    requestAnimationFrame(spinFrame);
  }

  // Per-frame connection cache — rebuilt only when connections mutate, NOT every frame
  // This avoids O(M) rebuild at 60fps with thousands of connections
  // (vars declared at top of IIFE so _applySnapshot can reference them)
  function _buildFrameConnCache() {
    if (!_connCacheDirty && _frameConnCache) return; // fast path: nothing changed
    _connCacheDirty = false;
    const byToNode = {};
    const byRefPort = {};
    const promptListCount = {}; // Số prompt từ prompt_list nối vào port 0 của gen node
    for (let ci = 0; ci < connections.length; ci++) {
      const c = connections[ci];
      if (!byToNode[c.toNode]) byToNode[c.toNode] = [];
      byToNode[c.toNode].push(c);
      if (c.toPort > 0) byRefPort[c.toNode] = (byRefPort[c.toNode] || 0) + 1;
      // Đếm số prompt từ prompt_list nối vào port 0 của gen node
      if (c.toPort === 0) {
        const fromNode = nodes.find(n => n.id === c.fromNode);
        const toNode = nodes.find(n => n.id === c.toNode);
        if (fromNode && fromNode.type === 'prompt_list' &&
          toNode && (toNode.type === 'generate_image' || toNode.type === 'generate_video')) {
          const lines = (fromNode.config?.text || '').split('\n').map(s => s.trim()).filter(Boolean);
          if (lines.length > 1) promptListCount[c.toNode] = lines.length;
        }
      }
    }
    _frameConnCache = { byToNode, byRefPort, promptListCount };
  }

  // Cached canvas rect to avoid getBoundingClientRect() layout reflow every frame
  let _cachedCanvasRect = null;
  let _canvasRectPan = { x: -9999, y: -9999 };
  let _canvasRectZoom = -1;
  function _getCanvasRect() {
    // Only re-read if pan/zoom changed (or first call)
    if (_cachedCanvasRect && pan.x === _canvasRectPan.x && pan.y === _canvasRectPan.y && zoom === _canvasRectZoom) {
      return _cachedCanvasRect;
    }
    _cachedCanvasRect = canvas.getBoundingClientRect();
    _canvasRectPan = { x: pan.x, y: pan.y };
    _canvasRectZoom = zoom;
    return _cachedCanvasRect;
  }

  function render() {
    if (!ctx) return;
    _buildFrameConnCache(); // Only rebuilds if connections changed
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);
    drawGrid(w, h);
    drawConnections();
    drawTempConnection();
    drawNodes();
    drawLasso();
    ctx.restore();
    syncInlineEditor();
  }

  function syncInlineEditor() {
    if (!window._activeWfbTextarea || !window._activeWfbNode) return;
    const ta = window._activeWfbTextarea;
    const node = window._activeWfbNode;
    const cr = _getCanvasRect(); // cached — no forced layout reflow
    const def = NODE_TYPES[node.type];
    if (!def) return;
    const maxPorts = Math.max(getNodeInputPorts(node).length, getNodeOutputPorts(node).length);
    const contentYOff = HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 6;
    const yStartOff = node.type === 'gemini_prompt' ? contentYOff + 18 : contentYOff + 2;

    const sx = cr.left + pan.x + (node.x + 10) * zoom;
    const sy = cr.top + pan.y + (node.y + yStartOff) * zoom;
    const sw = (def.width - 20) * zoom;
    ta.style.left = sx + 'px';
    ta.style.top = sy + 'px';
    ta.style.width = sw + 'px';
    ta.style.font = `${11 * zoom}px Inter,sans-serif`;
    ta.style.lineHeight = `${14 * zoom}px`;
  }

  // Draw lasso selection rectangle
  function drawLasso() {
    if (!lasso) return;
    const x = Math.min(lasso.startX, lasso.endX);
    const y = Math.min(lasso.startY, lasso.endY);
    const w = Math.abs(lasso.endX - lasso.startX);
    const h = Math.abs(lasso.endY - lasso.startY);
    ctx.save();
    ctx.fillStyle = 'rgba(138,92,246,0.08)';
    ctx.strokeStyle = 'rgba(138,92,246,0.7)';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 3 / zoom]);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawGrid(w, h) {
    // Skip expensive grid when zoomed way out (dots too dense to matter)
    if (zoom < 0.25) return;
    const gs = 30;
    const sx = Math.floor(-pan.x / zoom / gs) * gs, sy = Math.floor(-pan.y / zoom / gs) * gs;
    const ex = sx + w / zoom + gs * 2, ey = sy + h / zoom + gs * 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
    // Batch ALL vertical lines into one path (saves hundreds of draw calls)
    ctx.beginPath();
    for (let x = sx; x < ex; x += gs) { ctx.moveTo(x, sy); ctx.lineTo(x, ey); }
    ctx.stroke();
    // Batch ALL horizontal lines into one path
    ctx.beginPath();
    for (let y = sy; y < ey; y += gs) { ctx.moveTo(sx, y); ctx.lineTo(ex, y); }
    ctx.stroke();
  }

  // ─── Draw Nodes & Frames — with viewport culling ───
  function drawNodes() {
    // Compute visible world bounds (nodes outside this rect are culled)
    const cw = canvas.width / devicePixelRatio;
    const ch = canvas.height / devicePixelRatio;
    const vl = -pan.x / zoom;       // visible left in world coords
    const vt = -pan.y / zoom;       // visible top
    const vr = vl + cw / zoom;      // visible right
    const vb = vt + ch / zoom;      // visible bottom
    const CULL_PAD = 60;            // extra buffer so partially-visible nodes always draw

    function isVisible(nx, ny, nw, nh) {
      return nx + nw + CULL_PAD > vl && nx - CULL_PAD < vr &&
        ny + nh + CULL_PAD > vt && ny - CULL_PAD < vb;
    }

    for (const node of nodes) {
      if (node.type === 'frame') {
        const fw = node.config?.width || NODE_TYPES.frame.width;
        const fh = node.config?.height || NODE_TYPES.frame.defaults?.height || 400;
        if (isVisible(node.x, node.y, fw, fh)) drawFrameNode(node);
      }
    }
    for (const node of nodes) {
      if (node.type !== 'frame') {
        const nw = NODE_TYPES[node.type]?.width || 240;
        const nh = _heightCache[node.id] || 200; // use cached height (cheap)
        if (isVisible(node.x, node.y, nw, nh)) drawNode(node);
      }
    }
  }

  function drawFrameNode(node) {
    const def = NODE_TYPES[node.type];
    if (!def) return;
    const x = node.x, y = node.y;
    const w = node.config.width || def.width;
    const h = node.config.height || def.height;
    const isSelected = selectedNode === node.id || selectedNodes.has(node.id);
    const r = 8;

    // Background and border
    const frameColor = node.config.color || '#a78bfa';
    ctx.fillStyle = isSelected ? frameColor + '30' : frameColor + '15'; // 30 is roughly ~19% opacity, 15 is ~8% opacity
    ctx.strokeStyle = isSelected ? frameColor : frameColor + '66'; // ~40% opacity for unselected
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);

    // Header
    const hdrH = 26;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); roundRectTop(ctx, x, y, w, hdrH, r); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + hdrH); ctx.lineTo(x + w, y + hdrH); ctx.stroke();

    // Title (Không kèm icon crop_free)
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px Inter,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const titleText = (node.customName || node.config.name || def.defaults.name);
    ctx.fillText(titleText, x + 10, y + hdrH / 2);

    const titleWidth = ctx.measureText(titleText).width;

    // ─── Header Buttons (Moved next to title) ───
    const bY = y + (hdrH - HDR_BTN_SIZE) / 2;
    let bLeft = x + 10 + titleWidth + 10; // offset slightly from the title

    node._headerBtns = node._headerBtns || {};

    // Nút chạy
    node._headerBtns.run = { x: bLeft, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE, disabled: false };
    _drawHdrBtn(bLeft, bY, '▶', '#34d399', true);

    bLeft += HDR_BTN_SIZE + HDR_BTN_PAD;

    // Nút chi tiết
    node._headerBtns.detail = { x: bLeft, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE, disabled: false };
    _drawHdrBtn(bLeft, bY, 'ℹ', '#a0aec0', false);

    bLeft += HDR_BTN_SIZE + HDR_BTN_PAD;

    // Nút chọn màu
    node._headerBtns.color = { x: bLeft, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE, disabled: false };
    _drawHdrBtn(bLeft, bY, '■', frameColor, true);

    // ─── Resize handles (4 corners hit-zones & visual markers) ───
    const hs = 16; // Hit zone size
    node._resizeHandles = {
      tl: { x: x, y: y, s: hs },
      tr: { x: x + w - hs, y: y, s: hs },
      bl: { x: x, y: y + h - hs, s: hs },
      br: { x: x + w - hs, y: y + h - hs, s: hs }
    };

    // Draw subtle visual indicators for the 4 corners
    const vis = 8; // Visual line length
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // tl
    ctx.moveTo(x + 4, y + 4 + vis); ctx.lineTo(x + 4, y + 4); ctx.lineTo(x + 4 + vis, y + 4);
    // tr
    ctx.moveTo(x + w - 4 - vis, y + 4); ctx.lineTo(x + w - 4, y + 4); ctx.lineTo(x + w - 4, y + 4 + vis);
    // bl
    ctx.moveTo(x + 4, y + h - 4 - vis); ctx.lineTo(x + 4, y + h - 4); ctx.lineTo(x + 4 + vis, y + h - 4);
    // br
    ctx.moveTo(x + w - 4 - vis, y + h - 4); ctx.lineTo(x + w - 4, y + h - 4); ctx.lineTo(x + w - 4, y + h - 4 - vis);
    ctx.stroke();
  }

  // ─── Header icon button layout ───
  // Buttons drawn right-to-left from header right edge:
  // [ℹ] always, [▶ Run] for runnable, [⬇] when preview exists
  const HDR_BTN_SIZE = 18; // square button size
  const HDR_BTN_PAD = 4;  // gap between buttons & right edge

  function _drawHdrBtn(bx, by, icon, color, active) {
    const s = HDR_BTN_SIZE;
    ctx.fillStyle = active ? color + '30' : 'rgba(255,255,255,0.06)';
    ctx.beginPath(); roundRect(ctx, bx, by, s, s, 4); ctx.fill();
    ctx.strokeStyle = active ? color + '70' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(ctx, bx, by, s, s, 4); ctx.stroke();
    ctx.fillStyle = active ? color : '#888';
    ctx.font = 'bold 10px Inter,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(icon, bx + s / 2, by + s / 2 + 1);
  }

  function drawNode(node) {
    const def = NODE_TYPES[node.type];
    if (!def) return;
    const x = node.x, y = node.y;
    const w = def.width, h = _heightCache[node.id] ?? getNodeHeight(node);
    _heightCache[node.id] = h;
    const isSelected = selectedNode === node.id;
    const isMultiSelected = selectedNodes.has(node.id);
    const r = 10;

    // Shadow + body — only apply shadowBlur for selected nodes (very expensive on Canvas2D)
    // For multi-select: SKIP shadow when many nodes selected (each shadowBlur costs ~1ms GPU flush)
    const canDrawShadow = !isPanning && !isLassoing && !draggingNode && !draggingMulti;
    if (canDrawShadow && isSelected) {
      ctx.shadowColor = def.color + '60';
      ctx.shadowBlur = 16; ctx.shadowOffsetY = 2;
    } else if (canDrawShadow && isMultiSelected && selectedNodes.size <= 4) {
      // Only draw glow for small selections (≤4 nodes) — cheap enough
      ctx.shadowColor = '#a78bfa60';
      ctx.shadowBlur = 14; ctx.shadowOffsetY = 2;
    }
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // Border
    if (isMultiSelected) {
      ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
    } else if (isSelected) {
      ctx.strokeStyle = def.color; ctx.lineWidth = 2; ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.setLineDash([]);
    }
    ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.stroke();
    ctx.setLineDash([]);

    // Header bg
    ctx.fillStyle = def.color + '30';
    ctx.beginPath(); roundRectTop(ctx, x, y, w, HEADER_HEIGHT, r); ctx.fill();
    ctx.strokeStyle = def.color + '40'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + HEADER_HEIGHT); ctx.lineTo(x + w, y + HEADER_HEIGHT); ctx.stroke();

    // ─── Header icon buttons (right-to-left) ───
    const bY = y + (HEADER_HEIGHT - HDR_BTN_SIZE) / 2;
    let bRight = x + w - HDR_BTN_PAD;
    const hdrBtns = {};

    // ℹ Detail (always)
    bRight -= HDR_BTN_SIZE;
    hdrBtns.detail = { x: bRight, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE };
    _drawHdrBtn(bRight, bY, 'ℹ', '#a0aec0', false);
    bRight -= HDR_BTN_PAD;

    // ⬇ Download (only if previewMedia)
    if (node.previewMedia && node.previewMedia.length > 0) {
      bRight -= HDR_BTN_SIZE;
      hdrBtns.dl = { x: bRight, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE };
      _drawHdrBtn(bRight, bY, '⬇', '#34d399', true);
      bRight -= HDR_BTN_PAD;
    }

    // ▶ Run (for generate & gemini nodes)
    const isRunnable = (node.type === 'generate_image' || node.type === 'generate_video' ||
      node.type === 'gemini_prompt' || node.type === 'merge_video');
    if (isRunnable) {
      // Nút run ACTIVE khi:
      // - Gemini: luôn được
      // - Có BẤT KỲ connection nào vào node (prompt, ref image, video đều OK) — use cache O(1)
      // - Hoặc node có sẵn config.text (prompt tự nhập)
      const hasAnyInput = !!(_frameConnCache?.byToNode[node.id]?.length);
      const hasConfigText = !!(node.config?.text && node.config.text.trim());
      const hasPrompt = node.type === 'gemini_prompt' ? true : (hasAnyInput || hasConfigText);
      bRight -= HDR_BTN_SIZE;
      hdrBtns.run = { x: bRight, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE, disabled: !hasPrompt };
      _drawHdrBtn(bRight, bY, node.type === 'gemini_prompt' ? '✨' : '▶',
        hasPrompt ? (node.type === 'gemini_prompt' ? '#84cc16' : '#a78bfa') : '#444', hasPrompt);
    }

    // 📁 Upload (for upload_image nodes)
    if (node.type === 'upload_image') {
      bRight -= HDR_BTN_SIZE;
      hdrBtns.upload = { x: bRight, y: bY, w: HDR_BTN_SIZE, h: HDR_BTN_SIZE };
      _drawHdrBtn(bRight, bY, '📁', '#f59e0b', true);
    }
    node._headerBtns = hdrBtns;

    // Title (truncated to avoid overlapping buttons)
    const titleMaxRight = bRight - HDR_BTN_PAD;
    const titleW = titleMaxRight - (x + 30);
    ctx.fillStyle = '#f0f0f5'; ctx.font = 'bold 12px Inter,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const titleText = node.customName || def.label;
    // Clip title to available space
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, titleMaxRight - x, HEADER_HEIGHT); ctx.clip();
    ctx.fillText(titleText, x + 12, y + HEADER_HEIGHT / 2);
    ctx.restore();

    // Status dot (next to run button area if not replaced)
    if (node.status === 'done') {
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(x + 6, y + HEADER_HEIGHT / 2, 3, 0, Math.PI * 2); ctx.fill();
    } else if (node.status === 'error') {
      ctx.fillStyle = '#f87171';
      ctx.beginPath(); ctx.arc(x + 6, y + HEADER_HEIGHT / 2, 3, 0, Math.PI * 2); ctx.fill();
    }

    // Clip background so content never spills out of bounds
    ctx.save();
    ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.clip();

    // Content
    drawNodeContent(node, def, x, y + HEADER_HEIGHT, w, h - HEADER_HEIGHT);

    ctx.restore();

    // ─── Spinner overlay when running ───
    if (node.status === 'running') {
      const cx = x + w / 2, cy = y + HEADER_HEIGHT + (h - HEADER_HEIGHT) / 2;
      const rad = Math.min(w, h - HEADER_HEIGHT) * 0.2;
      ctx.fillStyle = 'rgba(14,14,28,0.65)';
      ctx.beginPath(); roundRect(ctx, x + 4, y + HEADER_HEIGHT + 4, w - 8, h - HEADER_HEIGHT - 8, 6); ctx.fill();
      // Calculate simulated progress
      let pct = 0;
      if (node.runStartTime) {
        const elapsedMs = Date.now() - node.runStartTime;
        const averageTimeMs = (node.type && node.type.includes('image')) ? 18000 : 85000;
        pct = Math.min(95, Math.floor((elapsedMs / averageTimeMs) * 100));
      }

      // Background track
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = rad * 0.22;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = def.color;
      ctx.lineWidth = rad * 0.22;
      ctx.lineCap = 'round';
      // Faint progress ring
      const startAngle = -Math.PI / 2;
      const progressAngle = startAngle + (pct / 100) * (Math.PI * 2);
      ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.arc(cx, cy, rad, startAngle, progressAngle); ctx.stroke();

      // Bright short spinner
      ctx.globalAlpha = 1.0;
      ctx.beginPath(); ctx.arc(cx, cy, rad, _spinAngle, _spinAngle + Math.PI * 0.5); ctx.stroke();

      ctx.lineCap = 'butt';
      // Percentage Text (center)
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(12, rad * 0.5)}px Inter,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pct + '%', cx, cy);

      // Subtext
      ctx.fillStyle = '#ccc'; ctx.font = `bold ${Math.max(9, rad * 0.35)}px Inter,sans-serif`;
      ctx.fillText('Đang chạy...', cx, cy + rad + 14);
    }

    // Input ports
    const inputPorts = getNodeInputPorts(node);
    inputPorts.forEach((port, i) => {
      const py = y + HEADER_HEIGHT + 14 + i * PORT_SPACING, px = x;
      ctx.fillStyle = port.color || '#888'; ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, PORT_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8888a0'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(port.name + (port.optional ? ' (opt)' : ''), px + 12, py + 1);
    });

    // Output ports
    const outputPorts = getNodeOutputPorts(node);
    outputPorts.forEach((port, i) => {
      const py = y + HEADER_HEIGHT + 14 + i * PORT_SPACING, px = x + w;
      ctx.fillStyle = port.color || '#888'; ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, PORT_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8888a0'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(port.name, px - 12, py + 1);
    });

    if (node.type === 'prompt' || node.type === 'prompt_list') {
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.beginPath();
      ctx.moveTo(x + w - 12, y + h - 2);
      ctx.lineTo(x + w - 2, y + h - 12);
      ctx.lineTo(x + w - 2, y + h - 2);
      ctx.fill();
    }
  }

  function getWrappedLines(text, maxWidth, ctx) {
    if (!text) return [];
    const lines = [];
    text.split('\n').forEach(p => {
      let line = '';
      const words = p.split(' ');
      for (let i = 0; i < words.length; i++) {
        let testLine = line + (line !== '' ? ' ' : '') + words[i];
        if (ctx.measureText(testLine).width <= maxWidth) {
          line = testLine;
        } else {
          if (line !== '') {
            lines.push(line);
            line = '';
          }
          let w = words[i];
          while (ctx.measureText(w).width > maxWidth) {
            let j = 0;
            while (j < w.length && ctx.measureText(w.slice(0, Math.max(1, j + 1))).width <= maxWidth) j++;
            const fit = Math.max(1, j - 1);
            lines.push(w.slice(0, fit));
            w = w.slice(fit);
          }
          line = w;
        }
      }
      if (line !== '') lines.push(line);
    });
    return lines;
  }

  function drawNodeContent(node, def, x, y, w, h) {
    // y = nodeY + HEADER_HEIGHT, h = nodeHeight - HEADER_HEIGHT
    const inputs = getNodeInputPorts(node);
    const outputs = getNodeOutputPorts(node);
    const maxPorts = Math.max(inputs.length, outputs.length);
    const contentY = y + 14 + maxPorts * PORT_SPACING + 6;
    const contentH = (y + h) - contentY - 8;

    ctx.fillStyle = '#555570'; ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'center';

    switch (node.type) {
      case 'prompt':
      case 'prompt_list':
      case 'gemini_prompt': {
        if (node.type === 'gemini_prompt') {
          const hasKey = typeof window !== 'undefined' && window.getGeminiApiKey && window.getGeminiApiKey();
          ctx.fillStyle = (!hasKey && !node.config.apiKey) ? '#f87171' : '#84cc16';
          ctx.textAlign = 'center';
          ctx.fillText((!hasKey && !node.config.apiKey) ? '⚠️ Chưa cài API Key!' : '✔️ Sẵn sàng gọi AI', x + w / 2, contentY + 8);
        }

        if (node._isEditing) break; // Ẩn chữ đi để hiển thị textarea inline seamless

        const field = node.type === 'gemini_prompt' ? 'promptTemplate' : 'text';
        let text = node.config[field] || '';
        if (node.type === 'prompt_list') text = text.split('\n').map(s => s.trim()).filter(Boolean).map(s => '• ' + s).join('\n');
        if (!text) {
          if (node.type === 'prompt_list') text = 'Double click để nhập, mỗi prompt là 1 dòng';
          else text = 'Double click để nhập';
        }

        ctx.textAlign = 'left';
        ctx.fillStyle = '#e8e8ff';

        let lines;
        const cacheKey = text + '_' + w;
        if (node._wrappedTextCacheKey !== cacheKey || !node._wrappedLines) {
          node._wrappedTextCacheKey = cacheKey;
          node._wrappedLines = getWrappedLines(text, w - 20, ctx);
        }
        lines = node._wrappedLines;

        const yStart = node.type === 'gemini_prompt' ? contentY + 24 : contentY + 8;

        const maxLines = node._isExpanded ? lines.length : Math.min(lines.length, 4);
        for (let i = 0; i < maxLines; i++) {
          ctx.fillText(lines[i], x + 10, yStart + i * 14);
        }

        if (lines.length > 4) {
          const btnY = yStart + maxLines * 14 + 6;
          ctx.fillStyle = '#a78bfa'; // Purple/indigo color
          ctx.font = '10px Inter,sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(node._isExpanded ? '▲ Thu gọn' : '▼ Xem thêm', x + w / 2, btnY);

          // Lưu giới hạn nút bấm để bắt sự kiện click
          node._expandBtn = { x: x, y: btnY - 10, w: w, h: 20 };
        } else {
          node._expandBtn = null;
        }
        break;
      }
      case 'upload_image': {
        if (node.config?.imageUrl) {
          node._emptyUploadBtn = null;
          const im = getCachedImg(node.config.imageUrl);
          if (im && im.complete && im.naturalWidth > 0) {
            const pad = 8, iw = w - pad * 2, ih = Math.max(contentH - 4, 30);
            const ix = x + pad, iy = contentY + 2;
            ctx.save();
            ctx.beginPath(); roundRect(ctx, ix, iy, iw, ih, 5); ctx.clip();
            // Fit image (cover)
            const scale = Math.max(iw / im.naturalWidth, ih / im.naturalHeight);
            const sw = im.naturalWidth * scale, sh = im.naturalHeight * scale;
            const wasSmoothing = ctx.imageSmoothingEnabled;
            if (zoom < 0.25) ctx.imageSmoothingEnabled = false;
            ctx.drawImage(im, ix + (iw - sw) / 2, iy + (ih - sh) / 2, sw, sh);
            ctx.imageSmoothingEnabled = wasSmoothing;
            ctx.restore();
          } else {
            ctx.fillText('⏳ Đang tải media…', x + w / 2, contentY + 12);
          }
        } else {
          const btnW = w - 24;
          const btnH = 34;
          const btnX = x + 12;
          const btnY = contentY;

          ctx.beginPath(); roundRect(ctx, btnX, btnY, btnW, btnH, 6);
          ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
          ctx.fill();

          ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#22d3ee';
          ctx.font = 'bold 12px Inter,sans-serif';
          ctx.fillText('📁 Nhấn để Upload Media', x + w / 2, btnY + btnH / 2);

          node._emptyUploadBtn = { x: btnX, y: btnY, w: btnW, h: btnH };
        }
        break;
      }
      case 'merge_video': {
        const inputCount = (_frameConnCache?.byToNode[node.id] || []).length;
        ctx.fillText(`Ghép ${inputCount} video liên tiếp`, x + w / 2, contentY + 8);

        // Preview thumbnails + download buttons
        if (node.previewMedia && node.previewMedia.length > 0) {
          const ratio = 'landscape';
          let r = 9 / 16;
          const thumbY = contentY + 22;
          const pad = 6;
          const maxThumbs = Math.min(node.previewMedia.length, 4);
          const thumbW = Math.floor((w - pad * 2 - (maxThumbs - 1) * 4) / maxThumbs);
          const thumbH = Math.floor(thumbW * r);
          if (thumbH > 220) thumbH = 220;
          for (let ti = 0; ti < maxThumbs; ti++) {
            const pm = node.previewMedia[ti];
            const tx = x + pad + ti * (thumbW + 4);
            const im = getCachedImg(pm.url, pm.type);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath(); roundRect(ctx, tx, thumbY, thumbW, thumbH, 5); ctx.fill();
            if (im && im.complete && im.naturalWidth > 0) {
              ctx.save();
              ctx.beginPath(); roundRect(ctx, tx, thumbY, thumbW, thumbH, 5); ctx.clip();
              const scale = Math.max(thumbW / im.naturalWidth, thumbH / im.naturalHeight);
              const sw = im.naturalWidth * scale, sh = im.naturalHeight * scale;
              const wasSmoothing = ctx.imageSmoothingEnabled;
              if (zoom < 0.25) ctx.imageSmoothingEnabled = false;
              ctx.drawImage(im, tx + (thumbW - sw) / 2, thumbY + (thumbH - sh) / 2, sw, sh);
              ctx.imageSmoothingEnabled = wasSmoothing;
              ctx.restore();
            } else {
              ctx.fillStyle = '#555570'; ctx.font = '18px Inter,sans-serif'; ctx.textAlign = 'center';
              ctx.fillText(pm.type === 'video' ? '🎬' : '🖼️', tx + thumbW / 2, thumbY + thumbH / 2 + 6);
            }
            if (pm.type === 'video') {
              ctx.fillStyle = 'rgba(0,0,0,0.55)';
              ctx.beginPath(); ctx.arc(tx + thumbW / 2, thumbY + thumbH / 2, 12, 0, Math.PI * 2); ctx.fill();
              ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillText('▶', tx + thumbW / 2 + 1, thumbY + thumbH / 2);
            }
            const dlBtnY = thumbY + thumbH + 3;
            const dlBtnH = 18;
            ctx.fillStyle = 'rgba(52,211,153,0.12)';
            ctx.beginPath(); roundRect(ctx, tx, dlBtnY, thumbW, dlBtnH, 4); ctx.fill();
            ctx.strokeStyle = 'rgba(52,211,153,0.35)'; ctx.lineWidth = 1;
            ctx.beginPath(); roundRect(ctx, tx, dlBtnY, thumbW, dlBtnH, 4); ctx.stroke();
            ctx.fillStyle = '#34d399'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⬇ Tải về', tx + thumbW / 2, dlBtnY + dlBtnH / 2);
          }
          node._previewBounds = { thumbY, thumbH, pad, maxThumbs, thumbW };
        } else {
          node._previewBounds = null;
        }
        break;
      }
      case 'generate_image':
      case 'generate_video': {
        const refCount = _frameConnCache?.byRefPort[node.id] || 0;
        // ─── Inline ratio + quantity + quality pills ───
        const PILL_H = 20, PILL_Y = contentY + 4;
        const ratioLabels = { landscape: '16:9', portrait: '9:16', square: '1:1', '4_3': '4:3', '3_4': '3:4' };
        const curRatioLabel = ratioLabels[node.config.ratio] || node.config.ratio;
        const curQtyLabel = `x${node.config.quantity || 1}`;
        const qualLabelMap = { native: 'Gốc', '1080p': '1080p', '2K': '2K', '4K': '4K', '720p': '720p' };
        const curQualLabel = qualLabelMap[node.config.quality] || node.config.quality || 'Gốc';
        const isVideoNode = node.type === 'generate_video';
        // Pill 4: model pill (gen_video và gen_image)
        const isImageNode = node.type === 'generate_image';
        let modelShort = '';
        let pill4W = 0;

        if (isVideoNode) {
          modelShort = { 'veo31_lite': 'Lite', 'veo31_lite_lower': 'Lite↓', 'veo31_fast': 'Fast', 'veo31_fast_lower': 'Fast↓', 'veo31_quality': 'Quality' }[node.config.videoModel || 'veo31_fast_lower'] || 'Fast↓';
          pill4W = 52;
        } else if (isImageNode) {
          modelShort = { 'nanobanana_2': 'N-Banana2', 'nanobanana_pro': 'NB-Pro', 'imagen_4': 'Imagen4' }[node.config.imageModel || 'imagen_4'] || 'Imagen4';
          pill4W = 60;
        }

        let pill5W = 0;
        let modeShort = '';
        if (isVideoNode) {
          modeShort = node.config.videoMode === 'REF' ? 'REF' : 'FRAME';
          pill5W = 44;
        }

        const pill1W = 50, pill2W = 32, pill3W = 46, pillGap = 4;
        const pill1X = x + 8;
        const pill2X = pill1X + pill1W + pillGap;
        const pill3X = pill2X + pill2W + pillGap;
        const pill4X = pill3X + pill3W + pillGap;
        const pill5X = (pill4W > 0) ? (pill4X + pill4W + pillGap) : (pill3X + pill3W + pillGap);
        // Draw ratio pill
        ctx.fillStyle = 'rgba(138,92,246,0.15)';
        ctx.beginPath(); roundRect(ctx, pill1X, PILL_Y, pill1W, PILL_H, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(138,92,246,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); roundRect(ctx, pill1X, PILL_Y, pill1W, PILL_H, 6); ctx.stroke();
        ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 10px Inter,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(curRatioLabel + ' ▾', pill1X + pill1W / 2, PILL_Y + PILL_H / 2);
        // Draw qty pill
        ctx.fillStyle = 'rgba(138,92,246,0.15)';
        ctx.beginPath(); roundRect(ctx, pill2X, PILL_Y, pill2W, PILL_H, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(138,92,246,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); roundRect(ctx, pill2X, PILL_Y, pill2W, PILL_H, 6); ctx.stroke();
        ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 10px Inter,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(curQtyLabel + ' ▾', pill2X + pill2W / 2, PILL_Y + PILL_H / 2);
        // Draw quality pill
        ctx.fillStyle = 'rgba(52,211,153,0.12)';
        ctx.beginPath(); roundRect(ctx, pill3X, PILL_Y, pill3W, PILL_H, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(52,211,153,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); roundRect(ctx, pill3X, PILL_Y, pill3W, PILL_H, 6); ctx.stroke();
        ctx.fillStyle = '#34d399'; ctx.font = 'bold 10px Inter,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(curQualLabel + ' ▾', pill3X + pill3W / 2, PILL_Y + PILL_H / 2);

        // Pill 4: model pill
        if (pill4W > 0) {
          ctx.fillStyle = isVideoNode ? 'rgba(249,115,22,0.14)' : 'rgba(236,72,153,0.14)';
          ctx.beginPath(); roundRect(ctx, pill4X, PILL_Y, pill4W, PILL_H, 6); ctx.fill();
          ctx.strokeStyle = isVideoNode ? 'rgba(249,115,22,0.5)' : 'rgba(236,72,153,0.5)'; ctx.lineWidth = 1;
          ctx.beginPath(); roundRect(ctx, pill4X, PILL_Y, pill4W, PILL_H, 6); ctx.stroke();
          ctx.fillStyle = isVideoNode ? '#fb923c' : '#ec4899'; ctx.font = 'bold 9.5px Inter,sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(modelShort + ' ▾', pill4X + pill4W / 2, PILL_Y + PILL_H / 2);
        }
        if (pill5W > 0) {
          ctx.fillStyle = 'rgba(56,189,248,0.15)';
          ctx.beginPath(); roundRect(ctx, pill5X, PILL_Y, pill5W, PILL_H, 6); ctx.fill();
          ctx.strokeStyle = 'rgba(56,189,248,0.4)'; ctx.lineWidth = 1;
          ctx.beginPath(); roundRect(ctx, pill5X, PILL_Y, pill5W, PILL_H, 6); ctx.stroke();
          ctx.fillStyle = '#38bdf8'; ctx.font = 'bold 9.5px Inter,sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(modeShort + ' ▾', pill5X + pill5W / 2, PILL_Y + PILL_H / 2);
        }
        // ref count hint
        const refHintX = (pill5W > 0) ? (pill5X + pill5W + 4) : ((pill4W > 0) ? (pill4X + pill4W + 4) : (pill3X + pill3W + 4));
        ctx.fillStyle = refCount ? (isVideoNode ? '#f97316' : '#ec4899') : '#555';
        ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`📎${refCount}`, refHintX, PILL_Y + PILL_H / 2);
        // Store pill bounds for click
        node._ratioPill = { x: pill1X, y: PILL_Y, w: pill1W, h: PILL_H };
        node._qtyPill = { x: pill2X, y: PILL_Y, w: pill2W, h: PILL_H };
        node._qualPill = { x: pill3X, y: PILL_Y, w: pill3W, h: PILL_H };
        node._modelPill = (pill4W > 0) ? { x: pill4X, y: PILL_Y, w: pill4W, h: PILL_H, isImage: isImageNode } : null;
        node._modePill = (pill5W > 0) ? { x: pill5X, y: PILL_Y, w: pill5W, h: PILL_H } : null;
        // Preview thumbnails
        if (node.previewMedia && node.previewMedia.length > 0) {
          const ratio = node.config?.ratio || 'landscape';
          let r = 9 / 16;
          if (ratio === 'portrait') r = 16 / 9;
          else if (ratio === 'square') r = 1;
          else if (ratio === '4_3') r = 3 / 4;
          else if (ratio === '3_4') r = 4 / 3;
          const thumbY = contentY + PILL_H + 12;
          const pad = 6;
          const maxThumbs = Math.min(node.previewMedia.length, 4);
          const thumbW = Math.floor((w - pad * 2 - (maxThumbs - 1) * 4) / maxThumbs);
          const thumbH = Math.min(Math.floor(thumbW * r), 500);
          for (let ti = 0; ti < maxThumbs; ti++) {
            const pm = node.previewMedia[ti];
            const tx = x + pad + ti * (thumbW + 4);
            const im = getCachedImg(pm.url, pm.type);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath(); roundRect(ctx, tx, thumbY, thumbW, thumbH, 5); ctx.fill();
            if (im && im.complete && im.naturalWidth > 0) {
              ctx.save(); ctx.beginPath(); roundRect(ctx, tx, thumbY, thumbW, thumbH, 5); ctx.clip();
              const scale = Math.max(thumbW / im.naturalWidth, thumbH / im.naturalHeight);
              const sw = im.naturalWidth * scale, sh = im.naturalHeight * scale;
              const wasSmoothing = ctx.imageSmoothingEnabled;
              if (zoom < 0.25) ctx.imageSmoothingEnabled = false;
              ctx.drawImage(im, tx + (thumbW - sw) / 2, thumbY + (thumbH - sh) / 2, sw, sh);
              ctx.imageSmoothingEnabled = wasSmoothing;
              ctx.restore();
            } else {
              ctx.fillStyle = '#555570'; ctx.font = '18px Inter,sans-serif'; ctx.textAlign = 'center';
              ctx.fillText(pm.type === 'video' ? '🎬' : '🖼️', tx + thumbW / 2, thumbY + thumbH / 2 + 6);
            }
            if (pm.type === 'video') {
              ctx.fillStyle = 'rgba(0,0,0,0.55)';
              ctx.beginPath(); ctx.arc(tx + thumbW / 2, thumbY + thumbH / 2, 12, 0, Math.PI * 2); ctx.fill();
              ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillText('▶', tx + thumbW / 2 + 1, thumbY + thumbH / 2);
            }
          }
          node._previewBounds = { thumbY, thumbH, pad, maxThumbs, thumbW };
        } else {
          node._previewBounds = null;
          node._runBtnBounds = null; // no longer used — button is in header
        }
        break;
      }
      case 'download': {
        const sc = (_frameConnCache?.byToNode[node.id] || []).length;
        ctx.fillText(`${node.config.quality} · ${sc} stream(s)`, x + w / 2, contentY + 8);
        break;
      }
    }
  }

  // ─── Draw Connections (uses _nodeMap + _frameConnCache for O(1) lookups) ───
  function drawConnections() {
    // Re-use the byToNode cache from _frameConnCache to build download port index (O(1) per conn)
    const downloadIdxCache = {};
    if (_frameConnCache) {
      for (const [nodeId, conns] of Object.entries(_frameConnCache.byToNode)) {
        const tn = _nodeMap[nodeId];
        if (!tn || (tn.type !== 'download' && tn.type !== 'merge_video')) continue;
        downloadIdxCache[nodeId] = { map: {}, count: 0 };
        for (const c of conns) {
          downloadIdxCache[nodeId].map[c.id] = downloadIdxCache[nodeId].count++;
        }
      }
    }

    // Visible world bounds for connection culling
    const _cw = canvas.width / devicePixelRatio;
    const _ch = canvas.height / devicePixelRatio;
    const _vl = -pan.x / zoom, _vt = -pan.y / zoom;
    const _vr = _vl + _cw / zoom, _vb = _vt + _ch / zoom;
    const CONN_PAD = 80; // extra margin for bezier curves that bulge

    for (const conn of connections) {
      const fn = _nodeMap[conn.fromNode];
      const tn = _nodeMap[conn.toNode];
      if (!fn || !tn) continue;
      const fd = NODE_TYPES[fn.type], td = NODE_TYPES[tn.type];
      if (!fd || !td) continue;

      const x1 = fn.x + fd.width;
      const y1 = fn.y + HEADER_HEIGHT + 14 + conn.fromPort * PORT_SPACING;

      let y2;
      if (tn.type === 'download' || tn.type === 'merge_video') {
        const idx = downloadIdxCache[tn.id]?.map[conn.id] ?? 0;
        y2 = tn.y + HEADER_HEIGHT + 14 + idx * PORT_SPACING;
      } else {
        y2 = tn.y + HEADER_HEIGHT + 14 + conn.toPort * PORT_SPACING;
      }
      const x2 = tn.x;

      // Viewport cull: skip if bounding box of wire is entirely off-screen
      const wxMin = Math.min(x1, x2) - CONN_PAD;
      const wxMax = Math.max(x1, x2) + CONN_PAD;
      const wyMin = Math.min(y1, y2) - CONN_PAD;
      const wyMax = Math.max(y1, y2) + CONN_PAD;
      if (wxMax < _vl || wxMin > _vr || wyMax < _vt || wyMin > _vb) continue;

      const fnOutputs = getNodeOutputPorts(fn);
      const fp = fnOutputs[conn.fromPort]; if (!fp) continue;

      const isConnSelected = selectedConnections.has(conn.id);
      const isFlowing = tn.status === 'running';
      if (isConnSelected) {
        drawBezier(x1, y1, x2, y2, '#f87171', isFlowing);
      } else {
        drawBezier(x1, y1, x2, y2, fp.color || '#888', isFlowing);
      }
    }
  }

  function drawTempConnection() {
    if (!connectingFrom || !tempLine) return;
    const fn = nodes.find(n => n.id === connectingFrom.nodeId); if (!fn) return;
    const fd = NODE_TYPES[fn.type]; if (!fd) return;
    let x1, y1;
    if (connectingFrom.portType === 'output') {
      x1 = fn.x + fd.width; y1 = fn.y + HEADER_HEIGHT + 14 + connectingFrom.portIndex * PORT_SPACING;
    } else {
      x1 = fn.x; y1 = fn.y + HEADER_HEIGHT + 14 + connectingFrom.portIndex * PORT_SPACING;
    }
    const x2 = (tempLine.x - pan.x) / zoom, y2 = (tempLine.y - pan.y) / zoom;
    drawBezier(x1, y1, x2, y2, '#8a5cf660');
  }

  function drawBezier(x1, y1, x2, y2, color, isFlowing = false) {
    const dx = Math.abs(x2 - x1) * 0.5;
    const _isInteracting = isPanning || isLassoing || draggingNode || draggingMulti;
    // Main solid core wire
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2); ctx.stroke();
    // Soft outer glow — skip entirely while user is interacting (big perf win with many wires)
    if (!_isInteracting && zoom > 0.5) {
      ctx.strokeStyle = color + '28'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2); ctx.stroke();
    }

    if (isFlowing && !_isInteracting) {
      ctx.save();
      const timeOffset = (performance.now() / 25) % 20;
      ctx.setLineDash([8, 12]);
      ctx.lineDashOffset = -timeOffset;
      ctx.strokeStyle = '#ffffffc0';
      // Use filter instead of shadowBlur (much cheaper on GPU)
      ctx.filter = `drop-shadow(0 0 3px ${color.length === 7 ? color : '#ffffff'})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2); ctx.stroke();
      ctx.filter = 'none';
      ctx.restore();
    }
  }

  // ─── Mouse Events ───
  function toCanvasPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toWorldPos(e) {
    const p = toCanvasPos(e);
    return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
  }

  // ─── Collision Detection ───
  function checkCollision(node, targetX, targetY) {
    if (node.type === 'frame') return false; // Frame không cản đường
    const h = _heightCache[node.id] ?? getNodeHeight(node);
    const w = NODE_TYPES[node.type].width;
    const pad = 15; // Adds a nice buffer zone between nodes

    for (const other of nodes) {
      if (other.id === node.id || other.type === 'frame') continue;

      const oh = _heightCache[other.id] ?? getNodeHeight(other);
      const ow = NODE_TYPES[other.type].width;

      // AABB Collision check
      if (targetX < other.x + ow + pad &&
        targetX + w + pad > other.x &&
        targetY < other.y + oh + pad &&
        targetY + h + pad > other.y) {
        return true; // Collision detected!
      }
    }
    return false;
  }

  function _findExpandBtnAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._expandBtn) continue;
      const b = node._expandBtn;
      if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
        return node;
      }
    }
    return null;
  }

  function _findEmptyUploadBtnAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._emptyUploadBtn) continue;
      const b = node._emptyUploadBtn;
      if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
        return node;
      }
    }
    return null;
  }

  function onMouseDown(e) {
    const wp = toWorldPos(e), cp = toCanvasPos(e);

    // Middle mouse or Alt+left = pan
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanning = true; panStart = { x: cp.x - pan.x, y: cp.y - pan.y };
      canvas.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0) return;

    const port = findPortAt(wp);
    if (port) { connectingFrom = port; tempLine = cp; return; }

    const resizeHit = findResizeHandleAt(wp);
    if (resizeHit) {
      resizingNode = resizeHit.node;
      resizeStart = {
        y: wp.y, x: wp.x,
        h: getNodeHeight(resizeHit.node),
        w: resizeHit.node.config.width || NODE_TYPES[resizeHit.node.type].width,
        nodeX: resizeHit.node.x,
        nodeY: resizeHit.node.y,
        corner: resizeHit.corner
      };
      // Khong hien thi context editor neu resize frame de do vuong víu
      if (resizingNode.type !== 'frame') {
        selectedNode = resizingNode.id;
        showNodeEditor(resizingNode);
      }
      return;
    }

    // ─── Header icon buttons ───
    const hdrHit = _findHeaderBtnAt(wp);
    if (hdrHit) {
      if (hdrHit.btn === 'run' && !hdrHit.bounds.disabled) { runNodeById(hdrHit.nodeId); return; }
      if (hdrHit.btn === 'dl') { downloadNodeMedia(hdrHit.nodeId, null); return; }
      if (hdrHit.btn === 'detail') { showNodeEditor(_nodeMap[hdrHit.nodeId]); return; }
      if (hdrHit.btn === 'upload') { _triggerImageUpload(hdrHit.nodeId); return; }
      if (hdrHit.btn === 'color') {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = _nodeMap[hdrHit.nodeId].config.color || '#a78bfa';

        // Neo input vào vị trí con trỏ chuột để Dialog hệ điều hành xuất hiện đúng chỗ
        inp.style.position = 'fixed'; // fixed to lock coordinates
        inp.style.left = (e.clientX || 0) + 'px';
        inp.style.top = (e.clientY || 0) + 'px';
        inp.style.width = '20px';
        inp.style.height = '20px';
        inp.style.padding = '0';
        inp.style.border = 'none';
        inp.style.opacity = '0.01'; // 0.01 thay vì 0 hoàn toàn để ép Chromium tính toán layout bounding box
        inp.style.zIndex = '999999';
        document.body.appendChild(inp);

        inp.getBoundingClientRect(); // Bắt buộc Chrome tính toán lại layout ngay lập tức trước khi gọi click

        inp.oninput = (ev) => {
          _nodeMap[hdrHit.nodeId].config.color = ev.target.value;
          markDirty();
        };
        // Xóa input rác sau khi hoàn tất hoặc click ra ngoài
        inp.onchange = () => { if (inp.parentElement) inp.remove(); };
        inp.onblur = () => { if (inp.parentElement) inp.remove(); };

        inp.click();
        return;
      }
      return;
    }

    const expHit = _findExpandBtnAt(wp);
    if (expHit) {
      expHit._isExpanded = !expHit._isExpanded;
      expHit.customHeight = null;
      delete _heightCache[expHit.id];
      markDirty();
      return;
    }

    const emptyUpHit = _findEmptyUploadBtnAt(wp);
    if (emptyUpHit) {
      _triggerImageUpload(emptyUpHit.id);
      return;
    }

    // ─── Inline pill buttons (ratio / qty) ───
    const pillHit = _findPillAt(wp);
    if (pillHit) { _showPillDropdown(pillHit); return; }


    const dlHit = findDownloadBtnAt(wp);
    if (dlHit) { downloadNodeMedia(dlHit.nodeId, dlHit.mediaIndex); return; }

    const prevHit = findPreviewThumbAt(wp);
    if (prevHit) {
      selectedNode = prevHit.node.id;
      showNodeEditor(prevHit.node);
      return;
    }

    const node = findNodeAt(wp);
    if (node) {
      if (selectedNodes.has(node.id) && selectedNodes.size > 1) {
        _hideMultiSelectHint();
        draggingMulti = true;
        multiDragOffsets = {};
        for (const id of selectedNodes) {
          const n = _nodeMap[id];
          if (n) multiDragOffsets[id] = { dx: wp.x - n.x, dy: wp.y - n.y };
        }
        canvas.style.cursor = 'move';
      } else {
        if (!e.shiftKey) { selectedNodes.clear(); _hideMultiSelectHint(); }

        let isTextClick = false;
        if (selectedNode === node.id && (node.type === 'prompt' || node.type === 'prompt_list' || node.type === 'gemini_prompt')) {
          const maxPorts = Math.max(getNodeInputPorts(node).length, getNodeOutputPorts(node).length);
          const contentYOff = HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 6;
          if (wp.y > node.y + contentYOff && !window._activeWfbTextarea) {
            const field = node.type === 'gemini_prompt' ? 'promptTemplate' : 'text';
            _spawnInlineTextarea(node, field, e);
            isTextClick = true;
          }
        }

        if (!isTextClick) {
          // --- If clicking a Frame, auto select everything inside it ---
          if (node.type === 'frame') {
            selectedNodes.add(node.id);
            const fw = node.config.width || NODE_TYPES.frame.width;
            const fh = node.config.height || NODE_TYPES.frame.height;
            for (const n of nodes) {
              if (n.id === node.id || n.type === 'frame') continue;
              const nw = NODE_TYPES[n.type].width;
              const nh = getNodeHeight(n);
              if (n.x >= node.x && n.x + nw <= node.x + fw && n.y >= node.y && n.y + nh <= node.y + fh) {
                selectedNodes.add(n.id);
              }
            }
            if (selectedNodes.size > 1) {
              // turn into multi drag immediately
              draggingMulti = true;
              multiDragOffsets = {};
              for (const id of selectedNodes) {
                const n = _nodeMap[id];
                if (n) multiDragOffsets[id] = { dx: wp.x - n.x, dy: wp.y - n.y };
              }
              canvas.style.cursor = 'move';
              markDirty();
              return;
            }
          }

          selectedNode = node.id; draggingNode = node;
          dragOffset = { x: wp.x - node.x, y: wp.y - node.y };
          const idx = nodes.indexOf(node);
          if (idx >= 0) { nodes.splice(idx, 1); nodes.push(node); }
          canvas.style.cursor = 'move';
        }
      }
      markDirty();
    } else {
      // --- Clicked on empty space: start lasso (ẩn hint cũ) ---
      selectedNodes.clear();
      selectedConnections.clear();
      _hideMultiSelectHint(); // ← ẩn hint khi bắt đầu lasso mới
      selectedNode = null; hideNodeEditor();
      isLassoing = true;
      lassoStart = { x: wp.x, y: wp.y };
      lasso = { startX: wp.x, startY: wp.y, endX: wp.x, endY: wp.y };
      canvas.style.cursor = 'crosshair';
      markDirty();
    }
  }

  function findResizeHandleAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.type === 'frame' && node._resizeHandles) {
        for (const corner in node._resizeHandles) {
          const r = node._resizeHandles[corner];
          if (pos.x >= r.x && pos.x <= r.x + r.s && pos.y >= r.y && pos.y <= r.y + r.s) {
            return { node, corner };
          }
        }
      }
      if (node.type !== 'prompt' && node.type !== 'prompt_list') continue;
      const h = _heightCache[node.id] ?? getNodeHeight(node); // use cached height — O(1)
      const w = NODE_TYPES[node.type].width;
      if (pos.x >= node.x + w - 16 && pos.x <= node.x + w && pos.y >= node.y + h - 16 && pos.y <= node.y + h) {
        return { node, corner: 'br' };
      }
    }
    return null;
  }

  function onMouseMove(e) {
    const cp = toCanvasPos(e), wp = toWorldPos(e);
    lastMouseWorldPos = wp;

    if (isPanning) {
      pan.x = cp.x - panStart.x;
      pan.y = cp.y - panStart.y;
      markDirty(); return;
    }

    if (resizingNode) {
      const dx = wp.x - resizeStart.x;
      const dy = wp.y - resizeStart.y;

      if (resizingNode.type === 'frame') {
        let newX = resizeStart.nodeX;
        let newY = resizeStart.nodeY;
        let newW = resizeStart.w;
        let newH = resizeStart.h;
        const corner = resizeStart.corner;

        if (corner === 'br') { newW += dx; newH += dy; }
        else if (corner === 'bl') { newW -= dx; newH += dy; newX += dx; }
        else if (corner === 'tr') { newW += dx; newH -= dy; newY += dy; }
        else if (corner === 'tl') { newW -= dx; newH -= dy; newX += dx; newY += dy; }

        const minW = NODE_TYPES[resizingNode.type].minW || 100;
        const minH = NODE_TYPES[resizingNode.type].minH || 100;

        resizingNode.config.width = Math.max(newW, minW);
        resizingNode.config.height = Math.max(newH, minH);

        if (corner.includes('l')) resizingNode.x = resizeStart.nodeX + (resizeStart.w - resizingNode.config.width);
        if (corner.includes('t')) resizingNode.y = resizeStart.nodeY + (resizeStart.h - resizingNode.config.height);

        canvas.style.cursor = (corner === 'br' || corner === 'tl') ? 'nwse-resize' : 'nesw-resize';
      } else {
        const newH = resizeStart.h + dy;
        resizingNode.customHeight = Math.max(newH, NODE_TYPES[resizingNode.type].minH);
        canvas.style.cursor = 'ns-resize';
      }
      markDirty(); return;
    }

    // Multi-drag: move all selected nodes together
    if (draggingMulti) {
      for (const id of selectedNodes) {
        const n = _nodeMap[id];
        const off = multiDragOffsets[id];
        if (n && off) {
          n.x = Math.round((wp.x - off.dx) / 15) * 15;
          n.y = Math.round((wp.y - off.dy) / 15) * 15;
        }
      }
      canvas.style.cursor = 'move';
      markDirty(); return;
    }

    if (draggingNode) {
      const newX = Math.round((wp.x - dragOffset.x) / 15) * 15;
      const newY = Math.round((wp.y - dragOffset.y) / 15) * 15;
      // Skip if position unchanged (snap grid means many mousemoves are identical)
      if (newX === draggingNode.x && newY === draggingNode.y) { markDirty(); return; }
      // NOTE: Collision detection removed from hot drag path (was O(N) per frame = main lag cause)
      // Nodes can visually overlap while dragging — this is intentional for performance
      draggingNode.x = newX;
      draggingNode.y = newY;
      markDirty(); return;
    }

    // Lasso selection
    if (isLassoing) {
      lasso.endX = wp.x;
      lasso.endY = wp.y;
      // Update selectedNodes live
      const lx = Math.min(lasso.startX, lasso.endX);
      const ly = Math.min(lasso.startY, lasso.endY);
      const lw = Math.abs(lasso.endX - lasso.startX);
      const lh = Math.abs(lasso.endY - lasso.startY);
      selectedNodes.clear();
      for (const node of nodes) {
        const def = NODE_TYPES[node.type]; if (!def) continue;
        const nh = _heightCache[node.id] ?? getNodeHeight(node); // use cached height — O(1)
        // Node intersects lasso rect?
        if (node.x < lx + lw && node.x + def.width > lx &&
          node.y < ly + lh && node.y + nh > ly) {
          selectedNodes.add(node.id);
        }
      }
      // Also select connections whose bezier passes through the lasso rect
      selectedConnections.clear();
      const downloadIdxCacheLasso = {};
      for (let ci = 0; ci < connections.length; ci++) {
        const conn = connections[ci];
        const tn = _nodeMap[conn.toNode];
        if (!tn) continue;
        if (tn.type === 'download' || tn.type === 'merge_video') {
          if (!downloadIdxCacheLasso[tn.id]) downloadIdxCacheLasso[tn.id] = { map: {}, count: 0 };
          downloadIdxCacheLasso[tn.id].map[conn.id] = downloadIdxCacheLasso[tn.id].count++;
        }
      }
      for (const conn of connections) {
        const fn = _nodeMap[conn.fromNode], tn = _nodeMap[conn.toNode];
        if (!fn || !tn) continue;
        const fd = NODE_TYPES[fn.type];
        const x1 = fn.x + fd.width;
        const y1 = fn.y + HEADER_HEIGHT + 14 + conn.fromPort * PORT_SPACING;
        let y2;
        if (tn.type === 'download' || tn.type === 'merge_video') {
          const idx = downloadIdxCacheLasso[tn.id]?.map[conn.id] ?? 0;
          y2 = tn.y + HEADER_HEIGHT + 14 + idx * PORT_SPACING;
        } else {
          y2 = tn.y + HEADER_HEIGHT + 14 + conn.toPort * PORT_SPACING;
        }
        const x2 = tn.x;
        const dx = Math.abs(x2 - x1) * 0.5;
        // Sample points along bezier and check if any falls in lasso rect
        for (let t = 0; t <= 1; t += 0.05) {
          const bx = Math.pow(1 - t, 3) * x1 + 3 * Math.pow(1 - t, 2) * t * (x1 + dx) + 3 * (1 - t) * t * t * (x2 - dx) + Math.pow(t, 3) * x2;
          const by = Math.pow(1 - t, 3) * y1 + 3 * Math.pow(1 - t, 2) * t * y1 + 3 * (1 - t) * t * t * y2 + Math.pow(t, 3) * y2;
          if (bx >= lx && bx <= lx + lw && by >= ly && by <= ly + lh) {
            selectedConnections.add(conn.id); break;
          }
        }
      }
      canvas.style.cursor = 'crosshair';
      markDirty(); return;
    }

    if (connectingFrom) {
      const p = findPortAt(wp);
      if (p && p.nodeId !== connectingFrom.nodeId) {
        if (!canConnect(connectingFrom, p)) {
          connectingFrom = null;
          tempLine = null;
          markDirty();
          return;
        }
      }
      tempLine = cp;
      markDirty();
      return;
    }

    // Throttle cursor hit-testing
    const now = Date.now();
    if (now - _lastCursorCheck < 33) return;
    _lastCursorCheck = now;

    const port = findPortAt(wp);
    if (port) { canvas.style.cursor = 'crosshair'; return; }
    const dlHit = findDownloadBtnAt(wp);
    const prevHit = findPreviewThumbAt(wp);
    const runHit = findRunBtnAt(wp);
    if (dlHit || prevHit || runHit) { canvas.style.cursor = 'pointer'; return; }
    const hovResize = findResizeHandleAt(wp);
    if (hovResize) {
      if (hovResize.corner === 'br' || hovResize.corner === 'tl') canvas.style.cursor = 'nwse-resize';
      else if (hovResize.corner === 'bl' || hovResize.corner === 'tr') canvas.style.cursor = 'nesw-resize';
      else canvas.style.cursor = 'ns-resize';
      return;
    }
    const htmlHover = findNodeAt(wp);
    canvas.style.cursor = htmlHover
      ? (selectedNodes.has(htmlHover.id) && selectedNodes.size > 1 ? 'move' : 'pointer')
      : 'default';
  }

  function onMouseUp(e) {
    if (isPanning) { isPanning = false; canvas.style.cursor = 'default'; return; }
    if (resizingNode) { resizingNode = null; canvas.style.cursor = 'default'; markDirty(); }

    // End lasso
    if (isLassoing) {
      isLassoing = false;
      lasso = null;
      // If only 1 node selected (no connections), treat as single-select
      if (selectedNodes.size === 1 && selectedConnections.size === 0) {
        const onlyId = [...selectedNodes][0];
        const n = _nodeMap[onlyId];
        selectedNode = onlyId;
        if (n) showNodeEditor(n);
        selectedNodes.clear();
      } else if (selectedNodes.size === 0 && selectedConnections.size === 0) {
        selectedNode = null; hideNodeEditor();
      } else if (selectedConnections.size > 0 && selectedNodes.size === 0) {
        // Only connections selected
        selectedNode = null; hideNodeEditor();
        _showMultiSelectHint();
      } else {
        // Keep multi-selection, show count in editor area
        selectedNode = null; hideNodeEditor();
        _showMultiSelectHint();
      }
      canvas.style.cursor = 'default';
      markDirty(); return;
    }

    // End multi-drag: ẩn hint sau khi thả
    if (draggingMulti) {
      draggingMulti = false;
      multiDragOffsets = {};
      canvas.style.cursor = 'default';
      _hideMultiSelectHint(); // ← ẩn hint sau khi hoàn thành kéo
      markDirty(); return;
    }

    if (connectingFrom && tempLine) {
      const wp = toWorldPos(e);
      const port = findPortAt(wp);
      if (port && port.nodeId !== connectingFrom.nodeId) {
        tryConnect(connectingFrom, port);
        connectingFrom = null; tempLine = null;
      } else if (!port) {
        const cp = toCanvasPos(e);
        const cr = canvas.getBoundingClientRect();
        pendingConnect = {
          from: connectingFrom,
          dropWorldX: wp.x, dropWorldY: wp.y,
          dropScreenX: cr.left + cp.x, dropScreenY: cr.top + cp.y
        };
        connectingFrom = null; tempLine = null;
        dialogShowAll = false;
        showConnectDialog(pendingConnect);
        return;
      } else {
        connectingFrom = null; tempLine = null;
      }
    }
    if (draggingNode) {
      draggingNode = null; canvas.style.cursor = 'default';
      _pushUndoSnapshot(); // node drop = committed move
      markDirty();
    }
  }

  // ─── Right-Click Context Menu ───
  function onContextMenu(e) {
    e.preventDefault();
    _hideCtxMenu();
    const wp = toWorldPos(e);
    const node = findNodeAt(wp);
    const screenX = e.clientX, screenY = e.clientY;

    if (node) {
      _showNodeCtxMenu(node, screenX, screenY);
    } else {
      _showCanvasCtxMenu(wp, screenX, screenY);
    }
  }

  function _hideCtxMenu() {
    const m = document.getElementById('wfbCtxMenu');
    if (m) m.remove();
  }

  function _ctxMenuEl(screenX, screenY) {
    const m = document.createElement('div');
    m.id = 'wfbCtxMenu';
    Object.assign(m.style, {
      position: 'fixed', left: screenX + 'px', top: screenY + 'px',
      background: 'rgba(14,14,28,0.97)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '10px', boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
      zIndex: '99999', overflow: 'hidden', minWidth: '200px',
      backdropFilter: 'blur(20px)', fontFamily: 'Inter,sans-serif',
      animation: 'wfbDialogIn 0.12s ease'
    });
    return m;
  }

  function _ctxItem(icon, label, color, onclick, disabled = false) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      padding: '8px 16px', cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex',
      alignItems: 'center', gap: '10px', fontSize: '12px',
      color: disabled ? '#444' : (color || '#e0e0f0'), transition: 'background .1s'
    });
    row.innerHTML = `<span style="font-size:15px;width:18px;text-align:center">${icon}</span>${label}`;
    if (!disabled) {
      row.onmouseenter = () => row.style.background = 'rgba(255,255,255,0.07)';
      row.onmouseleave = () => row.style.background = '';
      row.onclick = () => { _hideCtxMenu(); onclick(); };
    }
    return row;
  }

  function _ctxSep() {
    const s = document.createElement('div');
    s.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:3px 0';
    return s;
  }

  // Context menu on empty canvas space
  function _showCanvasCtxMenu(worldPos, screenX, screenY) {
    const m = _ctxMenuEl(screenX, screenY);

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:7px 16px 5px;font-size:10px;color:#555;font-weight:700;text-transform:uppercase;letter-spacing:.06em';
    hdr.textContent = 'Thêm node';
    m.appendChild(hdr);
    m.appendChild(_ctxSep());

    // Undo/redo row + paste
    m.appendChild(_ctxItem('↩', `Hoàn tác (Ctrl+Z)`, '#a78bfa', () => _undo(), _undoStack.length === 0));
    m.appendChild(_ctxItem('↪', `Làm lại (Ctrl+Y)`, '#a78bfa', () => _redo(), _redoStack.length === 0));
    const hasClip = !!(_clipboard || copiedNodeData);
    const clipLabel = _clipboard ? `Dán ${_clipboard.nodes.length} node (Ctrl+V)` : 'Dán (Ctrl+V)';
    m.appendChild(_ctxItem('📌', clipLabel, '#34d399',
      () => _pasteClipboard(worldPos.x, worldPos.y),
      !hasClip
    ));
    m.appendChild(_ctxSep());

    // Node categories
    const cats = { input: [], generate: [], output: [], util: [] };
    for (const [type, def] of Object.entries(NODE_TYPES)) {
      if (cats[def.category]) cats[def.category].push({ type, def });
    }
    const catLabels = { input: 'Input', generate: 'Generate', output: 'Output', util: 'Utility' };
    for (const [cat, items] of Object.entries(cats)) {
      if (!items.length) continue;
      const catHdr = document.createElement('div');
      catHdr.style.cssText = `padding:5px 16px 3px;font-size:9px;color:${cat === 'generate' ? '#a78bfa' : (cat === 'util' ? '#34d399' : '#555')};font-weight:700;text-transform:uppercase;letter-spacing:.05em`;
      catHdr.textContent = catLabels[cat];
      m.appendChild(catHdr);
      for (const { type, def } of items) {
        m.appendChild(_ctxItem(
          def.label.split(' ')[0],
          def.label.slice(def.label.indexOf(' ') + 1),
          def.color,
          () => {
            const n = addNode(type, worldPos.x, worldPos.y);
            if (n) markDirty();
          }
        ));
      }
    }

    document.body.appendChild(m);
    // Reposition if off screen
    const mr = m.getBoundingClientRect();
    if (mr.right > window.innerWidth) m.style.left = (screenX - mr.width) + 'px';
    if (mr.bottom > window.innerHeight) m.style.top = (screenY - mr.height) + 'px';
    // Only hide when clicking OUTSIDE the menu (not on menu items)
    const _outsideHandler = (ev) => {
      if (!document.getElementById('wfbCtxMenu')?.contains(ev.target)) {
        _hideCtxMenu();
        document.removeEventListener('mousedown', _outsideHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', _outsideHandler), 80);
  }

  // Context menu on a node
  function _showNodeCtxMenu(node, screenX, screenY) {
    const def = NODE_TYPES[node.type];
    const m = _ctxMenuEl(screenX, screenY);

    // Title header
    const hdr = document.createElement('div');
    hdr.style.cssText = `padding:8px 16px 6px;font-size:11px;color:${def.color};font-weight:700;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:6px`;
    hdr.innerHTML = `<span>${def.label.split(' ')[0]}</span><span>${node.customName || def.label.slice(def.label.indexOf(' ') + 1)}</span>`;
    m.appendChild(hdr);

    m.appendChild(_ctxItem('✂️', 'Cắt (Cut)', null, () => {
      // If node is in multi-select, cut all selected; else cut just this one
      const ids = (selectedNodes.size > 1 && selectedNodes.has(node.id))
        ? [...selectedNodes]
        : [node.id];
      _copyNodesToClipboard(ids);
      _pushUndoSnapshot();
      ids.forEach(id => deleteNode(id));
      selectedNodes.clear(); selectedNode = null; hideNodeEditor(); _hideMultiSelectHint();
      if (typeof window.showToast === 'function') window.showToast(`✂️ Đã cắt ${ids.length} node`, 'success');
    }));

    m.appendChild(_ctxItem('📋', `Sao chép (Copy)${selectedNodes.size > 1 && selectedNodes.has(node.id) ? ' ' + selectedNodes.size + ' node' : ''}`, null, () => {
      const ids = (selectedNodes.size > 1 && selectedNodes.has(node.id))
        ? [...selectedNodes]
        : [node.id];
      _copyNodesToClipboard(ids);
      if (typeof window.showToast === 'function') window.showToast(`📋 Đã copy ${ids.length} node`, 'success');
    }));

    m.appendChild(_ctxItem('📌', 'Dán (Paste)', null,
      () => _pasteClipboard(lastMouseWorldPos.x, lastMouseWorldPos.y),
      !_clipboard && !copiedNodeData
    ));

    m.appendChild(_ctxSep());

    m.appendChild(_ctxItem('✏️', 'Đổi tên node', null, () => {
      // Spawn inline renamer near the node header
      const fakeE = { clientX: screenX, clientY: screenY };
      spawnNodeRenamer(node, fakeE);
    }));

    m.appendChild(_ctxItem('↩', 'Hoàn tác (Ctrl+Z)', '#a78bfa', () => _undo(), _undoStack.length === 0));

    m.appendChild(_ctxSep());

    m.appendChild(_ctxItem('🗑️', 'Xóa node', '#f87171', () => {
      _pushUndoSnapshot();
      deleteNode(node.id);
      if (typeof window.showToast === 'function') window.showToast('🗑️ Đã xóa node', 'success');
    }));

    document.body.appendChild(m);
    const mr = m.getBoundingClientRect();
    if (mr.right > window.innerWidth) m.style.left = (screenX - mr.width) + 'px';
    if (mr.bottom > window.innerHeight) m.style.top = (screenY - mr.height) + 'px';
    // Only hide when clicking OUTSIDE the menu (not on menu items)
    const _outsideHandler = (ev) => {
      if (!document.getElementById('wfbCtxMenu')?.contains(ev.target)) {
        _hideCtxMenu();
        document.removeEventListener('mousedown', _outsideHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', _outsideHandler), 80);
  }

  // Show a small floating hint when multiple nodes are selected
  function _showMultiSelectHint() {
    let existing = document.getElementById('wfbMultiHint');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'wfbMultiHint';
      Object.assign(existing.style, {
        position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(138,92,246,0.92)', color: '#fff',
        padding: '7px 18px', borderRadius: '20px', fontSize: '12px',
        fontFamily: 'Inter,sans-serif', fontWeight: '600',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)', pointerEvents: 'none',
        zIndex: '9000', display: 'flex', alignItems: 'center', gap: '8px',
        backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.15)'
      });
      // Attach relative to canvas parent
      const parent = canvasEl?.parentElement;
      if (parent) { parent.style.position = 'relative'; parent.appendChild(existing); }
    }
    const nodeCount = selectedNodes.size;
    const connCount = selectedConnections.size;
    const parts = [];
    if (nodeCount > 0) parts.push(`${nodeCount} node`);
    if (connCount > 0) parts.push(`${connCount} kết nối`);
    existing.innerHTML = `
      <span style="font-size:15px">⬡</span>
      <span>${parts.join(' + ')} được chọn — kéo để di chuyển, <kbd style="background:rgba(255,255,255,0.18);padding:1px 5px;border-radius:4px">Ctrl+C</kbd> copy, <kbd style="background:rgba(255,255,255,0.18);padding:1px 5px;border-radius:4px">Del</kbd> để xóa</span>
    `;
    existing.style.display = 'flex';
    // Auto-hide when selection is cleared
  }

  function _hideMultiSelectHint() {
    const el = document.getElementById('wfbMultiHint');
    if (el) el.style.display = 'none';
  }

  function onWheel(e) {
    e.preventDefault();
    const cp = toCanvasPos(e);
    const d = e.deltaY > 0 ? 0.9 : 1.1;
    const nz = Math.max(0.1, Math.min(3, zoom * d));
    pan.x = cp.x - (cp.x - pan.x) * (nz / zoom);
    pan.y = cp.y - (cp.y - pan.y) * (nz / zoom);
    zoom = nz;
    markDirty();
  }

  function onDblClick(e) {
    const wp = toWorldPos(e);

    const prevHit = findPreviewThumbAt(wp);
    if (prevHit) {
      const pm = prevHit.node.previewMedia[prevHit.mediaIndex];
      if (pm && typeof openLightbox === 'function') openLightbox(pm.url, pm.type);
      return;
    }

    const node = findNodeAt(wp);
    if (node) {
      if (wp.y < node.y + HEADER_HEIGHT) {
        spawnNodeRenamer(node, e); return;
      }
      // ─── Inline editing for text/prompt nodes ───
      if (node.type === 'prompt' || node.type === 'prompt_list') {
        _spawnInlineTextarea(node, 'text', e); return;
      }
      if (node.type === 'gemini_prompt') {
        _spawnInlineTextarea(node, 'promptTemplate', e); return;
      }
      if (node.type === 'upload_image') {
        // Double-click on body → open lightbox if image exists
        if (node.config.imageUrl && typeof openLightbox === 'function') {
          openLightbox(node.config.imageUrl, 'image'); return;
        }
        return; // no action if no image yet
      }
      // Other nodes: do nothing (panel only via ℹ)
      return;
    }
    // Double-click on wire removed — use lasso + Del to delete connections
  }

  // ─── Inline textarea overlay for prompt editing ───
  function _spawnInlineTextarea(node, field, e) {
    node._isEditing = true; // Ẩn text trên canvas
    node._isExpanded = true; // Luôn bung rèm khi bắt đầu gõ
    markDirty();

    const cr = canvas.getBoundingClientRect();
    const def = NODE_TYPES[node.type];

    // Tương quan với yStart vẽ text trong canvas:
    const maxPorts = Math.max(getNodeInputPorts(node).length, getNodeOutputPorts(node).length);
    const contentYOff = HEADER_HEIGHT + 14 + maxPorts * PORT_SPACING + 6;
    const yStartOff = node.type === 'gemini_prompt' ? contentYOff + 18 : contentYOff + 2;

    const sx = cr.left + (node.x + pan.x + 10) * zoom;
    const sy = cr.top + (node.y + pan.y + yStartOff) * zoom;
    const sw = (def.width - 20) * zoom;

    const ta = document.createElement('textarea');
    ta.value = node.config[field] || '';
    ta.placeholder = field === 'promptTemplate' ? 'Nhập mẫu lệnh AI...' : 'Nhập prompt...';

    Object.assign(ta.style, {
      position: 'fixed', left: '0px', top: '0px',
      width: '0px', zIndex: '99998',
      background: 'transparent', color: '#e8e8ff',
      border: 'none', padding: '0', margin: '0',
      font: `${11 * zoom}px Inter,sans-serif`,
      outline: 'none', resize: 'none', lineHeight: `${14 * zoom}px`, // Khớp với spacing vẽ dòng
      boxSizing: 'border-box', overflow: 'hidden',
      wordWrap: 'break-word',
      wordBreak: 'normal',
      whiteSpace: 'pre-wrap'
    });
    document.body.appendChild(ta);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

    window._activeWfbTextarea = ta;
    window._activeWfbNode = node;
    syncInlineEditor();

    // Resize sync width node height 
    const adjustHeight = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';

      // Update data immediately so node height expands natively!
      node.config[field] = ta.value;
      node.customHeight = null; // Huỷ customHeight để node trở về chế độ căn dọc tự động
      delete _heightCache[node.id]; // Force recalculate height next frame
      markDirty();
    };
    ta.addEventListener('input', adjustHeight);
    adjustHeight();

    const save = () => {
      node._isEditing = false;
      node.config[field] = ta.value;
      node.customHeight = null; // Chốt auto height
      delete _heightCache[node.id];
      window._activeWfbTextarea = null;
      window._activeWfbNode = null;
      markDirty(); saveWorkflow();
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    };

    ta.addEventListener('blur', save);
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        node._isEditing = false;
        window._activeWfbTextarea = null;
        window._activeWfbNode = null;
        markDirty();
        if (ta.parentNode) ta.parentNode.removeChild(ta);
      }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        save();
      }
      ev.stopPropagation();
    });
  }

  // ─── Trigger file picker for upload_image nodes ───
  function _triggerImageUpload(nodeId) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*,video/*';
    inp.onchange = ev => WFB.handleNodeImageUpload(nodeId, ev);
    inp.click();
  }

  // ─── Header button hit-test ───
  function _findHeaderBtnAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._headerBtns) continue;
      for (const [btn, bounds] of Object.entries(node._headerBtns)) {
        if (pos.x >= bounds.x && pos.x <= bounds.x + bounds.w &&
          pos.y >= bounds.y && pos.y <= bounds.y + bounds.h) {
          return { nodeId: node.id, btn, bounds };
        }
      }
    }
    return null;
  }

  // ─── Inline pill (ratio/qty/quality) hit-test + dropdown ───
  function _findPillAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._ratioPill && !node._qtyPill && !node._qualPill && !node._modelPill && !node._modePill) continue;
      if (node._ratioPill) {
        const p = node._ratioPill;
        if (pos.x >= p.x && pos.x <= p.x + p.w && pos.y >= p.y && pos.y <= p.y + p.h)
          return { nodeId: node.id, kind: 'ratio', pill: p, node };
      }
      if (node._qtyPill) {
        const p = node._qtyPill;
        if (pos.x >= p.x && pos.x <= p.x + p.w && pos.y >= p.y && pos.y <= p.y + p.h)
          return { nodeId: node.id, kind: 'qty', pill: p, node };
      }
      if (node._qualPill) {
        const p = node._qualPill;
        if (pos.x >= p.x && pos.x <= p.x + p.w && pos.y >= p.y && pos.y <= p.y + p.h)
          return { nodeId: node.id, kind: 'quality', pill: p, node };
      }
      if (node._modelPill) {
        const p = node._modelPill;
        if (pos.x >= p.x && pos.x <= p.x + p.w && pos.y >= p.y && pos.y <= p.y + p.h)
          return { nodeId: node.id, kind: p.isImage ? 'imageModel' : 'videoModel', pill: p, node };
      }
      if (node._modePill) {
        const p = node._modePill;
        if (pos.x >= p.x && pos.x <= p.x + p.w && pos.y >= p.y && pos.y <= p.y + p.h)
          return { nodeId: node.id, kind: 'videoMode', pill: p, node };
      }
    }
    return null;
  }

  function _showPillDropdown({ nodeId, kind, pill, node: nodeRef }) {
    const node = _nodeMap[nodeId]; if (!node) return;
    document.getElementById('wfbPillSel')?.remove();
    const cr = canvas.getBoundingClientRect();
    // Convert world pill position to screen coords correctly
    const sx = cr.left + (pill.x * zoom + pan.x);
    const sy = cr.top + ((pill.y + pill.h) * zoom + pan.y);

    const sel = document.createElement('select');
    sel.id = 'wfbPillSel';
    const borderColor = kind === 'quality' ? 'rgba(52,211,153,0.6)' : kind === 'videoModel' ? 'rgba(249,115,22,0.6)' : kind === 'videoMode' ? 'rgba(56,189,248,0.6)' : 'rgba(138,92,246,0.5)';
    Object.assign(sel.style, {
      position: 'fixed', left: sx + 'px', top: sy + 'px',
      zIndex: '99999', background: 'rgba(14,14,28,0.97)', color: kind === 'videoModel' ? '#fb923c' : kind === 'videoMode' ? '#38bdf8' : '#e8e8ff',
      border: `1px solid ${borderColor}`, borderRadius: '6px',
      padding: '4px', font: '11px Inter,sans-serif', outline: 'none',
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)', cursor: 'pointer'
    });

    if (kind === 'ratio') {
      [['landscape', 'Ngang 16:9'], ['portrait', 'Dọc 9:16'], ['square', 'Vuông 1:1'], ['4_3', '4:3'], ['3_4', '3:4']]
        .forEach(([v, l]) => { const o = new Option(l, v); if (node.config.ratio === v) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { updateNodeConfig(nodeId, 'ratio', sel.value); saveWorkflow(); sel.remove(); markDirty(); };
    } else if (kind === 'qty') {
      [1, 2, 3, 4].forEach(n => { const o = new Option('x' + n, n); if (node.config.quantity === n) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { updateNodeConfig(nodeId, 'quantity', +sel.value); saveWorkflow(); sel.remove(); markDirty(); };
    } else if (kind === 'quality') {
      [['native', 'Gốc'], ['1080p', '1080p'], ['2K', '2K'], ['4K', '4K']]
        .forEach(([v, l]) => { const o = new Option(l, v); if ((node.config.quality || 'native') === v) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { updateNodeConfig(nodeId, 'quality', sel.value); saveWorkflow(); sel.remove(); markDirty(); };
    } else if (kind === 'videoModel') {
      [
        ['veo31_lite', '⚡ Veo 3.1 Lite — Nhanh nhất'],
        ['veo31_lite_lower', '🔽 Veo 3.1 Lite (Ưu tiên thấp)'],
        ['veo31_fast', '🚀 Veo 3.1 Fast — Nhanh'],
        ['veo31_fast_lower', '🔽 Veo 3.1 Fast (Ưu tiên thấp) (leaving 5/10)'],
        ['veo31_quality', '🎯 Veo 3.1 Quality — Chất lượng cao'],
      ].forEach(([v, l]) => {
        const o = new Option(l, v);
        if ((node.config.videoModel || 'veo31_fast_lower') === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => { updateNodeConfig(nodeId, 'videoModel', sel.value); saveWorkflow(); sel.remove(); markDirty(); };
    } else if (kind === 'imageModel') {
      sel.style.color = '#ec4899';
      sel.style.borderColor = 'rgba(236,72,153,0.6)';
      [
        ['nanobanana_2', '🍌 Nano Banana 2'],
        ['nanobanana_pro', '🍌 Nano Banana Pro'],
        ['imagen_4', 'Imagen 3/4'],
      ].forEach(([v, l]) => {
        const o = new Option(l, v);
        if ((node.config.imageModel || 'imagen_4') === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => { updateNodeConfig(nodeId, 'imageModel', sel.value); saveWorkflow(); sel.remove(); markDirty(); };
    } else if (kind === 'videoMode') {
      [
        ['FRAME', 'Khung hình'],
        ['REF', 'Thành phần']
      ].forEach(([v, l]) => {
        const o = new Option(l, v);
        if ((node.config.videoMode || 'FRAME') === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => {
        updateNodeConfig(nodeId, 'videoMode', sel.value);
        // Clear all media references to prevent port dangling or misalignment
        const toRemove = connections.filter(c => c.toNode === nodeId && c.toPort > 0);
        connections = connections.filter(c => !(c.toNode === nodeId && c.toPort > 0));
        if (toRemove.length > 0) {
          _connCacheDirty = true;
          delete _heightCache[nodeId];
          toRemove.forEach(c => delete _heightCache[c.fromNode]);
        }
        saveWorkflow();
        sel.remove();
        markDirty();
      };
    }

    document.body.appendChild(sel);
    sel.focus(); sel.size = sel.options.length;
    // Reposition if off-screen bottom
    const selR = sel.getBoundingClientRect();
    if (selR.bottom > window.innerHeight) sel.style.top = (sy - selR.height - pill.h * zoom) + 'px';
    if (selR.right > window.innerWidth) sel.style.left = (sx - selR.width + pill.w * zoom) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function h(ev) {
      if (!sel.contains(ev.target)) { sel.remove(); document.removeEventListener('mousedown', h); }
    }), 50);
  }

  function spawnNodeRenamer(node, e) {
    const def = NODE_TYPES[node.type];
    const input = document.createElement('input');
    input.type = 'text';
    input.value = node.customName || def.label;
    input.style.position = 'absolute';
    input.style.left = e.clientX + 'px';
    input.style.top = e.clientY + 'px';
    input.style.zIndex = '10000';
    input.style.background = '#1a1a2e';
    input.style.color = '#fff';
    input.style.border = '1px solid ' + def.color;
    input.style.padding = '4px 8px';
    input.style.borderRadius = '4px';
    input.style.outline = 'none';
    input.style.font = '12px Inter, sans-serif';
    document.body.appendChild(input);
    input.focus();
    input.select();
    let isSaved = false;
    const saveAndClose = () => {
      if (isSaved) return; isSaved = true;
      if (input.parentNode) {
        let val = input.value.trim();
        node.customName = val || null;
        document.body.removeChild(input);
        saveWorkflow();
      }
    };

    // Live update the canvas text as the user types
    input.addEventListener('input', ev => {
      node.customName = input.value || null;
      markDirty();
    });

    input.addEventListener('blur', saveAndClose);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') saveAndClose();
      if (ev.key === 'Escape') { isSaved = true; document.body.removeChild(input); }
    });
  }
  // alo dadasdasd
  // ─── Hit Testing ───
  function findConnectionAt(wp) {
    for (let i = connections.length - 1; i >= 0; i--) {
      const conn = connections[i];
      const fn = nodes.find(n => n.id === conn.fromNode);
      const tn = nodes.find(n => n.id === conn.toNode);
      if (!fn || !tn) continue;
      const fd = NODE_TYPES[fn.type];
      const x1 = fn.x + fd.width;
      const y1 = fn.y + HEADER_HEIGHT + 14 + conn.fromPort * PORT_SPACING;
      let y2;
      if (tn.type === 'download') {
        const nodeConns = connections.filter(c => c.toNode === tn.id);
        const idx = nodeConns.indexOf(conn);
        y2 = tn.y + HEADER_HEIGHT + 14 + Math.max(0, idx) * PORT_SPACING;
      } else {
        y2 = tn.y + HEADER_HEIGHT + 14 + conn.toPort * PORT_SPACING;
      }
      const x2 = tn.x;
      const dx = Math.abs(x2 - x1) * 0.5;

      let hit = false;
      for (let t = 0; t <= 1; t += 0.05) {
        const cx = Math.pow(1 - t, 3) * x1 + 3 * Math.pow(1 - t, 2) * t * (x1 + dx) + 3 * (1 - t) * t * t * (x2 - dx) + Math.pow(t, 3) * x2;
        const cy = Math.pow(1 - t, 3) * y1 + 3 * Math.pow(1 - t, 2) * t * y1 + 3 * (1 - t) * t * t * y2 + Math.pow(t, 3) * y2;
        // Bounding distance ~ 12
        if (Math.hypot(wp.x - cx, wp.y - cy) < 12) {
          hit = true;
          break;
        }
      }
      if (hit) return conn;
    }
    return null;
  }
  function findNodeAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i], def = NODE_TYPES[node.type];
      if (!def) continue;

      if (node.type === 'frame') {
        const fw = node.config?.width || def.width;
        // Chiều cao header của frame là 26px (từ drawFrameNode)
        const fh = 26;
        if (pos.x >= node.x && pos.x <= node.x + fw && pos.y >= node.y && pos.y <= node.y + fh) {
          return node;
        }
      } else {
        const h = _heightCache[node.id] ?? getNodeHeight(node); // use cached height — O(1)
        if (pos.x >= node.x && pos.x <= node.x + def.width && pos.y >= node.y && pos.y <= node.y + h) {
          return node;
        }
      }
    }
    return null;
  }

  function findPortAt(pos) {
    for (const node of nodes) {
      const def = NODE_TYPES[node.type]; if (!def) continue;
      const inputs = getNodeInputPorts(node);
      for (let i = 0; i < inputs.length; i++) {
        const px = node.x, py = node.y + HEADER_HEIGHT + 14 + i * PORT_SPACING;
        if (Math.hypot(pos.x - px, pos.y - py) <= PORT_RADIUS + 4)
          return { nodeId: node.id, portType: 'input', portIndex: i };
      }
      const outputs = getNodeOutputPorts(node);
      for (let i = 0; i < outputs.length; i++) {
        const px = node.x + def.width, py = node.y + HEADER_HEIGHT + 14 + i * PORT_SPACING;
        if (Math.hypot(pos.x - px, pos.y - py) <= PORT_RADIUS + 4)
          return { nodeId: node.id, portType: 'output', portIndex: i };
      }
    }
    return null;
  }

  // ─── Utility Drawing ───
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function roundRectTop(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ─── SMART DROP DIALOG ───
  function getDialogTargets(from) {
    const fromNode = nodes.find(n => n.id === from.nodeId);
    if (!fromNode) return { existing: [], creatables: [] };
    const fd = NODE_TYPES[fromNode.type];
    let draggingType;
    if (from.portType === 'output') draggingType = getNodeOutputPorts(fromNode)[from.portIndex]?.type;
    else draggingType = getNodeInputPorts(fromNode)[from.portIndex]?.type;

    const existing = [];
    for (const node of nodes) {
      if (node.id === from.nodeId) continue;
      const def = NODE_TYPES[node.type];
      if (from.portType === 'output') {
        getNodeInputPorts(node).forEach((p, i) => {
          const compat = p.type === 'any' || draggingType === 'any' || p.type === draggingType;
          if (compat) existing.push({ node, portType: 'input', portIndex: i, portName: p.name, color: p.color });
        });
      } else {
        def.outputs.forEach((p, i) => {
          const compat = p.type === 'any' || draggingType === 'any' || p.type === draggingType;
          if (compat) existing.push({ node, portType: 'output', portIndex: i, portName: p.name, color: p.color });
        });
      }
    }

    const creatables = [];
    for (const [type, def] of Object.entries(NODE_TYPES)) {
      const mockNode = { type, id: 'mock' };
      if (from.portType === 'output') {
        const hasCompat = type === 'download' ||
          getNodeInputPorts(mockNode).some(p => p.type === 'any' || draggingType === 'any' || p.type === draggingType);
        if (hasCompat) creatables.push({ type, def });
      } else {
        const outputs = getNodeOutputPorts(n);
        const hasCompat = outputs.some(p => p.type === 'any' || draggingType === 'any' || p.type === draggingType);
        if (hasCompat) creatables.push({ type, def });
      }
    }

    return { existing, creatables, draggingType };
  }


  // ─── Custom UI Confirm Dialog ───
  window.wfbConfirm = function (title, description, confirmText = 'Đồng ý', confirmColor = '#ef4444') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        zIndex: '999999', display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'wfbDialogIn 0.15s ease'
      });
      const dialog = document.createElement('div');
      Object.assign(dialog.style, {
        background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px', padding: '24px', width: '320px',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)', fontFamily: 'Inter, sans-serif',
        textAlign: 'center'
      });
      dialog.innerHTML = `
        <div style="font-size:18px;font-weight:bold;color:#fff;margin-bottom:10px;">${title}</div>
        <div style="font-size:13px;color:#a1a1aa;margin-bottom:24px;line-height:1.5;">${description}</div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="wfbConfirmCancel" style="flex:1;padding:10px;border-radius:8px;border:none;background:rgba(255,255,255,0.1);color:#fff;font-weight:600;cursor:pointer;transition:all 0.2s;">Hủy</button>
          <button id="wfbConfirmOk" style="flex:1;padding:10px;border-radius:8px;border:none;background:${confirmColor};color:#fff;font-weight:600;cursor:pointer;transition:all 0.2s;">${confirmText}</button>
        </div>
      `;
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const btnCancel = document.getElementById('wfbConfirmCancel');
      const btnOk = document.getElementById('wfbConfirmOk');
      btnCancel.onmouseover = () => btnCancel.style.background = 'rgba(255,255,255,0.15)';
      btnCancel.onmouseout = () => btnCancel.style.background = 'rgba(255,255,255,0.1)';
      btnOk.onmouseover = () => btnOk.style.filter = 'brightness(1.2)';
      btnOk.onmouseout = () => btnOk.style.filter = 'brightness(1)';
      btnCancel.onclick = () => { overlay.remove(); resolve(false); };
      btnOk.onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  // Custom input/prompt dialog (replaces window.prompt which is disabled in Electron)
  window.wfbPrompt = function (title, placeholder = '', defaultValue = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        zIndex: '999999', display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'wfbDialogIn 0.15s ease'
      });
      const dialog = document.createElement('div');
      Object.assign(dialog.style, {
        background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px', padding: '24px', width: '320px',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)', fontFamily: 'Inter, sans-serif'
      });
      dialog.innerHTML = `
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:14px;">${title}</div>
        <input id="wfbPromptInput" type="text" value="${defaultValue.replace(/"/g, '&quot;')}" placeholder="${placeholder}"
          style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid rgba(138,92,246,0.5);
          background:rgba(255,255,255,0.06);color:#fff;font-size:13px;outline:none;font-family:inherit;margin-bottom:14px;">
        <div style="display:flex;gap:10px;">
          <button id="wfbPromptCancel" style="flex:1;padding:9px;border-radius:8px;border:none;background:rgba(255,255,255,0.08);color:#fff;font-weight:600;cursor:pointer;">Hủy</button>
          <button id="wfbPromptOk" style="flex:1;padding:9px;border-radius:8px;border:none;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:600;cursor:pointer;">Đổi tên</button>
        </div>
      `;
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const inp = document.getElementById('wfbPromptInput');
      const btnCancel = document.getElementById('wfbPromptCancel');
      const btnOk = document.getElementById('wfbPromptOk');
      inp.focus(); inp.select();
      const done = (val) => { overlay.remove(); resolve(val); };
      btnCancel.onclick = () => done(null);
      btnOk.onclick = () => done(inp.value.trim() || null);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') done(inp.value.trim() || null);
        if (e.key === 'Escape') done(null);
      });
    });
  }

  function showConnectDialog(state) {
    removeConnectDialog();
    const { existing, creatables, draggingType } = getDialogTargets(state.from);
    const fromNode = nodes.find(n => n.id === state.from.nodeId);
    const fd = NODE_TYPES[fromNode?.type];
    let portColor = '#888';
    if (state.from.portType === 'output') portColor = getNodeOutputPorts(fromNode)[state.from.portIndex]?.color || '#888';

    const SHOW_LIMIT = 3;
    const visibleExisting = dialogShowAll ? existing : existing.slice(0, SHOW_LIMIT);
    const hiddenCount = existing.length - visibleExisting.length;

    const d = document.createElement('div');
    d.id = 'wfbConnectDialog';
    Object.assign(d.style, {
      position: 'fixed',
      left: Math.min(state.dropScreenX, window.innerWidth - 260) + 'px',
      top: Math.min(state.dropScreenY - 20, window.innerHeight - 420) + 'px',
      width: '248px',
      background: 'rgba(14,14,28,0.97)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '12px',
      boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
      zIndex: '9999',
      overflow: 'hidden',
      backdropFilter: 'blur(20px)',
      fontFamily: 'Inter,sans-serif',
      animation: 'wfbDialogIn 0.14s ease'
    });

    let html = `
      <div style="padding:9px 14px 6px;font-size:10px;color:#8888a0;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:6px;">
        <span style="color:${portColor};font-size:14px">●</span> Kết nối tới...
      </div>`;

    if (visibleExisting.length > 0) {
      html += `<div style="padding:5px 14px 2px;font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.05em">Nodes hiện có</div>`;
      // Build a counter per type to generate #1, #2... suffix when no custom name
      const _typeCount = {};
      visibleExisting.forEach((t, i) => {
        const tDef = NODE_TYPES[t.node.type];
        _typeCount[t.node.type] = (_typeCount[t.node.type] || 0) + 1;
        // Display name: customName first, fallback to type-label + index
        const displayName = t.node.customName
          ? t.node.customName
          : `${tDef.label.replace(/^\S+\s*/, '')} #${_typeCount[t.node.type]}`;
        const typeIcon = tDef.label.split(' ')[0];
        html += `<div class="wfb-conn-row" onclick="WFB._dc(${i})" style="border-left:3px solid ${tDef.color};padding-left:11px">
          <span style="font-size:14px;opacity:.7">${typeIcon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:#e8e8ff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${displayName}</div>
            <div style="font-size:9px;color:${t.color};margin-top:1px">→ ${t.portName}</div>
          </div>
          <span style="width:7px;height:7px;border-radius:50%;background:${t.color};flex-shrink:0;margin-left:4px"></span>
        </div>`;
      });
      if (hiddenCount > 0) {
        html += `<div class="wfb-conn-row" onclick="WFB._dex()" style="color:#8a5cf6;justify-content:center;font-size:11px;font-weight:600">
          ▾ Xem thêm ${hiddenCount} node khác...
        </div>`;
      }
    }

    if (creatables.length > 0) {
      html += `<div style="padding:5px 14px 2px;font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.05em;border-top:1px solid rgba(255,255,255,0.05)">Tạo node mới</div>`;
      creatables.forEach((ct, i) => {
        html += `<div class="wfb-conn-row" onclick="WFB._dcc(${i})">
          <span style="font-size:15px">${ct.def.label.split(' ')[0]}</span>
          <div style="flex:1">
            <div style="font-size:12px;color:#e0e0f0">${ct.def.label.slice(ct.def.label.indexOf(' ') + 1)}</div>
            <div style="font-size:9px;color:#555">+ Tạo mới</div>
          </div>
          <span style="padding:2px 5px;border-radius:4px;background:${ct.def.color}25;color:${ct.def.color};font-size:9px;font-weight:600">NEW</span>
        </div>`;
      });
    }

    if (existing.length === 0 && creatables.length === 0) {
      html += `<div style="padding:16px;text-align:center;color:#444;font-size:12px">Không có node tương thích</div>`;
    }

    html += '<div style="height:4px"></div>';
    d.innerHTML = html;
    d._ex = existing; d._cr = creatables;
    document.body.appendChild(d);
    setTimeout(() => document.addEventListener('mousedown', _onOutsideDialog, { once: true }), 60);
  }

  function _onOutsideDialog(e) {
    const d = document.getElementById('wfbConnectDialog');
    if (d && !d.contains(e.target)) { removeConnectDialog(); pendingConnect = null; }
  }

  function removeConnectDialog() {
    const d = document.getElementById('wfbConnectDialog');
    if (d) d.remove();
  }

  function _dc(idx) { // dialog connect to existing
    const d = document.getElementById('wfbConnectDialog'); if (!d || !pendingConnect) return;
    const t = d._ex[idx]; if (!t) return;
    const fromPort = pendingConnect.from;
    const toPort = { nodeId: t.node.id, portType: t.portType, portIndex: t.portIndex };
    if (fromPort.portType === 'output' && toPort.portType === 'input') tryConnect(fromPort, toPort);
    else if (fromPort.portType === 'input' && toPort.portType === 'output') tryConnect(toPort, fromPort);
    removeConnectDialog(); pendingConnect = null;
  }

  function _dex() { // expand dialog
    dialogShowAll = true;
    if (pendingConnect) showConnectDialog(pendingConnect);
  }

  function _dcc(idx) { // dialog create new
    const d = document.getElementById('wfbConnectDialog'); if (!d || !pendingConnect) return;
    const ct = d._cr[idx]; if (!ct) return;
    const newNode = addNode(ct.type, pendingConnect.dropWorldX, pendingConnect.dropWorldY);
    if (!newNode) { removeConnectDialog(); pendingConnect = null; return; }
    const from = pendingConnect.from;
    if (from.portType === 'output') {
      const fn = nodes.find(n => n.id === from.nodeId);
      const fd = NODE_TYPES[fn?.type];
      const outputs = getNodeOutputPorts(fn);
      const fpt = outputs[from.portIndex];
      const newIns = getNodeInputPorts(newNode);
      const ci = newIns.findIndex(p => p.type === 'any' || p.type === fpt?.type || fpt?.type === 'any');
      if (ci >= 0) tryConnect(from, { nodeId: newNode.id, portType: 'input', portIndex: ci });
    } else {
      const nd = NODE_TYPES[newNode.type];
      if (getNodeOutputPorts(newNode).length > 0) tryConnect({ nodeId: newNode.id, portType: 'output', portIndex: 0 }, from);
    }
    removeConnectDialog(); pendingConnect = null;
  }


  //Compactor Helper 
  function compactNodeConnections(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    if (node.type === 'generate_image' || node.type === 'generate_video' || node.type === 'gemini_prompt') {
      const dynamicConns = connections
        .filter(c => c.toNode === nodeId && c.toPort > 0)
        .sort((a, b) => a.toPort - b.toPort);

      dynamicConns.forEach((c, idx) => {
        c.toPort = idx + 1; // Re-index starting from 1 (0 is always prompt/text)
      });
    } else if (node.type === 'download' || node.type === 'merge_video') {
      const dynamicConns = connections
        .filter(c => c.toNode === nodeId)
        .sort((a, b) => a.toPort - b.toPort);

      dynamicConns.forEach((c, idx) => {
        c.toPort = idx; // Re-index starting from 0
      });
    }
    // Port indices changed — invalidate caches so next render recalculates correctly
    _connCacheDirty = true;
    delete _heightCache[nodeId];
  }


  function canConnect(p1, p2) {
    if (p1.portType === p2.portType) return false;
    const fp = p1.portType === 'output' ? p1 : p2;
    const tp = p1.portType === 'input' ? p1 : p2;
    const fn = _nodeMap[fp.nodeId];
    const tn = _nodeMap[tp.nodeId];
    if (!fn || !tn) return false;
    const fOutputs = getNodeOutputPorts(fn);
    const fDef = fOutputs[fp.portIndex];
    if (!fDef) return false;
    const tInputs = getNodeInputPorts(tn);
    const tDef = tInputs[tp.portIndex];
    if (!tDef) return false;
    if (tDef.type === 'string' && fDef.type !== 'string') return false;
    if (tDef.type !== 'any' && fDef.type !== 'any' && fDef.type !== tDef.type) return false;
    return true;
  }

  // ─── Core Connect ───
  function tryConnect(p1, p2) {
    if (!canConnect(p1, p2)) return false;
    const fp = p1.portType === 'output' ? p1 : p2;
    const tp = p1.portType === 'input' ? p1 : p2;
    const tn = _nodeMap[tp.nodeId];

    _pushUndoSnapshot();
    if (tn.type !== 'download' && tn.type !== 'merge_video') {
      // Remove existing connection to this port before replacing (also clears height cache)
      const existing = connections.find(c => c.toNode === tp.nodeId && c.toPort === tp.portIndex);
      if (existing) _removeConn(existing.id);
      else connections = connections.filter(c => !(c.toNode === tp.nodeId && c.toPort === tp.portIndex));
    }
    _addConn({
      id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fromNode: fp.nodeId, fromPort: fp.portIndex,
      toNode: tp.nodeId, toPort: tp.portIndex
    });
    compactNodeConnections(tp.nodeId);
    markDirty();
    return true;
  }

  // ─── Node CRUD ───
  function addNode(type, x, y) {
    const def = NODE_TYPES[type]; if (!def) return null;
    const id = 'node_' + (++nodeIdCounter);
    const node = {
      id, type,
      x: x || 100 + nodes.length * 30,
      y: y || 100 + nodes.length * 30,
      config: { ...def.defaults },
      status: null
    };
    if (type === 'download') {
      node.config.directory = localStorage.getItem('wfb_download_dir') || '';
    }
    _pushUndoSnapshot();
    _addNode(node);
    selectedNode = id;
    // Không mở panel chi tiết khi thêm node mới
    markDirty();
    return node;
  }

  function deleteNode(nodeId) {
    const affectedTargets = new Set(
      connections.filter(c => c.fromNode === nodeId).map(c => c.toNode)
    );
    nodes = nodes.filter(n => n.id !== nodeId);
    delete _nodeMap[nodeId];
    delete _heightCache[nodeId];
    connections = connections.filter(c => c.fromNode !== nodeId && c.toNode !== nodeId);
    _connCacheDirty = true;
    // Invalidate height cache for all nodes that lost connections
    affectedTargets.forEach(targetId => { delete _heightCache[targetId]; compactNodeConnections(targetId); });
    if (selectedNode === nodeId) { selectedNode = null; hideNodeEditor(); }
    markDirty();
  }

  // Undo / Redo core
  function _undo() {
    if (!_undoStack.length) {
      if (typeof window.showToast === 'function') window.showToast('Không có gì để hoàn tác', 'warning');
      return;
    }
    // Push current state to redo before reverting
    _redoStack.push({ nodes: JSON.parse(JSON.stringify(nodes)), connections: JSON.parse(JSON.stringify(connections)) });
    _applySnapshot(_undoStack.pop());
    if (typeof window.showToast === 'function') window.showToast('↩ Đã hoàn tác', 'success');
  }

  function _redo() {
    if (!_redoStack.length) {
      if (typeof window.showToast === 'function') window.showToast('Không có gì để làm lại', 'warning');
      return;
    }
    _undoStack.push({ nodes: JSON.parse(JSON.stringify(nodes)), connections: JSON.parse(JSON.stringify(connections)) });
    _applySnapshot(_redoStack.pop());
    if (typeof window.showToast === 'function') window.showToast('↪ Đã làm lại', 'success');
  }

  // ─── Multi-node clipboard ───

  /**
   * Build clipboard from a list of node IDs.
   * Also auto-expands frames: copies all nodes found inside any frame in the list.
   */
  function _copyNodesToClipboard(ids) {
    // Collect all node IDs to copy (expand frames)
    const allIds = new Set(ids);
    for (const id of ids) {
      const n = _nodeMap[id];
      if (n && n.type === 'frame') {
        const fw = n.config?.width || NODE_TYPES.frame.width;
        const fh = n.config?.height || NODE_TYPES.frame.defaults?.height || 400;
        for (const other of nodes) {
          if (other.type === 'frame') continue;
          const ow = NODE_TYPES[other.type]?.width || 240;
          // Use cached height — avoids expensive canvas text measurement
          const oh = _heightCache[other.id] || NODE_TYPES[other.type]?.minH || 100;
          if (other.x >= n.x && other.x + ow <= n.x + fw &&
            other.y >= n.y && other.y + oh <= n.y + fh) {
            allIds.add(other.id);
          }
        }
      }
    }

    // Deep-copy the node data (strip transient render state to keep clipboard small)
    const clipNodes = [];
    let minX = Infinity, minY = Infinity;
    for (const id of allIds) {
      const n = _nodeMap[id];
      if (!n) continue;
      const snap = JSON.parse(JSON.stringify(n));
      // Strip canvas-only transient props that would waste memory
      delete snap._headerBtns; delete snap._ratioPill; delete snap._qtyPill;
      delete snap._qualPill; delete snap._modelPill; delete snap._modePill;
      delete snap._previewBounds; delete snap._runBtnBounds;
      delete snap._expandBtn; delete snap._emptyUploadBtn;
      delete snap._wrappedLines; delete snap._wrappedTextCacheKey;
      clipNodes.push(snap);
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
    }

    // Only keep connections whose BOTH endpoints are in the copied set
    const clipConns = connections
      .filter(c => allIds.has(c.fromNode) && allIds.has(c.toNode))
      .map(c => ({ id: c.id, fromNode: c.fromNode, fromPort: c.fromPort, toNode: c.toNode, toPort: c.toPort }));

    _clipboard = {
      nodes: clipNodes,
      connections: clipConns,
      anchorX: isFinite(minX) ? minX : 0,
      anchorY: isFinite(minY) ? minY : 0
    };
    // Also keep legacy single-node compat
    if (clipNodes.length === 1) {
      copiedNodeData = { type: clipNodes[0].type, config: JSON.parse(JSON.stringify(clipNodes[0].config)), originalId: clipNodes[0].id };
    }
  }

  /**
   * Paste clipboard at world position (pastes relative to where user's mouse is).
   * All node/conn additions are batched — markDirty called only ONCE at the end.
   */
  function _pasteClipboard(targetX, targetY) {
    // Prefer multi-node clipboard; fall back to legacy copiedNodeData
    if (_clipboard && _clipboard.nodes.length > 0) {
      _pushUndoSnapshot();

      const offsetX = targetX - _clipboard.anchorX + 20;
      const offsetY = targetY - _clipboard.anchorY + 20;

      // Map old ID -> new ID
      const idMap = {};
      const newNodes = [];

      // ── Batch: temporarily suppress markDirty inside _addNode ──
      // We achieve this by pushing nodes directly without calling markDirty
      // then calling it once at the end.
      for (const srcNode of _clipboard.nodes) {
        const def = NODE_TYPES[srcNode.type]; if (!def) continue;
        const newId = 'node_' + (++nodeIdCounter);
        idMap[srcNode.id] = newId;

        const newNode = {
          id: newId,
          type: srcNode.type,
          x: srcNode.x + offsetX,
          y: srcNode.y + offsetY,
          config: JSON.parse(JSON.stringify(srcNode.config)),
          status: null,
          previewMedia: [],
          customName: srcNode.customName || null,
          customHeight: srcNode.customHeight || null,
          _isExpanded: srcNode._isExpanded || false
        };
        // Direct push into nodes array + nodeMap (bypass per-node markDirty)
        nodes.push(newNode);
        _nodeMap[newNode.id] = newNode;
        newNodes.push(newNode);
      }

      // Re-create internal connections with new IDs
      for (const srcConn of _clipboard.connections) {
        const newFromId = idMap[srcConn.fromNode];
        const newToId = idMap[srcConn.toNode];
        if (!newFromId || !newToId) continue;
        const newConn = {
          id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          fromNode: newFromId, fromPort: srcConn.fromPort,
          toNode: newToId, toPort: srcConn.toPort
        };
        connections.push(newConn);
        // Invalidate height cache for endpoints (mirrors what _addConn does)
        delete _heightCache[newConn.toNode];
        delete _heightCache[newConn.fromNode];
      }

      // One-shot: mark conn cache dirty + trigger a single render
      _connCacheDirty = true;

      // Select all pasted nodes
      selectedNodes.clear();
      selectedNode = null;
      newNodes.forEach(n => selectedNodes.add(n.id));
      if (newNodes.length === 1) {
        selectedNode = newNodes[0].id;
        showNodeEditor(newNodes[0]);
      } else if (newNodes.length > 1) {
        _showMultiSelectHint();
      }

      markDirty(); // single render call for the entire paste batch
      if (typeof window.showToast === 'function')
        window.showToast(`📌 Đã dán ${newNodes.length} node`, 'success');

      // Auto-deselect after a short delay so the canvas returns to normal render cost
      // (keeping selection briefly lets user see what was pasted, then workspace stays fast)
      if (newNodes.length > 1) {
        setTimeout(() => {
          selectedNodes.clear();
          selectedNode = null;
          _hideMultiSelectHint();
          markDirty();
        }, 1200);
      }

    } else if (copiedNodeData) {
      // Legacy single-node fallback
      // Note: addNode() internally calls _pushUndoSnapshot(), so we skip it here
      const newNode = addNode(copiedNodeData.type, targetX + 20, targetY + 20);
      if (newNode) {
        newNode.config = JSON.parse(JSON.stringify(copiedNodeData.config));
        newNode.status = null;
        newNode.previewMedia = [];
        showNodeEditor(newNode);
        markDirty();
        if (typeof window.showToast === 'function') window.showToast('📌 Đã dán node', 'success');
      }
    }
  }

  // Helper: paste single copiedNodeData at world position (legacy, context-menu)
  function _pasteNode(nx, ny) {
    _pasteClipboard(nx, ny);

  }

  function onKeyDown(e) {
    // Không bắt phím nếu đang gõ text trong input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // Escape: bỏ chọn tất cả
    if (e.key === 'Escape') {
      // Nếu đang xem video full màn hình, để trình duyệt tự thoát ra, không đóng panel chi tiết
      if (document.fullscreenElement) return;

      selectedNodes.clear(); selectedConnections.clear(); selectedNode = null;
      hideNodeEditor(); _hideMultiSelectHint(); markDirty();
      e.preventDefault(); return;
    }

    // Ctrl+A: chọn tất cả node
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      selectedNodes.clear();
      for (const n of nodes) selectedNodes.add(n.id);
      selectedNode = null; hideNodeEditor();
      if (selectedNodes.size > 1) _showMultiSelectHint();
      markDirty();
      e.preventDefault(); return;
    }

    // Phím xóa (Delete hoặc Backspace)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      let deletedCount = 0;
      if (selectedNodes.size > 0 || selectedConnections.size > 0) {
        _pushUndoSnapshot();
        // Delete selected connections first
        if (selectedConnections.size > 0) {
          const connIds = [...selectedConnections];
          connIds.forEach(id => deleteConnection(id));
          deletedCount += connIds.length;
          selectedConnections.clear();
        }
        // Delete selected nodes
        if (selectedNodes.size > 0) {
          const toDelete = [...selectedNodes];
          for (const id of toDelete) deleteNode(id);
          deletedCount += toDelete.length;
          selectedNodes.clear();
        }
        _hideMultiSelectHint();
        if (typeof window.showToast === 'function' && deletedCount > 0)
          window.showToast(`🗑️ Đã xóa ${deletedCount} mục`, 'success');
      } else if (selectedNode) {
        _pushUndoSnapshot();
        deleteNode(selectedNode);
      }
    }

    // Undo (Ctrl+Z)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      _undo(); e.preventDefault(); return;
    }

    // Redo (Ctrl+Y or Ctrl+Shift+Z)
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      _redo(); e.preventDefault(); return;
    }

    // Copy (Ctrl+C hoặc Cmd+C) — hỗ trợ copy nhiều node
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      let ids = [];
      if (selectedNodes.size > 0) {
        ids = [...selectedNodes];
      } else if (selectedNode) {
        ids = [selectedNode];
      }
      if (ids.length > 0) {
        _copyNodesToClipboard(ids);
        const count = _clipboard ? _clipboard.nodes.length : ids.length;
        if (typeof window.showToast === 'function')
          window.showToast(`📋 Đã copy ${count} node${_clipboard && _clipboard.connections.length > 0 ? ' + ' + _clipboard.connections.length + ' kết nối' : ''}`, 'success');
      }
      return;
    }

    // Paste (Ctrl+V hoặc Cmd+V)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      const tx = lastMouseWorldPos ? lastMouseWorldPos.x : 150;
      const ty = lastMouseWorldPos ? lastMouseWorldPos.y : 150;
      _pasteClipboard(tx, ty);
      return;
    }
  }

  function deleteConnection(connId) {
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;
    const targetNodeId = conn.toNode;
    _removeConn(connId); // clears height cache for both endpoints + marks _connCacheDirty
    compactNodeConnections(targetNodeId);
    markDirty();
  }
  // ─── Node Palette ───
  function renderNodePalette() {
    const container = document.getElementById('wfbNodePalette'); if (!container) return;
    const cats = { input: { label: 'Input', items: [] }, generate: { label: 'Generate', items: [] }, output: { label: 'Output', items: [] }, util: { label: 'Công cụ', items: [] } };
    for (const [type, def] of Object.entries(NODE_TYPES)) {
      if (cats[def.category]) cats[def.category].items.push({ type, ...def });
    }
    container.innerHTML = Object.values(cats).map(cat => `
      <div class="wfb-palette-category">
        <div class="wfb-palette-category-label">${cat.label}</div>
        ${cat.items.map(item => `
          <div class="wfb-palette-item" data-type="${item.type}" draggable="true" style="border-left:3px solid ${item.color}">
            <span class="material-symbols-rounded" style="font-size:15px;color:${item.color}">${item.icon}</span>
            <span>${item.label}</span>
          </div>`).join('')}
      </div>`).join('');

    // Dragstart: chỉ gắn lại vì innerHTML được rebuild
    container.querySelectorAll('.wfb-palette-item').forEach(el => {
      el.addEventListener('dragstart', e => {
        e.dataTransfer.setData('nodeType', el.dataset.type);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });

    // Canvas drop listeners: chỉ đăng ký 1 lần duy nhất (tránh duplicate node)
    if (!canvasEl?._paletteDragBound) {
      canvasEl._paletteDragBound = true;
      canvasEl.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      canvasEl.addEventListener('drop', e => {
        e.preventDefault();
        const type = e.dataTransfer.getData('nodeType');
        if (!type || !NODE_TYPES[type]) return; // guard: bỏ qua drop không hợp lệ
        const wp = toWorldPos(e);
        addNode(type, wp.x, wp.y);
      });
    }
  }

  // ─── Node Editor ───
  function showNodeEditor(node) {
    const panel = document.getElementById('wfbNodeEditor'); if (!panel) return;
    const def = NODE_TYPES[node.type]; if (!def) return;
    panel.dataset.readonly = 'true'; // always read-only from ℹ button

    const refCount = (node.type === 'generate_image' || node.type === 'generate_video')
      ? connections.filter(c => c.toNode === node.id && c.toPort > 0).length : 0;
    const streamCount = node.type === 'download' ? connections.filter(c => c.toNode === node.id).length : 0;

    let html = `
      <div class="wfb-editor-header">
        <span class="material-symbols-rounded" style="color:${def.color}">${def.icon}</span>
        <span>${node.customName || def.label}</span>
        <span style="margin-left:auto;font-size:9px;color:#8a5cf6;background:rgba(138,92,246,0.12);padding:2px 7px;border-radius:8px;font-weight:600">CHI TIẾT</span>
      </div>
      <div class="wfb-editor-fields" style="pointer-events:none;opacity:0.85">`;

    switch (node.type) {
      case 'frame': {
        const fw = node.config.width || def.width;
        const fh = node.config.height || def.height;
        const subNodes = [];
        for (const n of nodes) {
          if (n.type === 'frame') continue;
          const nw = NODE_TYPES[n.type].width;
          const nh = getNodeHeight(n);
          if (n.x >= node.x && n.x + nw <= node.x + fw && n.y >= node.y && n.y + nh <= node.y + fh) {
            subNodes.push(n);
          }
        }

        html += `<label class="wfb-field-label">Nodes nằm trong Frame <b>(${subNodes.length})</b></label>`;
        if (subNodes.length === 0) {
          html += `<div style="font-size:11px;color:#888;font-style:italic">Không có node nào. Vui lòng kéo Frame để gom các Node lại.</div>`;
        } else {
          html += `<ul style="margin:5px 0 0 15px;padding:0;color:#d4d4d4;font-size:11px;line-height:1.6">`;
          subNodes.forEach(sn => {
            const label = sn.config.name || NODE_TYPES[sn.type].label;
            html += `<li>${label}</li>`;
          });
          html += `</ul>`;
        }
        break;
      }
      case 'prompt':
        html += `
          <label class="wfb-field-label">Nội dung prompt</label>
          <div style="pointer-events:auto;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:11px;color:#d4d4d4;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;user-select:text">${node.config.text || '(trống)'}</div>`;
        break;

      case 'prompt_list':
        html += `
          <label class="wfb-field-label">Danh sách Prompt (mỗi dòng 1 prompt)</label>
          <div style="pointer-events:auto;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:11px;color:#d4d4d4;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;user-select:text">${node.config.text || '(trống)'}</div>`;
        break;

      case 'gemini_prompt': {
        const promptPreview = node.config.promptTemplate || '(chưa có dữ liệu)';
        const useAdditional = node.config.useAdditionalText || false;
        const additionalText = node.config.additionalText || '';

        // Tính toán style ban đầu cho switch
        const toggleBg = useAdditional ? '#84cc16' : 'rgba(255,255,255,0.1)';
        const toggleTx = useAdditional ? 'translateX(14px)' : 'translateX(0)';

        html += `
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:8px;line-height:1.4;background:rgba(132,204,22,0.1);padding:8px;border-radius:6px;border:1px solid rgba(132,204,22,0.3)">
            🔑 Đang sử dụng <b>Gemini API Key Toàn cục</b>
          </div>
          
          <div style="display:flex;align-items:center;justify-content:space-between;margin:12px 0 8px 0;">
            <label class="wfb-field-label" style="margin:0">Bổ sung lệnh phụ (Hậu tố)</label>
            <label style="position:relative;display:inline-block;width:34px;height:20px;pointer-events:auto;">
              <input type="checkbox" style="opacity:0;width:0;height:0;position:absolute;" 
                     ${useAdditional ? 'checked' : ''} 
                     onchange="
                       WFB.updateNodeConfig('${node.id}', 'useAdditionalText', this.checked); 
                       document.getElementById('gemini_add_text_${node.id}').style.display = this.checked ? 'block' : 'none';
                       // Update CSS trực tiếp khi click
                       this.nextElementSibling.style.backgroundColor = this.checked ? '#84cc16' : 'rgba(255,255,255,0.1)';
                       this.nextElementSibling.firstElementChild.style.transform = this.checked ? 'translateX(14px)' : 'translateX(0)';
                     ">
              <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:${toggleBg};border-radius:20px;transition:.4s;">
                <span style="position:absolute;content:'';height:14px;width:14px;left:3px;bottom:3px;background-color:white;border-radius:50%;transition:.4s;transform:${toggleTx}"></span>
              </span>
            </label>
          </div>
          
          <div id="gemini_add_text_${node.id}" style="display:${useAdditional ? 'block' : 'none'};margin-bottom:12px;">
             <textarea style="pointer-events:auto;width:100%;height:60px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#e8e8ff;font-size:11px;padding:8px;resize:vertical;font-family:Inter,sans-serif;" 
                       onchange="WFB.updateNodeConfig('${node.id}', 'additionalText', this.value)">${additionalText}</textarea>
             <div style="font-size:9.5px;color:#888;margin-top:4px;">Đoạn text này sẽ được tự động nối vào phía sau nội dung được đưa vào Node.</div>
          </div>

          <label class="wfb-field-label">Kết quả (Output)</label>
          <div style="pointer-events:auto;padding:8px 10px;background:rgba(132,204,22,0.06);border:1px solid rgba(132,204,22,0.15);border-radius:6px;font-size:11px;color:#d4d4d4;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;user-select:text">${promptPreview}</div>`;
        break;
      }

      case 'upload_image': {
        const isUpVideo = node.config.imageUrl && (node.config.imageUrl.startsWith('data:video/') || /\.(mp4|webm|mov)(\?|$)/i.test(node.config.imageUrl));
        let mediaHtml = '';
        if (node.config.imageUrl) {
          mediaHtml = isUpVideo ?
            `<video src="${node.config.imageUrl}" controls style="pointer-events:auto;width:100%;height:130px;object-fit:contain;border-radius:6px;display:block;background:#050505" onmouseup="event.stopPropagation()"></video>` :
            `<img src="${node.config.imageUrl}" style="pointer-events:auto;width:100%;height:130px;object-fit:cover;border-radius:6px;display:block;" onerror="this.style.display='none'">`;
        } else {
          mediaHtml = `<span class="material-symbols-rounded" style="font-size:28px;color:var(--text-muted)">add_photo_alternate</span>
                       <span style="font-size:11px;color:var(--text-muted)">Click để chọn media</span>`;
        }

        html += `
          <label class="wfb-field-label">File Media</label>
          <div class="wfb-upload-zone" onclick="if(event.target.tagName !== 'VIDEO') document.getElementById('wfbUpl_${node.id}').click()" style="pointer-events:auto;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
            ${mediaHtml}
            ${node.config.imagePath ? `<div style="font-size:9px;color:#666;margin-top:2px;word-break:break-all">${node.config.imagePath.split(/[\\/]/).pop()}</div>` : ''}
          </div>
          <input type="file" id="wfbUpl_${node.id}" class="file-input-hidden" accept="image/*,video/*"
            onchange="WFB.handleNodeImageUpload('${node.id}', event)">`;
        break;
      }

      case 'generate_image': {
        const ratioLabelImg = { landscape: 'Ngang 16:9', portrait: 'Dọc 9:16', square: 'Vuông 1:1', '4_3': '4:3', '3_4': '3:4' }[node.config.ratio] || node.config.ratio;
        const IMAGE_MODELS = [
          { value: 'nanobanana_2', label: '🍌 Nano Banana 2' },
          { value: 'nanobanana_pro', label: '🍌 Nano Banana Pro' },
          { value: 'imagen_4', label: 'Imagen 3/4' },
        ];
        const curImgModel = node.config.imageModel || 'imagen_4';
        html += `
          <label class="wfb-field-label">Tỷ lệ</label>
          <div class="wfb-field-value">${ratioLabelImg}</div>
          <label class="wfb-field-label">Số lượng</label>
          <div class="wfb-field-value">x${node.config.quantity}</div>
          <label class="wfb-field-label">Chất lượng tải về</label>
          <div class="wfb-field-value">${node.config.quality || '1080p'}</div>
          
          <label class="wfb-field-label" style="margin-top:8px;display:flex;align-items:center;gap:5px">
            <span style="font-size:14px">🖼️</span> AI Model tạo ảnh
          </label>
          <select class="wfb-field-select"
            style="background:rgba(236,72,153,0.08);border-color:rgba(236,72,153,0.3);color:#ec4899;font-weight:600"
            onchange="WFB.updateNodeConfig('${node.id}','imageModel',this.value)">
            ${IMAGE_MODELS.map(m => `<option value="${m.value}" ${curImgModel === m.value ? 'selected' : ''}>${m.label}</option>`).join('')}
          </select>
          <div style="font-size:9.5px;color:#888;margin-top:2px;line-height:1.4">⚡ Ghi đè cài đặt AI Model bên tab Prompt</div>

          <div style="margin-top:6px;padding:6px 8px;background:rgba(236,72,153,0.08);border-radius:6px;font-size:10px;color:${refCount ? '#ec4899' : '#666'}">
            📎 ${refCount}/${MAX_IMG_REFS} reference image đang kết nối
          </div>
          ${_buildPreviewHtml(node)}`;
        break;
      }

      case 'generate_video': {
        const ratioLabelVid = { landscape: 'Ngang 16:9', portrait: 'Dọc 9:16' }[node.config.ratio] || node.config.ratio;
        const VIDEO_MODELS = [
          { value: 'veo31_lite', label: 'Veo 3.1 — Lite', tag: 'Nhẹ nhất' },
          { value: 'veo31_lite_lower', label: 'Veo 3.1 — Lite Low Pri', tag: 'Ưu tiên thấp' },
          { value: 'veo31_fast', label: 'Veo 3.1 — Fast', tag: 'Nhanh' },
          { value: 'veo31_fast_lower', label: 'Veo 3.1 — Fast Low (5/10)', tag: 'Ưu tiên thấp' },
          { value: 'veo31_quality', label: 'Veo 3.1 — Quality', tag: 'Chất lượng cao' },
        ];
        const curModel = node.config.videoModel || 'veo31_fast_lower';
        html += `
          <label class="wfb-field-label">Tỷ lệ</label>
          <div class="wfb-field-value">${ratioLabelVid}</div>
          <label class="wfb-field-label">Số lượng</label>
          <div class="wfb-field-value">x${node.config.quantity}</div>
          <label class="wfb-field-label">Chất lượng tải về</label>
          <div class="wfb-field-value">${node.config.quality || '1080p'}</div>
          <label class="wfb-field-label" style="margin-top:8px;display:flex;align-items:center;gap:5px">
            <span style="font-size:14px">🤖</span> AI Model tạo video
          </label>
          <select class="wfb-field-select"
            style="background:rgba(249,115,22,0.08);border-color:rgba(249,115,22,0.3);color:#fb923c;font-weight:600"
            onchange="WFB.updateNodeConfig('${node.id}','videoModel',this.value)">
            ${VIDEO_MODELS.map(m => `<option value="${m.value}" ${curModel === m.value ? 'selected' : ''}>${m.label} — ${m.tag}</option>`).join('')}
          </select>
          <div style="font-size:9.5px;color:#888;margin-top:2px;line-height:1.4">⚡ Ghi đè cài đặt AI Model bên tab Prompt</div>
          <div style="margin-top:8px;padding:6px 8px;background:rgba(249,115,22,0.08);border-radius:6px;font-size:10px;color:${refCount ? '#f97316' : '#666'}">
            📎 ${refCount}/2 khung hình (Start/End) đang kết nối
          </div>
          ${_buildPreviewHtml(node)}`;
        break;
      }

      case 'merge_video': {
        const inputCount = connections.filter(c => c.toNode === node.id).length;
        html += `
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:8px;line-height:1.4">Đang cắm <b style="color:#10b981">${inputCount}</b> video để ghép nối. VEO3 sẽ chạy ghép tự động và tạo ra 1 video duy nhất.</div>
          ${_buildPreviewHtml(node)}`;
        break;
      }

      case 'download':
        html += `
          <label class="wfb-field-label">Chất lượng ✨</label>
          <select class="wfb-field-select" onchange="WFB.updateNodeConfig('${node.id}','quality',this.value)">
            ${['native', '1080p', '2K', '4K'].map(q => `<option value="${q}" ${node.config.quality === q ? 'selected' : ''}>${q === 'native' ? 'Gốc (không upscale)' : q}</option>`).join('')}
          </select>
          <div style="font-size:9.5px;color:#666;margin-top:3px;line-height:1.4">⚡ FFmpeg Lanczos upscale sau khi tải về</div>
          <label class="wfb-field-label">Thư mục lưu</label>
          <div style="display:flex;gap:5px;align-items:center">
            <input class="wfb-field-input" id="wfbDlDir_${node.id}" value="${node.config.directory || ''}"
              placeholder="D:\\downloads\\veo3" style="flex:1"
              onchange="WFB.updateNodeConfig('${node.id}','directory',this.value);localStorage.setItem('wfb_download_dir',this.value)">
            <button onclick="WFB._pickDir('${node.id}')" title="Chọn thư mục"
              style="padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#ccc;cursor:pointer;flex-shrink:0">
              <span class="material-symbols-rounded" style="font-size:16px">folder_open</span>
            </button>
          </div>
          <div style="margin-top:8px;padding:7px 10px;background:rgba(52,211,153,0.07);border:1px solid rgba(52,211,153,0.18);border-radius:8px">
            <div style="font-size:11px;color:#34d399;font-weight:600">📥 ${streamCount} stream(s) đang kết nối</div>
            <div style="font-size:9px;color:#555;margin-top:1px">Download tuần tự theo thứ tự kết nối</div>
          </div>`;
        break;
    }

    html += '</div>';
    panel.innerHTML = html;

    // Nếu panel đang bị ẩn, khi mở lên phải resize canvas để nhường chỗ
    if (panel.style.display !== 'block') {
      panel.style.display = 'block';
      if (typeof resizeCanvas === 'function') setTimeout(() => { resizeCanvas(); markDirty(); }, 10);
    }
  }

  async function _pickDir(nodeId) {
    try {
      const res = await fetch('/api/select-folder');
      const data = await res.json();
      if (data.success && data.path) {
        updateNodeConfig(nodeId, 'directory', data.path);
        localStorage.setItem('wfb_download_dir', data.path);
        const input = document.getElementById(`wfbDlDir_${nodeId}`);
        if (input) input.value = data.path;
        if (typeof showToast === 'function') showToast('📁 Đã chọn: ' + data.path, 'success');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Lỗi chọn thư mục: ' + e.message, 'error');
    }
  }

  function hideNodeEditor() {
    const p = document.getElementById('wfbNodeEditor');
    if (p && p.style.display !== 'none') {
      if (document.fullscreenElement && p.contains(document.fullscreenElement)) {
        try { document.exitFullscreen(); } catch (e) { }
      }
      p.style.display = 'none';
      p.innerHTML = ''; // dọn sạch video tránh lỗi tiếp tục phát ngầm
      if (typeof resizeCanvas === 'function') setTimeout(() => { resizeCanvas(); markDirty(); }, 10);
    }
  }

  function updateNodeConfig(nodeId, key, value) {
    const node = _nodeMap[nodeId];
    if (node) {
      node.config[key] = value;
      delete _heightCache[nodeId];
    }
    markDirty();
  }

  async function handleNodeImageUpload(nodeId, event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const fd = new FormData(); fd.append('image', file);
      const res = await fetch('/api/upload-reference', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.success) {
        updateNodeConfig(nodeId, 'imagePath', data.path);
        updateNodeConfig(nodeId, 'imageUrl', data.url);
        // Preload image, then force redraw once it's loaded so node updates immediately
        const img = new Image();
        img.onload = () => {
          imgCache[data.url] = img; // populate cache so canvas draws it right away
          markDirty();
        };
        img.src = data.url;
        markDirty(); // redraw now (shows loading state / resizes node)
        if (typeof showToast === 'function') showToast('✅ Upload thành công', 'success');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Lỗi upload: ' + e.message, 'error');
    }
  }

  // ─── Workflow Save/Load ───
  function getWorkflowJSON() {
    if (!currentWorkflowId) currentWorkflowId = 'wf_' + Date.now();
    const wfNodes = nodes.map(n => {
      const copy = JSON.parse(JSON.stringify(n));
      // ⚠️ Never persist transient runtime state to disk.
      // If we save 'running', a reload after crash will show stuck spinners.
      copy.status = null;
      copy._runBtnBounds = undefined;
      copy._previewBounds = undefined;
      copy._headerBtns = undefined;
      if (copy.type === 'gemini_prompt' && !copy.config.apiKey) {
        if (typeof window !== 'undefined' && window.getGeminiApiKey) {
          copy.config.apiKey = window.getGeminiApiKey();
        }
      }
      return copy;
    });
    return {
      id: currentWorkflowId,
      name: currentWorkflowName, version: 2,
      createdAt: new Date().toISOString(),
      nodes: wfNodes,
      connections: connections.map(c => ({ ...c })),
      viewport: { pan: { ...pan }, zoom }
    };
  }

  function loadWorkflowJSON(data) {
    nodes = (data.nodes || []).map(n => ({
      ...n,
      // ⚠️ Always reset transient runtime state on load.
      // If the app was killed/crashed while nodes were 'running',
      // they must restart as idle — not frozen with the spinner stuck.
      status: null,
      // Don't restore previewMedia from crashed-run nodes (stale URLs)
      // previewMedia IS kept if previously saved cleanly (status was null when saved)
      previewMedia: n.status === 'running' ? [] : (n.previewMedia || [])
    }));
    connections = (data.connections || []).map(c => ({ ...c }));
    currentWorkflowId = data.id || null;
    currentWorkflowName = data.name || 'Untitled';
    if (data.viewport) { pan = data.viewport.pan || { x: 0, y: 0 }; zoom = data.viewport.zoom || 1; }
    nodeIdCounter = 0;
    nodes.forEach(n => { const num = parseInt(n.id.replace('node_', '')); if (num > nodeIdCounter) nodeIdCounter = num; });
    _rebuildNodeMap();
    _connCacheDirty = true;
    Object.keys(_heightCache).forEach(k => delete _heightCache[k]);
    _checkSpinActive(); // update spinner — should be inactive since all status=null
    setWfbButtons('idle'); // always reset toolbar to idle state on load
    markDirty();
    selectedNode = null; hideNodeEditor();
    updateWorkflowNameUI(); renderWorkflowList();
  }

  async function saveWorkflow(silent = false) {
    const name = document.getElementById('wfbWorkflowName')?.value || currentWorkflowName;
    currentWorkflowName = name;
    const wf = getWorkflowJSON(); currentWorkflowId = wf.id;
    try {
      const res = await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wf) });
      const data = await res.json();
      if (data.success) { if (!silent && typeof showToast === 'function') showToast(`💾 Đã lưu: ${name}`, 'success'); loadWorkflowsFromStorage(); }
    } catch (e) {
      const list = JSON.parse(localStorage.getItem('wfb_workflows') || '[]');
      const idx = list.findIndex(w => w.id === wf.id);
      if (idx >= 0) list[idx] = wf; else list.push(wf);
      localStorage.setItem('wfb_workflows', JSON.stringify(list));
      if (!silent && typeof showToast === 'function') showToast(`💾 Đã lưu (local): ${name}`, 'success');
      loadWorkflowsFromStorage();
    }
  }

  async function loadWorkflowsFromStorage() {
    try {
      const res = await fetch('/api/workflows');
      const data = await res.json();
      if (data.success) savedWorkflows = data.workflows || [];
    } catch (e) {
      savedWorkflows = JSON.parse(localStorage.getItem('wfb_workflows') || '[]');
    }
    renderWorkflowList();
    const lastId = localStorage.getItem('wfb_last_active');
    if (lastId && !currentWorkflowId) {
      await loadWorkflow(lastId);
    }
  }

  async function loadWorkflow(id) {
    try {
      const res = await fetch(`/api/workflows/${id}`); const data = await res.json();
      if (data.success && data.workflow) {
        loadWorkflowJSON(data.workflow);
        localStorage.setItem('wfb_last_active', id);
        if (typeof showToast === 'function') showToast(`📂 Đã mở: ${data.workflow.name}`, 'success'); return;
      }
    } catch (e) { /* fallback */ }
    const list = JSON.parse(localStorage.getItem('wfb_workflows') || '[]');
    const wf = list.find(w => w.id === id);
    if (wf) {
      loadWorkflowJSON(wf);
      localStorage.setItem('wfb_last_active', id); // ← ADD
      if (typeof showToast === 'function') showToast(`📂 Đã mở: ${wf.name}`, 'success');
    }
  }

  async function skipCurrentTask() {
    const confirmed = await window.wfbConfirm(
      'Hủy tác vụ hiện tại?',
      'Bạn có chắc muốn hủy tác vụ ĐANG CHẠY? (Các tác vụ đang chờ phía sau vẫn sẽ tiếp tục)',
      'Hủy tác vụ',
      '#f97316' // Màu cam cảnh báo
    );

    if (!confirmed) return;

    fetch('/api/skip-current', { method: 'POST' });
  }


  async function removeQueueItem(index) {
    const confirmed = await window.wfbConfirm(
      'Xóa khỏi hàng đợi?',
      'Tác vụ này sẽ bị xóa khỏi danh sách chờ và không được thực thi.',
      'Xóa',
      '#ef4444'
    );
    if (!confirmed) return;

    fetch('/api/remove-queue-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
  }

  async function deleteWorkflow(id) {
    const confirmed = await wfbConfirm(
      'Xóa Workflow?',
      'Bạn có chắc chắn muốn xóa workflow này không? Thao tác này không thể hoàn tác.',
      'Xóa',
      '#ef4444'
    );
    if (!confirmed) return;

    try { await fetch(`/api/workflows/${id}`, { method: 'DELETE' }); } catch (e) { /* ignore */ }
    const list = JSON.parse(localStorage.getItem('wfb_workflows') || '[]');
    localStorage.setItem('wfb_workflows', JSON.stringify(list.filter(w => w.id !== id)));
    if (currentWorkflowId === id) newWorkflow();
    loadWorkflowsFromStorage();
    if (typeof showToast === 'function') showToast('🗑️ Đã xóa workflow', 'success');
  }

  function newWorkflow() {
    nodes = []; connections = []; selectedNode = null;
    _nodeMap = {};
    currentWorkflowId = null; currentWorkflowName = 'Untitled Workflow';
    pan = { x: 0, y: 0 }; zoom = 1;
    markDirty();
    hideNodeEditor(); updateWorkflowNameUI();
  }

  function exportWorkflow() {
    const wf = getWorkflowJSON();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' }));
    a.download = `${currentWorkflowName.replace(/\s+/g, '_')}.json`; a.click();
  }

  function importWorkflow() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = ev => {
        try { const d = JSON.parse(ev.target.result); loadWorkflowJSON(d); if (typeof showToast === 'function') showToast(`📥 Imported: ${d.name}`, 'success'); }
        catch (err) { if (typeof showToast === 'function') showToast('Lỗi import: ' + err.message, 'error'); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function renderWorkflowList() {
    const c = document.getElementById('wfbWorkflowList'); if (!c) return;
    if (!savedWorkflows.length) { c.innerHTML = '<div class="wfb-empty-list">Chưa có workflow nào</div>'; return; }
    c.innerHTML = savedWorkflows.map(wf => `
      <div class="wfb-wf-item ${wf.id === currentWorkflowId ? 'active' : ''}" onclick="WFB.loadWorkflow('${wf.id}')">
        <div class="wfb-wf-item-name">${wf.name || 'Untitled'}</div>
        <div class="wfb-wf-item-meta">${wf.nodes?.length || 0} nodes</div>
        <button class="wfb-wf-item-delete" onclick="event.stopPropagation();WFB.deleteWorkflow('${wf.id}')" title="Xóa">
          <span class="material-symbols-rounded" style="font-size:13px">close</span>
        </button>
      </div>`).join('');
  }

  function updateWorkflowNameUI() {
    const el = document.getElementById('wfbWorkflowName'); if (el) el.value = currentWorkflowName;
  }

  // Quan ly hien thi cac nut Run / Pause / Stop
  function setWfbButtons(state) {
    // state: 'idle' | 'running' | 'paused'
    const btnRun = document.getElementById('wfbBtnRun');
    const btnPause = document.getElementById('wfbBtnPause');
    const btnStop = document.getElementById('wfbBtnStop');
    const lblPause = document.getElementById('wfbBtnPauseLabel');
    if (!btnRun) return;
    if (state === 'idle') {
      btnRun.style.display = '';
      btnPause.style.display = 'none';
      btnStop.style.display = 'none';
    } else if (state === 'running') {
      btnRun.style.display = 'none';
      btnPause.style.display = 'inline-flex';
      btnStop.style.display = 'inline-flex';
      btnPause.removeAttribute('disabled');
      btnStop.removeAttribute('disabled');
      if (lblPause) lblPause.textContent = 'Tạm dừng';
      btnPause.querySelector('.material-symbols-rounded').textContent = 'pause';
    } else if (state === 'paused') {
      btnRun.style.display = 'none';
      btnPause.style.display = 'inline-flex';
      btnStop.style.display = 'inline-flex';
      btnPause.removeAttribute('disabled');
      btnStop.removeAttribute('disabled');
      if (lblPause) lblPause.textContent = 'Tiếp tục';
      btnPause.querySelector('.material-symbols-rounded').textContent = 'play_arrow';
    }
  }

  async function runWorkflow() {
    if (!nodes.length) { if (typeof showToast === 'function') showToast('Chưa có node nào!', 'warning'); return; }
    try {
      const res = await fetch('/api/run-workflow-builder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: getWorkflowJSON() })
      });
      const data = await res.json();
      if (data.success) {
        clearNodeStatuses();
        setWfbButtons('running');
        if (typeof showToast === 'function') showToast('🚀 Đang chạy workflow...', 'success');
      } else {
        if (typeof showToast === 'function') showToast('Lỗi: ' + data.error, 'error');
      }
    } catch (e) { if (typeof showToast === 'function') showToast('Lỗi: ' + e.message, 'error'); }
  }

  let _wfbIsPaused = false;
  async function pauseWorkflow() {
    try {
      if (!_wfbIsPaused) {
        await fetch('/api/workflow-builder-pause', { method: 'POST' });
        _wfbIsPaused = true;
        setWfbButtons('paused');
        if (typeof showToast === 'function') showToast('⏸️ Đã tạm dừng workflow', 'warning');
      } else {
        await fetch('/api/workflow-builder-resume', { method: 'POST' });
        _wfbIsPaused = false;
        setWfbButtons('running');
        if (typeof showToast === 'function') showToast('▶️ Đang tiếp tục workflow...', 'success');
      }
    } catch (e) { if (typeof showToast === 'function') showToast('Lỗi: ' + e.message, 'error'); }
  }

  async function stopWorkflow() {
    const confirmed = await wfbConfirm(
      'Dừng hệ thống?',
      'Bạn có chắc chắn muốn dừng toàn bộ tiến trình đang chạy và làm sạch hàng đợi không?',
      'Dừng ngay',
      '#ef4444'
    );
    if (!confirmed) return;

    try {
      await fetch('/api/workflow-builder-stop', { method: 'POST' });
    } catch (e) { /* ignore network error — still reset UI */ }

    // Always reset node states immediately — don't leave spinner stuck
    _wfbIsPaused = false;
    clearNodeStatuses(); // resets all status=null, stops spin loop
    setWfbButtons('idle');
    if (typeof showToast === 'function') showToast('⏹️ Đã dừng workflow', 'error');
  }

  function updateNodeStatus(nodeId, status) {
    const n = _nodeMap[nodeId];
    if (n) {
      n.status = status;
      if (status === 'running') n.runStartTime = Date.now();
      else n.runStartTime = null;
      _checkSpinActive();
      // Force immediate repaint — don't wait for dirty-flag cycle
      if (ctx) { _dirty = false; render(); }
    }
  }
  function clearNodeStatuses() {
    nodes.forEach(n => { n.status = null; n.runStartTime = null; n._runBtnBounds = null; });
    _checkSpinActive();
    markDirty();
  }
  function resetAllStatus() {
    nodes.forEach(n => { n.status = null; n.runStartTime = null; n.previewMedia = null; n._previewBounds = null; n._runBtnBounds = null; delete _heightCache[n.id]; });
    _checkSpinActive();
    markDirty();
  }
  function setNodePreview(nodeId, media) {
    const n = _nodeMap[nodeId];
    if (n) {
      n.previewMedia = media.map(m => ({
        url: m.url,
        type: m.type || 'image'
      }));
      delete _heightCache[nodeId];
      n.status = 'done'; // stop spinner as soon as media arrives
      _checkSpinActive();
      // Preload all media into imgCache so canvas draws immediately
      n.previewMedia.forEach(pm => getCachedImg(pm.url, pm.type));
      // Force immediate repaint — don't wait for dirty-flag cycle
      if (ctx) { _dirty = false; render(); }
    }
  }

  // ─── Hit Test: Download Button & Preview Thumb ───
  function findDownloadBtnAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._previewBounds || !node.previewMedia) continue;
      const { thumbY, thumbH, pad, maxThumbs, thumbW } = node._previewBounds;
      const dlBtnY = thumbY + thumbH + 3;
      const dlBtnH = 18;
      for (let ti = 0; ti < maxThumbs; ti++) {
        const tx = node.x + pad + ti * (thumbW + 4);
        if (pos.x >= tx && pos.x <= tx + thumbW && pos.y >= dlBtnY && pos.y <= dlBtnY + dlBtnH) {
          return { nodeId: node.id, mediaIndex: ti };
        }
      }
    }
    return null;
  }

  function findPreviewThumbAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._previewBounds || !node.previewMedia) continue;
      const { thumbY, thumbH, pad, maxThumbs, thumbW } = node._previewBounds;
      for (let ti = 0; ti < maxThumbs; ti++) {
        const tx = node.x + pad + ti * (thumbW + 4);
        if (pos.x >= tx && pos.x <= tx + thumbW && pos.y >= thumbY && pos.y <= thumbY + thumbH) {
          return { node, mediaIndex: ti };
        }
      }
    }
    return null;
  }

  // ─── Hit Test: Run Button on generate nodes ───
  function findRunBtnAt(pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (!node._runBtnBounds) continue;
      const { x, y, w, h, disabled } = node._runBtnBounds;
      if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) {
        if (disabled) {
          if (typeof showToast === 'function') showToast('Cần kết nối điểm [prompt] trước khi chạy node này!', 'warning');
          return null;
        }
        return node.id;
      }
    }
    return null;
  }

  // ─── Download media from a node ───
  async function downloadNodeMedia(nodeId, mediaIndex) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || !node.previewMedia) return;
    const items = mediaIndex != null ? [node.previewMedia[mediaIndex]] : node.previewMedia;

    // Lấy chất lượng từ node config (generate nodes có quality, download node cũng có)
    const quality = node.config?.quality || 'native';
    const qualLabel = quality === 'native' ? 'Gốc' : quality;

    for (let i = 0; i < items.length; i++) {
      const pm = items[i];
      if (!pm || !pm.url) continue;
      const ext = pm.type === 'video' ? 'mp4' : 'png';
      const filename = `veo3_wf_${nodeId}_${mediaIndex != null ? mediaIndex : i}_${Date.now()}.${ext}`;
      try {
        if (typeof showToast === 'function') showToast(`⏬ Đang tải ${filename} [${qualLabel}]...`, 'info');
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: pm.url,
            filename,
            quality,
            mediaType: pm.type || 'image',
            editLink: pm.editLink || null
          })
        });
        const data = await res.json();
        if (data.success) {
          if (typeof showToast === 'function') showToast(`✅ Đã tải: ${data.filename}${quality !== 'native' ? ` [${quality}]` : ''}`, 'success');
        } else {
          if (typeof showToast === 'function') showToast(`Lỗi: ${data.error}`, 'error');
        }
      } catch (e) {
        if (typeof showToast === 'function') showToast(`Lỗi tải: ${e.message}`, 'error');
      }
    }
  }


  // ─── Build preview HTML for sidebar editor ───
  function _buildPreviewHtml(node) {
    if (!node.previewMedia || node.previewMedia.length === 0) return '';
    let html = `
      <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px">
        <label class="wfb-field-label" style="display:flex;align-items:center;gap:4px">
          <span class="material-symbols-rounded" style="font-size:14px;color:#34d399">preview</span>
          Kết quả (${node.previewMedia.length})
        </label>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;margin-top:4px">`;
    node.previewMedia.forEach((pm, i) => {
      const imgSrc = pm.url;
      const isVideo = pm.type === 'video';
      html += `
        <div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)">
           <div style="cursor:pointer;height:70px;display:flex;align-items:center;justify-content:center" title="Nhấp đúp (Double-click) để xem" ondblclick="if(typeof openLightbox==='function')openLightbox('${imgSrc.substring(0, 200).replace(/'/g, "\\'")}','${pm.type}')">            ${isVideo
          ? `<span class="material-symbols-rounded" style="font-size:28px;color:#f97316">play_circle</span>`
          : `<img src="${imgSrc}" style="width:100%;height:100%;object-fit:contain;display:block" onerror="this.outerHTML='<span class=\\'material-symbols-rounded\\' style=\\'font-size:28px;color:#ec4899\\'>image</span>'">`
        }
          </div>
          <button onclick="WFB.downloadNodeMedia('${node.id}',${i})" title="Tải về"
            style="width:100%;padding:4px 0;border:none;border-top:1px solid rgba(255,255,255,0.06);background:rgba(52,211,153,0.08);color:#34d399;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:3px;font-family:Inter,sans-serif;pointer-events:auto">
            <span class="material-symbols-rounded" style="font-size:13px">download</span> Tải về
          </button>
        </div>`;
    });
    html += `
        </div>`;
    if (node.previewMedia.length > 1) {
      html += `
        <button onclick="WFB.downloadNodeMedia('${node.id}')" 
          style="margin-top:6px;width:100%;padding:6px;border:1px solid rgba(52,211,153,0.3);border-radius:6px;background:rgba(52,211,153,0.08);color:#34d399;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;font-family:Inter,sans-serif;font-weight:600;pointer-events:auto">
          <span class="material-symbols-rounded" style="font-size:15px">download</span> Tải tất cả (${node.previewMedia.length})
        </button>`;
    }
    html += `
      </div>`;
    return html;
  }

  // ─── Run single node ───
  async function runNodeById(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    // ─── RUN FRAME (PARTIAL WORKFLOW) ───
    if (node.type === 'frame') {
      const fw = node.config.width || NODE_TYPES.frame.width;
      const fh = node.config.height || NODE_TYPES.frame.height;
      const subNodes = [];
      for (const n of nodes) {
        if (n.type === 'frame') continue;
        const nw = NODE_TYPES[n.type].width;
        const nh = getNodeHeight(n);
        if (n.x >= node.x && n.x + nw <= node.x + fw && n.y >= node.y && n.y + nh <= node.y + fh) {
          subNodes.push(JSON.parse(JSON.stringify(n)));
        }
      }
      if (subNodes.length === 0) {
        if (typeof showToast === 'function') showToast('Không có node nào để chạy trong Frame!', 'warning');
        return;
      }

      const originalSubNodeIds = new Set(subNodes.map(n => n.id));
      const subNodeIds = new Set(originalSubNodeIds);

      // Bắt mọi connection có điểm đến (toNode) nằm trong frame, để đón dữ liệu từ frame khác (nếu có)
      const subConns = connections.filter(c => subNodeIds.has(c.toNode));

      let missingDependency = false;
      let missingNodeNames = [];
      const addedExternalNodes = new Set(); // Tránh trùng lặp (A)

      // Inject các node cha (nguồn) từ bên ngoài Frame vào luồng phụ, đánh dấu _isContextNode để backend đọc dữ liệu
      subConns.forEach(c => {
        if (!originalSubNodeIds.has(c.fromNode)) {
          if (!addedExternalNodes.has(c.fromNode)) {
            const externalNode = nodes.find(n => n.id === c.fromNode);
            if (externalNode) {
              const liveNode = nodes.find(ln => ln.id === c.fromNode);

              // Kiểm tra Dependency (B)
              const isMediaNode = ['generate_image', 'generate_video', 'merge_video'].includes(externalNode.type);
              if (isMediaNode && (!liveNode || !liveNode.previewMedia || liveNode.previewMedia.length === 0)) {
                missingDependency = true;
                missingNodeNames.push(externalNode.config?.name || externalNode.type);
              } else {
                const clonedNode = JSON.parse(JSON.stringify(externalNode));
                clonedNode._isContextNode = true; // Flag báo hiệu cho automation.js
                // Mượn nguyên khối log data hiện tại
                if (liveNode && liveNode.previewMedia) clonedNode.previewMedia = liveNode.previewMedia;

                subNodes.push(clonedNode);
                addedExternalNodes.add(c.fromNode);
                subNodeIds.add(c.fromNode);
              }
            }
          }
        }
      });

      if (missingDependency) {
        if (typeof showToast === 'function') {
          showToast(`⏳ Lỗi: Các node nguồn nằm ngoài Frame chưa có dữ liệu (${missingNodeNames.join(', ')}). Vui lòng chạy các node này trước!`, 'warning');
        }
        return;
      }

      if (typeof showToast === 'function') showToast(`▶ Đang chạy luồng trong [${node.customName || node.config.name || 'Frame'}]...`, 'info');
      setWfbButtons('running');

      subNodes.forEach(n => {
        const localNode = nodes.find(ln => ln.id === n.id);
        if (localNode && localNode.previewMedia) n.previewMedia = localNode.previewMedia;
      });

      try {
        const res = await fetch('/api/run-workflow-builder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workflow: {
              name: `Frame: ${node.customName || node.config.name || 'Local'}`,
              nodes: subNodes,
              connections: subConns
            }
          })
        });
        const data = await res.json();
        if (!data.success) {
          if (typeof showToast === 'function') showToast('Lỗi: ' + data.error, 'error');
          setWfbButtons('idle');
        }
      } catch (e) {
        if (typeof showToast === 'function') showToast('Lỗi: ' + e.message, 'error');
        setWfbButtons('idle');
      }
      return;
    }

    if (!['generate_image', 'generate_video', 'download', 'merge_video', 'gemini_prompt'].includes(node.type)) {
      if (typeof showToast === 'function') showToast('Chỉ hỗ trợ chạy node Generate, Download, Merge Video hoặc Gemini', 'warning');
      return;
    }
    try {
      if (typeof showToast === 'function') showToast(`▶ Đang chạy ${node.type}...`, 'info');
      setWfbButtons('running');
      const wf = getWorkflowJSON();
      // Gửi previewMedia của các node cha nếu có
      wf.nodes.forEach(n => {
        const localNode = nodes.find(ln => ln.id === n.id);
        if (localNode && localNode.previewMedia) n.previewMedia = localNode.previewMedia;
      });
      const res = await fetch('/api/run-single-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: wf, nodeId })
      });
      const data = await res.json();
      if (!data.success) {
        if (typeof showToast === 'function') showToast('Lỗi: ' + data.error, 'error');
        setWfbButtons('idle');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Lỗi: ' + e.message, 'error');
      setWfbButtons('idle');
    }
  }

  function updateNodeConfigFromSocket(nodeId, newConfig) {
    const n = _nodeMap[nodeId];
    if (!n) return;
    Object.assign(n.config, newConfig);
    markDirty();
    if (selectedNode === n.id) showNodeEditor(n);
  }

  // ─── Public API ───
  return {
    init, addNode, deleteNode, deleteConnection,
    updateNodeConfig, handleNodeImageUpload,
    saveWorkflow, loadWorkflow, deleteWorkflow,
    newWorkflow, exportWorkflow, importWorkflow, runWorkflow,
    pauseWorkflow, stopWorkflow, setWfbButtons,
    updateNodeStatus, clearNodeStatuses, resetAllStatus, setNodePreview,
    downloadNodeMedia, runNodeById, updateNodeConfigFromSocket,
    getWorkflowJSON, loadWorkflowJSON,
    skipCurrentTask, removeQueueItem,
    _dc, _dcc, _dex, _pickDir
  };
})();
