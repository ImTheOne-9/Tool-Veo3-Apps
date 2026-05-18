// === VEO3 Flow Automation - Frontend App ===

// State
let prompts = [];
let currentMode = 'image'; // image | video | image_from_image | video_from_image | video_from_frames
let imagePaths = { refs: [], start: null, end: null }; // refs: mảng ảnh tham chiếu (image_from_image)
let settings = {
  ratio: 'landscape',
  quantity: 2,
  projectUrl: '',
  delayBetween: 5000,
  waitForGeneration: 300000,
  downloadQuality: '2K',
  videoModel: 'veo31_fast_lower'
};
let isConnected = false;
let isRunning = false;
let isPaused = false;
let stats = { completed: 0, pending: 0, errors: 0 };

// Socket.IO
const socket = io();

// ─── IPC: Force Update từ Electron main process (updater.js) ─────────────────
// Khi GitHub Releases có bản mới + đã tải xong → updater.js gửi 'update:force'
// → overlay đỏ block toàn bộ UI, bắt buộc nhấn "Cài đặt ngay" → quitAndInstall
(function initForceUpdateIPC() {
  try {
    const { ipcRenderer } = require('electron');

    // Khi PHÁT HIỆN bản mới: hiện toast nhỏ ngay lập tức
    ipcRenderer.on('update:available', (_event, data) => {
      _showUpdateToast(`🔄 Đang tải bản mới v${data.version}...`, 'info', 0); // 0 = không tự ẩn
    });

    // Cập nhật tiến trình tải về trong toast
    ipcRenderer.on('update:progress', (_event, data) => {
      _showUpdateToast(`⬇ Đang tải bản mới: ${data.percent}% (${data.bytesPerSecond})`, 'info', 0);
    });

    // Khi ĐÃ TẢI XONG: ẩn toast + hiện blocking overlay
    ipcRenderer.on('update:force', (_event, data) => {
      _hideUpdateToast();
      const overlay = document.getElementById('forceUpdateOverlay');
      const verText = document.getElementById('forceUpdateVersionText');
      const noteText = document.getElementById('forceUpdateNote');

      if (verText) verText.textContent =
        `Hiện tại: v${data.current_version}  →  Bản mới: v${data.latest_version}`;
      if (noteText && data.update_note)
        noteText.textContent = data.update_note;

      if (overlay) {
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden'; // ngăn scroll
      }
      console.warn('[Force Update] 🔴 Update đã tải xong — tool bị khóa cho đến khi cài đặt.');
    });
  } catch (e) {
    // Không phải môi trường Electron — bỏ qua
  }
})();

// ─── Toast nhỏ thông báo đang tải update ─────────────────────────────────────
function _showUpdateToast(msg, type = 'info', duration = 4000) {
  let toast = document.getElementById('_updateToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_updateToast';
    toast.style.cssText = `
      position:fixed; bottom:20px; right:20px; z-index:99998;
      background:#1e1e3a; border:1px solid #8b5cf6; border-radius:12px;
      padding:12px 16px; color:white; font-size:13px; font-family:'Inter',sans-serif;
      display:flex; align-items:center; gap:8px; max-width:320px;
      box-shadow:0 8px 32px rgba(0,0,0,0.4); backdrop-filter:blur(8px);
      transition:opacity 0.3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.display = 'flex';
  if (toast._hideTimer) clearTimeout(toast._hideTimer);
  if (duration > 0) {
    toast._hideTimer = setTimeout(() => _hideUpdateToast(), duration);
  }
}
function _hideUpdateToast() {
  const toast = document.getElementById('_updateToast');
  if (toast) toast.style.display = 'none';
}

/** Gọi khi user nhấn "Cài Đặt Ngay" trong force overlay — dùng electron-updater quitAndInstall */
function doForceUpdate() {
  const btn = document.getElementById('btnForceUpdate');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.6s linear infinite;display:inline-block"></div> Đang khởi động lại...';
  }
  const noteEl = document.getElementById('forceUpdateNote');
  if (noteEl) noteEl.textContent = '⏳ Đang áp dụng cập nhật, ứng dụng sẽ tự khởi động lại...';

  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update:install'); // → updater.js → autoUpdater.quitAndInstall()
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

// ════════ LẮNG NGHE BỘ ĐẾM WORKFLOW ════════
function switchStoreTab(viewId, btnElement) {
  // Update buttons
  const buttons = btnElement.parentElement.querySelectorAll('.store-filter-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  btnElement.classList.add('active');

  // Update views
  const views = document.querySelectorAll('.store-view-content');
  views.forEach(v => v.style.display = 'none');

  const targetView = document.getElementById('store-view-' + viewId);
  if (targetView) {
    targetView.style.display = 'block';
  }

  // Load data for category view if needed
  if (viewId !== 'all') {
    _loadStoreCategoryView(viewId);
  }
}

// ════════════════════════════════════════════════
// ═══════ STORE MODULE ════════════════════════
// ════════════════════════════════════════════════

// State
let _storeProducts = [];
let _storeSearchTimer = null;
let _storeCurrentOrderId = null;
let _storePollTimer = null;
let _storePollCount = 0;
let _storePaymentInfo = null; // cache từ /api/auth/payment-info
const STORE_POLL_INTERVAL = 8000;
const STORE_POLL_MAX = 75; // 10 phút

/**
 * Gọi khi user mở tab Store lần đầu.
 * Được gọi từ switchTab() trong app.js
 */
async function loadStoreProducts() {
  // Hiển thị loading
  const loadEl = document.getElementById('storeLoadingAll');
  const errEl = document.getElementById('storeErrorAll');
  const secFree = document.getElementById('storeSectionFree');
  const secPaid = document.getElementById('storeSectionPaid');
  const emptyEl = document.getElementById('storeEmptyAll');
  if (loadEl) loadEl.style.display = 'block';
  if (errEl) errEl.style.display = 'none';
  if (secFree) secFree.style.display = 'none';
  if (secPaid) secPaid.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'none';

  try {
    const res = await fetch('/api/veo3/store/products');
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Lỗi server');

    _storeProducts = data.products || [];
    _renderStoreAll(_storeProducts);

    // Tải đơn hàng trong sidebar
    _loadStoreOrders();

    // Cache payment info nếu chưa có
    if (!_storePaymentInfo) {
      fetch('/api/auth/payment-info').then(r => r.json()).then(d => {
        if (d.success) _storePaymentInfo = d;
      }).catch(() => { });
    }

  } catch (e) {
    if (loadEl) loadEl.style.display = 'none';
    if (errEl) {
      errEl.style.display = 'block';
      const msgEl = document.getElementById('storeErrorMsg');
      if (msgEl) msgEl.textContent = e.message || 'Không thể tải sản phẩm';
    }
    console.error('[Store] loadStoreProducts error:', e.message);
  }
}

const STORE_PAGE_SIZE = 8;

// Pagination state per grid key
const _storePagination = {}; // { key: { page, total, items } }

/**
 * Render tất cả sản phẩm vào view "all" - có phân trang
 */
function _renderStoreAll(products, searchTerm = '') {
  const loadEl = document.getElementById('storeLoadingAll');
  const emptyEl = document.getElementById('storeEmptyAll');

  if (loadEl) loadEl.style.display = 'none';

  const filtered = searchTerm
    ? products.filter(p =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchTerm.toLowerCase())
    )
    : products;

  if (filtered.length === 0) {
    _hideAllStoreSections();
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  // Nhóm 1: Prompt Free (category = freeprompts hoặc price_type = free)
  const freepromptItems = filtered.filter(p =>
    p.category === 'freeprompts' || p.price_type === 'free' || p.price === 0
  );

  // Nhóm 2: Chatbot (category = chatbot)
  const chatbotItems = filtered.filter(p =>
    p.category === 'chatbot' && !(p.price_type === 'free' || p.price === 0)
  );

  // Nhóm 3: Sản phẩm có phí còn lại (không phải freeprompts, không phải chatbot free)
  const paidItems = filtered.filter(p =>
    p.price > 0 && p.price_type !== 'free' && p.category !== 'chatbot'
  );

  _renderSectionGroup('storeSectionFree', 'storeGridFree', freepromptItems, 'free-all',
    '🎁 Prompt Free', '#34d399', 'redeem');

  _renderSectionGroup('storeSectionChatbotAll', 'storeGridChatbotAll', chatbotItems, 'chatbot-all',
    '🤖 Chatbot', '#60a5fa', 'smart_toy');

  _renderSectionGroup('storeSectionPaid', 'storeGridPaid', paidItems, 'paid-all',
    '⚡ Cao cấp', '#fbbf24', 'bolt');
}

/** Helper: render một nhóm section, tự tạo nếu chưa có trong DOM */
function _renderSectionGroup(sectionId, gridId, items, pageKey, label, color, icon) {
  let secEl = document.getElementById(sectionId);
  let gridEl = document.getElementById(gridId);

  // Nếu element chưa tồn tại, tự tạo và append vào store-view-all
  if (!secEl) {
    const container = document.getElementById('store-view-all');
    if (!container) return;
    secEl = document.createElement('div');
    secEl.id = sectionId;
    secEl.style.cssText = 'display:none; margin-bottom:30px;';
    secEl.innerHTML = `
      <h2 style="font-size:16px; font-weight:600; margin-bottom:14px; display:flex; align-items:center; gap:8px; color:${color};">
        <span class="material-symbols-rounded" style="color:${color};">${icon}</span> ${label}
        <span id="${sectionId}_count" style="font-size:12px; font-weight:400; color:#64748b; margin-left:4px;"></span>
      </h2>
      <div id="${gridId}" class="store-grid"></div>`;
    // Insert before storeEmptyAll if it exists
    const emptyEl = document.getElementById('storeEmptyAll');
    if (emptyEl) container.insertBefore(secEl, emptyEl);
    else container.appendChild(secEl);
    gridEl = document.getElementById(gridId);
  }

  if (items.length === 0) {
    secEl.style.display = 'none';
    // Xóa pagination cũ
    const oldPg = document.getElementById(`pg_${pageKey}`);
    if (oldPg) oldPg.remove();
    return;
  }

  secEl.style.display = 'block';

  // Cập nhật label count
  const countEl = document.getElementById(`${sectionId}_count`);
  if (countEl) countEl.textContent = `(${items.length})`;

  _renderGridPaged(gridEl, items, pageKey);
}

function _hideAllStoreSections() {
  ['storeSectionFree', 'storeSectionChatbotAll', 'storeSectionPaid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}


/**
 * Render grid với true pagination (số trang), 8 items/trang
 * @param {HTMLElement} gridEl
 * @param {Array} items
 * @param {string} key - unique key để track state
 */
function _renderGridPaged(gridEl, items, key) {
  if (!gridEl) return;
  _storePagination[key] = { page: 1, items };
  _renderGridPage(gridEl, key);
}

function _renderGridPage(gridEl, key) {
  if (!gridEl) return;
  const state = _storePagination[key];
  if (!state) return;

  const { page, items } = state;
  const totalPages = Math.ceil(items.length / STORE_PAGE_SIZE);
  const start = (page - 1) * STORE_PAGE_SIZE;
  const pageItems = items.slice(start, start + STORE_PAGE_SIZE);

  // Render cards
  const tmp = document.createElement('div');
  tmp.innerHTML = pageItems.map(_renderProductCard).join('');
  const frag = document.createDocumentFragment();
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  gridEl.innerHTML = '';
  gridEl.style.display = 'grid';
  gridEl.appendChild(frag);

  // Xóa TẤT CẢ pg_* bars ngay sau gridEl (tránh duplicate từ all-view và tab-view)
  let _pgSibling = gridEl.nextElementSibling;
  while (_pgSibling && _pgSibling.id && _pgSibling.id.startsWith('pg_')) {
    const _next = _pgSibling.nextElementSibling;
    _pgSibling.remove();
    _pgSibling = _next;
  }

  if (totalPages <= 1) return;

  // Tạo pagination bar
  const bar = document.createElement('div');
  bar.id = `pg_${key}`;
  bar.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;padding:16px 0 4px;flex-wrap:wrap;';

  // Prev
  const prev = _mkPageBtn(page <= 1, () => { state.page--; _renderGridPage(gridEl, key); },
    '<span class="material-symbols-rounded" style="font-size:16px;">chevron_left</span>');
  bar.appendChild(prev);

  // Page numbers
  for (let i = 1; i <= totalPages; i++) {
    const pageNum = i; // capture để tránh closure bug
    const active = pageNum === page;
    const btn = _mkPageBtn(false, () => { state.page = pageNum; _renderGridPage(gridEl, key); },
      String(pageNum), active);
    if (active) btn.style.cssText = 'width:32px;height:32px;border-radius:6px;border:1px solid #8b5cf6;background:rgba(139,92,246,0.2);color:#a78bfa;font-weight:700;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;';
    bar.appendChild(btn);
  }

  // Next
  const next = _mkPageBtn(page >= totalPages, () => { state.page++; _renderGridPage(gridEl, key); },
    '<span class="material-symbols-rounded" style="font-size:16px;">chevron_right</span>');
  bar.appendChild(next);

  gridEl.after(bar);
}

function _mkPageBtn(disabled, onClick, html, active = false) {
  const btn = document.createElement('button');
  btn.disabled = disabled;
  btn.innerHTML = html;
  btn.style.cssText = `width:32px;height:32px;border-radius:6px;border:1px solid ${disabled ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)'};background:${active ? 'rgba(139,92,246,0.2)' : 'transparent'};color:${disabled ? '#334155' : active ? '#a78bfa' : '#94a3b8'};cursor:${disabled ? 'not-allowed' : 'pointer'};font-size:13px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;`;
  if (!disabled) {
    btn.onmouseover = () => { if (!active) btn.style.background = 'rgba(139,92,246,0.1)'; };
    btn.onmouseout = () => { if (!active) btn.style.background = 'transparent'; };
    btn.onclick = onClick;
  }
  return btn;
}

/**
 * Render danh sách theo category (workflow, chatbot, freeprompts)
 */
async function _loadStoreCategoryView(cat) {
  const catMap = { workflow: 'workflow', chatbot: 'chatbot', freeprompts: 'freeprompts' };
  const gridId = `storeGrid${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
  const loadId = `storeLoading${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
  const emptyId = `storeEmpty${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
  const gridEl = document.getElementById(gridId);
  const loadEl = document.getElementById(loadId);
  const emptyEl = document.getElementById(emptyId);

  if (!gridEl) return;

  if (loadEl) loadEl.style.display = 'block';
  if (gridEl) gridEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'none';

  try {
    // Dùng cached nếu đã load rồi
    const catKey = catMap[cat] || cat;
    const filtered = _storeProducts.length
      ? _storeProducts.filter(p => p.category === catKey)
      : null;

    if (filtered === null) {
      // Cần fetch lần đầu
      const res = await fetch(`/api/veo3/store/products?category=${catKey}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const items = data.products || [];
      _renderCategoryGrid(items, gridEl, loadEl, emptyEl);
    } else {
      _renderCategoryGrid(filtered, gridEl, loadEl, emptyEl);
    }
  } catch (e) {
    if (loadEl) loadEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
  }
}

function _renderCategoryGrid(items, gridEl, loadEl, emptyEl) {
  if (loadEl) loadEl.style.display = 'none';
  if (items.length === 0) {
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }
  _renderGridPaged(gridEl, items, gridEl.id);
}


/**
 * Strip HTML tags và decode entities từ chuỗi (description từ Supabase thường chứa HTML)
 */
function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<br\s*\/?>/gi, ' ')       // <br> → space
    .replace(/<[^>]+>/g, '')             // xóa tất cả tags
    .replace(/&nbsp;/gi, ' ')            // &nbsp; → space
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}

/**
 * Render một product card HTML
 */
function _renderProductCard(p) {
  const isFree = p.price === 0 || p.price_type === 'free';
  const isPurchased = p.purchased;
  const iconMap = {
    workflow: 'account_tree',
    chatbot: 'smart_toy',
    freeprompts: 'notes',
    prompt: 'notes',
    template: 'description'
  };
  const colorMap = {
    workflow: '#a78bfa',
    chatbot: '#60a5fa',
    freeprompts: '#34d399',
    prompt: '#34d399',
    template: '#fbbf24'
  };
  const icon = iconMap[p.category] || 'widgets';
  const color = colorMap[p.category] || '#8b5cf6';
  const priceLabel = isFree ? `<span class="store-price free">Miễn phí</span>` :
    `<span class="store-price">${Number(p.price).toLocaleString('vi-VN')}đ</span>`;

  // Thumb: ảnh thật nếu có, ngược lại icon
  // object-position: top center — tránh cắt phần đầu của ảnh người/sản phẩm
  const thumbHtml = p.thumbnail
    ? `<img src="${escapeHtml(p.thumbnail)}" class="store-thumb-img" style="width:100%;height:100%;object-fit:cover;object-position:top center;border-radius:12px 12px 0 0;" onerror="this.parentElement.innerHTML='<span class=\\'material-symbols-rounded\\' style=\\'font-size:48px;color:${color};\\'>widgets</span>';" loading="lazy">
       ${!isFree ? '<span class="store-badge-pro">PRO</span>' : ''}
       ${isPurchased ? '<span class="store-badge-pro" style="background:rgba(52,211,153,0.8);color:#fff;">✓</span>' : ''}`
    : `<span class="material-symbols-rounded" style="font-size:48px; color:${color};">${icon}</span>
       ${!isFree ? '<span class="store-badge-pro">PRO</span>' : ''}
       ${isPurchased ? '<span class="store-badge-pro" style="background:rgba(52,211,153,0.8);color:#fff;">✓</span>' : ''}`;
  let btnHtml = '';
  if (isPurchased) {
    btnHtml = `<button class="btn" onclick="event.stopPropagation();openStorePurchasedProduct('${p.id}')"
      style="padding:6px 12px; font-size:12px; background:rgba(52,211,153,0.15); color:#34d399; border:1px solid rgba(52,211,153,0.3);">
      <span class="material-symbols-rounded" style="font-size:14px;">download</span> Xem lại
    </button>`;
  } else if (isFree) {
    btnHtml = `<button class="btn" onclick="event.stopPropagation();buyProduct('${p.id}')"
      style="padding:6px 12px; font-size:12px; background:rgba(52,211,153,0.15); color:#34d399; border:none;">
      <span class="material-symbols-rounded" style="font-size:14px;">download</span> Nhận miễn phí
    </button>`;
  } else {
    btnHtml = `<button class="btn btn-primary" onclick="event.stopPropagation();buyProduct('${p.id}')" style="padding:6px 12px; font-size:12px;">
      <span class="material-symbols-rounded" style="font-size:14px;">shopping_cart</span> Mua
    </button>`;
  }

  return `
    <div class="store-card" onclick="openStoreDetail('${p.id}')" style="cursor:pointer;"
         data-pid="${escapeHtml(p.id)}"
         data-video="${escapeHtml(p.videoUrl || '')}"
         data-gallery="${escapeHtml(JSON.stringify(p.galleryImages || []))}"
         data-thumb="${escapeHtml(p.thumbnail || '')}">
      <div class="store-card-thumb" style="background: rgba(${color === '#34d399' ? '52,211,153' : color === '#60a5fa' ? '96,165,250' : color === '#fbbf24' ? '251,191,36' : '139,92,246'},0.1); position:relative; overflow:hidden;">
        ${thumbHtml}
        ${(p.videoUrl || (p.galleryImages && p.galleryImages.length > 1)) ?
      '<div class="store-thumb-play"><span class="material-symbols-rounded">play_circle</span></div>' : ''}
      </div>
      <div class="store-card-body">
        <h3 class="store-card-title">${escapeHtml(stripHtml(p.name))}</h3>
        <p class="store-card-desc">${escapeHtml(stripHtml(p.description || ''))}</p>
        <div class="store-card-stats">
          <span><span class="material-symbols-rounded" style="font-size:14px;">download</span> ${p.downloads || 0}</span>
          ${p.rating ? `<span><span class="material-symbols-rounded" style="font-size:14px; color:#fbbf24;">star</span> ${p.rating}</span>` : ''}
        </div>
      </div>
      <div class="store-card-footer">
        ${priceLabel}
        ${btnHtml}
      </div>
    </div>
  `;
}

// ════ STORE HOVER EFFECTS: video / gallery cycling ════
(function initStoreHoverEffects() {
  function _getCard(e) { return e.target.closest('.store-card'); }

  function _startHover(card) {
    const thumb = card.querySelector('.store-card-thumb');
    if (!thumb || thumb._hoverActive) return;
    thumb._hoverActive = true;

    const videoUrl = card.dataset.video || '';
    const thumbSrc = card.dataset.thumb || '';
    const imgEl = thumb.querySelector('.store-thumb-img');

    if (videoUrl) {
      // Trích YouTube ID từ mọi dạng URL
      const m = videoUrl.match(/(?:youtu\.be\/|watch\?v=|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (m) {
        const ytId = m[1];
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1&loop=1&playlist=${ytId}&controls=0&modestbranding=1&rel=0`;
        iframe.allow = 'autoplay';
        iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;z-index:2;';
        thumb.appendChild(iframe);
        thumb._ytIframe = iframe;
        // Ẩn icon play khi iframe hiện
        const playEl = thumb.querySelector('.store-thumb-play');
        if (playEl) playEl.style.display = 'none';
      }
    } else {
      // Cycle gallery images
      let gallery = [];
      try { gallery = JSON.parse(card.dataset.gallery || '[]'); } catch (e) { }
      if (gallery.length > 1 && imgEl) {
        let idx = 0;
        thumb._galleryTimer = setInterval(() => {
          idx = (idx + 1) % gallery.length;
          imgEl.src = gallery[idx];
        }, 700);
      }
    }
  }

  function _stopHover(card) {
    const thumb = card.querySelector('.store-card-thumb');
    if (!thumb || !thumb._hoverActive) return;
    thumb._hoverActive = false;

    // Xóa YouTube iframe
    if (thumb._ytIframe) { thumb._ytIframe.remove(); thumb._ytIframe = null; }

    // Dừng gallery cycle + restore thumbnail gốc
    if (thumb._galleryTimer) {
      clearInterval(thumb._galleryTimer);
      thumb._galleryTimer = null;
      const imgEl = thumb.querySelector('.store-thumb-img');
      const orig = card.dataset.thumb;
      if (imgEl && orig) imgEl.src = orig;
    }

    // Hiện lại play icon
    const playEl = thumb.querySelector('.store-thumb-play');
    if (playEl) playEl.style.display = '';
  }

  document.addEventListener('mouseover', e => {
    const card = _getCard(e);
    if (card) _startHover(card);
  });

  document.addEventListener('mouseout', e => {
    const card = _getCard(e);
    if (card && !card.contains(e.relatedTarget)) _stopHover(card);
  });
})();

/**
 * Mở modal chi tiết sản phẩm
 */
function openStoreDetail(productId) {
  const p = _storeProducts.find(x => x.id === productId);
  if (!p) return;

  const modal = document.getElementById('storeDetailModal');
  if (!modal) { buyProduct(productId); return; }

  const isFree = p.isFree === true || p.price === 0 || p.price_type === 'free' || p.category === 'freeprompts';
  const iconMap = { workflow: 'account_tree', chatbot: 'smart_toy', freeprompts: 'notes' };
  const colorMap = { workflow: '#a78bfa', chatbot: '#60a5fa', freeprompts: '#34d399' };
  const icon = iconMap[p.category] || 'widgets';
  const color = colorMap[p.category] || '#8b5cf6';
  const catLabel = { workflow: 'Workflow', chatbot: 'Chatbot Prompt', freeprompts: 'Free Prompt' }[p.category] || p.category;

  // ── Thumbnail chính ──────────────────────────────
  const thumbWrap = document.getElementById('sdThumbWrap');
  const thumbImg = document.getElementById('sdThumbImg');
  const thumbIcon = document.getElementById('sdThumbIcon');

  // Build gallery: thumbnail + galleryImages
  const allImages = [];
  if (p.thumbnail) allImages.push(p.thumbnail);
  if (Array.isArray(p.galleryImages)) allImages.push(...p.galleryImages.filter(u => u && u !== p.thumbnail));

  // Cache để lightbox dùng
  window._sdAllImages = allImages;
  window._sdCurrentImgIdx = 0;

  const zoomBtn = document.getElementById('sdZoomBtn');

  if (allImages.length > 0) {
    thumbImg.src = allImages[0];
    thumbImg.style.display = 'block';
    thumbIcon.style.display = 'none';
    // Cập nhật onclick thumbnail → lightbox với toàn bộ gallery
    thumbImg.onclick = () => openLightbox(allImages[0], allImages, 0);
    if (zoomBtn) zoomBtn.style.display = 'flex';
  } else {
    thumbImg.style.display = 'none';
    thumbIcon.style.display = 'flex';
    document.getElementById('sdCatIcon').textContent = icon;
    document.getElementById('sdCatIcon').style.color = color;
    if (zoomBtn) zoomBtn.style.display = 'none';
  }
  // ── Gallery strip (ảnh nhỏ bên dưới ảnh chính trong cột trái) ────────
  let galleryEl = document.getElementById('sdGalleryStrip');
  if (!galleryEl) {
    galleryEl = document.createElement('div');
    galleryEl.id = 'sdGalleryStrip';
    galleryEl.style.cssText = 'display:flex;gap:5px;padding:8px 10px;overflow-x:auto;background:rgba(0,0,0,0.3);flex-shrink:0;';
    // Inject vào cuối sdLeftCol (bên dưới ảnh chính)
    const leftCol = document.getElementById('sdLeftCol');
    if (leftCol) leftCol.appendChild(galleryEl);
    else thumbWrap.after(galleryEl); // fallback
  }
  if (allImages.length > 1) {
    galleryEl.style.display = 'flex';
    galleryEl.innerHTML = allImages.map((url, idx) => `
      <img src="${escapeHtml(url)}" loading="lazy"
        style="height:54px;width:80px;object-fit:cover;border-radius:6px;cursor:pointer;opacity:${idx === 0 ? 1 : 0.6};border:2px solid ${idx === 0 ? '#8b5cf6' : 'transparent'};flex-shrink:0;transition:all 0.15s;"
        onclick="_sdSelectImg(this,'${escapeHtml(url)}',${idx})"
        onerror="this.style.display='none'">`
    ).join('');
  } else {
    galleryEl.style.display = 'none';
    galleryEl.innerHTML = '';
  }

  document.getElementById('sdCatBadge').textContent = catLabel;
  document.getElementById('sdFreeBadge').style.display = isFree ? 'inline-block' : 'none';
  document.getElementById('sdTitle').textContent = stripHtml(p.name);

  // Description — Short preview (cột phải) + Full (section dưới)
  const rawDesc = p.description || '';
  const cleanDesc = stripHtml(rawDesc);
  const sdDescShort = document.getElementById('sdDescShort');
  if (sdDescShort) sdDescShort.textContent = cleanDesc;
  document.getElementById('sdDesc').textContent = cleanDesc;

  // Prompt text (Free Prompts có promptContent) — append vào section chi tiết
  let sdPromptEl = document.getElementById('sdPromptBox');
  if (!sdPromptEl) {
    sdPromptEl = document.createElement('div');
    sdPromptEl.id = 'sdPromptBox';
    sdPromptEl.style.cssText = 'margin-top:14px;';
    document.getElementById('sdDesc').after(sdPromptEl);
  }
  if (p.promptContent && isFree) {
    sdPromptEl.style.display = 'block';
    sdPromptEl.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Nội dung Prompt</div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px;font-size:11px;color:#94a3b8;font-family:monospace;line-height:1.6;max-height:140px;overflow-y:auto;white-space:pre-wrap;">${escapeHtml(p.promptContent.substring(0, 500))}${p.promptContent.length > 500 ? '...\n\n[Xem đầy đủ khi nhận miễn phí]' : ''}</div>`;
  } else {
    sdPromptEl.style.display = 'none';
  }

  // Price
  document.getElementById('sdPrice').textContent = isFree ? 'Miễn phí' : Number(p.price).toLocaleString('vi-VN') + 'đ';

  // Buy button
  const btn = document.getElementById('sdBuyBtn');
  if (p.purchased) {
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">download</span> Xem lại';
    btn.style.background = 'rgba(52,211,153,0.2)';
    btn.style.color = '#34d399';
    btn.onclick = () => { closeStoreDetail(); openStorePurchasedProduct(productId); };
  } else if (isFree) {
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">download</span> Nhận miễn phí';
    btn.style.background = 'linear-gradient(135deg,#34d399,#10b981)';
    btn.style.color = 'white';
    btn.onclick = () => { closeStoreDetail(); buyProduct(productId); };
  } else {
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">shopping_cart</span> Mua ngay — ' + Number(p.price).toLocaleString('vi-VN') + 'đ';
    btn.style.background = 'linear-gradient(135deg,#8b5cf6,#6366f1)';
    btn.style.color = 'white';
    btn.onclick = () => { closeStoreDetail(); buyProduct(productId); };
  }

  modal.style.display = 'flex';
}

// Chọn ảnh trong gallery strip → cập nhật main thumb + mở lightbox khi double-click
function _sdSelectImg(el, url, idx = 0) {
  const thumbImg = document.getElementById('sdThumbImg');
  thumbImg.src = url;
  thumbImg.onclick = () => openLightbox(url, window._sdAllImages || [url], idx);
  window._sdCurrentImgIdx = idx;

  const strip = document.getElementById('sdGalleryStrip');
  if (strip) {
    strip.querySelectorAll('img').forEach(img => {
      img.style.opacity = '0.6';
      img.style.borderColor = 'transparent';
    });
    el.style.opacity = '1';
    el.style.borderColor = '#8b5cf6';
  }
}

function closeStoreDetail() {
  const modal = document.getElementById('storeDetailModal');
  if (modal) modal.style.display = 'none';
}


/**
 * Search debounce
 */
function debounceStoreSearch() {
  clearTimeout(_storeSearchTimer);
  _storeSearchTimer = setTimeout(() => {
    const term = document.getElementById('storeSearchAll')?.value || '';
    _renderStoreAll(_storeProducts, term);
  }, 300);
}

// ════════ BUY PRODUCT ════════
/**
 * Gọi khi user nhấn "Mua" hoặc "Nhận miễn phí"
 */
async function buyProduct(productId) {
  // Tìm product trong cache
  const product = _storeProducts.find(p => p.id === productId);
  if (!product) {
    showToast('Không tìm thấy sản phẩm', 'error');
    return;
  }

  // isFree: kiểm tra tất cả các field có thể có
  const isFree = product.isFree === true
    || product.price === 0
    || product.price_type === 'free'
    || product.category === 'freeprompts';

  try {
    showToast('Đang xử lý...', 'info', 2000);
    const res = await fetch('/api/veo3/store/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId })
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Lỗi xử lý đơn hàng');

    // Lấy product_data từ MỌI field có thể trả về (camelCase + snake_case)
    const productData = data.productData        // camelCase (submitOrder trả về)
      || data.product_data                      // snake_case legacy
      || data.order?.product_data
      || data.order?.productData
      || data.data
      || data.content
      || null;

    if (isFree) {
      // Free product → hiện kết quả ngay, không cần payment
      _showStoreResult(product.name, productData);
      const cached = _storeProducts.find(p => p.id === productId);
      if (cached) cached.purchased = true;
    } else if (data.requirePayment && data.order) {
      // Cần thanh toán → mở QR modal
      await _openStorePaymentModal(product, data.order, data.payment_info);
    } else if (data.order?.status === 'confirmed' || data.status === 'confirmed') {
      // Đã sở hữu → hiện kết quả
      _showStoreResult(product.name, productData);
      const cached = _storeProducts.find(p => p.id === productId);
      if (cached) cached.purchased = true;
    } else {
      // Fallback: hiện kết quả dù không có data
      _showStoreResult(product.name, productData);
    }

  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
    console.error('[Store] buyProduct error:', e.message);
  }
}


/**
 * Hiện kết quả sản phẩm đã mua
 */
async function openStorePurchasedProduct(productId) {
  try {
    const res = await fetch(`/api/veo3/store/orders?product_id=${productId}`);
    const data = await res.json();
    if (!data.success || !data.orders?.length) {
      showToast('Không tìm thấy dữ liệu sản phẩm', 'warning');
      return;
    }
    const order = data.orders.find(o => o.status === 'confirmed') || data.orders[0];
    const product = _storeProducts.find(p => p.id === productId);
    _showStoreResult(product?.name || 'Sản phẩm', order.product_data);
  } catch (e) {
    showToast('Lỗi: ' + e.message, 'error');
  }
}

// ════════ PAYMENT MODAL ════════
async function _openStorePaymentModal(product, order, paymentInfoFromAPI) {
  _storeCurrentOrderId = order.id;

  // Show modal
  const modal = document.getElementById('storePaymentModal');
  if (modal) modal.style.display = 'flex';

  const spLoad = document.getElementById('spLoading');
  const spContent = document.getElementById('spContent');
  const spError = document.getElementById('spError');

  document.getElementById('spProductName').textContent = product.name || '';
  if (spLoad) spLoad.style.display = 'block';
  if (spContent) spContent.style.display = 'none';
  if (spError) spError.style.display = 'none';

  try {
    // Lấy thông tin bank từ payment-info
    let info = paymentInfoFromAPI || _storePaymentInfo;
    if (!info) {
      const r = await fetch('/api/auth/payment-info');
      info = await r.json();
      if (info.success) _storePaymentInfo = info;
    }

    const bank = info?.bank || {};
    const bankCode = bank.code || 'BIDV';
    const acctNum = (bank.accountNumber || '').replace(/\s/g, '');
    const amount = product.price || 0;
    const payCode = `${info?.paymentCode || 'wfbm00000'} STORE-${order.id}`;

    // Điền thông tin
    document.getElementById('spBankName').textContent = bank.name || 'BIDV';
    document.getElementById('spAcctNum').textContent = bank.accountNumber || '—';
    document.getElementById('spAcctName').textContent = bank.accountName || '—';
    document.getElementById('spAmount').textContent = amount.toLocaleString('vi-VN') + 'đ';
    document.getElementById('spPayCode').textContent = payCode;

    // Tạo QR VietQR
    const qrUrl = `https://img.vietqr.io/image/${bankCode}-${acctNum}-compact2.png`
      + `?amount=${amount}`
      + `&addInfo=${encodeURIComponent(payCode)}`
      + `&accountName=${encodeURIComponent(bank.accountName || '')}`;

    const qrImg = document.getElementById('spQrImage');
    qrImg.onload = () => {
      if (spLoad) spLoad.style.display = 'none';
      if (spContent) spContent.style.display = 'block';
      _startStorePaymentPoll();
    };
    qrImg.onerror = () => {
      if (spLoad) spLoad.style.display = 'none';
      if (spContent) spContent.style.display = 'block';
      qrImg.style.display = 'none';
      _startStorePaymentPoll();
    };
    qrImg.src = qrUrl;

  } catch (e) {
    if (spLoad) spLoad.style.display = 'none';
    if (spError) {
      spError.style.display = 'block';
      document.getElementById('spErrorMsg').textContent = e.message || 'Không thể tải thông tin thanh toán';
    }
  }
}

function closeStorePaymentModal() {
  const modal = document.getElementById('storePaymentModal');
  if (modal) modal.style.display = 'none';
  _stopStorePaymentPoll();
}

function copyStorePayCode() {
  const code = document.getElementById('spPayCode')?.textContent || '';
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('spCopyBtn');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:12px; color:#34d399;">check</span> Đã copy!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Đã copy nội dung chuyển khoản', 'success');
  });
}

// ════════ ORDER POLL ════════
function _startStorePaymentPoll() {
  _stopStorePaymentPoll();
  _storePollCount = 0;

  _storePollTimer = setInterval(async () => {
    _storePollCount++;
    const remaining = STORE_POLL_MAX - _storePollCount;
    const pollEl = document.getElementById('spPollStatus');

    if (_storePollCount > STORE_POLL_MAX) {
      _stopStorePaymentPoll();
      if (pollEl) pollEl.textContent = 'Hết thời gian tự động. Nhấn "Kiểm tra" để kiểm tra thủ công.';
      return;
    }
    if (pollEl) {
      pollEl.textContent = `Tự động kiểm tra mỗi 8s (còn ${remaining * 8}s)`;
    }

    await _doStoreOrderCheck();
  }, STORE_POLL_INTERVAL);
}

function _stopStorePaymentPoll() {
  if (_storePollTimer) {
    clearInterval(_storePollTimer);
    _storePollTimer = null;
    _storePollCount = 0;
  }
}

async function _doStoreOrderCheck() {
  if (!_storeCurrentOrderId) return;
  try {
    const res = await fetch(`/api/veo3/store/orders/${_storeCurrentOrderId}`);
    const data = await res.json();
    if (!data.success) return;

    const order = data.order;
    if (order.status === 'confirmed') {
      _stopStorePaymentPoll();
      closeStorePaymentModal();
      // Lấy tên sản phẩm từ cache
      const product = _storeProducts.find(p => p.id === order.product_id);
      _showStoreResult(product?.name || 'Sản phẩm', order.product_data);
      // Refresh danh sách đơn hàng sidebar
      _loadStoreOrders();
    } else if (order.status === 'failed') {
      _stopStorePaymentPoll();
      const pollEl = document.getElementById('spPollStatus');
      if (pollEl) pollEl.textContent = '❌ Đơn hàng thất bại. Vui lòng thử lại.';
    }
  } catch (e) {
    // Im lặng khi poll lỗi
  }
}

async function checkStorePayment() {
  const btn = document.getElementById('spCheckBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.2);border-top-color:#a78bfa;border-radius:50%;animation:spin 0.6s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px;"></div> Đang kiểm tra...';
  }
  await _doStoreOrderCheck();
  setTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">refresh</span> Kiểm tra thanh toán';
    }
  }, 3000);
}

// ════════ RESULT MODAL ════════
function _showStoreResult(productName, productData) {
  const modal = document.getElementById('storeResultModal');
  if (!modal) return;

  document.getElementById('srProductName').textContent = productName || 'Sản phẩm';

  const dataEl = document.getElementById('srProductData');
  if (dataEl) {
    if (!productData) {
      dataEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px; text-align:center;">Đang chờ nội dung từ hệ thống...</p>';
    } else if (typeof productData === 'string') {
      // Thử parse JSON
      try {
        const parsed = JSON.parse(productData);
        dataEl.innerHTML = _renderProductDataHTML(parsed);
      } catch {
        // Hiển thị raw string (có thể là license key, link...)
        dataEl.innerHTML = `<pre style="font-size:12px; color:#f8fafc; white-space:pre-wrap; word-break:break-all; margin:0; font-family:monospace;">${escapeHtml(productData)}</pre>`;
      }
    } else if (typeof productData === 'object') {
      dataEl.innerHTML = _renderProductDataHTML(productData);
    }
  }

  modal.style.display = 'flex';
  showToast('🎉 Mua hàng thành công!', 'success', 5000);
}

function _renderProductDataHTML(data) {
  if (!data || typeof data !== 'object') return '<p>Không có dữ liệu</p>';
  let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
  for (const [key, val] of Object.entries(data)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const isLong = String(val).length > 80;
    html += `
      <div style="border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:8px;">
        <div style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">${escapeHtml(label)}</div>
        ${isLong
        ? `<textarea readonly style="width:100%; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.08); border-radius:6px; color:#f8fafc; padding:8px; font-size:12px; font-family:monospace; resize:vertical; min-height:80px; box-sizing:border-box;">${escapeHtml(String(val))}</textarea>`
        : `<span style="font-size:13px; color:#f8fafc; word-break:break-all;">${escapeHtml(String(val))}</span>`
      }
      </div>`;
  }
  html += '</div>';
  return html;
}

function closeStoreResultModal() {
  const modal = document.getElementById('storeResultModal');
  if (modal) modal.style.display = 'none';
}

// ════════ ORDER HISTORY SIDEBAR ════════
async function _loadStoreOrders() {
  const listEl = document.getElementById('storeOrderList');
  if (!listEl) return;

  try {
    const res = await fetch('/api/veo3/store/orders');
    const data = await res.json();
    if (!data.success || !data.orders?.length) {
      listEl.innerHTML = '<div style="text-align:center; padding:10px 0; opacity:0.4; font-size:12px;">Chưa có đơn hàng nào</div>';
      return;
    }

    listEl.innerHTML = data.orders.slice(0, 5).map(order => {
      const statusColor = order.status === 'confirmed' ? '#34d399' : order.status === 'pending' ? '#fbbf24' : '#ef4444';
      const statusText = order.status === 'confirmed' ? 'Hoàn thành' : order.status === 'pending' ? 'Chờ TT' : 'Thất bại';
      return `
        <div style="padding:8px; border:1px solid rgba(255,255,255,0.06); border-radius:8px; margin-bottom:6px; background:rgba(0,0,0,0.2); cursor:pointer;"
          onclick="${order.status === 'confirmed' ? `openStorePurchasedProduct('${order.product_id}')` : ''}">
          <div style="font-size:12px; color:#f8fafc; font-weight:500; margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(order.product_name || '')}">
            ${escapeHtml(order.product_name || `Đơn #${order.id}`)}
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:${statusColor};">${statusText}</span>
            <span style="font-size:10px; color:#475569;">${order.price ? Number(order.price).toLocaleString('vi-VN') + 'đ' : 'Free'}</span>
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    listEl.innerHTML = '<div style="text-align:center; padding:10px 0; opacity:0.4; font-size:12px;">Không thể tải đơn hàng</div>';
  }
}

socket.on('workflowStats', (stats) => {
  const doneEl = document.getElementById('wfbStatDone');
  const waitEl = document.getElementById('wfbStatWait');
  const errEl = document.getElementById('wfbStatErr');

  if (doneEl) doneEl.textContent = stats.done;
  if (waitEl) waitEl.textContent = stats.wait;
  if (errEl) errEl.textContent = stats.err;
});


// === Socket Events ===
socket.on('connect', () => {
  addLog('Đã kết nối WebSocket với server', 'success');
});

// === Auth: License hết hạn → buộc đăng xuất ===
let _authExpiredHandled = false; // guard: chỉ redirect 1 lần dù server emit nhiều lần
socket.on('auth:expired', (data) => {
  if (_authExpiredHandled) return;
  _authExpiredHandled = true;
  showToast('⚠️ ' + (data.error || 'License đã hết hạn. Vui lòng đăng nhập lại.'), 'error');
  setTimeout(() => {
    window.location.href = '/login.html';
  }, 5000); // 5s để user đọc thông báo
});

// === Auth: Chưa xác thực email → chuyển hướng về login để hiện verify card ===
let _authNeedVerifyHandled = false;
socket.on('auth:needVerify', (data) => {
  if (_authNeedVerifyHandled) return;
  _authNeedVerifyHandled = true;
  showToast('📬 ' + (data.error || 'Email chưa được xác thực. Đang chuyển hướng...'), 'warning');
  setTimeout(() => {
    window.location.href = '/login.html';
  }, 2500);
});

// === Auth: Plan thay đổi (upgrade hoặc downgrade, từ web hoặc admin) ===
socket.on('auth:planUpgraded', (data) => {
  const { plan, prevPlan, expires_at } = data;
  console.log(`[UI] Plan change: ${prevPlan?.toUpperCase()} → ${plan?.toUpperCase()}`);

  const planColors = {
    pro: { bg: 'rgba(138,92,246,0.2)', color: '#a78bfa' },
    lifetime: { bg: 'rgba(52,211,153,0.15)', color: '#34d399' },
    trial: { bg: 'rgba(251,191,36,0.15)', color: '#fbbf24' }
  };
  const c = planColors[plan] || planColors.trial;

  // -- 1. Cập nhật user badge trong header --
  const userPlanBadge = document.getElementById('userPlanBadge');
  if (userPlanBadge) {
    userPlanBadge.textContent = plan.toUpperCase();
    userPlanBadge.style.background = c.bg;
    userPlanBadge.style.color = c.color;
  }

  // -- 2. Cập nhật badge trong account modal (nếu đang mở) --
  const acctBadge = document.getElementById('acctPlanBadge');
  if (acctBadge) {
    acctBadge.textContent = plan.toUpperCase();
    acctBadge.style.background = c.bg;
    acctBadge.style.color = c.color;
  }

  // -- 3. Cập nhật expiry text --
  const expiryEl = document.getElementById('acctExpiry');
  if (expiryEl) {
    if (plan === 'lifetime') {
      expiryEl.textContent = '♾ Vĩnh viễn';
      expiryEl.style.color = '#34d399';
    } else if (expires_at) {
      const days = Math.ceil((new Date(expires_at) - new Date()) / 86400000);
      expiryEl.textContent = days > 0 ? `Còn ${days} ngày` : 'Đã hết hạn';
      expiryEl.style.color = days > 5 ? 'var(--text-muted)' : '#ef4444';
    } else {
      expiryEl.textContent = '';
    }
  }

  // -- 4. Cập nhật pricing cards trực tiếp (không qua _updatePricingUI để tránh scope issues) --
  const cardPro = document.getElementById('cardPro');
  const cardLifetime = document.getElementById('cardLifetime');
  const lifetimeBanner = document.getElementById('lifetimeBanner');
  const planCardsGrid = document.getElementById('planCardsGrid');
  const pricingLabel = document.getElementById('pricingLabel');
  const pricingFooter = document.getElementById('pricingFooter');

  if (planCardsGrid) {   // chỉ chạy nếu modal elements tồn tại
    if (plan === 'lifetime') {
      planCardsGrid.style.display = 'none';
      if (lifetimeBanner) lifetimeBanner.style.display = 'block';
      if (pricingLabel) pricingLabel.textContent = 'Gói của bạn';
      if (pricingFooter) pricingFooter.style.display = 'none';
    } else if (plan === 'pro') {
      planCardsGrid.style.display = 'grid';
      planCardsGrid.style.gridTemplateColumns = '1fr';
      if (cardPro) cardPro.style.display = 'none';
      if (cardLifetime) cardLifetime.style.display = 'block';
      if (lifetimeBanner) lifetimeBanner.style.display = 'none';
      if (pricingLabel) pricingLabel.textContent = 'Nâng cấp lên Lifetime';
      if (pricingFooter) pricingFooter.style.display = 'block';
    } else {
      // trial hoặc downgrade
      planCardsGrid.style.display = 'grid';
      planCardsGrid.style.gridTemplateColumns = '1fr 1fr';
      if (cardPro) cardPro.style.display = 'block';
      if (cardLifetime) cardLifetime.style.display = 'block';
      if (lifetimeBanner) lifetimeBanner.style.display = 'none';
      if (pricingLabel) pricingLabel.textContent = 'Nâng cấp gói';
      if (pricingFooter) pricingFooter.style.display = 'block';
    }
  }

  // -- 5. Toast thông báo --
  const labels = { lifetime: 'Lifetime ♾ (Vĩnh viễn)', pro: 'Pro (30 ngày)', trial: 'Trial' };
  const label = labels[plan] || plan.toUpperCase();
  if (plan !== 'trial') {
    showToast(`🎉 Tài khoản nâng cấp lên ${label}!`, 'success');
  } else {
    showToast(`ℹ️ Gói đã đổi về ${label}.`, 'info');
  }
});

socket.on('connected', (status) => {
  isConnected = status;
  updateConnectionUI();
  if (status) {
    showToast('Đã kết nối Chrome thành công!', 'success');
  }
});

socket.on('log', (entry) => {
  addLogEntry(entry);
});

socket.on('promptStart', ({ index, total, prompt }) => {
  updatePromptStatus(index, 'active');
  updateProgress(index, total);
});

socket.on('promptComplete', ({ index, result, total }) => {
  const status = (result.status === 'completed' || result.status === 'success') ? 'completed' : 'error';
  updatePromptStatus(index, status);

  if (status === 'completed') stats.completed++;
  else stats.errors++;
  stats.pending = Math.max(0, prompts.length - stats.completed - stats.errors);

  updateStatsUI();
  updateProgress(index + 1, total);
});

socket.on('generationProgress', ({ elapsed }) => {
  // Cập nhật tiến trình tạo video
});

socket.on('allComplete', (results) => {
  isRunning = false;
  isPaused = false;
  updateControlButtons();
  const promptSpan = document.getElementById('promptSimProgress');
  if (promptSpan) promptSpan.textContent = '0%';
  showToast(`Hoàn thành! ${stats.completed} thành công, ${stats.errors} lỗi`,
    stats.errors > 0 ? 'warning' : 'success');
});

socket.on('paused', (paused) => {
  isPaused = paused; // <-- Cập nhật state
  const btn = document.getElementById('btnPause');
  btn.innerHTML = paused
    ? '<span class="material-symbols-rounded">play_arrow</span>'
    : '<span class="material-symbols-rounded">pause</span>';
  btn.title = paused ? 'Tiếp tục' : 'Tạm dừng';
  updateControlButtons();
});

socket.on('stopped', () => {
  isRunning = false;
  isPaused = false;
  updateControlButtons();
  const promptSpan = document.getElementById('promptSimProgress');
  if (promptSpan) promptSpan.textContent = '0%';
  showToast('Đã dừng tiến trình', 'warning');
});

// === Builder Workflow Socket Events ===
socket.on('wfNodeUpdateConfig', ({ nodeId, config }) => {
  if (typeof WFB !== 'undefined' && WFB.updateNodeConfigFromSocket) {
    WFB.updateNodeConfigFromSocket(nodeId, config);
  }
});

socket.on('wfNodeStatus', ({ nodeId, status, error }) => {
  if (typeof WFB !== 'undefined' && WFB.updateNodeStatus) {
    WFB.updateNodeStatus(nodeId, status, error);
  }
});

// ════════ LẮNG NGHE SỰ KIỆN HÀNG ĐỢI (QUEUE) ════════
let _activeTaskRunStart = null;
let _lastQueueCompleted = -1;
window._activeTaskProgress = null;

setInterval(() => {
  if (!window._activeTaskProgress || !_activeTaskRunStart) return;
  const p = window._activeTaskProgress;
  if (p.total === 0) return;

  const elapsedMs = Date.now() - _activeTaskRunStart;
  // Tăng thời gian trung bình tạo ảnh từ 18s lên 35s để % chạy chậm lại thực tế hơn
  const avgTime = (p.runningType && p.runningType.includes('image')) ? 35000 : 85000;

  const basePct = (p.completed / p.total) * 100;
  const fraction = Math.min(0.95, elapsedMs / avgTime);
  const runningPct = (fraction / p.total) * 100;
  const totalPct = Math.min(100, Math.floor(basePct + runningPct));

  // Update in builder map
  const spans = document.querySelectorAll('.task-sim-progress');
  spans.forEach(span => span.textContent = ' — ' + totalPct + '%');

  // Update in Prompt Tab bottom bar
  const promptSpan = document.getElementById('promptSimProgress');
  if (promptSpan) promptSpan.textContent = totalPct + '%';
}, 1000);

// === Store: Realtime Events từ SePay Webhook ===
// Khi SePay xác nhận thanh toán → server emit ngay, không cần đợi poll 8s
socket.on('store:order_confirmed', ({ orderId, userId, productData }) => {
  if (String(orderId) !== String(_storeCurrentOrderId)) return; // không phải đơn đang chờ
  _stopStorePaymentPoll();
  closeStorePaymentModal();
  // Tìm tên sản phẩm từ cache
  const product = _storeProducts.find(p => p.id && true); // fallback
  const productName = document.getElementById('spProductName')?.textContent || 'Sản phẩm';
  _showStoreResult(productName, productData);
  _loadStoreOrders(); // refresh sidebar
  console.log('[Store] ✅ Realtime confirmed:', orderId);
});

socket.on('store:payment_received', ({ orderId, userId, message }) => {
  if (String(orderId) !== String(_storeCurrentOrderId)) return;
  const pollEl = document.getElementById('spPollStatus');
  if (pollEl) pollEl.textContent = '💰 ' + (message || 'Tiền đã nhận, đang xử lý sản phẩm...');
  showToast('💰 Đã nhận tiền, đang xử lý...', 'info', 5000);
});

// ════════ LẮNG NGHE SỰ KIỆN HÀNG ĐỢI (QUEUE) ════════
socket.on('queue_update', (queueData) => {
  const container = document.getElementById('queueContainer');
  const badge = document.getElementById('queueCountBadge');

  if (!container) return;

  // Tính số lượng tác vụ đanh CHỜ (bỏ qua tác vụ đang chạy có id = -1)
  const waitingCount = queueData.filter(t => t.id !== -1).length;

  if (badge) {
    badge.textContent = waitingCount;
    badge.style.display = waitingCount > 0 ? 'inline-block' : 'none';
  }

  if (!queueData || queueData.length === 0) {
    window._activeTaskProgress = null;
    _activeTaskRunStart = null;
    container.innerHTML = `
      <div class="empty-queue-state">
        <span class="material-symbols-rounded">check_circle</span>
        <p>Không có tác vụ chờ</p>
      </div>
    `;
    return;
  }

  const activeTask = queueData.find(t => t.status === 'running');
  if (activeTask && activeTask.progress) {
    window._activeTaskProgress = activeTask.progress;
    if (_lastQueueCompleted !== activeTask.progress.completed) {
      _activeTaskRunStart = Date.now();
      _lastQueueCompleted = activeTask.progress.completed;
    }
    if (!_activeTaskRunStart) _activeTaskRunStart = Date.now();
  } else {
    window._activeTaskProgress = null;
    _activeTaskRunStart = null;
  }

  let html = '';
  queueData.forEach((task) => {
    let statusClass = '';
    let statusText = '';
    let statusIcon = '';
    let removeBtn = '';

    if (task.status === 'running') {
      statusClass = 'running';
      statusText = 'Đang chạy';
      statusIcon = 'sync'; // Spinner style
      removeBtn = `<button class="queue-rm-btn" onclick="WFB.skipCurrentTask()" title="Hủy tác vụ này"><span class="material-symbols-rounded">cancel</span></button>`;
    } else if (task.status === 'paused') {
      statusClass = 'paused';
      statusText = 'Tạm dừng';
      statusIcon = 'pause_circle';
      removeBtn = `<button class="queue-rm-btn" onclick="WFB.skipCurrentTask()" title="Hủy tác vụ này"><span class="material-symbols-rounded">cancel</span></button>`;
    } else if (task.status === 'next') {
      statusClass = 'next';
      statusText = 'Tiếp theo';
      statusIcon = 'hourglass_top';
      removeBtn = `<button class="queue-rm-btn" onclick="WFB.removeQueueItem(${task.id})" title="Xóa tác vụ này"><span class="material-symbols-rounded">delete</span></button>`;
    } else {
      statusClass = 'waiting';
      statusText = 'Đang chờ';
      statusIcon = 'schedule';
      removeBtn = `<button class="queue-rm-btn" onclick="WFB.removeQueueItem(${task.id})" title="Xóa tác vụ này"><span class="material-symbols-rounded">delete</span></button>`;
    }
    html += `
      <div class="queue-item ${statusClass}">
        <div class="queue-item-header">
          <span class="queue-item-title">${task.name}</span>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="queue-item-status">
              <span class="material-symbols-rounded ${statusClass === 'running' ? 'spin-icon' : ''}" style="font-size:11px; vertical-align:middle;">
                ${statusIcon}
              </span>
              ${statusText}
              ${(task.status === 'running' && task.progress && task.progress.total > 0) ? `<span class="task-sim-progress" style="color:#a78bfa; font-weight:700; margin-left:2px;"> — 0%</span>` : ''}
            </span>
            ${removeBtn}
          </div>
        </div>
        <div class="queue-item-desc">${task.desc}</div>
      </div>
    `;
  });

  container.innerHTML = html;
});



socket.on('wfComplete', (data) => {
  isRunning = false;
  updateControlButtons();
  showToast(`✅ Workflow "${data.name || ''}" hoàn tất!`, 'success');
  // Không xóa kết quả (previewMedia), chỉ clear status (spinner / border running)
  if (typeof WFB !== 'undefined' && WFB.clearNodeStatuses) {
    WFB.clearNodeStatuses();
  }
});

socket.on('wfError', (data) => {
  isRunning = false;
  updateControlButtons();
  showToast(`❌ Lỗi workflow: ${data.error}`, 'error');
});

// Hiển thị preview trên node khi generate xong (không download)
socket.on('wfNodeResult', ({ nodeId, media }) => {
  if (typeof WFB !== 'undefined' && WFB.setNodePreview) {
    WFB.setNodePreview(nodeId, media);
  }
});



// === Prompt Management ===
function addPrompts() {
  const textarea = document.getElementById('promptTextarea');
  const text = textarea.value.trim();
  if (!text) {
    showToast('Vui lòng nhập ít nhất 1 prompt', 'warning');
    return;
  }

  const newPrompts = text.split('\n')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  if (newPrompts.length === 0) {
    showToast('Không tìm thấy prompt hợp lệ', 'warning');
    return;
  }

  prompts = [...prompts, ...newPrompts];
  textarea.value = '';
  renderPromptList();
  updateStartButton();
  showToast(`Đã thêm ${newPrompts.length} prompt`, 'success');
}

function importFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const newPrompts = text.split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    prompts = [...prompts, ...newPrompts];
    renderPromptList();
    updateStartButton();
    showToast(`Đã import ${newPrompts.length} prompt từ ${file.name}`, 'success');
  };
  reader.readAsText(file);
  event.target.value = ''; // Reset input
}

function removePrompt(index) {
  prompts.splice(index, 1);
  renderPromptList();
  updateStartButton();
}

async function clearAllPrompts() {
  if (prompts.length === 0) return;
  const confirmed = await window.wfbConfirm('Xóa tất cả prompt?', 'Bạn có chắc chắn muốn xóa toàn bộ danh sách prompt hiện tại?', 'Xóa', '#ef4444');
  if (!confirmed) return;

  prompts = [];
  renderPromptList();
  updateStartButton();
}

function renderPromptList() {
  const container = document.getElementById('promptList');
  const countEl = document.getElementById('promptCount');
  countEl.textContent = `${prompts.length} prompt`;

  if (prompts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-rounded icon">movie_creation</span>
        <h3 style="color: var(--text-muted); font-size: 16px;">Chưa có prompt nào</h3>
        <p>Nhập prompt ở trên hoặc import từ file .txt</p>
      </div>
    `;
    return;
  }

  container.innerHTML = prompts.map((prompt, i) => `
    <div class="prompt-item" id="prompt-${i}" data-index="${i}">
      <div class="prompt-number">${i + 1}</div>
      <div class="prompt-text" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</div>
      <div class="prompt-status-icon" id="prompt-status-${i}"></div>
      <button class="prompt-remove" onclick="removePrompt(${i})" title="Xóa">
        <span class="material-symbols-rounded" style="font-size: 16px;">close</span>
      </button>
    </div>
  `).join('');
}

function updatePromptStatus(index, status) {
  const item = document.getElementById(`prompt-${index}`);
  const icon = document.getElementById(`prompt-status-${index}`);
  if (!item || !icon) return;

  // Remove old classes
  item.classList.remove('active', 'completed', 'error');
  item.classList.add(status);

  switch (status) {
    case 'active':
      icon.innerHTML = '<div class="spinner"></div>';
      // Scroll into view
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    case 'completed':
      icon.innerHTML = '<span class="material-symbols-rounded" style="color: var(--success); font-size: 20px;">check_circle</span>';
      break;
    case 'error':
      icon.innerHTML = '<span class="material-symbols-rounded" style="color: var(--error); font-size: 20px;">error</span>';
      break;
  }
}

// === Settings ===
function setSetting(el) {
  const settingName = el.dataset.setting;
  const value = el.dataset.value;

  // Cập nhật UI
  const siblings = el.parentElement.querySelectorAll('.setting-option');
  siblings.forEach(s => s.classList.remove('active'));
  el.classList.add('active');

  // Cập nhật settings
  if (settingName === 'quantity') {
    settings[settingName] = parseInt(value);
  } else {
    settings[settingName] = value;
  }
}

function getSettings() {
  return {
    ...settings,
    mode: currentMode,
    projectUrl: document.getElementById('projectUrl').value,
    delayBetween: Math.max(5000, parseInt(document.getElementById('delayBetween').value || 5) * 1000),
    waitForGeneration: parseInt(document.getElementById('waitForGeneration').value || 0) * 1000,
    downloadDir: document.getElementById('downloadDir').value.trim(),
    subfolderName: document.getElementById('subfolderName') ? document.getElementById('subfolderName').value.trim() : '',
    imagePaths: {
      // Chuyển refs array thành định dạng server hiểu: ref = ảnh đầu tiên (cũ), refs = tất cả
      ref: imagePaths.refs[0] || null,
      refs: imagePaths.refs,
      start: imagePaths.start,
      end: imagePaths.end,
    },
    videoModel: settings.videoModel || 'veo31_fast_lower',
    imageModel: settings.imageModel || 'imagen_4',
  };
}

// === Mode Selection ===

// Level 1: chọn Ảnh hoặc Video (top-level type switch)
function selectModeType(type) {
  document.getElementById('modeTypeImg').classList.toggle('active', type === 'image');
  document.getElementById('modeTypeVid').classList.toggle('active', type === 'video');
  document.getElementById('imageSubModes').style.display = type === 'image' ? '' : 'none';
  document.getElementById('videoSubModes').style.display = type === 'video' ? '' : 'none';
  selectMode(type === 'image' ? 'image' : 'video');
}

function selectMode(mode) {
  currentMode = mode;
  // Cập nhật mode-sub-btn (UI mới)
  document.querySelectorAll('.mode-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Cập nhật mode-btn legacy
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Show/hide upload zones
  const needsRef = mode === 'image_from_image' || mode === 'video_from_image';
  const needsFrames = mode === 'video_from_frames';
  document.getElementById('uploadRefGroup').style.display = needsRef ? '' : 'none';
  document.getElementById('uploadFramesGroup').style.display = needsFrames ? '' : 'none';

  // Show/hide model groups
  const isVideo = mode.includes('video');
  const videoModelGroup = document.getElementById('videoModelGroup');
  if (videoModelGroup) videoModelGroup.style.display = isVideo ? '' : 'none';

  const imageModelGroup = document.getElementById('imageModelGroup');
  if (imageModelGroup) imageModelGroup.style.display = !isVideo ? '' : 'none';

  // Lọc tỉ lệ dựa vào chế độ Video
  document.querySelectorAll('[data-setting="ratio"]').forEach(btn => {
    if (isVideo && !['landscape', 'portrait'].includes(btn.dataset.value)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'inline-block';
    }
  });

  const activeRatioBtn = document.querySelector('[data-setting="ratio"].active');
  if (activeRatioBtn && activeRatioBtn.style.display === 'none') {
    document.querySelector('[data-setting="ratio"][data-value="landscape"]').click();
  }

  // Update start button state
  updateStartButton();
}

// Chọn AI model video
function selectVideoModelUI(el) {
  document.querySelectorAll('#videoModelList .video-model-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  settings.videoModel = el.dataset.model;
}

// Chọn AI model ảnh
function selectImageModelUI(el) {
  document.querySelectorAll('#imageModelList .video-model-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  settings.imageModel = el.dataset.model;
}

// === Multi-image Reference Upload (image_from_image) ===
const MAX_REF_IMAGES = 3;

function handleMultiRefImageUpload(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  const remaining = MAX_REF_IMAGES - imagePaths.refs.length;
  const toAdd = files.slice(0, remaining);

  toAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePaths.refs.push(e.target.result);
      _renderRefThumbs();
      updateStartButton();
    };
    reader.readAsDataURL(file);
  });

  if (files.length > remaining) {
    showToast(`Chỉ thêm được ${remaining} ảnh (tối đa ${MAX_REF_IMAGES})`, 'warning');
  }
  event.target.value = '';
}

function removeRefImage(index) {
  imagePaths.refs.splice(index, 1);
  _renderRefThumbs();
  updateStartButton();
}

function _renderRefThumbs() {
  const thumbsEl = document.getElementById('refImageThumbs');
  const countEl = document.getElementById('refImageCount');
  const zoneEl = document.getElementById('uploadRefZone');
  if (!thumbsEl) return;

  const count = imagePaths.refs.length;
  if (countEl) countEl.textContent = `(${count}/${MAX_REF_IMAGES})`;

  // Ẩn drop zone khi đã đủ 3 ảnh
  if (zoneEl) zoneEl.style.display = count >= MAX_REF_IMAGES ? 'none' : '';

  thumbsEl.innerHTML = imagePaths.refs.map((dataUrl, i) => `
    <div style="position:relative;width:58px;height:58px;border-radius:8px;overflow:hidden;
      border:1.5px solid rgba(255,255,255,0.12);flex-shrink:0;">
      <img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;display:block;">
      <button onclick="removeRefImage(${i})" title="Xóa" style="
        position:absolute;top:2px;right:2px;width:16px;height:16px;
        border-radius:50%;border:none;background:rgba(0,0,0,0.7);color:#fff;
        font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;
        line-height:1;padding:0;
      ">&times;</button>
    </div>
  `).join('');
}

// Giữ handleImageUpload cho start/end frame (video_from_frames)
function handleImageUpload(slot, event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    imagePaths[slot] = dataUrl;

    // Update preview
    const previewId = slot === 'ref' ? 'refImagePreview' : (slot === 'start' ? 'startImagePreview' : 'endImagePreview');
    const placeholderId = slot === 'ref' ? 'uploadRefPlaceholder' : (slot === 'start' ? 'uploadStartPlaceholder' : 'uploadEndPlaceholder');
    const preview = document.getElementById(previewId);
    const placeholder = document.getElementById(placeholderId);
    preview.src = dataUrl;
    preview.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    updateStartButton();
    showToast(`Đã chọn ảnh ${slot}: ${file.name}`, 'success');
  };
  reader.readAsDataURL(file);
}


function updateConnectionUI() {
  const el = document.getElementById('connectionStatus');
  const text = document.getElementById('connectionText');

  if (isConnected) {
    el.className = 'connection-status connected';
    text.textContent = 'Đã kết nối';
  } else {
    el.className = 'connection-status disconnected';
    text.textContent = 'Chưa kết nối';
  }

  updateStartButton();
}

// === Automation Control ===
async function startAutomation() {
  if (prompts.length === 0) {
    showToast('Chưa có prompt nào!', 'warning');
    return;
  }

  // Nếu chưa kết nối — thử tự động launch Chrome với cookie đã lưu
  if (!isConnected) {
    const savedCookies = localStorage.getItem('veo3_cookies');
    const projectUrl = document.getElementById('projectUrl')?.value || '';
    if (savedCookies) {
      showToast('Đang mở Chrome tự động...', 'info');
      try {
        const res = await fetch('/api/cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: savedCookies, projectUrl })
        });
        const data = await res.json();
        if (!data.success) {
          showToast('Không mở được Chrome. Hãy Inject Cookie lại.', 'error');
          return;
        }
        // Chờ kết nối xác nhận qua socket
        await new Promise(r => setTimeout(r, 2500));
      } catch (e) {
        showToast('Lỗi mở Chrome: ' + e.message, 'error');
        return;
      }
    } else {
      showToast('Chưa kết nối Chrome! Nhấn biểu tượng 🔗 → Inject Cookie trước.', 'warning');
      return;
    }
  }

  // Reset stats
  stats = { completed: 0, pending: prompts.length, errors: 0 };
  updateStatsUI();
  updateProgress(0, prompts.length);

  // Reset prompt status icons
  prompts.forEach((_, i) => {
    const item = document.getElementById(`prompt-${i}`);
    const icon = document.getElementById(`prompt-status-${i}`);
    if (item) item.classList.remove('active', 'completed', 'error');
    if (icon) icon.innerHTML = '';
  });

  isRunning = true;
  updateControlButtons();

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompts,
        settings: getSettings()
      })
    });
    const data = await res.json();
    if (!data.success) {
      showToast(`Lỗi: ${data.error}`, 'error');
      isRunning = false;
      updateControlButtons();
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
    isRunning = false;
    updateControlButtons();
  }
}

async function pauseAutomation() {
  try {
    if (window.isPaused) {
      await fetch('/api/resume', { method: 'POST' });
    } else {
      await fetch('/api/pause', { method: 'POST' });
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

async function stopAutomation() {
  const confirmed = await window.wfbConfirm('Dừng hệ thống?', 'Bạn có chắc muốn dừng tiến trình hiện tại?', 'Dừng lại', '#ef4444');
  if (!confirmed) return;

  try {
    await fetch('/api/stop', { method: 'POST' });
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

// Hàm xóa hàng đợi gọi từ nút UI (thùng rác) trong panel Hàng Đợi
async function clearQueue() {
  const confirmed = await window.wfbConfirm('Xóa toàn bộ hàng đợi?', 'Bạn có chắc muốn xóa toàn bộ hàng đợi? (Tác vụ đang chạy sẽ không bị ảnh hưởng)', 'Xóa tất cả', '#ef4444');
  if (!confirmed) return;

  fetch('/api/clear-queue', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.success && typeof showToast === 'function') {
        showToast('Đã dọn sạch hàng đợi', 'success');
      }
    })
    .catch(err => {
      if (typeof showToast === 'function') showToast('Lỗi khi xóa hàng đợi: ' + err.message, 'error');
    });
}


async function restartAutomation() {
  if (!isRunning) return;
  const confirmed = await window.wfbConfirm('Chạy lại từ đầu?', 'Dừng tiến trình hiện tại và chạy lại toàn bộ từ đầu?', 'Chạy lại', '#f97316');
  if (!confirmed) return;

  try {
    await fetch('/api/stop', { method: 'POST' });
    // Chờ dừng hoàn toàn rồi mới start lại
    await new Promise(r => setTimeout(r, 2000));
    await startAutomation();
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

function updateControlButtons() {
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const btnRestart = document.getElementById('btnRestart');

  // Hệ thống đang hoạt động nếu đang chạy HOẶC đang bị tạm dừng
  const isSystemActive = isRunning || isPaused;

  btnStart.disabled = isSystemActive || !isConnected || prompts.length === 0;
  btnPause.disabled = !isSystemActive; // Luôn mở nếu đang chạy hoặc tạm dừng
  btnStop.disabled = !isSystemActive;  // Luôn mở nếu đang chạy hoặc tạm dừng
  if (btnRestart) btnRestart.disabled = !isSystemActive;

  if (isRunning && !isPaused) {
    btnStart.innerHTML = '<div class="spinner" style="border-top-color: white;"></div> Đang chạy...';
  } else if (isPaused) {
    btnStart.innerHTML = '<span class="material-symbols-rounded">pause</span> Đang tạm dừng';
  } else {
    btnStart.innerHTML = '<span class="material-symbols-rounded">play_arrow</span> Bắt đầu tạo';
  }
}


function updateStartButton() {
  const btnStart = document.getElementById('btnStart');
  let hasRequiredImages = true;
  if (currentMode === 'image_from_image' || currentMode === 'video_from_image') {
    hasRequiredImages = imagePaths.refs.length > 0;
  } else if (currentMode === 'video_from_frames') {
    hasRequiredImages = !!imagePaths.start && !!imagePaths.end;
  }
  // Cho phép start nếu đã kết nối HOẶC có cookie đã lưu (sẽ auto-launch Chrome)
  const canStart = isConnected || !!localStorage.getItem('veo3_cookies');
  btnStart.disabled = isRunning || !canStart || prompts.length === 0 || !hasRequiredImages;
}

// === Progress ===
function updateProgress(current, total) {
  const bar = document.getElementById('progressBar');
  const percent = total > 0 ? (current / total) * 100 : 0;
  bar.style.width = `${percent}%`;
}

function updateStatsUI() {
  document.getElementById('statCompleted').textContent = stats.completed;
  document.getElementById('statPending').textContent = stats.pending;
  document.getElementById('statErrors').textContent = stats.errors;
  // Đồng bộ với stat badges trong wfb toolbar
  const d = document.getElementById('wfbStatDone');
  const w = document.getElementById('wfbStatWait');
  const e = document.getElementById('wfbStatErr');
  if (d) d.textContent = stats.completed;
  if (w) w.textContent = stats.pending;
  if (e) e.textContent = stats.errors;
}

// === Log ===
function addLog(message, type = 'info') {
  addLogEntry({
    time: new Date().toLocaleTimeString('vi-VN'),
    message,
    type
  });
}

function addLogEntry(entry) {
  const container = document.getElementById('logContainer');
  const div = document.createElement('div');
  div.className = `log-entry ${entry.type}`;
  div.innerHTML = `
    <span class="time">${entry.time}</span>
    <span>${escapeHtml(entry.message)}</span>
  `;
  container.appendChild(div);

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Giới hạn số dòng log (giữ 200 dòng mới nhất)
  while (container.children.length > 200) {
    container.removeChild(container.firstChild);
  }
}

// === Utilities ===
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: 'check_circle',
    error: 'error',
    warning: 'warning',
    info: 'info'
  };

  toast.innerHTML = `
    <span class="material-symbols-rounded" style="font-size: 20px;">${icons[type] || 'info'}</span>
    ${escapeHtml(message)}
  `;

  document.body.appendChild(toast);

  // Auto remove after 4 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// === Connection UI ===
function updateConnectionUI() {
  const badge = document.getElementById('connectionStatus');
  const text = document.getElementById('connectionText');
  if (isConnected) {
    badge.className = 'conn-badge connected';
    text.textContent = 'Đã kết nối';
  } else {
    badge.className = 'conn-badge disconnected';
    text.textContent = 'Chưa kết nối';
  }
  updateStartButton();
}

// === Keyboard Shortcuts ===
document.addEventListener('keydown', (e) => {
  // Ctrl+Enter to add prompts
  if (e.ctrlKey && e.key === 'Enter') {
    const textarea = document.getElementById('promptTextarea');
    if (document.activeElement === textarea) {
      addPrompts();
    }
  }
});

window.saveGeminiApiKey = function (val) {
  localStorage.setItem('veo3_gemini_api_key', val);
  if (typeof showToast === 'function') showToast('Đã lưu Gemini API Key toàn cục', 'success');
};
window.getGeminiApiKey = function () {
  return localStorage.getItem('veo3_gemini_api_key') || '';
};

// === Khởi tạo
document.addEventListener('DOMContentLoaded', () => {
  const geminiKeyEl = document.getElementById('globalGeminiKey');
  if (geminiKeyEl) geminiKeyEl.value = window.getGeminiApiKey();

  // Tự động tải cookie đã lưu
  fetch('/api/cookies').then(res => res.json()).then(data => {
    if (data.success && data.cookies) {
      const cookieEl = document.getElementById('cookieTextarea');
      if (cookieEl) cookieEl.value = data.cookies;
      const statusSpan = document.getElementById('cookieStatus');
      if (statusSpan) {
        statusSpan.innerText = 'Đã tải tự động';
        statusSpan.className = 'cookie-badge success';
      }
    }
  }).catch(() => { });

  // Load saved settings
  const savedSettings = localStorage.getItem('veo3Settings');
  if (savedSettings) {
    const settings = JSON.parse(savedSettings);
    // Apply settings to UI elements
    for (const key in settings) {
      const el = document.getElementById(key);
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = settings[key];
        } else {
          el.value = settings[key];
        }
      }
    }
    // Special handling for mode
    if (settings.mode) {
      selectMode(settings.mode);
    } else {
      selectMode(currentMode);
    }
  } else {
    selectMode(currentMode); // Ép UI cập nhật lần đầu nếu chưa có saved settings
  }

  renderPromptList();
  updateStatsUI();
  addLog('Ứng dụng đã sẵn sàng. Bước 1: Kết nối Chrome.', 'info');
  loadDownloadDir();
  loadSavedCookies();
  loadHistory();

  // Lightbox
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.id = 'lightbox';
  lightbox.innerHTML = '<button class="lightbox-close" onclick="closeLightbox()"><span class="material-symbols-rounded">close</span></button><img id="lightboxImg" src="" alt="">';
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
  document.body.appendChild(lightbox);
});

// === History & Gallery ===
let allMedia = [];

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (data.success && data.history) {
      // Chuẩn hóa type từ tên file (tránh lỗi video bị gán type='image')
      allMedia = data.history.map(m => normalizeMediaType(m));
      renderGallery();
    }
  } catch (e) { /* ignore */ }
}

// Suy luận type từ tên file nếu field type bị sai hoặc thiếu
function normalizeMediaType(m) {
  const src = m.path || m.filename || m.url || '';
  const ext = src.split('?')[0].split('.').pop().toLowerCase();
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
  const inferredType = videoExts.includes(ext) ? 'video' : 'image';
  return { ...m, type: inferredType };
}

socket.on('newMedia', ({ index, prompt, media }) => {
  showToast(`Phát hiện ${media.length} media mới! Đang tải về...`, 'info');
});

socket.on('mediaDownloaded', async ({ files, prompt }) => {
  const now = new Date().toISOString();
  const newItems = files.map(f => ({
    ...f,
    prompt,
    date: now,
    url: `/api/media?path=${encodeURIComponent(f.path)}`
  })).map(m => normalizeMediaType(m));

  // Chèn lên đầu
  allMedia = [...newItems, ...allMedia];
  renderGallery();
  showToast(`Đã tải xong ${files.length} file!`, 'success');

  // Lưu vào history
  try {
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaList: newItems })
    });
  } catch (e) { /* ignore */ }
});

// ===== GALLERY STATE =====
const galleryState = {
  typeFilter: 'all',       // 'all' | 'image' | 'video'
  dateFrom: '',
  dateTo: '',
  searchQuery: '',
  sortKey: 'date-desc',    // 'date-desc' | 'date-asc' | 'type-image' | 'type-video'
  currentPage: 1,
  rowsPerPage: 4,          // 4 dòng/trang
  cardsPerRow: 4,          // sẽ tự cập nhật theo màn hình
};

// ---- Helper: format date label ----
function formatDateLabel(dateStr) {
  if (!dateStr) return 'Không rõ ngày';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return dateStr; }
}

// ---- Nhóm allMedia theo prompt+ngày ----
function groupMedia(mediaList) {
  const groups = {};
  mediaList.forEach(m => {
    const dateRaw = m.date || m.createdAt || m.timestamp || '';
    const dateKey = dateRaw ? new Date(dateRaw).toDateString() : 'unknown';
    const prompt = (m.prompt || 'Không có prompt').trim();
    const key = `${prompt}||${dateKey}`;
    if (!groups[key]) {
      groups[key] = {
        prompt,
        dateKey,
        dateLabel: dateRaw ? formatDateLabel(dateRaw) : 'Không rõ ngày',
        dateSortVal: dateRaw ? new Date(dateRaw).getTime() : 0,
        items: []
      };
    }
    groups[key].items.push(m);
  });
  return Object.values(groups);
}

// ---- Lấy danh sách nhóm đã lọc + sắp xếp ----
function getFilteredGroups() {
  const q = galleryState.searchQuery.toLowerCase().trim();
  const tf = galleryState.typeFilter;
  const sort = galleryState.sortKey;
  const dfrom = galleryState.dateFrom ? new Date(galleryState.dateFrom).getTime() : null;
  const dto = galleryState.dateTo ? new Date(galleryState.dateTo + 'T23:59:59').getTime() : null;

  let groups = groupMedia(allMedia);

  // Lọc theo type (chỉ giữ nhóm còn ít nhất 1 item phù hợp type)
  if (tf !== 'all') {
    groups = groups.map(g => ({ ...g, items: g.items.filter(m => m.type === tf) }))
      .filter(g => g.items.length > 0);
  }

  // Lọc theo ngày (dùng dateSortVal của nhóm)
  if (dfrom !== null) groups = groups.filter(g => g.dateSortVal >= dfrom);
  if (dto !== null) groups = groups.filter(g => g.dateSortVal <= dto);

  // Lọc theo search query (trong prompt)
  if (q) groups = groups.filter(g => g.prompt.toLowerCase().includes(q));

  // Sắp xếp
  if (sort === 'date-desc') groups.sort((a, b) => b.dateSortVal - a.dateSortVal);
  else if (sort === 'date-asc') groups.sort((a, b) => a.dateSortVal - b.dateSortVal);
  else if (sort === 'type-image') {
    // Nhóm chứa nhiều ảnh lên trước
    groups.sort((a, b) => {
      const ai = a.items.filter(m => m.type === 'image').length;
      const bi = b.items.filter(m => m.type === 'image').length;
      return bi - ai;
    });
  } else if (sort === 'type-video') {
    groups.sort((a, b) => {
      const av = a.items.filter(m => m.type === 'video').length;
      const bv = b.items.filter(m => m.type === 'video').length;
      return bv - av;
    });
  }

  return groups;
}

// ---- Tính số trang (mỗi trang = rowsPerPage dòng, mỗi dòng ≈ 4 cards, tức 1 nhóm) ----
function getTotalPages(groups) {
  // Mỗi nhóm chiếm ít nhất 1 "hàng" (header + 1 dòng cards)
  // Tính số hàng card thực tế của mỗi nhóm: ceil(items.length / cardsPerRow)
  const rpp = galleryState.rowsPerPage;
  let page = 1, rowsLeft = rpp;
  for (const g of groups) {
    const rowsNeeded = Math.ceil(g.items.length / galleryState.cardsPerRow) + 1; // +1 cho header
    if (rowsNeeded > rowsLeft && rowsLeft < rpp) { page++; rowsLeft = rpp; }
    rowsLeft -= rowsNeeded;
    if (rowsLeft <= 0) { if (page < groups.length) { page++; rowsLeft = rpp; } }
  }
  return page;
}

function getGroupsForPage(groups, page) {
  // Đơn giản: phân trang theo nhóm, mỗi trang 4 nhóm
  const perPage = galleryState.rowsPerPage;
  const start = (page - 1) * perPage;
  return groups.slice(start, start + perPage);
}

// ---- RENDER CHÍNH ----
function renderGallery() {
  const section = document.getElementById('gallerySection');
  const gallery = document.getElementById('mediaGallery');
  const countEl = document.getElementById('mediaCount');
  const pagination = document.getElementById('galleryPagination');

  if (allMedia.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.textContent = allMedia.length;

  const groups = getFilteredGroups();
  const totalPages = Math.max(1, Math.ceil(groups.length / galleryState.rowsPerPage));
  if (galleryState.currentPage > totalPages) galleryState.currentPage = totalPages;
  const pageGroups = getGroupsForPage(groups, galleryState.currentPage);

  if (groups.length === 0) {
    gallery.innerHTML = `
      <div class="gallery-empty-state">
        <span class="material-symbols-rounded" style="font-size:40px;opacity:0.3">search_off</span>
        <p style="color:var(--text-muted);margin-top:8px">Không tìm thấy kết quả nào</p>
      </div>`;
    pagination.style.display = 'none';
    return;
  }

  // Build flat ordered lists separated by media type from ALL groups (not just current page)
  const allFlatItems = groups.flatMap(g => g.items);
  window._galleryFlatImageUrls = [];
  window._galleryFlatVideoUrls = [];

  allFlatItems.forEach(m => {
    if ((m.type || 'image') === 'video') {
      m._lbGlobalIdx = window._galleryFlatVideoUrls.length;
      window._galleryFlatVideoUrls.push(m.url);
    } else {
      m._lbGlobalIdx = window._galleryFlatImageUrls.length;
      window._galleryFlatImageUrls.push(m.url);
    }
  });

  // Render current page groups
  gallery.innerHTML = pageGroups.map(g => {
    const imageCount = g.items.filter(m => m.type === 'image').length;
    const videoCount = g.items.filter(m => m.type === 'video').length;
    const badgeHtml = [
      imageCount > 0 ? `<span class="group-badge badge-image"><span class="material-symbols-rounded" style="font-size:12px">image</span>${imageCount} ảnh</span>` : '',
      videoCount > 0 ? `<span class="group-badge badge-video"><span class="material-symbols-rounded" style="font-size:12px">videocam</span>${videoCount} video</span>` : '',
    ].filter(Boolean).join('');

    const cardsHtml = g.items.map(m => {
      const isVideo = (m.type || 'image') === 'video';
      const globalIdx = m._lbGlobalIdx;
      const arrayName = isVideo ? 'window._galleryFlatVideoUrls' : 'window._galleryFlatImageUrls';
      const safeUrl = m.url.replace(/'/g, "\\'");
      return `
        <div class="media-card">
          <div class="media-card-preview" onclick="openLightbox('${safeUrl}', ${arrayName}, ${globalIdx})">
            ${isVideo
          ? `<video src="${m.url}" muted loop preload="metadata" onmouseover="this.play()" onmouseout="this.pause()"></video>`
          : `<img src="${m.url}" alt="media" loading="lazy">`
        }
            <div class="media-type-badge">${isVideo ? '🎬 Video' : '🖼️ Ảnh'}</div>
            <div class="media-overlay">
              <div class="media-actions">
                <button class="media-btn" onclick="event.stopPropagation();window.open('${safeUrl}','_blank')" title="Mở">
                  <span class="material-symbols-rounded">open_in_new</span>
                </button>
                <button class="media-btn" onclick="event.stopPropagation();openLightbox('${safeUrl}', ${arrayName}, ${globalIdx})" title="Phóng to">
                  <span class="material-symbols-rounded">fullscreen</span>
                </button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="media-group">
        <div class="media-group-header">
          <div class="media-group-prompt" title="${escapeHtml(g.prompt)}">
            <span class="material-symbols-rounded" style="font-size:16px;color:var(--accent)">chat</span>
            <span class="media-group-prompt-text">${escapeHtml(g.prompt)}</span>
          </div>
          <div class="media-group-meta">
            ${badgeHtml}
            <span class="media-group-date">
              <span class="material-symbols-rounded" style="font-size:13px">schedule</span>
              ${g.dateLabel}
            </span>
          </div>
        </div>
        <div class="media-group-cards">${cardsHtml}</div>
      </div>`;
  }).join('');

  // Pagination
  if (totalPages > 1) {
    pagination.style.display = 'flex';
    renderPageNumbers(totalPages);
    document.getElementById('pagePrev').disabled = galleryState.currentPage <= 1;
    document.getElementById('pageNext').disabled = galleryState.currentPage >= totalPages;
  } else {
    pagination.style.display = 'none';
  }
}

function renderPageNumbers(totalPages) {
  const container = document.getElementById('pageNumbers');
  const cur = galleryState.currentPage;
  let html = '';
  const maxVisible = 7;

  if (totalPages <= maxVisible) {
    for (let i = 1; i <= totalPages; i++) {
      html += `<button class="page-num ${i === cur ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }
  } else {
    const pages = new Set([1, totalPages, cur]);
    for (let i = Math.max(1, cur - 1); i <= Math.min(totalPages, cur + 1); i++) pages.add(i);
    const sorted = [...pages].sort((a, b) => a - b);
    let prev = 0;
    for (const p of sorted) {
      if (p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
      html += `<button class="page-num ${p === cur ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
      prev = p;
    }
  }
  container.innerHTML = html;
}

function goToPage(n) {
  galleryState.currentPage = n;
  renderGallery();
  document.getElementById('gallerySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changePage(delta) {
  const groups = getFilteredGroups();
  const total = Math.max(1, Math.ceil(groups.length / galleryState.rowsPerPage));
  galleryState.currentPage = Math.min(total, Math.max(1, galleryState.currentPage + delta));
  renderGallery();
  document.getElementById('gallerySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onGalleryFilterChange() {
  galleryState.searchQuery = document.getElementById('gallerySearch')?.value || '';
  galleryState.sortKey = document.getElementById('gallerySortSelect')?.value || 'date-desc';
  galleryState.dateFrom = document.getElementById('galleryDateFrom')?.value || '';
  galleryState.dateTo = document.getElementById('galleryDateTo')?.value || '';
  const clearBtn = document.getElementById('galleryClearSearch');
  if (clearBtn) clearBtn.style.display = galleryState.searchQuery ? 'flex' : 'none';
  galleryState.currentPage = 1;
  renderGallery();
}

function setGalleryFilter(el, filterType, value) {
  if (filterType === 'type') {
    galleryState.typeFilter = value;
    document.querySelectorAll('.gallery-filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
  }
  galleryState.currentPage = 1;
  renderGallery();
}

function clearGallerySearch() {
  const inp = document.getElementById('gallerySearch');
  if (inp) inp.value = '';
  galleryState.searchQuery = '';
  const clearBtn = document.getElementById('galleryClearSearch');
  if (clearBtn) clearBtn.style.display = 'none';
  galleryState.currentPage = 1;
  renderGallery();
}

function clearDateFilter() {
  const df = document.getElementById('galleryDateFrom');
  const dt = document.getElementById('galleryDateTo');
  if (df) df.value = '';
  if (dt) dt.value = '';
  galleryState.dateFrom = '';
  galleryState.dateTo = '';
  galleryState.currentPage = 1;
  renderGallery();
}


// ════════ UNIFIED LIGHTBOX ════════
// Hỗ trợ 2 cú pháp:
//   openLightbox(url, 'video')        — từ WFB/gallery (cũ)
//   openLightbox(url, 'image')        — từ WFB/gallery (cũ)
//   openLightbox(url, [urls], index)  — từ Store gallery (mới)
let _lbImages = [];
let _lbIndex = 0;

function openLightbox(url, typeOrArray = null, startIndex = 0) {
  if (!url) return;

  // Phân biệt cú pháp: array gallery vs type string (WFB legacy)
  const isGallery = Array.isArray(typeOrArray);
  // In gallery mode: pass null so _lbRender auto-detects video vs image per URL
  // In legacy string mode: honour the explicit type passed (e.g. 'video' from WFB)
  const mediaType = (!isGallery && typeof typeOrArray === 'string') ? typeOrArray : null;

  _lbImages = isGallery ? typeOrArray : [url];
  _lbIndex = isGallery ? startIndex : 0;

  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;

  _lbRender(mediaType);
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function _lbRender(forcedType = null) {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;

  const src = _lbImages[_lbIndex] || '';
  const counter = document.getElementById('lbCounter');
  const prevBtn = document.getElementById('lbPrev');
  const nextBtn = document.getElementById('lbNext');
  const strip = document.getElementById('lbThumbStrip');

  // Xác định type: ưu tiên forcedType, fallback theo extension
  const type = forcedType || (src.match(/\.(mp4|webm|mov|ogg)(\?|$)/i) ? 'video' : 'image');

  let imgEl = document.getElementById('lightboxImg');
  let vidEl = document.getElementById('lightboxVid');

  if (type === 'video') {
    if (imgEl) imgEl.style.display = 'none';
    if (!vidEl) {
      vidEl = document.createElement('video');
      vidEl.id = 'lightboxVid';
      vidEl.controls = true;
      vidEl.autoplay = true;
      vidEl.style.cssText = 'max-width:74vw;max-height:72vh;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,0.8);cursor:default;flex-shrink:0;';
      vidEl.onclick = e => e.stopPropagation();
      if (imgEl) imgEl.after(vidEl); else overlay.appendChild(vidEl);
    }
    vidEl.style.display = '';
    if (vidEl.src !== src) { vidEl.src = src; vidEl.load(); vidEl.play().catch(() => { }); }
  } else {
    if (vidEl) { vidEl.pause(); vidEl.style.display = 'none'; }
    if (!imgEl) {
      imgEl = document.createElement('img');
      imgEl.id = 'lightboxImg';
      imgEl.alt = '';
      imgEl.style.cssText = 'max-width:74vw;max-height:72vh;object-fit:contain;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,0.8);cursor:default;flex-shrink:0;';
      imgEl.onclick = e => e.stopPropagation();
      overlay.appendChild(imgEl);
    }
    imgEl.style.display = '';
    imgEl.style.animation = 'none';
    requestAnimationFrame(() => {
      imgEl.style.animation = 'lbFadeIn 0.18s ease';
      imgEl.src = src;
    });
  }

  // Multi-image nav + thumbnail strip
  const multi = _lbImages.length > 1;
  if (prevBtn) prevBtn.style.display = multi ? 'flex' : 'none';
  if (nextBtn) nextBtn.style.display = multi ? 'flex' : 'none';
  if (counter) {
    counter.style.display = multi ? 'block' : 'none';
    if (multi) counter.textContent = `${_lbIndex + 1} / ${_lbImages.length}`;
  }

  // ── Right-side thumbnail strip ──────────────────────────────────────
  if (strip) {
    if (!multi) {
      strip.style.display = 'none';
    } else {
      strip.style.display = 'flex';
      // Only rebuild DOM if image set changed
      if (strip.dataset.images !== _lbImages.join('|')) {
        strip.dataset.images = _lbImages.join('|');

        // Separate images and videos while keeping original global index
        const imageItems = [];
        const videoItems = [];
        _lbImages.forEach((url, idx) => {
          if (/\.(mp4|webm|mov|ogg)/i.test(url)) videoItems.push({ url, idx });
          else imageItems.push({ url, idx });
        });

        // Build a thumb card — videos use a real <video> seeking to 1s for a frame thumbnail
        function _makeThumbCard(url, globalIdx) {
          const isVid = /\.(mp4|webm|mov|ogg)/i.test(url);
          const mediaEl = isVid
            ? `<video src="${url}" muted preload="metadata"
                style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;"
                onloadedmetadata="this.currentTime=1"
                onerror="this.outerHTML='<span class=\\'material-symbols-rounded\\' style=\\'font-size:20px;color:rgba(255,255,255,0.35)\\'>videocam</span>'"></video>`
            : `<img src="${url}"
                style="width:100%;height:100%;object-fit:cover;display:block;"
                onerror="this.outerHTML='<span class=\\'material-symbols-rounded\\' style=\\'font-size:20px;color:rgba(255,255,255,0.35)\\'>image</span>'">`;
          return `
            <div id="lbThumb_${globalIdx}" data-lbidx="${globalIdx}"
              onclick="event.stopPropagation(); window._lbGoTo(${globalIdx})"
              style="flex-shrink:0; width:66px; height:54px; border-radius:8px; overflow:hidden;
                     cursor:pointer; border:2px solid transparent; transition:all 0.15s;
                     background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center;"
              onmouseover="this.style.opacity='1'; this.style.transform='scale(1.04)'"
              onmouseout="this.style.transform='scale(1)'">${mediaEl}</div>`;
        }

        const sectionLabel = (icon, count) => `
          <div style="font-size:10px;color:rgba(255,255,255,0.38);text-align:center;
                      padding:3px 0;letter-spacing:0.4px;flex-shrink:0;">${icon} ${count}</div>`;

        let html = '';
        if (imageItems.length > 0) {
          if (videoItems.length > 0) html += sectionLabel('🖼️', imageItems.length);
          html += imageItems.map(({ url, idx }) => _makeThumbCard(url, idx)).join('');
        }
        if (videoItems.length > 0) {
          if (imageItems.length > 0) {
            html += `<div style="height:1px;background:rgba(255,255,255,0.08);margin:4px 4px;flex-shrink:0;"></div>`;
            html += sectionLabel('🎬', videoItems.length);
          }
          html += videoItems.map(({ url, idx }) => _makeThumbCard(url, idx)).join('');
        }
        strip.innerHTML = html;
      }

      // Highlight active thumb using data-lbidx (robust against reordering)
      strip.querySelectorAll('[data-lbidx]').forEach(el => {
        const isActive = parseInt(el.dataset.lbidx, 10) === _lbIndex;
        el.style.borderColor = isActive ? '#8b5cf6' : 'transparent';
        el.style.boxShadow = isActive ? '0 0 0 1px rgba(139,92,246,0.5)' : '';
        el.style.opacity = isActive ? '1' : '0.55';
        if (isActive) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }
}

function lightboxNav(dir) {
  _lbIndex = (_lbIndex + dir + _lbImages.length) % _lbImages.length;
  _lbRender();
}

function _lbGoTo(idx) {
  _lbIndex = Math.max(0, Math.min(idx, _lbImages.length - 1));
  _lbRender();
}

function closeLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';

  // Dừng video khi đóng
  const vid = document.getElementById('lightboxVid');
  if (vid) { vid.pause(); vid.src = ''; }

  // Compat: dừng video trong lightbox cũ (id=lightbox)
  const oldLb = document.getElementById('lightbox');
  if (oldLb) {
    oldLb.classList.remove('active');
    const v = oldLb.querySelector('video');
    if (v) v.pause();
  }

  _lbImages = [];
  _lbIndex = 0;
}

// Gán lên window — bắt buộc để WFB IIFE + inline HTML onclick gọi được
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.lightboxNav = lightboxNav;
window._lbGoTo = _lbGoTo;

// Phím tắt: Escape đóng, ← → chuyển ảnh/video
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxNav(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNav(1); }
});

async function downloadMedia(index) {
  const media = allMedia[index];
  if (!media) return;

  const cleanPrompt = (media.prompt || 'untitled').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s]/g, '').trim().substring(0, 40).replace(/\s+/g, '_');
  const ext = media.type === 'video' ? 'mp4' : 'png';
  const filename = media.id ? `${cleanPrompt}_${media.id}.${ext}` : `${cleanPrompt}_${Date.now()}.${ext}`;

  showToast(`Đang tải ${filename}...`, 'info');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: media.url, filename })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Đã tải: ${data.filename}`, 'success');
    } else {
      showToast(`Lỗi tải: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

async function downloadAllMedia() {
  if (allMedia.length === 0) return;
  showToast(`Đang tải ${allMedia.length} file...`, 'info');
  for (let i = 0; i < allMedia.length; i++) {
    await downloadMedia(i);
    await new Promise(r => setTimeout(r, 500));
  }
  showToast(`Hoàn thành tải ${allMedia.length} file!`, 'success');
}

async function clearGallery() {
  const confirmed = await window.wfbConfirm('Xóa lịch sử?', 'Xóa tất cả kết quả hiển thị và lịch sử? (File gốc trong máy vẫn được giữ nguyên)', 'Xóa lịch sử', '#ef4444');
  if (!confirmed) return;

  allMedia = [];
  renderGallery();
  fetch('/api/history', { method: 'DELETE' }).catch(() => { });
}

// === Download Directory ===
async function loadDownloadDir() {
  try {
    const res = await fetch('/api/download-dir');
    const data = await res.json();
    document.getElementById('downloadDir').value = data.dir || '';
  } catch (e) { /* ignore */ }
}

async function updateDownloadDir() {
  const dir = document.getElementById('downloadDir').value.trim();
  if (!dir) {
    showToast('Vui lòng nhập đường dẫn thư mục', 'warning');
    return;
  }
  try {
    const res = await fetch('/api/download-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Thư mục lưu: ${data.dir}`, 'success');
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

async function selectFolderDialog() {
  try {
    const res = await fetch('/api/select-folder');
    const data = await res.json();
    if (data.success && data.path) {
      document.getElementById('downloadDir').value = data.path;
      updateDownloadDir(); // Tự động lưu
    }
  } catch (e) {
    showToast('Không thể mở hộp thoại chọn thư mục', 'warning');
  }
}

// === CAPTCHA MODE ===
let _captchaStatusTimer = null;

async function loadCaptchaStatus() {
  try {
    const res = await fetch('/api/captcha-status');
    const d = await res.json();

    // ── Update status badge ──
    const badge = document.getElementById('captchaStatusBadge');
    if (badge) {
      const badgeMap = {
        chrome_connected: { text: 'Chrome Connected ●', bg: 'rgba(52,211,153,0.15)', color: '#34d399' },
        waiting_for_chrome: { text: 'Waiting for Chrome…', bg: 'rgba(251,191,36,0.12)', color: '#fbbf24' },
        brave_connected: { text: 'Brave Active', bg: 'rgba(138,92,246,0.15)', color: '#a78bfa' },
        no_extension: { text: 'No Extension', bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
        server_offline: { text: 'Server Offline', bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
        error: { text: 'Error', bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
      };
      const b = badgeMap[d.status] || { text: d.status, bg: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' };
      badge.textContent = b.text;
      badge.style.background = b.bg;
      badge.style.color = b.color;
    }

    // ── Update toggle buttons ──
    const btnAuto = document.getElementById('captchaModeAuto');
    const btnChrome = document.getElementById('captchaModeRealChrome');
    const instructions = document.getElementById('captchaChromeInstructions');

    if (btnAuto && btnChrome) {
      const isAuto = d.mode !== 'real_chrome';
      // Active = purple fill
      btnAuto.style.borderColor = isAuto ? 'rgba(138,92,246,0.6)' : 'rgba(255,255,255,0.1)';
      btnAuto.style.background = isAuto ? 'rgba(138,92,246,0.2)' : 'rgba(255,255,255,0.04)';
      btnAuto.style.color = isAuto ? '#c4b5fd' : 'rgba(255,255,255,0.4)';
      btnChrome.style.borderColor = !isAuto ? 'rgba(52,211,153,0.6)' : 'rgba(255,255,255,0.1)';
      btnChrome.style.background = !isAuto ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.04)';
      btnChrome.style.color = !isAuto ? '#34d399' : 'rgba(255,255,255,0.4)';
    }

    if (instructions) {
      instructions.style.display = d.mode === 'real_chrome' ? 'block' : 'none';
    }
  } catch (e) { /* settings modal may not be open */ }
}

async function setCaptchaMode(mode) {
  try {
    const res = await fetch('/api/captcha-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (data.success) {
      const label = mode === 'real_chrome' ? 'Real Chrome ✨' : 'Auto (Brave)';
      showToast(`Captcha mode: ${label} — Khởi động lại app để áp dụng`, 'warning');
      loadCaptchaStatus(); // Refresh UI immediately
    } else {
      showToast('Lỗi thay đổi chế độ captcha', 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.style.display = 'flex';
    loadDownloadDir();
    // Clear any stale timer before starting a fresh one
    if (_captchaStatusTimer) { clearInterval(_captchaStatusTimer); _captchaStatusTimer = null; }
    loadCaptchaStatus();
    _captchaStatusTimer = setInterval(loadCaptchaStatus, 4000);
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
  if (_captchaStatusTimer) { clearInterval(_captchaStatusTimer); _captchaStatusTimer = null; }
  if (typeof _extStatusTimer !== 'undefined' && _extStatusTimer) { clearInterval(_extStatusTimer); _extStatusTimer = null; }
}

// === EXTENSION CAPTCHA TAB LOGIC ===
let _extStatusTimer = null;

function switchSettingsTab(tab) {
  document.getElementById('tabSettingsChung').style.borderColor = (tab === 'chung') ? '#8b5cf6' : 'transparent';
  document.getElementById('tabSettingsChung').style.color = (tab === 'chung') ? '#a78bfa' : 'var(--text-muted)';
  document.getElementById('tabSettingsExt').style.borderColor = (tab === 'ext') ? '#8b5cf6' : 'transparent';
  document.getElementById('tabSettingsExt').style.color = (tab === 'ext') ? '#a78bfa' : 'var(--text-muted)';
  
  document.getElementById('bodySettingsChung').style.display = (tab === 'chung') ? 'block' : 'none';
  document.getElementById('bodySettingsExt').style.display = (tab === 'ext') ? 'block' : 'none';

  if (tab === 'ext') {
    checkExtHealth();
    if (!_extStatusTimer) _extStatusTimer = setInterval(checkExtHealth, 4000);
  } else {
    if (_extStatusTimer) { clearInterval(_extStatusTimer); _extStatusTimer = null; }
  }
}

async function checkExtHealth() {
  const SERVER = 'http://127.0.0.1:3456';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(`${SERVER}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const n = d.connectedClients ?? 0;
    
    document.getElementById('ext-server-dot').style.background = '#10b981';
    document.getElementById('ext-server-dot').style.boxShadow = '0 0 8px rgba(16,185,129,0.4)';
    document.getElementById('ext-server-status').textContent = n > 0 ? `${n} client(s)` : '0 clients';
  } catch (e) {
    document.getElementById('ext-server-dot').style.background = '#ef4444';
    document.getElementById('ext-server-dot').style.boxShadow = '0 0 8px rgba(239,68,68,0.4)';
    document.getElementById('ext-server-status').textContent = 'Not running';
  }
}

function testCaptchaExt() {
  showToast('Đang gửi yêu cầu test Captcha...', 'info');
  fetch('http://127.0.0.1:3456/captcha?action=IMAGE_GENERATION')
    .then(r => r.json())
    .then(d => {
      if (d.captcha) showToast(`✅ Giải thành công! Token: ${d.captcha.substring(0,25)}...`, 'success');
      else showToast(`❌ Lỗi API: ${d.error || 'No token'}`, 'error');
    }).catch(e => showToast(`❌ Lỗi kết nối Captcha Server.`, 'error'));
}

function forceRefreshExt() {
  showToast('Đang gửi lệnh tải lại trang cho Extension...', 'info');
  fetch('http://127.0.0.1:3456/force-refresh', { method: 'POST' })
    .catch(e => console.log(e));
}

// === TAB SWITCHING ===
let builderInitialized = false;

function switchTab(tab) {
  // 1. Cập nhật trạng thái active cho các nút trên Top Nav
  document.getElementById('tabPrompt').classList.toggle('active', tab === 'prompt');

  const tabBuilder = document.getElementById('tabBuilder');
  if (tabBuilder) tabBuilder.classList.toggle('active', tab === 'builder');

  const tabStore = document.getElementById('tabStore');
  if (tabStore) tabStore.classList.toggle('active', tab === 'store');

  // 2. Hiển thị nội dung Tab tương ứng trong cột giữa (main)
  document.getElementById('promptTab').style.display = tab === 'prompt' ? 'block' : 'none';

  const builderTab = document.getElementById('builderTab');
  if (builderTab) builderTab.style.display = tab === 'builder' ? 'block' : 'none';

  const storeTab = document.getElementById('storeTab');
  if (storeTab) storeTab.style.display = tab === 'store' ? 'block' : 'none';

  // 3. Xử lý ẩn/hiện các Panel hai bên
  // Gọi updatePanelsUI để xử lý theo trạng thái tab mới nhất
  updatePanelsUI();

  // 4. Cập nhật class cho Layout Wrapper (nếu cần để css tự bung full màn) và cập nhật body data-tab
  const layout = document.getElementById('promptLayoutWrapper');
  if (layout) {
    if (tab === 'store' || tab === 'builder') {
      layout.classList.add('builder-active');
    } else {
      layout.classList.remove('builder-active');
    }
  }
  document.body.setAttribute('data-tab', tab);

  // 5. Ẩn bottom-bar (taskbar bắt đầu tạo) khi sang Builder hoặc Store
  const bottomBar = document.querySelector('.bottom-bar');
  if (bottomBar) bottomBar.style.display = (tab === 'builder' || tab === 'store') ? 'none' : '';

  // 6. Khởi tạo Builder canvas nếu cần
  if (tab === 'builder' && !builderInitialized && typeof WFB !== 'undefined') {
    setTimeout(() => { WFB.init(); builderInitialized = true; }, 100);
  }

  // 7. Gọi resize cho Canvas của Builder nếu đang mở tab Builder
  if (tab === 'builder') {
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      if (typeof WFB !== 'undefined' && typeof WFB.resize === 'function') {
        WFB.resize();
      }
    }, 50);
  }

  // 8. Tải Store khi mở tab Store lần đầu (lazy load)
  if (tab === 'store') {
    if (typeof loadStoreProducts === 'function') {
      // Chỉ tải nếu chưa có sản phẩm trong cache
      if (!window._storeLoaded) {
        window._storeLoaded = true;
        loadStoreProducts();
      }
    }
  } else {
    // Nếu rời khỏi Store, dừng poll thanh toán nếu đang chạy
    if (typeof _stopStorePaymentPoll === 'function') {
      _stopStorePaymentPoll();
    }
  }
}


function openExternalBrowser(url) {
  fetch('/api/open-browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  }).catch(err => console.error('Failed to open browser:', err));
}

function toggleConnectPanel() {
  const panel = document.getElementById('connectPanel');
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'flex' : 'none';
}

// Legacy stubs — panels now always visible
function toggleSettingsDrawer() { }
function toggleLogDrawer() { }
function updateAppLayout() {
  // Kích hoạt sự kiện resize để WFB canvas tự động tính toán lại kích thước
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    if (typeof WFB !== 'undefined' && typeof WFB.resize === 'function') {
      WFB.resize();
    }
  }, 50);
}



// === COOKIE POOL MANAGEMENT (Option A — Dynamic) ===

let _activePoolTab = 0;    // which slot tab is currently visible
let _poolSlots = [];       // last-known slot list from API
let _countdownTimer = null; // interval handle for live expiry countdown

// ── Helpers ─────────────────────────────────────────────────────────

/** Format milliseconds remaining as "Xh Ym" or "Expired" */
function _formatRemaining(remainingMs) {
  if (remainingMs == null) return '';
  if (remainingMs <= 0) return 'Hết hạn';
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor((remainingMs % 60_000) / 1_000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Pick expiry badge colour based on time remaining */
function _expiryColor(remainingMs, isExpired) {
  if (isExpired || remainingMs === 0) return '#ef4444';       // red
  if (remainingMs < 2 * 3_600_000) return '#f97316';       // orange — < 2h
  if (remainingMs < 6 * 3_600_000) return '#fbbf24';       // yellow — < 6h
  return '#34d399';                                            // green — fresh
}

// ── Tab Switching ────────────────────────────────────────────────────

function switchPoolTab(slot) {
  _activePoolTab = slot;
  // Update tab active state
  document.querySelectorAll('.pool-tab[data-slot]').forEach(btn => {
    const s = parseInt(btn.dataset.slot, 10);
    btn.classList.toggle('active', s === slot);
  });
  // Show matching panel, hide others
  document.querySelectorAll('.pool-slot-panel').forEach(panel => {
    const s = parseInt(panel.dataset.slot, 10);
    panel.style.display = s === slot ? 'block' : 'none';
  });
}

// ── Add Account ──────────────────────────────────────────────────────

function addCookieSlot() {
  // Next available slot index = max existing + 1, or 0 if empty
  const nextSlot = _poolSlots.length > 0
    ? Math.max(..._poolSlots.map(s => s.slot)) + 1
    : 0;
  const phantomSlot = {
    slot: nextSlot,
    label: `Account ${nextSlot + 1}`,
    exists: false,
    cookieCount: 0,
    isActive: false,
    savedAt: null,
    expiresAt: null,
    remainingMs: null,
    isExpired: false,
    _phantom: true,   // local-only flag
  };
  _renderSlot(phantomSlot, true);
  switchPoolTab(nextSlot);
}

/**
 * Remove a slot from _poolSlots and rebuild just the tabs + panels
 * without fetching from the server. Used for phantom (never-saved) slots.
 */
function _removeSlotLocally(slot) {
  _poolSlots = _poolSlots.filter(s => s.slot !== slot);
  // Rebuild tabs
  const tabRow = document.getElementById('poolTabRow');
  if (tabRow) {
    tabRow.querySelectorAll('.pool-tab[data-slot]').forEach(el => el.remove());
    const addBtn = tabRow.querySelector('.pool-add-btn');
    _poolSlots.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'pool-tab' + (s.slot === _activePoolTab ? ' active' : '');
      btn.dataset.slot = s.slot;
      btn.onclick = () => switchPoolTab(s.slot);
      const dotColor = s.isExpired ? '#ef4444' : (s.exists ? '#34d399' : 'rgba(255,255,255,0.3)');
      btn.innerHTML = `<span style="font-size:8px;color:${dotColor};line-height:1;">${s.exists ? '●' : '○'}</span> ${s.label}`;
      if (s.isActive) { btn.style.borderColor = 'rgba(52,211,153,0.6)'; btn.style.color = '#34d399'; }
      if (addBtn) tabRow.insertBefore(btn, addBtn); else tabRow.appendChild(btn);
    });
  }
  // Rebuild panels
  const container = document.getElementById('poolSlotContainer');
  if (container) {
    container.innerHTML = '';
    _poolSlots.forEach(s => container.appendChild(_buildSlotPanel(s)));
  }
  // Switch to nearest slot
  if (_poolSlots.length > 0) {
    if (!_poolSlots.find(s => s.slot === _activePoolTab)) {
      _activePoolTab = _poolSlots[_poolSlots.length - 1].slot;
    }
    switchPoolTab(_activePoolTab);
  }
}

// ── Render ───────────────────────────────────────────────────────────

/** Build the full pool UI from API data */
function _renderPoolUI(data) {
  // Preserve any phantom (local-only, never-saved) slots the user added via "+"
  // They don't exist on the server, so re-fetching would wipe them.
  const phantoms = _poolSlots.filter(s => s._phantom === true);

  const serverSlots = data.slots || [];
  // Merge: server slots come first, then phantoms whose index doesn't conflict
  const serverIndices = new Set(serverSlots.map(s => s.slot));
  const survivingPhantoms = phantoms.filter(p => !serverIndices.has(p.slot));
  _poolSlots = [...serverSlots, ...survivingPhantoms].sort((a, b) => a.slot - b.slot);

  // ── Status bar ──
  const statusBar = document.getElementById('poolStatusBar');
  if (statusBar) {
    statusBar.style.display = _poolSlots.length > 0 ? 'flex' : 'none';
    const activeSlot = _poolSlots.find(s => s.isActive) || _poolSlots[0];
    const lblText = activeSlot ? activeSlot.label : `Account ${(data.activeIndex || 0) + 1}`;
    document.getElementById('poolStatusText').textContent = `Đang dùng: ${lblText}`;
    const sc = document.getElementById('poolSwitchCount');
    if (sc) sc.textContent = data.switchCount ? `⚡ ${data.switchCount} lần chuyển` : '';
  }

  // ── Tab row ──
  const tabRow = document.getElementById('poolTabRow');
  if (tabRow) {
    // Remove old tabs (keep the Add button)
    tabRow.querySelectorAll('.pool-tab[data-slot]').forEach(el => el.remove());
    const addBtn = tabRow.querySelector('.pool-add-btn');

    _poolSlots.forEach(slot => {
      const btn = document.createElement('button');
      btn.className = 'pool-tab' + (slot.slot === _activePoolTab ? ' active' : '');
      btn.dataset.slot = slot.slot;
      btn.onclick = () => switchPoolTab(slot.slot);

      const dotColor = slot.isExpired ? '#ef4444' : (slot.exists ? '#34d399' : 'rgba(255,255,255,0.3)');
      const dot = slot.exists ? '●' : '○';
      btn.innerHTML = `<span style="font-size:8px;color:${dotColor};line-height:1;">${dot}</span> ${slot.label}`;
      if (slot.isActive) {
        btn.style.borderColor = 'rgba(52,211,153,0.6)';
        btn.style.color = '#34d399';
      }
      if (addBtn) tabRow.insertBefore(btn, addBtn);
      else tabRow.appendChild(btn);
    });
  }

  // ── Slot panels ──
  const container = document.getElementById('poolSlotContainer');
  if (container) {
    container.innerHTML = '';
    _poolSlots.forEach(slot => {
      container.appendChild(_buildSlotPanel(slot));
    });
  }

  // Start/restart live countdown
  _startCountdown();

  // If activePoolTab no longer exists, reset to first slot
  if (_poolSlots.length > 0 && !_poolSlots.find(s => s.slot === _activePoolTab)) {
    _activePoolTab = _poolSlots[0].slot;
  }
  switchPoolTab(_activePoolTab);
}

/** Build a single slot panel DOM element */
function _buildSlotPanel(slot) {
  const panel = document.createElement('div');
  panel.className = 'pool-slot-panel';
  panel.dataset.slot = slot.slot;
  panel.style.display = slot.slot === _activePoolTab ? 'block' : 'none';

  const expiryColor = slot.exists ? _expiryColor(slot.remainingMs, slot.isExpired) : 'rgba(255,255,255,0.3)';
  const expiryText = slot.exists ? _formatRemaining(slot.remainingMs) : '';
  const savedText = slot.savedAt
    ? `Lưu lúc ${new Date(slot.savedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ${new Date(slot.savedAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`
    : '';

  panel.innerHTML = `
    ${slot.exists ? `
    <div style="display:flex; align-items:center; gap:8px; padding:8px 12px;
      background:rgba(52,211,153,0.06); border:1px solid rgba(52,211,153,0.2);
      border-radius:8px; margin-bottom:8px;">
      <span class="material-symbols-rounded" style="font-size:15px; color:#34d399;">check_circle</span>
      <div style="flex:1; min-width:0;">
        <div style="font-size:11px; color:#34d399; font-weight:600;">${slot.cookieCount ? `${slot.cookieCount} cookie` : 'Đã lưu'} &nbsp;·&nbsp; <span style="opacity:0.7;">${savedText}</span></div>
        <div style="display:flex; align-items:center; gap:5px; margin-top:2px;">
          <span class="material-symbols-rounded" style="font-size:12px; color:${expiryColor};">schedule</span>
          <span id="expiryLabel_${slot.slot}" style="font-size:10px; color:${expiryColor}; font-weight:700;">${expiryText}</span>
          ${slot.expiresAt ? `<span style="font-size:9px; opacity:0.5;">· hết ${new Date(slot.expiresAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
        </div>
      </div>
      ${slot.isActive ? `<span style="font-size:10px; font-weight:700; color:#34d399; white-space:nowrap;">● Đang dùng</span>` : ``}
    </div>` : ''}

    <div class="connect-desc" style="margin-bottom:6px;">
      <span class="material-symbols-rounded" style="font-size:14px; color:var(--warning);">key</span>
      Cookie ${slot.label}${slot.isExpired ? ' <span style="color:#ef4444;font-weight:700;">[HẾT HẠN]</span>' : ''}
    </div>
    <textarea id="cookieTextarea_${slot.slot}" class="cookie-textarea"
      placeholder="Dán cookie ${slot.label}...&#10;&#10;Hỗ trợ JSON array hoặc key=value;key=value"
      style="${slot.exists ? 'opacity:0.5;' : ''}"></textarea>
    <div class="connect-btn-row" style="margin-top:6px;">
      <button class="btn btn-primary" onclick="saveCookieSlot(${slot.slot})">
        <span class="material-symbols-rounded" style="font-size:15px;">save</span> Lưu
      </button>
      <button class="btn" onclick="renameCookieSlot(${slot.slot})" title="Đổi tên">
        <span class="material-symbols-rounded" style="font-size:15px;">edit</span>
      </button>
      <button class="btn" onclick="deleteCookieSlot(${slot.slot})" title="Xóa slot">
        <span class="material-symbols-rounded" style="font-size:15px;">delete</span>
      </button>
    </div>
  `;
  return panel;
}

/** Render a new empty slot immediately (before server confirms) */
function _renderSlot(slot, asNew = false) {
  const container = document.getElementById('poolSlotContainer');
  const tabRow = document.getElementById('poolTabRow');
  if (!container || !tabRow) return;

  // Add tab
  const addBtn = tabRow.querySelector('.pool-add-btn');
  const btn = document.createElement('button');
  btn.className = 'pool-tab';
  btn.dataset.slot = slot.slot;
  btn.onclick = () => switchPoolTab(slot.slot);
  btn.innerHTML = `<span style="font-size:8px;color:rgba(255,255,255,0.3);line-height:1;">○</span> ${slot.label}`;
  if (addBtn) tabRow.insertBefore(btn, addBtn); else tabRow.appendChild(btn);

  // Add panel
  const panel = _buildSlotPanel(slot);
  container.appendChild(panel);

  if (!_poolSlots.find(s => s.slot === slot.slot)) _poolSlots.push(slot);
}

// ── Live Countdown ───────────────────────────────────────────────────

function _startCountdown() {
  if (_countdownTimer) clearInterval(_countdownTimer);
  _countdownTimer = setInterval(_tickCountdown, 1_000);
}

function _tickCountdown() {
  const now = Date.now();
  _poolSlots.forEach(slot => {
    if (!slot.expiresAt) return;
    const remaining = Math.max(0, slot.expiresAt - now);
    const isExpired = remaining === 0;
    const label = document.getElementById(`expiryLabel_${slot.slot}`);
    if (!label) return;
    label.textContent = _formatRemaining(remaining);
    const color = _expiryColor(remaining, isExpired);
    label.style.color = color;
    // Update panel border if about to expire
    const panel = document.querySelector(`.pool-slot-panel[data-slot="${slot.slot}"]`);
    if (panel && isExpired) {
      panel.style.outline = '1px solid rgba(239,68,68,0.4)';
      panel.style.borderRadius = '8px';
    }
    // Warn once when <30min left
    if (!slot._warnedExpiry && remaining > 0 && remaining < 30 * 60_000) {
      slot._warnedExpiry = true;
      showToast(`⏳ Cookie ${slot.label} còn dưới 30 phút — hãy cập nhật!`, 'warning');
    }
  });
}

// ── API Calls ────────────────────────────────────────────────────────

async function loadCookiePool() {
  try {
    const res = await fetch('/api/cookie-pool');
    const data = await res.json();
    if (!data.success) return;
    _renderPoolUI(data);
  } catch (e) { /* ignore */ }
}

async function saveCookieSlot(slot) {
  // Support both old numeric IDs and new dynamic IDs
  const ta = document.getElementById(`cookieTextarea_${slot}`) || document.getElementById(`cookieTextarea${slot}`);
  const cookies = ta ? ta.value.trim() : '';
  if (!cookies) { showToast('Vui lòng dán cookie vào ô nhập!', 'warning'); return; }

  try {
    const res = await fetch('/api/cookie-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, cookies })
    });
    const data = await res.json();
    if (data.success) {
      const expiresStr = data.expiresAt
        ? new Date(data.expiresAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
        : '';
      showToast(`✅ Đã lưu cookie Account ${slot + 1} (${data.cookieCount} cookie)${expiresStr ? ` — hết hạn ${expiresStr}` : ''}`, 'success');
      // Mirror to legacy slot-0 & cookies.json so auto-launch works
      if (slot === 0) {
        localStorage.setItem('veo3_cookies', cookies);
        await fetch('/api/cookies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies, projectUrl: document.getElementById('projectUrl')?.value || '' })
        });
      }
      await loadCookiePool();
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

async function renameCookieSlot(slot) {
  const slotInfo = _poolSlots.find(s => s.slot === slot);
  const currentLabel = slotInfo ? slotInfo.label : `Account ${slot + 1}`;

  // Custom dialog to bypass Electron's native prompt block
  const getPrompt = () => new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1a2e;padding:20px;border-radius:12px;border:1px solid #6366f1;width:320px;font-family:Inter,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.5);';
    box.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:white;margin-bottom:12px;">Đổi tên ${currentLabel}:</div>
      <input type="text" id="_cpInput" value="${currentLabel}" style="width:100%;padding:10px;background:rgba(0,0,0,0.2);border:1px solid #4f46e5;color:white;border-radius:6px;outline:none;margin-bottom:16px;box-sizing:border-box;">
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button id="_cpCancel" style="padding:8px 16px;background:transparent;border:1px solid rgba(255,255,255,0.2);color:white;border-radius:6px;cursor:pointer;transition:background 0.2s;">Hủy</button>
        <button id="_cpOk" style="padding:8px 16px;background:#6366f1;border:none;color:white;border-radius:6px;font-weight:600;cursor:pointer;transition:background 0.2s;">Lưu</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => { document.getElementById('_cpInput').focus(); document.getElementById('_cpInput').select(); }, 10);

    const cleanup = (val) => { document.body.removeChild(overlay); resolve(val); };
    document.getElementById('_cpOk').onclick = () => cleanup(document.getElementById('_cpInput').value);
    document.getElementById('_cpCancel').onclick = () => cleanup(null);
    document.getElementById('_cpInput').onkeydown = (e) => {
      if (e.key === 'Enter') cleanup(e.target.value);
      if (e.key === 'Escape') cleanup(null);
    };
  });

  let newLabel = await getPrompt();
  if (!newLabel || newLabel.trim() === '' || newLabel === currentLabel) return;
  newLabel = newLabel.trim();

  try {
    const res = await fetch(`/api/cookie-pool/${slot}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Đã đổi tên thành "${newLabel}"`, 'success');
      await loadCookiePool(); // Reload UI
    } else {
      showToast(`Lỗi khi đổi tên: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi mạng: ${e.message}`, 'error');
  }
}

async function deleteCookieSlot(slot) {
  const slotInfo = _poolSlots.find(s => s.slot === slot);
  const label = slotInfo ? slotInfo.label : `Account ${slot + 1}`;

  // ── Phantom slot (never saved to disk) ──────────────────────────────
  // Just remove it from local state; no server call, no full reload.
  if (!slotInfo || !slotInfo.exists) {
    if (_activePoolTab === slot) {
      const others = _poolSlots.filter(s => s.slot !== slot);
      _activePoolTab = others.length > 0 ? others[others.length - 1].slot : 0;
    }
    _removeSlotLocally(slot);
    return;
  }

  // ── Saved slot ────────────────────────────────────────────────────────
  const confirmed = await window.wfbConfirm(
    `Xóa ${label}?`,
    'Cookie của tài khoản này sẽ bị xóa khỏi pool. Phantom slots sẽ không bị ảnh hưởng.',
    'Xóa', '#ef4444'
  );
  if (!confirmed) return;
  try {
    await fetch(`/api/cookie-pool/${slot}`, { method: 'DELETE' });
    showToast(`Đã xóa cookie ${label}`, 'success');
    if (slot === _activePoolTab) {
      // Move active tab to nearest remaining slot
      const others = _poolSlots.filter(s => s.slot !== slot && s.exists);
      _activePoolTab = others.length > 0 ? others[0].slot : (_poolSlots.find(s => s.slot !== slot)?.slot ?? 0);
    }
    await loadCookiePool(); // full reload — OK since server state changed
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}




async function switchToSlot(slot) {
  try {
    const res = await fetch('/api/cookie-pool/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot })
    });
    const data = await res.json();
    if (data.success) {
      const slotInfo = _poolSlots.find(s => s.slot === slot);
      showToast(`✅ Đã kích hoạt ${slotInfo?.label || `Account ${slot + 1}`}`, 'success');
      await loadCookiePool();
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

async function switchToNextAccount() {
  try {
    const res = await fetch('/api/cookie-pool/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (data.success) {
      const slotInfo = _poolSlots.find(s => s.slot === data.activeIndex);
      showToast(`⚡ Đã chuyển sang ${slotInfo?.label || `Account ${(data.activeIndex || 0) + 1}`}`, 'success');
      await loadCookiePool();
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

// Socket: account switched by backend (auto-switch on 403)
socket.on('account:switched', ({ to, reason }) => {
  const slotInfo = _poolSlots.find(s => s.slot === to);
  showToast(`⚡ Đã chuyển sang ${slotInfo?.label || `Account ${(to || 0) + 1}`} (${reason || 'auto'})`, 'warning');
  loadCookiePool();
});



// Legacy injectCookies renamed to injectCookiesLegacy — launches Chrome with active slot cookies
async function injectCookiesLegacy() {
  // Gather cookies from active slot textarea (slot_0 or cookieTextarea_0)
  const ta0 = document.getElementById('cookieTextarea_0') || document.getElementById('cookieTextarea0');
  const rawCookies = ta0 ? ta0.value.trim() : '';

  const btn = document.getElementById('btnLaunchChrome');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="border-top-color:white;width:16px;height:16px;"></div> Đang mở Chrome...';
  }

  try {
    // Use saved slot-0 cookies if textarea is empty
    const cookiesToSend = rawCookies || localStorage.getItem('veo3_cookies') || '';
    if (!cookiesToSend) {
      showToast('Chưa có cookie. Hãy dán cookie Account 1 và nhấn Lưu trước!', 'warning');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">play_circle</span> Mở Chrome & Kết nối'; }
      return;
    }
    const projectUrl = document.getElementById('projectUrl')?.value || '';
    const res = await fetch('/api/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: cookiesToSend, projectUrl })
    });
    const data = await res.json();
    if (data.success && data.launching) {
      showToast('Đang mở Chrome và inject cookie... vui lòng chờ', 'info');
      return;
    } else if (data.success) {
      isConnected = true;
      updateConnectionUI();
      showToast('Đã mở Chrome thành công!', 'success');
      document.getElementById('connectPanel').style.display = 'none';
    } else {
      showToast(`Lỗi: ${data.error}`, 'error');
    }
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">play_circle</span> Mở Chrome & Kết nối'; }
}

// Keep old injectCookies name for backward-compat references
async function injectCookies() { return injectCookiesLegacy(); }

async function loadSavedCookies() {
  try {
    // Load pool status
    await loadCookiePool();

    // Also load legacy cookies.json into slot-0 textarea if slot file doesn't exist yet
    const poolRes = await fetch('/api/cookie-pool');
    const poolData = await poolRes.json();
    const slot0 = poolData.slots && poolData.slots[0];

    if (!slot0 || !slot0.exists) {
      // Try legacy file
      const res = await fetch('/api/cookies');
      const data = await res.json();
      if (data.success && data.cookies) {
        // Put legacy cookies into slot_0 textarea if visible
        const ta = document.getElementById('cookieTextarea_0') || document.getElementById('cookieTextarea0');
        if (ta) ta.value = data.cookies;
        localStorage.setItem('veo3_cookies', data.cookies);
        let count = 0;
        try { const p = JSON.parse(data.cookies); count = Array.isArray(p) ? p.length : 0; }
        catch { count = data.cookies.split(';').filter(Boolean).length; }
        updateCookieBadge(true, count);
        updateStartButton();
        showToast(`Đã lưu ${count} cookie — đang tự động mở Chrome...`, 'info');
        setTimeout(injectCookiesLegacy, 800);
      }
    } else if (slot0.exists) {
      // Cookies exist in slot 0 — auto-launch
      updateCookieBadge(true, slot0.cookieCount);
      updateStartButton();
      showToast(`Đã lưu ${slot0.cookieCount} cookie — đang tự động mở Chrome...`, 'info');
      setTimeout(injectCookiesLegacy, 800);
    }
  } catch (e) { /* ignore */ }
}

function updateSavedCookieUI(hasSaved, count) {
  // No-op — pool UI handles this now via loadCookiePool()
}

async function clearSavedCookies() {
  const confirmed = await window.wfbConfirm('Xóa Cookie?', 'Xóa tất cả cookie đã lưu?', 'Xóa', '#ef4444');
  if (!confirmed) return;
  try {
    await fetch('/api/cookies', { method: 'DELETE' });
    // Delete all known slots dynamically
    for (const s of _poolSlots) {
      await fetch(`/api/cookie-pool/${s.slot}`, { method: 'DELETE' }).catch(() => { });
    }
    localStorage.removeItem('veo3_cookies');
    updateCookieBadge(false);
    await loadCookiePool();
    showToast('Đã xóa tất cả cookie', 'success');
  } catch (e) {
    showToast(`Lỗi: ${e.message}`, 'error');
  }
}

function updateCookieBadge(hasCookies, count) {
  const badge = document.getElementById('cookieStatus');
  if (!badge) return;
  if (hasCookies) {
    badge.textContent = count ? `${count} cookie` : 'Đã lưu';
    badge.className = 'cookie-badge cookie-badge-active';
  } else {
    badge.textContent = 'Chưa có';
    badge.className = 'cookie-badge';
  }
}

socket.on('cookiesSet', ({ count }) => {
  updateCookieBadge(true, count);
  isConnected = true;
  updateConnectionUI();
  showToast(`Đã inject ${count} cookie và mở Chrome thành công!`, 'success');
  const btn = document.getElementById('btnLaunchChrome');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">play_circle</span> Mở Chrome & Kết nối'; }
  document.getElementById('connectPanel').style.display = 'none';
  loadCookiePool(); // refresh pool status after connect
});

socket.on('launchError', ({ error }) => {
  showToast(`Lỗi mở Chrome: ${error}`, 'error');
  const btn = document.getElementById('btnLaunchChrome');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">play_circle</span> Mở Chrome & Kết nối'; }
});

// === PAGE INIT ===
document.addEventListener('DOMContentLoaded', async () => {
  await loadSavedCookies();
  await loadDownloadDir();
  // Poll pool status every 30s to keep active-account display fresh
  setInterval(loadCookiePool, 60_000); // full re-render every 60s; live countdown runs every 1s

});


// === SIDEBAR TOGGLE ===
const panelsState = {
  left: true,
  queue: true,
  log: true
};

function toggleSidebar(panelName) {
  panelsState[panelName] = !panelsState[panelName];
  updatePanelsUI();
}

function updatePanelsUI() {
  const isBuilder = document.getElementById('tabBuilder')?.classList.contains('active');
  const isStore = document.getElementById('tabStore')?.classList.contains('active');

  const leftPanel = document.getElementById('leftPanel');
  const leftDock = document.getElementById('leftDock');

  if (isBuilder || isStore) {
    if (leftPanel) leftPanel.style.display = 'none';
    if (leftDock) leftDock.style.display = 'none';
  } else {
    if (leftPanel && leftDock) {
      leftPanel.style.display = panelsState.left ? 'flex' : 'none';
      leftDock.style.display = panelsState.left ? 'none' : 'flex';
    }
  }

  const rightPanel = document.getElementById('rightPanel');
  const queueSection = document.querySelector('.queue-section');
  const logSection = document.querySelector('.log-section');
  const rightDivider = document.querySelector('#rightPanel .panel-divider');

  const rightDock = document.getElementById('rightDock');
  const dockBtnQueue = document.getElementById('dockBtnQueue');
  const dockBtnLog = document.getElementById('dockBtnLog');

  if (isStore) {
    if (rightPanel) rightPanel.style.display = 'none';
    if (rightDock) rightDock.style.display = 'none';
  } else {
    // Builder and Prompt Tab both show right panel
    if (panelsState.queue) {
      if (queueSection) queueSection.style.display = 'flex';
      if (dockBtnQueue) dockBtnQueue.style.display = 'none';
    } else {
      if (queueSection) queueSection.style.display = 'none';
      if (dockBtnQueue) dockBtnQueue.style.display = 'flex';
    }

    if (panelsState.log) {
      if (logSection) logSection.style.display = 'flex';
      if (dockBtnLog) dockBtnLog.style.display = 'none';
    } else {
      if (logSection) logSection.style.display = 'none';
      if (dockBtnLog) dockBtnLog.style.display = 'flex';
    }

    if (rightDivider) {
      rightDivider.style.display = (panelsState.queue && panelsState.log) ? 'block' : 'none';
    }

    if (!panelsState.queue && !panelsState.log) {
      if (rightPanel) rightPanel.style.display = 'none';
    } else {
      if (rightPanel) rightPanel.style.display = 'flex';
    }

    if (rightDock) {
      if (!panelsState.queue || !panelsState.log) {
        rightDock.style.display = 'flex';
      } else {
        rightDock.style.display = 'none';
      }
    }
  }

  if (typeof updateAppLayout === 'function') updateAppLayout();
}
