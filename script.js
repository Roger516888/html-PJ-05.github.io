/* 無人機百科 ─ 機型規格比較
   資料來源：drones.json（每個機型自帶 sources 與 confidence） */

'use strict';

var DATA = [];
var META = {};
var MAX_COMPARE = 4;

var state = {
  q: '',
  filters: {},      // { 欄位名: Set(選中的值) }
  sortKey: 'flight_time_min',
  sortDir: 'desc',
  compare: []       // id 陣列
};

/* ---------- 小工具 ---------- */

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function nil() { return '<span class="nil">—</span>'; }

function has(v) { return v !== null && v !== undefined && v !== ''; }

function fmtWeight(g) {
  if (!has(g)) return null;
  return g >= 1000 ? (Math.round(g / 10) / 100) + ' kg' : g + ' g';
}

function fmtNum(v, unit) {
  if (!has(v)) return null;
  return v + (unit ? ' ' + unit : '');
}

function boolLabel(v) {
  if (v === true) return '有';
  if (v === false) return '無';
  return null;
}

function confBadge(c) {
  var map = { high: ['badge-high', '高'], medium: ['badge-medium', '中'], low: ['badge-low', '低'] };
  var m = map[c] || ['badge-flat', '未標'];
  return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
}

function byId(id) {
  for (var i = 0; i < DATA.length; i++) if (DATA[i].id === id) return DATA[i];
  return null;
}

/* ---------- 篩選定義 ---------- */

var FILTER_DEFS = [
  { key: 'category', label: '類別' },
  { key: 'tier', label: '等級' },
  { key: 'maker_country', label: '原產國' },
  { key: 'ndaa_status', label: 'NDAA' }
];

var FEATURE_DEFS = [
  { key: 'rtk', label: 'RTK' },
  { key: 'thermal', label: '熱影像' },
  { key: 'lidar', label: '光達' }
];

function buildFilters() {
  var host = el('filters');
  host.innerHTML = '';

  FILTER_DEFS.forEach(function (def) {
    var vals = {};
    DATA.forEach(function (d) { if (has(d[def.key])) vals[d[def.key]] = (vals[d[def.key]] || 0) + 1; });
    var keys = Object.keys(vals).sort(function (a, b) { return vals[b] - vals[a] || a.localeCompare(b, 'zh-Hant'); });
    if (!keys.length) return;

    var group = document.createElement('div');
    group.className = 'filter-group';
    group.innerHTML = '<span class="filter-label">' + esc(def.label) + '</span>';

    keys.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('aria-pressed', 'false');
      b.dataset.filterKey = def.key;
      b.dataset.filterVal = v;
      b.innerHTML = esc(v) + ' <span class="nil">' + vals[v] + '</span>';
      group.appendChild(b);
    });
    host.appendChild(group);
  });

  // 功能篩選（布林）
  var fgroup = document.createElement('div');
  fgroup.className = 'filter-group';
  fgroup.innerHTML = '<span class="filter-label">功能</span>';
  var any = false;
  FEATURE_DEFS.forEach(function (def) {
    var n = DATA.filter(function (d) { return d[def.key] === true; }).length;
    if (!n) return;
    any = true;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', 'false');
    b.dataset.featureKey = def.key;
    b.innerHTML = esc(def.label) + ' <span class="nil">' + n + '</span>';
    fgroup.appendChild(b);
  });
  if (any) host.appendChild(fgroup);

  host.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.chip') : null;
    if (!b) return;
    var on = b.getAttribute('aria-pressed') === 'true';
    b.setAttribute('aria-pressed', on ? 'false' : 'true');

    var k = b.dataset.filterKey || ('feat:' + b.dataset.featureKey);
    var v = b.dataset.filterKey ? b.dataset.filterVal : true;
    if (!state.filters[k]) state.filters[k] = [];
    if (on) {
      state.filters[k] = state.filters[k].filter(function (x) { return x !== v; });
      if (!state.filters[k].length) delete state.filters[k];
    } else {
      state.filters[k].push(v);
    }
    render();
  });
}

function clearFilters() {
  state.filters = {};
  state.q = '';
  el('search').value = '';
  Array.prototype.forEach.call(document.querySelectorAll('.chip[aria-pressed="true"]'), function (b) {
    b.setAttribute('aria-pressed', 'false');
  });
  render();
}

/* ---------- 篩選與排序 ---------- */

function matches(d) {
  if (state.q) {
    var hay = [d.name_zh, d.name_en, d.maker, d.maker_country, d.category, d.tier,
               (d.sensors || []).join(' '), d.notes].join(' ').toLowerCase();
    var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
  }
  for (var k in state.filters) {
    if (!Object.prototype.hasOwnProperty.call(state.filters, k)) continue;
    var sel = state.filters[k];
    if (k.indexOf('feat:') === 0) {
      if (d[k.slice(5)] !== true) return false;
    } else if (sel.indexOf(d[k]) === -1) {
      return false;
    }
  }
  return true;
}

function sortRows(rows) {
  var k = state.sortKey, dir = state.sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort(function (a, b) {
    var av = a[k], bv = b[k];
    var an = !has(av), bn = !has(bv);
    if (an && bn) return a.name_en.localeCompare(b.name_en);
    if (an) return 1;        // 空值永遠排最後，不論升降
    if (bn) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'zh-Hant') * dir;
  });
}

/* ---------- 表格 ---------- */

var COLUMNS = [
  { key: 'name_zh', label: '機型', sortable: true },
  { key: 'maker_country', label: '原產國', sortable: true },
  { key: 'category', label: '類別', sortable: true },
  { key: 'tier', label: '等級', sortable: true },
  { key: 'flight_time_min', label: '續航', unit: 'min', num: true, sortable: true },
  { key: 'max_payload_g', label: '酬載', weight: true, num: true, sortable: true },
  { key: 'mtow_g', label: '最大起飛重', weight: true, num: true, sortable: true },
  { key: 'max_range_km', label: '圖傳', unit: 'km', num: true, sortable: true },
  { key: 'confidence', label: '可信度', sortable: true }
];

function buildHead() {
  var tr = el('head-row');
  tr.innerHTML = '<th class="col-check"><span class="sr-only">加入比較</span></th>';
  COLUMNS.forEach(function (c) {
    var th = document.createElement('th');
    if (c.num) th.className = 'num';
    var arrow = state.sortKey === c.key ? '<span class="arrow">' + (state.sortDir === 'asc' ? '▲' : '▼') + '</span>' : '';
    th.innerHTML = '<button type="button" class="sort-btn" data-sort="' + c.key + '">' + esc(c.label) + arrow + '</button>';
    tr.appendChild(th);
  });
  tr.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-sort]') : null;
    if (!b) return;
    var k = b.dataset.sort;
    if (state.sortKey === k) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = k;
      // 數值欄預設大到小，文字欄預設 A→Z
      var col = COLUMNS.filter(function (c) { return c.key === k; })[0];
      state.sortDir = col && col.num ? 'desc' : 'asc';
    }
    render();
  });
}

function cellValue(d, c) {
  var v = d[c.key];
  if (c.key === 'confidence') return confBadge(v);
  if (c.key === 'name_zh') {
    var sub = d.name_zh !== d.name_en ? '<span class="model-sub">' + esc(d.name_en) + '</span>' : '';
    return '<button type="button" class="model-btn" data-detail="' + esc(d.id) + '">' + esc(d.name_zh) + '</button>' +
           '<span class="model-sub">' + esc(d.maker) + '</span>' + sub;
  }
  if (c.weight) { var w = fmtWeight(v); return w ? esc(w) : nil(); }
  if (c.unit) { var n = fmtNum(v, c.unit); return n ? esc(n) : nil(); }
  return has(v) ? esc(v) : nil();
}

function render() {
  var rows = sortRows(DATA.filter(matches));

  el('result-count').textContent = rows.length === DATA.length
    ? '共 ' + DATA.length + ' 款機型'
    : '符合 ' + rows.length + ' / ' + DATA.length + ' 款';

  var anyFilter = state.q || Object.keys(state.filters).length;
  el('clear-filters').classList.toggle('hidden', !anyFilter);
  el('empty-state').classList.toggle('hidden', rows.length > 0);
  el('table-scroll').classList.toggle('hidden', rows.length === 0);

  buildHead();

  var body = el('body-rows');
  body.innerHTML = rows.map(function (d) {
    var checked = state.compare.indexOf(d.id) !== -1;
    var full = !checked && state.compare.length >= MAX_COMPARE;
    var tds = COLUMNS.map(function (c) {
      return '<td' + (c.num ? ' class="num"' : '') + '>' + cellValue(d, c) + '</td>';
    }).join('');
    return '<tr>' +
      '<td class="col-check"><input type="checkbox" data-cmp="' + esc(d.id) + '"' +
      (checked ? ' checked' : '') + (full ? ' disabled' : '') +
      ' aria-label="把 ' + esc(d.name_zh) + ' 加入比較"></td>' + tds + '</tr>';
  }).join('');

  renderTray();
}

/* ---------- 比較盤 ---------- */

function renderTray() {
  var tray = el('compare-tray');
  tray.classList.toggle('hidden', state.compare.length === 0);
  el('tray-items').innerHTML = state.compare.map(function (id) {
    var d = byId(id);
    if (!d) return '';
    return '<span class="tray-chip">' + esc(d.name_zh) +
      '<button type="button" data-untray="' + esc(id) + '" aria-label="移除 ' + esc(d.name_zh) + '">✕</button></span>';
  }).join('');
  el('compare-open').disabled = state.compare.length < 2;
  el('compare-open').textContent = state.compare.length < 2
    ? '並列比較（再選 ' + (2 - state.compare.length) + ' 款）'
    : '並列比較 ' + state.compare.length + ' 款';
}

function toggleCompare(id, on) {
  var i = state.compare.indexOf(id);
  if (on && i === -1) {
    if (state.compare.length >= MAX_COMPARE) return;
    state.compare.push(id);
  } else if (!on && i !== -1) {
    state.compare.splice(i, 1);
  }
  render();
}

/* ---------- 彈出層 ---------- */

function openModal(title, html) {
  el('modal-title').textContent = title;
  el('modal-body').innerHTML = html;
  el('modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  el('modal').classList.add('hidden');
  document.body.style.overflow = '';
}

var DETAIL_FIELDS = [
  { key: 'flight_time_min', label: '原廠標示續航', unit: 'min', cond: 'flight_time_note' },
  { key: 'max_payload_g', label: '最大酬載', weight: true },
  { key: 'mtow_g', label: '最大起飛重量', weight: true },
  { key: 'weight_g', label: '機身重量', weight: true },
  { key: 'max_range_km', label: '圖傳距離', unit: 'km' },
  { key: 'max_speed_kmh', label: '最大速度', unit: 'km/h' },
  { key: 'wind_resistance_ms', label: '抗風', unit: 'm/s' },
  { key: 'ceiling_m', label: '升限／最大起飛海拔', unit: 'm' },
  { key: 'ip_rating', label: '防護等級' },
  { key: 'year', label: '發布年份' }
];

function detailHtml(d) {
  var cells = DETAIL_FIELDS.map(function (f) {
    var v = d[f.key];
    var shown = f.weight ? fmtWeight(v) : (f.unit ? fmtNum(v, f.unit) : (has(v) ? String(v) : null));
    var cond = f.cond && has(d[f.cond]) ? '<span class="cond">' + esc(d[f.cond]) + '</span>' : '';
    return '<div class="detail-cell"><dt>' + esc(f.label) + '</dt><dd>' +
      (shown ? esc(shown) : nil()) + cond + '</dd></div>';
  }).join('');

  var feats = FEATURE_DEFS.map(function (f) {
    var l = boolLabel(d[f.key]);
    return '<span class="badge badge-flat">' + esc(f.label) + '：' + (l || '未確認') + '</span>';
  }).join('');

  var sensors = (d.sensors && d.sensors.length)
    ? '<ul>' + d.sensors.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'
    : '<p>' + nil() + '</p>';

  var srcs = (d.sources && d.sources.length)
    ? '<ul>' + d.sources.map(function (s) {
        return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.url) + '</a> ' +
          '<span class="badge ' + (s.official ? 'badge-high' : 'badge-flat') + '">' +
          (s.official ? '官方' : '非官方') + '</span>' +
          (has(s.note) ? ' <span class="nil">' + esc(s.note) + '</span>' : '') + '</li>';
      }).join('') + '</ul>'
    : '<p>本機型未取得可引用的公開來源。</p>';

  return '' +
    '<div class="tag-row" style="margin-bottom:14px">' +
      '<span class="badge badge-flat">' + esc(d.maker) + '</span>' +
      '<span class="badge badge-flat">' + esc(d.maker_country) + '</span>' +
      '<span class="badge badge-flat">' + esc(d.category) + '</span>' +
      '<span class="badge badge-flat">' + esc(d.tier) + '</span>' +
      '<span class="badge badge-flat">NDAA：' + esc(d.ndaa_status) + '</span>' +
      '資料可信度 ' + confBadge(d.confidence) +
    '</div>' +
    '<dl class="detail-grid">' + cells + '</dl>' +
    '<div class="detail-section"><h3>功能</h3><div class="tag-row">' + feats + '</div></div>' +
    '<div class="detail-section"><h3>可搭載感測器／酬載</h3>' + sensors + '</div>' +
    (has(d.price_note) ? '<div class="detail-section"><h3>價格參考</h3><p>' + esc(d.price_note) + '</p></div>' : '') +
    (has(d.notes) ? '<div class="detail-section"><h3>選型備註</h3><p>' + esc(d.notes) + '</p></div>' : '') +
    '<div class="detail-section"><h3>資料來源</h3>' + srcs + '</div>';
}

/* 比較表：這些欄位數字越大越好，才標示最佳值 */
var HIGHER_BETTER = {
  flight_time_min: true, max_payload_g: true, max_range_km: true,
  max_speed_kmh: true, wind_resistance_ms: true, ceiling_m: true
};

var COMPARE_ROWS = [
  { key: 'maker', label: '廠商' },
  { key: 'maker_country', label: '原產國' },
  { key: 'category', label: '類別' },
  { key: 'tier', label: '等級' },
  { key: 'year', label: '發布年份' },
  { key: 'flight_time_min', label: '原廠標示續航', unit: 'min', cond: 'flight_time_note' },
  { key: 'max_payload_g', label: '最大酬載', weight: true },
  { key: 'mtow_g', label: '最大起飛重量', weight: true },
  { key: 'max_range_km', label: '圖傳距離', unit: 'km' },
  { key: 'max_speed_kmh', label: '最大速度', unit: 'km/h' },
  { key: 'wind_resistance_ms', label: '抗風', unit: 'm/s' },
  { key: 'ceiling_m', label: '升限', unit: 'm' },
  { key: 'ip_rating', label: '防護等級' },
  { key: 'rtk', label: 'RTK', bool: true },
  { key: 'thermal', label: '熱影像', bool: true },
  { key: 'lidar', label: '光達', bool: true },
  { key: 'ndaa_status', label: 'NDAA 狀態' },
  { key: 'confidence', label: '資料可信度', conf: true },
  { key: 'notes', label: '選型備註' }
];

function compareHtml(list) {
  var head = '<tr><th>項目</th>' + list.map(function (d) {
    return '<th>' + esc(d.name_zh) + '</th>';
  }).join('') + '</tr>';

  var body = COMPARE_ROWS.map(function (r) {
    var best = null;
    if (HIGHER_BETTER[r.key]) {
      var nums = list.map(function (d) { return d[r.key]; }).filter(function (v) { return typeof v === 'number'; });
      if (nums.length > 1) best = Math.max.apply(Math, nums);
    }
    var tds = list.map(function (d) {
      var v = d[r.key];
      var shown;
      if (r.conf) shown = confBadge(v);
      else if (r.bool) shown = boolLabel(v) ? esc(boolLabel(v)) : nil();
      else if (r.weight) shown = fmtWeight(v) ? esc(fmtWeight(v)) : nil();
      else if (r.unit) shown = fmtNum(v, r.unit) ? esc(fmtNum(v, r.unit)) : nil();
      else shown = has(v) ? esc(v) : nil();
      if (r.cond && has(d[r.cond])) shown += '<span class="cond">' + esc(d[r.cond]) + '</span>';
      var cls = (best !== null && v === best) ? ' class="best"' : '';
      return '<td' + cls + '>' + shown + '</td>';
    }).join('');
    return '<tr><th>' + esc(r.label) + '</th>' + tds + '</tr>';
  }).join('');

  return '<p class="compare-legend">綠底＝該列數值最佳。續航與酬載為原廠標示值，測試條件列在數字下方；' +
         '「—」代表查不到可信公開資料。</p>' +
         '<div class="compare-wrap"><table class="compare-table"><thead>' + head +
         '</thead><tbody>' + body + '</tbody></table></div>';
}

/* ---------- 主題 ---------- */

function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem('dronewiki-theme'); } catch (e) { /* 無痕視窗等情形 */ }
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  el('theme-toggle').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next;
    if (cur) {
      next = cur === 'dark' ? 'light' : 'dark';
    } else {
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      next = prefersDark ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('dronewiki-theme', next); } catch (e) { /* 忽略 */ }
  });
}

/* ---------- 啟動 ---------- */

function wireEvents() {
  el('search').addEventListener('input', function (e) {
    state.q = e.target.value.trim();
    render();
  });

  el('clear-filters').addEventListener('click', clearFilters);
  document.addEventListener('click', function (e) {
    if (e.target.matches && e.target.matches('[data-clear]')) clearFilters();
  });

  el('body-rows').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-detail]') : null;
    if (!b) return;
    var d = byId(b.dataset.detail);
    if (d) openModal(d.name_zh, detailHtml(d));
  });

  el('body-rows').addEventListener('change', function (e) {
    if (e.target.dataset && e.target.dataset.cmp) toggleCompare(e.target.dataset.cmp, e.target.checked);
  });

  el('tray-items').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-untray]') : null;
    if (b) toggleCompare(b.dataset.untray, false);
  });

  el('compare-clear').addEventListener('click', function () {
    state.compare = [];
    render();
  });

  el('compare-open').addEventListener('click', function () {
    var list = state.compare.map(byId).filter(Boolean);
    if (list.length >= 2) openModal('並列比較：' + list.length + ' 款', compareHtml(list));
  });

  el('modal').addEventListener('click', function (e) {
    if (e.target.matches && e.target.matches('[data-close]')) closeModal();
    var b = e.target.closest ? e.target.closest('[data-close]') : null;
    if (b) closeModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el('modal').classList.contains('hidden')) closeModal();
  });
}

function showNoData() {
  el('table-scroll').classList.add('hidden');
  el('result-count').textContent = '';
  var box = el('empty-state');
  box.classList.remove('hidden');
  box.innerHTML = '<p><strong>規格資料尚未建立。</strong></p>' +
    '<p class="meta">站台功能（搜尋、篩選、排序、並列比較）已完成並通過測試，' +
    '等著 <code>drones.json</code> 填入機型資料。<br>' +
    '本站不放推測值，所以在查到可引用的原廠規格之前，這裡維持空白。</p>';
  el('dataset-meta').textContent = META.note || '';
}

function showLoadError(msg) {
  el('table-scroll').classList.add('hidden');
  var box = el('empty-state');
  box.classList.remove('hidden');
  box.innerHTML = '<p>規格資料載入失敗：' + esc(msg) + '</p>' +
    '<p class="meta">若是直接用 file:// 開啟本頁，瀏覽器會擋下 drones.json 的讀取；' +
    '請改用本機伺服器或 GitHub Pages 開啟。</p>';
}

function start() {
  initTheme();
  wireEvents();

  fetch('drones.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      DATA = (json.drones || []).filter(function (d) { return d && d.id; });
      META = json.meta || {};
      if (!DATA.length) { showNoData(); return; }
      buildFilters();
      render();
      var bits = [];
      if (META.updated) bits.push('資料更新日：' + META.updated);
      bits.push('收錄 ' + DATA.length + ' 款機型');
      if (META.note) bits.push(META.note);
      el('dataset-meta').textContent = bits.join('　｜　');
    })
    .catch(function (err) { showLoadError(err.message || String(err)); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
