// ===== 動態日曆（手機版小工具）=====
// 版面依示意圖：上方動態島、星期一開頭的圓形日期、上下滑動切換月份、底部四顆功能鍵

const EVENTS_KEY = 'dyn-calendar-events';
const THEME_KEY = 'dyn-calendar-theme';
const HOLIDAY_KEY_PREFIX = 'dyn-calendar-holidays-';
const HOLIDAY_CACHE_DAYS = 7;
const HOLIDAY_SOURCES = [
    year => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
    year => `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${year}.json`
];
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const COLOR_NAMES = { blue: '工作', green: '個人', orange: '提醒', red: '重要', purple: '其他' };
// 圓圈裡放不下的節日名稱改用簡稱
const SHORT_NAMES = {
    '開國紀念日': '元旦',
    '農曆除夕': '除夕',
    '和平紀念日': '和平紀念',
    '兒童節及民族掃墓節': '兒童節',
    '孔子誕辰紀念日': '教師節',
    '臺灣光復暨金門古寧頭大捷紀念日': '光復節',
    '行憲紀念日': '行憲紀念'
};
const ISLAND_AUTO_CLOSE = 4000;
const SWIPE_THRESHOLD = 60;

const $ = id => document.getElementById(id);
const grid = $('grid');
const island = $('island');

const state = {
    viewYear: 0,
    viewMonth: 0,       // 0 = 一月
    selected: '',       // 'YYYY-MM-DD'
    todayKey: '',
    events: loadEvents(),
    holidays: {}        // { 2026: { status: 'ok' | 'loading' | 'failed', days: { 'YYYY-MM-DD': {...} } } }
};

// ---------- 工具函式 ----------
function pad(n) {
    return String(n).padStart(2, '0');
}

function toKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function storageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        // 無痕模式或停用儲存空間時忽略，日曆仍可正常使用
    }
}

function restartAnimation(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
}

// ---------- 農曆 ----------
const lunarFormatter = (() => {
    try {
        return new Intl.DateTimeFormat('zh-TW-u-ca-chinese', { month: 'long', day: 'numeric' });
    } catch (e) {
        return null;
    }
})();

const LUNAR_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function lunarDayName(n) {
    if (n <= 10) return '初' + LUNAR_DIGITS[n];
    if (n < 20) return '十' + LUNAR_DIGITS[n - 10];
    if (n === 20) return '二十';
    if (n < 30) return '廿' + LUNAR_DIGITS[n - 20];
    return '三十';
}

// 回傳 { month: '九月', day: '十二', isFirst: false }，不支援時回傳 null
function getLunar(date) {
    if (!lunarFormatter) return null;
    try {
        const parts = lunarFormatter.formatToParts(date);
        const month = parts.find(p => p.type === 'month');
        const day = parts.find(p => p.type === 'day');
        if (!month || !day) return null;
        const n = parseInt(day.value, 10);
        if (Number.isNaN(n)) return null;
        return { month: month.value, day: lunarDayName(n), isFirst: n === 1 };
    } catch (e) {
        return null;
    }
}

// ---------- 國定假日 ----------
function parseHolidayData(list) {
    const days = {};
    for (const item of list) {
        if (!item || typeof item.date !== 'string' || item.date.length !== 8) continue;
        const key = `${item.date.slice(0, 4)}-${item.date.slice(4, 6)}-${item.date.slice(6, 8)}`;
        days[key] = { isHoliday: !!item.isHoliday, description: item.description || '' };
    }
    return days;
}

async function fetchHolidayYear(year) {
    for (const source of HOLIDAY_SOURCES) {
        try {
            const res = await fetch(source(year));
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) return data;
        } catch (e) {
            // 換下一個來源
        }
    }
    return null;
}

async function ensureHolidays(year) {
    if (state.holidays[year]) return;

    const cached = storageGet(HOLIDAY_KEY_PREFIX + year);
    if (cached) {
        try {
            const { savedAt, data } = JSON.parse(cached);
            state.holidays[year] = { status: 'ok', days: parseHolidayData(data) };
            if (Date.now() - savedAt < HOLIDAY_CACHE_DAYS * 86400000) return;
        } catch (e) {
            // 快取損毀就重新下載
        }
    }

    if (!state.holidays[year]) {
        state.holidays[year] = { status: 'loading', days: {} };
    }

    const data = await fetchHolidayYear(year);
    if (data) {
        state.holidays[year] = { status: 'ok', days: parseHolidayData(data) };
        storageSet(HOLIDAY_KEY_PREFIX + year, JSON.stringify({ savedAt: Date.now(), data }));
    } else if (state.holidays[year].status !== 'ok') {
        state.holidays[year] = { status: 'failed', days: {} };
    }
    refreshAllCells();
    renderAgenda();
    refreshIsland();
    updateHolidayStatus();
}

function getDayInfo(date) {
    const key = toKey(date);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const yearData = state.holidays[date.getFullYear()];
    const info = yearData && yearData.days[key];

    if (!info) return { off: weekend, label: '', makeupWorkday: false };
    if (!info.isHoliday && weekend) {
        return { off: false, label: '補班', makeupWorkday: true };
    }
    return { off: info.isHoliday, label: info.isHoliday ? info.description : '', makeupWorkday: false };
}

function shortLabel(label) {
    const part = label.split('/').pop();
    const name = SHORT_NAMES[label] || SHORT_NAMES[part] || part;
    return name.length > 4 ? name.slice(0, 4) : name;
}

function updateHolidayStatus() {
    const status = state.holidays[state.viewYear];
    const text = $('holiday-status');
    text.hidden = !(status && status.status === 'failed');
    text.textContent = `無法載入 ${state.viewYear} 年假日資料，目前僅標示週末`;
}

// ---------- 行程資料 ----------
function loadEvents() {
    try {
        const data = JSON.parse(storageGet(EVENTS_KEY) || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        const clean = {};
        for (const [key, list] of Object.entries(data)) {
            if (!Array.isArray(list)) continue;
            const valid = list.filter(ev => ev && typeof ev.title === 'string' && ev.title);
            if (valid.length) clean[key] = valid;
        }
        return clean;
    } catch (e) {
        return {};
    }
}

function saveEvents() {
    storageSet(EVENTS_KEY, JSON.stringify(state.events));
}

function getEvents(key) {
    const list = state.events[key] || [];
    // 全天行程排最前，其餘依時間排序
    return list.slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

function addEvent(key, title, time, color) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!state.events[key]) state.events[key] = [];
    state.events[key].push({ id, title, time, color });
    saveEvents();
}

function removeEvent(key, id) {
    const list = (state.events[key] || []).filter(ev => ev.id !== id);
    if (list.length) {
        state.events[key] = list;
    } else {
        delete state.events[key];
    }
    saveEvents();
}

// ---------- 日期文字 ----------
function dateTitle(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEK_NAMES[date.getDay()]}`;
}

function dateSub(date) {
    const info = getDayInfo(date);
    const lunar = getLunar(date);
    const sub = [];
    if (lunar) sub.push(`農曆${lunar.month}${lunar.day}`);
    if (info.label) sub.push(info.label);
    return sub.join(' · ');
}

// ---------- 圓形日期 ----------
function fillCell(cell, date) {
    const key = toKey(date);
    const info = getDayInfo(date);
    const lunar = getLunar(date);
    const events = getEvents(key);
    const isToday = key === state.todayKey;
    const isSelected = key === state.selected;

    cell.classList.toggle('today', isToday);
    cell.classList.toggle('selected', isSelected);
    cell.classList.toggle('off', info.off);
    cell.setAttribute('aria-pressed', String(isSelected));
    if (isToday) {
        cell.setAttribute('aria-current', 'date');
    } else {
        cell.removeAttribute('aria-current');
    }

    const label = [`${date.getFullYear()}年${dateTitle(date)}`];
    if (info.label) label.push(info.label);
    if (events.length) label.push(`${events.length} 個行程`);
    cell.setAttribute('aria-label', label.join('，'));

    const circle = el('span', 'circle');
    circle.append(el('span', 'num', String(date.getDate())));
    if (info.label && !info.makeupWorkday) {
        circle.append(el('span', 'lunar holiday', shortLabel(info.label)));
    } else if (lunar) {
        circle.append(el('span', 'lunar' + (lunar.isFirst ? ' month-start' : ''), lunar.isFirst ? lunar.month : lunar.day));
    }
    if (info.makeupWorkday) circle.append(el('span', 'badge', '班'));

    const dots = el('span', 'dots');
    for (const ev of events.slice(0, 3)) {
        dots.append(el('span', `dot c-${ev.color}`));
    }
    cell.replaceChildren(circle, dots);
}

function refreshCell(key) {
    const cell = grid.querySelector(`[data-date="${key}"]`);
    if (cell) fillCell(cell, fromKey(key));
}

function refreshAllCells() {
    grid.querySelectorAll('.day').forEach(cell => fillCell(cell, fromKey(cell.dataset.date)));
}

function renderGrid(direction = 0) {
    ensureHolidays(state.viewYear);

    const first = new Date(state.viewYear, state.viewMonth, 1);
    const offset = (first.getDay() + 6) % 7; // 星期一開頭
    const days = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < offset; i++) {
        cells.push(el('span', 'cell blank'));
    }
    for (let d = 1; d <= days; d++) {
        const date = new Date(state.viewYear, state.viewMonth, d);
        const cell = el('button', 'cell day');
        cell.type = 'button';
        cell.dataset.date = toKey(date);
        cell.style.setProperty('--i', offset + d - 1);
        fillCell(cell, date);
        cells.push(cell);
    }

    grid.replaceChildren(...cells);
    grid.style.transform = '';
    grid.style.opacity = '';
    grid.classList.remove('from-below', 'from-above');
    if (direction) restartAnimation(grid, direction > 0 ? 'from-below' : 'from-above');
}

// ---------- 當日行程 ----------
function eventItem(key, ev) {
    const item = el('li', 'ev-item');
    item.append(el('span', `ev-bar c-${ev.color}`));

    const body = el('div', 'ev-body');
    body.append(el('div', 'ev-title', ev.title));
    body.append(el('div', 'ev-meta', `${ev.time || '全天'} · ${COLOR_NAMES[ev.color] || '其他'}`));
    item.append(body);

    const del = el('button', 'del-btn', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `刪除「${ev.title}」`);
    del.addEventListener('click', () => {
        const finish = () => {
            removeEvent(key, ev.id);
            refreshCell(key);
            renderAgenda();
            refreshIsland();
        };
        item.classList.add('removing');
        // 關閉動畫時 animationend 不會觸發
        if (getComputedStyle(item).animationName === 'none') {
            finish();
        } else {
            item.addEventListener('animationend', finish, { once: true });
        }
    });
    item.append(del);
    return item;
}

function renderAgenda() {
    const date = fromKey(state.selected);
    $('agenda-date').textContent = dateTitle(date);
    $('agenda-sub').textContent = dateSub(date);

    const list = $('agenda-list');
    const events = getEvents(state.selected);
    list.replaceChildren();

    if (!events.length) {
        const empty = el('li', 'empty');
        empty.append(el('div', '', '這天沒有行程'));
        empty.append(el('div', 'hint', '按下方「新增」加入行程・上下滑動月曆切換月份'));
        list.append(empty);
        return;
    }
    for (const ev of events) list.append(eventItem(state.selected, ev));
}

// ---------- 動態島 ----------
let islandTimer = 0;

function updateIslandMonth(animate) {
    const month = $('island-month');
    const text = `${state.viewYear}年${state.viewMonth + 1}月`;
    month.textContent = text;
    $('sr-status').textContent = text;
    if (animate) {
        restartAnimation(island, 'bump');
        restartAnimation(month, 'roll');
    }
}

function buildIslandDetail(key) {
    const date = fromKey(key);
    const info = getDayInfo(date);
    const events = getEvents(key);
    const box = $('island-detail');

    const head = el('div', 'isl-head');
    head.append(el('div', 'isl-day' + (info.off ? ' off' : ''), String(date.getDate())));
    const text = el('div', 'isl-text');
    text.append(el('div', 'isl-title', `${date.getFullYear()}年${date.getMonth() + 1}月 星期${WEEK_NAMES[date.getDay()]}`));
    text.append(el('div', 'isl-sub', dateSub(date)));
    head.append(text);
    box.replaceChildren(head);

    if (!events.length) {
        box.append(el('div', 'isl-empty', '這天沒有行程'));
        return;
    }
    const list = el('ul', 'isl-events');
    for (const ev of events.slice(0, 3)) {
        const li = el('li');
        li.append(el('span', `dot c-${ev.color}`), el('span', 'isl-time', ev.time || '全天'), el('span', 'isl-ev', ev.title));
        list.append(li);
    }
    if (events.length > 3) list.append(el('li', 'isl-more', `還有 ${events.length - 3} 個行程`));
    box.append(list);
}

function sizeIsland() {
    const detail = $('island-detail');
    detail.style.width = `${island.parentElement.clientWidth}px`;
    island.style.height = `${detail.offsetHeight}px`;
}

function expandIsland(key) {
    buildIslandDetail(key);
    island.classList.add('expanded');
    island.setAttribute('aria-expanded', 'true');
    sizeIsland();
    clearTimeout(islandTimer);
    islandTimer = setTimeout(collapseIsland, ISLAND_AUTO_CLOSE);
}

function collapseIsland() {
    clearTimeout(islandTimer);
    island.classList.remove('expanded');
    island.setAttribute('aria-expanded', 'false');
    island.style.height = '';
}

// 展開中時更新內容（不重設自動收合的計時）
function refreshIsland() {
    if (!island.classList.contains('expanded')) return;
    buildIslandDetail(state.selected);
    sizeIsland();
}

// ---------- 月份切換 ----------
function goToMonth(year, month) {
    const target = new Date(year, month, 1);
    const current = new Date(state.viewYear, state.viewMonth, 1);
    if (target.getTime() === current.getTime()) return;
    state.viewYear = target.getFullYear();
    state.viewMonth = target.getMonth();
    collapseIsland();
    renderGrid(target > current ? 1 : -1);
    updateIslandMonth(true);
    updateHolidayStatus();
}

// 滑動換月：新月份若包含今天就選今天，否則選 1 號
function shiftMonth(delta) {
    const target = new Date(state.viewYear, state.viewMonth + delta, 1);
    const today = fromKey(state.todayKey);
    const sameMonth = today.getFullYear() === target.getFullYear() && today.getMonth() === target.getMonth();
    state.selected = sameMonth ? state.todayKey : toKey(target);
    goToMonth(target.getFullYear(), target.getMonth());
    renderAgenda();
}

function selectDate(key) {
    const date = fromKey(key);
    const previous = state.selected;
    state.selected = key;

    if (date.getFullYear() !== state.viewYear || date.getMonth() !== state.viewMonth) {
        goToMonth(date.getFullYear(), date.getMonth());
    } else {
        if (previous) refreshCell(previous);
        refreshCell(key);
    }
    renderAgenda();
    expandIsland(key);
}

// ---------- 底部面板 ----------
function openSheet(dialog) {
    collapseIsland();
    dialog.classList.remove('closing');
    dialog.showModal();
}

function closeSheet(dialog) {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    const done = () => {
        dialog.classList.remove('closing');
        dialog.close();
    };
    if (getComputedStyle(dialog).animationName === 'none') {
        done();
    } else {
        dialog.addEventListener('animationend', done, { once: true });
    }
}

function openAddSheet() {
    const date = fromKey(state.selected);
    $('add-form').reset();
    $('add-title').textContent = `新增行程 · ${date.getMonth() + 1}月${date.getDate()}日`;
    openSheet($('add-sheet'));
}

function renderUpcoming() {
    const list = $('upcoming-list');
    const keys = Object.keys(state.events).filter(key => key >= state.todayKey).sort().slice(0, 30);
    list.replaceChildren();

    if (!keys.length) {
        list.append(el('li', 'empty', '目前沒有即將到來的行程'));
        return;
    }
    for (const key of keys) {
        const group = el('li', 'up-group');
        group.append(el('div', 'up-date', dateTitle(fromKey(key)) + (key === state.todayKey ? '（今天）' : '')));
        for (const ev of getEvents(key)) {
            const item = el('button', 'up-item');
            item.type = 'button';
            item.append(el('span', `dot c-${ev.color}`), el('span', 'up-time', ev.time || '全天'), el('span', 'up-title', ev.title));
            item.addEventListener('click', () => {
                closeSheet($('list-sheet'));
                selectDate(key);
            });
            group.append(item);
        }
        list.append(group);
    }
}

// ---------- 即時時鐘 ----------
function tick() {
    const now = new Date();
    const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if ($('island-clock').textContent !== clock) $('island-clock').textContent = clock;

    const key = toKey(now);
    if (key !== state.todayKey) {
        // 跨過午夜時更新「今天」的標示
        const oldToday = state.todayKey;
        state.todayKey = key;
        if (oldToday) {
            refreshCell(oldToday);
            refreshCell(key);
        }
    }
}

// ---------- 深色模式 ----------
function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet(THEME_KEY, next);
}

// ---------- 上下滑動 ----------
function bindSwipe() {
    const area = $('cal');
    let startX = 0;
    let startY = 0;
    let pointerId = null;
    let dragging = false;

    area.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        dragging = false;
    });

    area.addEventListener('pointermove', e => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
            if (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(dx)) return;
            // 開始拖曳後才捕捉指標，單純點擊日期不受影響
            dragging = true;
            area.setPointerCapture(e.pointerId);
            grid.classList.add('dragging');
            collapseIsland();
        }
        grid.style.transform = `translateY(${dy * 0.4}px)`;
        grid.style.opacity = String(1 - Math.min(Math.abs(dy) / 400, 0.5));
    });

    const end = e => {
        if (e.pointerId !== pointerId) return;
        pointerId = null;
        if (!dragging) return;
        dragging = false;
        grid.classList.remove('dragging');
        const dy = e.clientY - startY;
        if (e.type === 'pointerup' && Math.abs(dy) > SWIPE_THRESHOLD) {
            shiftMonth(dy < 0 ? 1 : -1); // 往上滑看下個月
        } else {
            grid.style.transform = '';
            grid.style.opacity = '';
        }
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);

    // 桌機用滑鼠滾輪
    let wheelSum = 0;
    let wheelLockUntil = 0;
    let lastWheel = 0;
    area.addEventListener('wheel', e => {
        e.preventDefault();
        const now = Date.now();
        if (now < wheelLockUntil) return;
        if (now - lastWheel > 200) wheelSum = 0;
        lastWheel = now;
        wheelSum += e.deltaY;
        if (Math.abs(wheelSum) > 50) {
            shiftMonth(wheelSum > 0 ? 1 : -1);
            wheelSum = 0;
            wheelLockUntil = now + 500;
        }
    }, { passive: false });
}

// ---------- 事件綁定 ----------
function bindEvents() {
    grid.addEventListener('click', e => {
        const cell = e.target.closest('.day');
        if (cell) selectDate(cell.dataset.date);
    });

    island.addEventListener('click', () => {
        if (island.classList.contains('expanded')) {
            collapseIsland();
        } else {
            expandIsland(state.selected);
        }
    });
    island.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            island.click();
        }
    });
    // 點動態島以外的地方就收合（點日期會重新展開，所以略過）
    document.addEventListener('pointerdown', e => {
        if (!island.contains(e.target) && !e.target.closest('.day')) collapseIsland();
    });
    window.addEventListener('resize', refreshIsland);

    $('btn-today').addEventListener('click', () => selectDate(state.todayKey));
    $('btn-add').addEventListener('click', openAddSheet);
    $('btn-list').addEventListener('click', () => {
        renderUpcoming();
        openSheet($('list-sheet'));
    });
    $('btn-theme').addEventListener('click', toggleTheme);

    $('add-form').addEventListener('submit', e => {
        e.preventDefault();
        const form = e.target;
        const title = $('ev-title').value.trim();
        if (!title) return;
        addEvent(state.selected, title, $('ev-time').value, form.elements.color.value);
        refreshCell(state.selected);
        renderAgenda();
        closeSheet($('add-sheet'));
        expandIsland(state.selected);
    });

    document.querySelectorAll('.sheet').forEach(dialog => {
        dialog.addEventListener('cancel', e => {
            e.preventDefault();
            closeSheet(dialog);
        });
        dialog.addEventListener('click', e => {
            // 點到面板外的背景
            if (e.target === dialog) closeSheet(dialog);
        });
        dialog.querySelectorAll('[data-close]').forEach(btn => {
            btn.addEventListener('click', () => closeSheet(dialog));
        });
    });

    document.addEventListener('keydown', e => {
        if (e.target.closest('input, textarea, dialog')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') shiftMonth(-1);
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') shiftMonth(1);
        else if (e.key === 't' || e.key === 'T') selectDate(state.todayKey);
        else if (e.key === 'Escape') collapseIsland();
        else return;
        e.preventDefault();
    });

    bindSwipe();
}

// ---------- 初始化 ----------
function init() {
    applyTheme(storageGet(THEME_KEY));

    tick();
    setInterval(tick, 1000);

    const today = fromKey(state.todayKey);
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth();
    state.selected = state.todayKey;

    bindEvents();
    renderGrid();
    updateIslandMonth(false);
    updateHolidayStatus();
    renderAgenda();

    // 開場：動態島展開一下今天的資訊
    setTimeout(() => expandIsland(state.selected), 600);
}

init();
