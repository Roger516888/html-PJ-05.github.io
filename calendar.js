// ===== 動態日曆 =====
// 功能：月份切換動畫、即時時鐘、農曆、台灣國定假日（線上載入）、每日行程（存在瀏覽器）

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
const MAX_CHIPS = 2;

const $ = id => document.getElementById(id);
const grid = $('grid');

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
        updateHolidayStatus();
    }

    const data = await fetchHolidayYear(year);
    if (data) {
        state.holidays[year] = { status: 'ok', days: parseHolidayData(data) };
        storageSet(HOLIDAY_KEY_PREFIX + year, JSON.stringify({ savedAt: Date.now(), data }));
    } else if (state.holidays[year].status !== 'ok') {
        state.holidays[year] = { status: 'failed', days: {} };
    }
    refreshAllCells();
    renderPanel();
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

function updateHolidayStatus() {
    const status = state.holidays[state.viewYear];
    const text = $('holiday-status');
    if (!status || status.status === 'loading') {
        text.textContent = '假日資料載入中…';
    } else if (status.status === 'failed') {
        text.textContent = `無法載入 ${state.viewYear} 年假日資料，目前僅標示週末`;
    } else {
        text.textContent = '假日資料來源：政府行政機關辦公日曆表';
    }
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

// ---------- 月曆格子 ----------
function fillCell(cell, date) {
    const key = toKey(date);
    const info = getDayInfo(date);
    const lunar = getLunar(date);
    const events = getEvents(key);

    cell.classList.toggle('other', date.getMonth() !== state.viewMonth);
    cell.classList.toggle('today', key === state.todayKey);
    cell.classList.toggle('selected', key === state.selected);
    cell.classList.toggle('off', info.off);
    cell.setAttribute('aria-pressed', key === state.selected ? 'true' : 'false');
    if (key === state.todayKey) {
        cell.setAttribute('aria-current', 'date');
    } else {
        cell.removeAttribute('aria-current');
    }

    const label = [`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 星期${WEEK_NAMES[date.getDay()]}`];
    if (info.label) label.push(info.label);
    if (events.length) label.push(`${events.length} 個行程`);
    cell.setAttribute('aria-label', label.join('，'));

    cell.replaceChildren();

    const top = el('div', 'day-top');
    top.append(el('span', 'day-num', String(date.getDate())));
    if (lunar) {
        top.append(el('span', 'lunar' + (lunar.isFirst ? ' month-start' : ''), lunar.isFirst ? lunar.month : lunar.day));
    }
    cell.append(top);

    if (info.label) {
        cell.append(el('div', 'tag ' + (info.makeupWorkday ? 'workday' : 'holiday'), info.label));
    }

    if (events.length) {
        const chips = el('div', 'chips');
        for (const ev of events.slice(0, MAX_CHIPS)) {
            chips.append(el('div', `chip c-${ev.color}`, (ev.time ? ev.time + ' ' : '') + ev.title));
        }
        cell.append(chips);
        if (events.length > MAX_CHIPS) {
            cell.append(el('div', 'more', `+${events.length - MAX_CHIPS} 個`));
        }
    }
}

function refreshCell(key) {
    const cell = grid.querySelector(`[data-date="${key}"]`);
    if (cell) fillCell(cell, fromKey(key));
}

function refreshAllCells() {
    grid.querySelectorAll('.day').forEach(cell => fillCell(cell, fromKey(cell.dataset.date)));
}

function renderGrid(direction) {
    const first = new Date(state.viewYear, state.viewMonth, 1);
    const start = new Date(state.viewYear, state.viewMonth, 1 - first.getDay());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);

    // 月曆前後可能跨年，兩個年份的假日都要載入（有快取時會立即可用）
    new Set([start.getFullYear(), end.getFullYear()]).forEach(ensureHolidays);

    const cells = [];
    for (let i = 0; i < 42; i++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const cell = el('button', 'day');
        cell.type = 'button';
        cell.dataset.date = toKey(date);
        cell.style.setProperty('--i', i);
        fillCell(cell, date);
        cells.push(cell);
    }

    grid.classList.remove('slide-next', 'slide-prev');
    grid.replaceChildren(...cells);
    if (direction) {
        void grid.offsetWidth; // 重新觸發動畫
        grid.classList.add(direction > 0 ? 'slide-next' : 'slide-prev');
    }
}

function renderHeader() {
    const yearSelect = $('year-select');
    yearSelect.replaceChildren();
    for (let y = state.viewYear - 10; y <= state.viewYear + 10; y++) {
        const opt = el('option', '', `${y}年`);
        opt.value = y;
        yearSelect.append(opt);
    }
    yearSelect.value = state.viewYear;
    $('month-select').value = state.viewMonth;
}

function render(direction = 0) {
    renderHeader();
    renderGrid(direction);
    updateHolidayStatus();
}

// ---------- 月份切換 ----------
function goToMonth(year, month) {
    const target = new Date(year, month, 1);
    const current = new Date(state.viewYear, state.viewMonth, 1);
    if (target.getTime() === current.getTime()) return;
    state.viewYear = target.getFullYear();
    state.viewMonth = target.getMonth();
    render(target > current ? 1 : -1);
}

function shiftMonth(delta) {
    goToMonth(state.viewYear, state.viewMonth + delta);
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
    renderPanel();
}

// ---------- 右側面板 ----------
function renderPanel() {
    const key = state.selected;
    const date = fromKey(key);
    const info = getDayInfo(date);
    const lunar = getLunar(date);

    $('panel-date').textContent = `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEK_NAMES[date.getDay()]}`;
    const sub = [`${date.getFullYear()}年`];
    if (lunar) sub.push(`農曆${lunar.month}${lunar.day}`);
    if (info.label) sub.push(info.label);
    $('panel-sub').textContent = sub.join(' · ');

    const list = $('event-list');
    const events = getEvents(key);
    list.replaceChildren();

    if (!events.length) {
        list.append(el('li', 'empty', '這天還沒有行程'));
        return;
    }

    for (const ev of events) {
        const item = el('li', 'event-item');
        item.append(el('span', `event-bar c-${ev.color}`));

        const body = el('div', 'event-body');
        body.append(el('div', 'event-title', ev.title));
        body.append(el('div', 'event-meta', `${ev.time || '全天'} · ${COLOR_NAMES[ev.color] || '其他'}`));
        item.append(body);

        const del = el('button', 'del-btn', '✕');
        del.type = 'button';
        del.setAttribute('aria-label', `刪除「${ev.title}」`);
        del.addEventListener('click', () => {
            item.classList.add('removing');
            item.addEventListener('animationend', () => {
                removeEvent(key, ev.id);
                refreshCell(key);
                renderPanel();
            }, { once: true });
            // 關閉動畫時 animationend 不會觸發
            if (getComputedStyle(item).animationName === 'none') {
                removeEvent(key, ev.id);
                refreshCell(key);
                renderPanel();
            }
        });
        item.append(del);
        list.append(item);
    }
}

// ---------- 即時時鐘 ----------
function tick() {
    const now = new Date();
    $('clock-time').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const key = toKey(now);
    if (key !== state.todayKey) {
        // 跨過午夜時更新「今天」的標示
        const oldToday = state.todayKey;
        state.todayKey = key;
        const lunar = getLunar(now);
        $('clock-date').textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK_NAMES[now.getDay()]}` +
            (lunar ? ` · 農曆${lunar.month}${lunar.day}` : '');
        if (oldToday) {
            refreshCell(oldToday);
            refreshCell(key);
        }
    }
}

// ---------- 深色模式 ----------
function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
        document.documentElement.dataset.theme = theme;
    } else {
        delete document.documentElement.dataset.theme;
    }
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet(THEME_KEY, next);
}

// ---------- 事件綁定 ----------
function bindEvents() {
    $('prev-month').addEventListener('click', () => shiftMonth(-1));
    $('next-month').addEventListener('click', () => shiftMonth(1));
    $('today-btn').addEventListener('click', () => selectDate(state.todayKey));
    $('theme-toggle').addEventListener('click', toggleTheme);

    $('year-select').addEventListener('change', e => goToMonth(Number(e.target.value), state.viewMonth));
    $('month-select').addEventListener('change', e => goToMonth(state.viewYear, Number(e.target.value)));

    grid.addEventListener('click', e => {
        const cell = e.target.closest('.day');
        if (cell) selectDate(cell.dataset.date);
    });

    $('event-form').addEventListener('submit', e => {
        e.preventDefault();
        const title = $('event-title').value.trim();
        if (!title) return;
        addEvent(state.selected, title, $('event-time').value, $('event-color').value);
        $('event-title').value = '';
        $('event-time').value = '';
        refreshCell(state.selected);
        renderPanel();
        $('event-title').focus();
    });

    document.addEventListener('keydown', e => {
        if (e.target.closest('input, select, textarea')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'ArrowLeft') shiftMonth(-1);
        else if (e.key === 'ArrowRight') shiftMonth(1);
        else if (e.key === 't' || e.key === 'T') selectDate(state.todayKey);
    });

    // 手機左右滑動切換月份
    let touchX = 0;
    let touchY = 0;
    const viewport = document.querySelector('.grid-viewport');
    viewport.addEventListener('touchstart', e => {
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
    }, { passive: true });
    viewport.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - touchX;
        const dy = e.changedTouches[0].clientY - touchY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            shiftMonth(dx < 0 ? 1 : -1);
        }
    });
}

// ---------- 初始化 ----------
function init() {
    applyTheme(storageGet(THEME_KEY));

    const monthSelect = $('month-select');
    for (let m = 0; m < 12; m++) {
        const opt = el('option', '', `${m + 1}月`);
        opt.value = m;
        monthSelect.append(opt);
    }

    tick();
    setInterval(tick, 1000);

    const today = new Date();
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth();
    state.selected = state.todayKey;

    bindEvents();
    render();
    renderPanel();
}

init();
