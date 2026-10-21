// ===== 採購時程日曆 =====
// 點日期設定某個節點（例如上網公告、開標），其他節點依「與前一節點相隔幾天」自動往前後推算；
// 相隔天數可用半天為單位（上午／下午），版面為連續週曆長條，可直接用 A4 直式列印。

const STORE_KEY = 'procure-calendar-v2';
const OLD_STORE_KEY = 'procure-calendar-v1';
const HOLIDAY_KEY_PREFIX = 'dyn-calendar-holidays-';
const HOLIDAY_CACHE_DAYS = 7;
const HOLIDAY_SOURCES = [
    year => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
    year => `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${year}.json`
];
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const UNIT_NAMES = { cal: '日曆天', work: '工作天' };
const SLOT_NAMES = { day: '全天', am: '上午', pm: '下午' };
const COLORS = ['#2f6fdf', '#0f9488', '#d9822b', '#c2410c', '#8b5cf6', '#db2777', '#16a34a', '#e0453a', '#0e7fa8', '#64748b'];
const DEFAULT_STEPS = [
    { name: '上網公告', offset: 0, unit: 'cal', slot: 'day', roll: false, note: '' },
    { name: '結標', offset: 28, unit: 'cal', slot: 'day', roll: true, note: '' },
    { name: '開標', offset: 1, unit: 'work', slot: 'am', roll: true, note: '' },
    { name: 'POC說明會', offset: 0.5, unit: 'cal', slot: 'pm', roll: true, note: '' },
    { name: 'POC', offset: 14, unit: 'cal', slot: 'day', roll: true, note: '廠商申請空域 14 天' },
    { name: '評選', offset: 7, unit: 'cal', slot: 'day', roll: true, note: '' },
    { name: '決標', offset: 3, unit: 'work', slot: 'day', roll: true, note: '' },
    { name: '履約期限', offset: 180, unit: 'cal', slot: 'day', roll: false, note: '' }
];
// 第一版的預設流程；使用者沒改過的話，升級成新的預設流程
const V1_DEFAULT = [['上網公告', 0, 'cal'], ['結標', 28, 'cal'], ['開標', 1, 'work'], ['POC', 7, 'cal'],
    ['評選', 7, 'cal'], ['決標', 3, 'work'], ['履約期限', 180, 'cal']];
// 格子裡放不下的節日名稱改用簡稱
const SHORT_NAMES = {
    '開國紀念日': '元旦',
    '農曆除夕': '除夕',
    '兒童節及民族掃墓節': '兒童節',
    '孔子誕辰紀念日': '教師節',
    '臺灣光復暨金門古寧頭大捷紀念日': '光復節'
};
const MAX_STEPS = 16;
const MAX_OFFSET = 1500;
const LOOP_LIMIT = 6000;

const $ = id => document.getElementById(id);
const holidays = {};      // { 2026: { status: 'ok' | 'loading' | 'failed', days: { 'YYYY-MM-DD': {...} } } }
const undoStack = [];
let state = loadState();
let dates = [];           // 各節點的日期（Date）
let slots = [];           // 各節點的時段：day / am / pm
let rolled = [];          // 各節點是否因遇假日而順延
let periodMap = {};       // 'YYYY-MM-DD' → { i, label }：落在第 i 段期間及其天數標示
let pendingSnapshot = null;

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

function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function diffDays(a, b) {
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
        Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

function mondayOf(date) {
    return addDays(date, -((date.getDay() + 6) % 7));
}

function fmtDate(date) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}（${WEEK_NAMES[date.getDay()]}）`;
}

function fmtWhen(i) {
    return fmtDate(dates[i]) + (slots[i] !== 'day' ? SLOT_NAMES[slots[i]] : '');
}

function clampInt(value, min, max) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

// 天數以半天為最小單位
function clampHalf(value) {
    const n = Math.round(Number(value) * 2) / 2;
    return Number.isFinite(n) ? Math.min(MAX_OFFSET, Math.max(0, n)) : 0;
}

function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
        // 無痕模式或停用儲存空間時忽略，工具仍可正常使用
    }
}

// ---------- 狀態（存在瀏覽器） ----------
function defaultSteps() {
    return DEFAULT_STEPS.map((step, i) => ({ ...step, id: newId(), color: COLORS[i % COLORS.length] }));
}

function defaultState() {
    const steps = defaultSteps();
    return {
        title: '',
        note: '',
        startRule: 'next',
        anchorId: steps[0].id,
        anchorDate: toKey(new Date()),
        activeId: steps[0].id,
        steps
    };
}

function cleanStep(s, i) {
    return {
        id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : newId(),
        name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 20) : `節點${i + 1}`,
        offset: clampHalf(s.offset),
        unit: s.unit === 'work' ? 'work' : 'cal',
        slot: s.slot === 'am' || s.slot === 'pm' ? s.slot : 'day',
        roll: !!s.roll,
        note: typeof s.note === 'string' ? s.note.slice(0, 40) : '',
        color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : COLORS[i % COLORS.length]
    };
}

function loadState() {
    const base = defaultState();
    try {
        let saved = JSON.parse(storageGet(STORE_KEY) || 'null');
        if (!saved) saved = migrateV1(JSON.parse(storageGet(OLD_STORE_KEY) || 'null'));
        if (!saved || !Array.isArray(saved.steps) || saved.steps.length < 2) return base;
        const steps = saved.steps.slice(0, MAX_STEPS).map(cleanStep);
        const ids = steps.map(s => s.id);
        return {
            title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : '',
            note: typeof saved.note === 'string' ? saved.note.slice(0, 2000) : '',
            startRule: saved.startRule === 'same' ? 'same' : 'next',
            anchorId: ids.includes(saved.anchorId) ? saved.anchorId : ids[0],
            anchorDate: /^\d{4}-\d{2}-\d{2}$/.test(saved.anchorDate) ? saved.anchorDate : base.anchorDate,
            activeId: ids.includes(saved.activeId) ? saved.activeId : ids[0],
            steps
        };
    } catch (e) {
        return base;
    }
}

// 第一版用索引記錄基準節點，改成用 id；沒改過的預設流程直接換成新的預設流程
function migrateV1(old) {
    if (!old || !Array.isArray(old.steps) || old.steps.length < 2) return null;
    const untouched = old.steps.length === V1_DEFAULT.length &&
        old.steps.every((s, i) => s.name === V1_DEFAULT[i][0] && s.offset === V1_DEFAULT[i][1] && s.unit === V1_DEFAULT[i][2]);
    const anchorName = (old.steps[old.anchorIndex] || old.steps[0]).name;
    const activeName = (old.steps[old.active] || old.steps[0]).name;
    const steps = untouched ? defaultSteps() : old.steps.map((s, i) => ({ ...s, id: newId(), color: s.color || COLORS[i % COLORS.length] }));
    const find = name => (steps.find(s => s.name === name) || steps[0]).id;
    return { ...old, steps, anchorId: find(anchorName), activeId: find(activeName) };
}

function saveState() {
    storageSet(STORE_KEY, JSON.stringify(state));
}

function indexOf(id) {
    const i = state.steps.findIndex(s => s.id === id);
    return i < 0 ? 0 : i;
}

function snapshot() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 50) undoStack.shift();
    updateUndoButton();
}

function undo() {
    if (!undoStack.length) return;
    state = JSON.parse(undoStack.pop());
    saveState();
    refresh();
    syncHeader();
    if ($('settings').open) buildStepsTable();
    updateUndoButton();
    showReadout(toKey(dates[indexOf(state.anchorId)]));
}

function updateUndoButton() {
    $('btn-undo').disabled = undoStack.length === 0;
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
    if (holidays[year]) return;

    const cached = storageGet(HOLIDAY_KEY_PREFIX + year);
    if (cached) {
        try {
            const { savedAt, data } = JSON.parse(cached);
            holidays[year] = { status: 'ok', days: parseHolidayData(data) };
            if (Date.now() - savedAt < HOLIDAY_CACHE_DAYS * 86400000) return;
        } catch (e) {
            // 快取損毀就重新下載
        }
    }

    if (!holidays[year]) holidays[year] = { status: 'loading', days: {} };

    const data = await fetchHolidayYear(year);
    if (data) {
        holidays[year] = { status: 'ok', days: parseHolidayData(data) };
        storageSet(HOLIDAY_KEY_PREFIX + year, JSON.stringify({ savedAt: Date.now(), data }));
    } else if (holidays[year].status !== 'ok') {
        holidays[year] = { status: 'failed', days: {} };
    }
    // 工作天與順延都依假日而定，載入後重新推算
    refresh();
}

function holidayInfo(date) {
    const yearData = holidays[date.getFullYear()];
    return yearData ? yearData.days[toKey(date)] : undefined;
}

function isWorkday(date) {
    const info = holidayInfo(date);
    if (info) return !info.isHoliday;
    const day = date.getDay();
    return day !== 0 && day !== 6;
}

function dayLabel(date) {
    const info = holidayInfo(date);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    if (!info) return { off: weekend, label: '', makeup: false };
    if (!info.isHoliday && weekend) return { off: false, label: '補班', makeup: true };
    return { off: info.isHoliday, label: info.isHoliday ? info.description : '', makeup: false };
}

function shortLabel(label) {
    const part = label.split('/').pop();
    return SHORT_NAMES[label] || SHORT_NAMES[part] || part;
}

// ---------- 推算日期 ----------
// 次日起算：起始日不算，往後第 n 天；當日起算：起始日算第 1 天
function forward(start, n, unit) {
    if (n <= 0) return start;
    if (unit === 'cal') return addDays(start, state.startRule === 'same' ? n - 1 : n);
    let d = state.startRule === 'same' ? addDays(start, -1) : start;
    let count = 0;
    for (let guard = 0; count < n && guard < LOOP_LIMIT; guard++) {
        d = addDays(d, 1);
        if (isWorkday(d)) count++;
    }
    return d;
}

function backward(end, n, unit) {
    if (n <= 0) return end;
    if (unit === 'cal') return addDays(end, -(state.startRule === 'same' ? n - 1 : n));
    // 從結束日往前數 n 個工作天，找到第 1 個計入的工作天
    let d = addDays(end, 1);
    let count = 0;
    for (let guard = 0; count < n && guard < LOOP_LIMIT; guard++) {
        d = addDays(d, -1);
        if (isWorkday(d)) count++;
    }
    return state.startRule === 'same' ? d : addDays(d, -1);
}

function rollTo(date, step) {
    let d = date;
    for (let guard = 0; !isWorkday(d) && guard < 60; guard++) d = addDays(d, step);
    return d;
}

// 往後或往前一天；工作天只算上班日
function nextDay(date, unit, dir) {
    const d = addDays(date, dir);
    return unit === 'work' ? rollTo(d, dir) : d;
}

// 整數天依起算方式計算；多出的半天：上午→同日下午，下午→隔天上午
function stepForward(prevDate, prevSlot, step) {
    const whole = Math.floor(step.offset);
    const half = step.offset - whole >= 0.5;
    let d = forward(prevDate, whole, step.unit);
    let slot = step.slot;
    if (half) {
        if (prevSlot === 'pm') {
            d = nextDay(d, step.unit, 1);
            slot = 'am';
        } else {
            slot = 'pm';
        }
    }
    return { d, slot };
}

function stepBackward(nextDate, nextSlot, step, prevStep) {
    const whole = Math.floor(step.offset);
    const half = step.offset - whole >= 0.5;
    let d = nextDate;
    let slot = prevStep.slot;
    if (half) {
        if (nextSlot === 'pm') {
            slot = 'am';
        } else {
            d = nextDay(d, step.unit, -1);
            slot = 'pm';
        }
    }
    return { d: backward(d, whole, step.unit), slot };
}

function compute() {
    const steps = state.steps;
    const a = indexOf(state.anchorId);
    dates = new Array(steps.length);
    slots = new Array(steps.length);
    rolled = new Array(steps.length).fill(false);
    dates[a] = fromKey(state.anchorDate);
    slots[a] = steps[a].slot;

    for (let i = a + 1; i < steps.length; i++) {
        let { d, slot } = stepForward(dates[i - 1], slots[i - 1], steps[i]);
        if (steps[i].roll && !isWorkday(d)) {
            d = rollTo(d, 1);
            rolled[i] = true;
        }
        dates[i] = d;
        slots[i] = slot;
    }
    for (let i = a - 1; i >= 0; i--) {
        let { d, slot } = stepBackward(dates[i + 1], slots[i + 1], steps[i + 1], steps[i]);
        if (steps[i].roll && !isWorkday(d)) {
            d = rollTo(d, -1);
            rolled[i] = true;
        }
        dates[i] = d;
        slots[i] = slot;
    }

    // 每段期間的天數標示：日曆天標「第 N 天」，工作天只在上班日標「第 N 工作天」；不足一天的不標
    periodMap = {};
    for (let i = 1; i < steps.length; i++) {
        if (steps[i].offset < 1) continue;
        const end = dates[i];
        let d = periodStart(i);
        let calIdx = 0;
        let workIdx = 0;
        for (let guard = 0; d <= end && guard < LOOP_LIMIT; guard++) {
            calIdx++;
            const work = isWorkday(d);
            if (work) workIdx++;
            let label = '';
            if (steps[i].unit === 'cal') label = `第${calIdx}天`;
            else if (work) label = `第${workIdx}工作天`;
            periodMap[toKey(d)] = { i, label };
            d = addDays(d, 1);
        }
    }
}

function periodStart(i) {
    return state.startRule === 'same' ? dates[i - 1] : addDays(dates[i - 1], 1);
}

function offsetText(step) {
    return `${step.offset} ${UNIT_NAMES[step.unit]}`;
}

function ruleText(i) {
    if (i === 0) return '起點';
    const step = state.steps[i];
    return `${state.steps[i - 1].name}後 ${offsetText(step)}` + (step.note ? `（${step.note}）` : '');
}

// ---------- 畫面 ----------
function refresh() {
    // 有快取的假日資料會立即可用，載入後要重新推算一次工作天與順延
    for (let pass = 0; pass < 3; pass++) {
        compute();
        if (!loadHolidayYears()) break;
    }
    renderIsland();
    renderStrip();
    renderSummary();
    renderMeta();
    if ($('settings').open) syncStepDates();
}

function renderIsland() {
    const ai = indexOf(state.activeId);
    const active = state.steps[ai];
    $('active-name').textContent = active.name;
    $('active-name').style.setProperty('--active-color', active.color);

    const list = $('chips');
    list.replaceChildren();
    state.steps.forEach((step, i) => {
        const chip = el('button', 'chip' + (i === ai ? ' active' : ''));
        chip.type = 'button';
        chip.dataset.id = step.id;
        chip.style.setProperty('--c', step.color);
        chip.setAttribute('aria-pressed', String(i === ai));
        chip.append(el('span', 'chip-name', step.name));
        chip.append(el('span', 'chip-date', fmtWhen(i)));
        const rule = i === 0 ? '起點' : `+${offsetText(step)}`;
        chip.append(el('span', 'chip-rule', rule + (rolled[i] ? '・順延' : '')));
        if (step.note) chip.append(el('span', 'chip-note', step.note));
        if (step.id === state.anchorId) chip.append(el('span', 'chip-tag', '基準'));
        const li = el('li');
        li.append(chip);
        list.append(li);
    });
    updateIslandHeight();
}

function updateIslandHeight() {
    const island = $('island');
    const sticky = getComputedStyle(island).position === 'sticky';
    document.documentElement.style.setProperty('--island-h', sticky ? `${island.offsetHeight + 8}px` : '0px');
}

// 週曆範圍：最早節點所在月份的第一週，到最晚節點所在月份的最後一週
function stripRange() {
    let min = dates[0];
    let max = dates[0];
    for (const d of dates) {
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return {
        start: mondayOf(new Date(min.getFullYear(), min.getMonth(), 1)),
        end: addDays(mondayOf(new Date(max.getFullYear(), max.getMonth() + 1, 0)), 6)
    };
}

// 回傳是否有年份的假日資料剛從快取取得
function loadHolidayYears() {
    const { start, end } = stripRange();
    let changed = false;
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
        if (holidays[y]) continue;
        ensureHolidays(y);
        if (holidays[y] && holidays[y].status === 'ok') changed = true;
    }
    return changed;
}

function renderStrip() {
    const { start, end } = stripRange();

    const milestones = {};
    dates.forEach((d, i) => {
        const key = toKey(d);
        (milestones[key] = milestones[key] || []).push(i);
    });
    // 同一天先上午、再全天、後下午
    const slotOrder = { am: 0, day: 1, pm: 2 };
    Object.values(milestones).forEach(list => list.sort((x, y) => slotOrder[slots[x]] - slotOrder[slots[y]] || x - y));
    const todayKey = toKey(new Date());

    const rows = [];
    for (let week = start, first = true; week <= end; week = addDays(week, 7), first = false) {
        const tr = el('tr');
        const label = el('th', 'month-label');
        label.scope = 'row';
        // 這週有 1 號就標出月份
        for (let k = 0; k < 7; k++) {
            const day = addDays(week, k);
            if (day.getDate() === 1) {
                if (first || day.getMonth() === 0) label.append(el('span', 'year', String(day.getFullYear())));
                label.append(document.createTextNode(`${day.getMonth() + 1}月`));
            }
        }
        tr.append(label);

        for (let k = 0; k < 7; k++) {
            const day = addDays(week, k);
            const key = toKey(day);
            const info = dayLabel(day);
            const period = periodMap[key];
            const ms = milestones[key] || [];

            const td = el('td', 'cell');
            if (day.getMonth() % 2 === 1) td.classList.add('alt');
            if (info.off) td.classList.add('off');
            if (key === todayKey) td.classList.add('today');
            if (period) {
                td.classList.add('tinted');
                td.style.setProperty('--tint', hexToRgba(state.steps[period.i].color, 0.12));
            }
            if (ms.length) {
                td.classList.add('ms');
                td.style.setProperty('--c', state.steps[ms[0]].color);
            }

            const btn = el('button', 'day');
            btn.type = 'button';
            btn.dataset.date = key;
            const aria = [fmtDate(day)];
            if (info.label) aria.push(info.label);
            ms.forEach(i => aria.push(state.steps[i].name + (slots[i] !== 'day' ? SLOT_NAMES[slots[i]] : '')));
            if (period && period.label) aria.push(`${state.steps[period.i - 1].name}後${period.label}`);
            btn.setAttribute('aria-label', aria.join('，'));

            const top = el('span', 'day-top');
            top.append(el('span', 'num' + (day.getDate() === 1 ? ' month-start' : ''),
                day.getDate() === 1 ? `${day.getMonth() + 1}/1` : String(day.getDate())));
            if (period && period.label) top.append(el('span', 'idx', period.label));
            btn.append(top);

            if (info.label) btn.append(el('span', 'hol' + (info.makeup ? ' workday' : ''), shortLabel(info.label)));

            if (ms.length) {
                const pills = el('span', 'pills');
                ms.forEach(i => {
                    const pill = el('span', 'pill' + (rolled[i] ? ' rolled' : ''));
                    pill.style.setProperty('--c', state.steps[i].color);
                    if (slots[i] !== 'day') pill.append(el('span', 'slot', SLOT_NAMES[slots[i]]));
                    pill.append(document.createTextNode(state.steps[i].name));
                    pills.append(pill);
                });
                btn.append(pills);
            }
            td.append(btn);
            tr.append(td);
        }
        rows.push(tr);
    }
    $('weeks').replaceChildren(...rows);
}

function renderSummary() {
    const body = $('summary-body');
    body.replaceChildren();
    state.steps.forEach((step, i) => {
        const tr = el('tr');
        const name = el('td');
        const swatch = el('span', 'swatch');
        swatch.style.setProperty('--c', step.color);
        name.append(swatch, document.createTextNode(step.name + (step.id === state.anchorId ? '（基準）' : '')));
        tr.append(name);
        tr.append(el('td', '', fmtWhen(i) + (rolled[i] ? '（遇假日順延）' : '')));
        tr.append(el('td', '', ruleText(i)));
        const span = i === 0 || step.offset < 1 ? '—' : `${fmtDate(periodStart(i))} ～ ${fmtDate(dates[i])}`;
        tr.append(el('td', '', span));
        body.append(tr);
    });
}

function renderMeta() {
    const years = Object.keys(holidays).sort();
    const failed = years.filter(y => holidays[y].status === 'failed');
    const loading = years.some(y => holidays[y].status === 'loading');
    const meta = $('doc-meta');
    meta.replaceChildren();
    const rule = state.startRule === 'same' ? '當日起算（起始日算第 1 天）' : '次日起算（始日不算入）';
    meta.append(document.createTextNode(`天數${rule}｜製表日期 ${fmtDate(new Date())}`));
    if (failed.length) {
        meta.append(document.createTextNode('｜'));
        meta.append(el('span', 'warn', `無法載入 ${failed.join('、')} 年國定假日，工作天僅扣除週末`));
    } else if (loading) {
        meta.append(document.createTextNode('｜假日資料載入中…'));
    }

    $('foot-note').textContent =
        `說明：日曆天${state.startRule === 'same' ? '以起始日為第 1 天' : '自起始日次日起算（始日不算入）'}；` +
        '半天為單位時，上午加半天為同日下午，下午加半天為隔天上午；' +
        '工作天扣除週六、週日及國定假日（依政府行政機關辦公日曆表），補行上班日計為工作天；' +
        '標示「順延」者為原推算日遇停止上班日，順延至次一上班日（往前推算時改為前一上班日）。';
}

function cellOf(key) {
    return document.querySelector(`.day[data-date="${key}"]`);
}

function flash(key) {
    const btn = cellOf(key);
    if (!btn) return;
    const td = btn.parentElement;
    td.classList.remove('flash');
    void td.offsetWidth;
    td.classList.add('flash');
}

// 游標所在日期的說明：是哪個節點、在哪段期間的第幾天、距下一節點幾天
function showReadout(key, prefix) {
    const date = fromKey(key);
    const out = $('readout');
    out.replaceChildren();
    const parts = [];
    const info = dayLabel(date);
    const head = fmtDate(date) + (info.label ? ` ${info.label}` : '');

    const ms = [];
    dates.forEach((d, i) => {
        if (toKey(d) === key) ms.push(state.steps[i].name + (slots[i] !== 'day' ? `（${SLOT_NAMES[slots[i]]}）` : ''));
    });
    if (ms.length) parts.push(`這天是「${ms.join('、')}」`);

    const period = periodMap[key];
    if (period) {
        const i = period.i;
        const step = state.steps[i];
        const calIdx = diffDays(periodStart(i), date) + 1;
        let text = `${state.steps[i - 1].name}後第 ${calIdx} 天`;
        if (step.unit === 'work' && period.label) text += `（${period.label}）`;
        parts.push(text);
        const left = diffDays(date, dates[i]);
        if (left > 0) parts.push(`距${step.name}還有 ${left} 天`);
    } else if (!ms.length) {
        if (date < dates[0]) parts.push(`距${state.steps[0].name}還有 ${diffDays(date, dates[0])} 天`);
        const last = dates.length - 1;
        if (date > dates[last]) parts.push(`${state.steps[last].name}後 ${diffDays(dates[last], date)} 天`);
    }

    if (prefix) out.append(el('span', '', prefix));
    out.append(el('strong', '', head));
    if (parts.length) out.append(el('span', '', '｜' + parts.join('｜')));
}

// ---------- 設定節點日期 ----------
function setMilestone(id, key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const before = cellOf(key);
    const beforeTop = before ? before.getBoundingClientRect().top : null;
    snapshot();
    // 半天推算出來的時段，設為基準時沿用目前的時段
    const i = indexOf(id);
    if (slots[i]) state.steps[i].slot = slots[i];
    state.anchorId = id;
    state.anchorDate = key;
    saveState();
    refresh();
    // 版面範圍可能改變，讓點到的格子留在原來的位置
    const after = cellOf(key);
    if (after && beforeTop !== null) window.scrollBy(0, after.getBoundingClientRect().top - beforeTop);
    showReadout(key, `已設定「${state.steps[i].name}」：`);
    flash(key);
}

function setActive(id) {
    state.activeId = id;
    saveState();
    renderIsland();
}

// ---------- 流程設定 ----------
function makeInput(type, id, field, value, label) {
    const input = el('input');
    input.type = type;
    input.id = id;
    input.dataset.field = field;
    input.setAttribute('aria-label', label);
    if (type === 'checkbox') input.checked = value;
    else input.value = value;
    return input;
}

function buildStepsTable() {
    const body = $('steps-body');
    body.replaceChildren();
    const last = state.steps.length - 1;
    state.steps.forEach((step, i) => {
        const tr = el('tr');
        tr.dataset.id = step.id;
        // 頭尾節點固定，中間的節點可以拖曳排序
        const movable = i > 0 && i < last;

        const handleTd = el('td');
        const handle = el('button', 'handle' + (movable ? '' : ' fixed'), '⠿');
        handle.type = 'button';
        handle.dataset.field = 'handle';
        handle.id = `step-handle-${step.id}`;
        handle.disabled = !movable;
        handle.setAttribute('aria-label', movable ? `拖曳或按上下鍵調整「${step.name}」的順序` : '頭尾節點固定');
        handleTd.append(handle);

        const nameTd = el('td');
        const nameWrap = el('div', 'name-cell');
        const swatch = el('span', 'swatch');
        swatch.style.setProperty('--c', step.color);
        const name = makeInput('text', `step-name-${step.id}`, 'name', step.name, `第 ${i + 1} 個節點名稱`);
        name.maxLength = 20;
        nameWrap.append(swatch, name);
        nameTd.append(nameWrap);

        const gapTd = el('td');
        if (i === 0) {
            gapTd.append(el('span', 'muted', '起點'));
        } else {
            const gap = el('div', 'gap-cell');
            const offset = makeInput('number', `step-offset-${step.id}`, 'offset', step.offset, `${step.name}與前一節點相隔天數`);
            offset.min = 0;
            offset.max = MAX_OFFSET;
            offset.step = 0.5;
            const unit = el('select');
            unit.id = `step-unit-${step.id}`;
            unit.dataset.field = 'unit';
            unit.setAttribute('aria-label', '天數單位');
            for (const [value, text] of Object.entries(UNIT_NAMES)) {
                const opt = el('option', '', text);
                opt.value = value;
                unit.append(opt);
            }
            unit.value = step.unit;
            gap.append(offset, unit);
            gapTd.append(gap);
        }

        const slotTd = el('td');
        const slot = el('select');
        slot.id = `step-slot-${step.id}`;
        slot.dataset.field = 'slot';
        slot.setAttribute('aria-label', `${step.name}時段`);
        for (const [value, text] of Object.entries(SLOT_NAMES)) {
            const opt = el('option', '', text);
            opt.value = value;
            slot.append(opt);
        }
        slot.value = step.slot;
        // 相隔含半天時，時段由推算決定
        slotTd.append(slot);

        const rollTd = el('td');
        rollTd.append(makeInput('checkbox', `step-roll-${step.id}`, 'roll', step.roll, `${step.name}遇假日順延`));

        const dateTd = el('td');
        dateTd.append(makeInput('date', `step-date-${step.id}`, 'date', toKey(dates[i]), `${step.name}日期`));

        const noteTd = el('td');
        const note = makeInput('text', `step-note-${step.id}`, 'note', step.note, `${step.name}說明`);
        note.className = 'note-input';
        note.maxLength = 40;
        note.placeholder = '例如：廠商申請空域';
        noteTd.append(note);

        const actTd = el('td');
        const actions = el('div', 'row-actions');
        const ins = el('button', 'ins', '＋');
        ins.type = 'button';
        ins.dataset.field = 'insert';
        ins.disabled = state.steps.length >= MAX_STEPS;
        ins.setAttribute('aria-label', `在「${step.name}」下方插入節點`);
        ins.title = '在下方插入節點';
        const del = el('button', 'del', '✕');
        del.type = 'button';
        del.dataset.field = 'delete';
        del.disabled = state.steps.length <= 2;
        del.setAttribute('aria-label', `刪除「${step.name}」`);
        del.title = '刪除節點';
        actions.append(ins, del);
        actTd.append(actions);

        tr.append(handleTd, nameTd, gapTd, slotTd, rollTd, dateTd, noteTd, actTd);
        body.append(tr);
        updateSlotLock(step);
    });
    document.querySelectorAll('input[name="startRule"]').forEach(r => { r.checked = r.value === state.startRule; });
}

// 相隔含半天時，時段由推算決定，不能手動選
function updateSlotLock(step) {
    const select = $(`step-slot-${step.id}`);
    if (!select) return;
    const auto = indexOf(step.id) > 0 && step.offset % 1 !== 0 && step.id !== state.anchorId;
    select.disabled = auto;
    select.title = auto ? '相隔含半天，時段自動推算' : '';
}

function syncStepDates() {
    state.steps.forEach((step, i) => {
        const input = $(`step-date-${step.id}`);
        if (input && document.activeElement !== input) input.value = toKey(dates[i]);
        const slot = $(`step-slot-${step.id}`);
        if (slot && slot.disabled) slot.value = slots[i];
    });
}

function rowStep(target) {
    const tr = target.closest('tr');
    return tr ? state.steps.find(s => s.id === tr.dataset.id) : null;
}

function onStepInput(e) {
    const field = e.target.dataset.field;
    const step = rowStep(e.target);
    if (!field || !step) return;

    if (field === 'name') {
        step.name = e.target.value.trim().slice(0, 20) || '未命名';
    } else if (field === 'offset') {
        step.offset = clampHalf(e.target.value);
        updateSlotLock(step);
    } else if (field === 'unit') {
        step.unit = e.target.value === 'work' ? 'work' : 'cal';
    } else if (field === 'slot') {
        step.slot = SLOT_NAMES[e.target.value] ? e.target.value : 'day';
    } else if (field === 'roll') {
        step.roll = e.target.checked;
    } else if (field === 'note') {
        step.note = e.target.value.trim().slice(0, 40);
    } else {
        return;
    }
    saveState();
    refresh();
}

function onStepChange(e) {
    const field = e.target.dataset.field;
    const step = rowStep(e.target);
    if (!step) return;
    if (field === 'date') {
        if (e.target.value) setMilestone(step.id, e.target.value);
        return;
    }
    // 打字過程不記錄，每改完一個欄位才存一筆可復原的紀錄
    if (pendingSnapshot && pendingSnapshot !== JSON.stringify(state)) {
        undoStack.push(pendingSnapshot);
        updateUndoButton();
    }
    pendingSnapshot = JSON.stringify(state);
    if (field === 'offset') e.target.value = step.offset;
}

function onStepClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const step = rowStep(btn);
    if (!step) return;
    if (btn.dataset.field === 'delete') deleteStep(step.id);
    else if (btn.dataset.field === 'insert') insertStep(indexOf(step.id) + 1);
}

function insertStep(at) {
    if (state.steps.length >= MAX_STEPS) return;
    snapshot();
    const used = new Set(state.steps.map(s => s.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[state.steps.length % COLORS.length];
    const step = { id: newId(), name: '新節點', offset: 1, unit: 'cal', slot: 'day', roll: false, note: '', color };
    state.steps.splice(at, 0, step);
    saveState();
    refresh();
    buildStepsTable();
    const name = $(`step-name-${step.id}`);
    name.focus();
    name.select();
}

function deleteStep(id) {
    if (state.steps.length <= 2) return;
    const i = indexOf(id);
    snapshot();
    // 刪掉的是基準節點時，改用相鄰節點當基準並保留它目前的日期
    if (id === state.anchorId) {
        const keep = i === 0 ? 1 : i - 1;
        state.anchorId = state.steps[keep].id;
        state.anchorDate = toKey(dates[keep]);
        state.steps[keep].slot = slots[keep];
    }
    state.steps.splice(i, 1);
    if (id === state.activeId) state.activeId = state.steps[Math.min(i, state.steps.length - 1)].id;
    saveState();
    refresh();
    buildStepsTable();
}

// 把節點從 from 移到 to（只限中間節點），保留各節點設定，其他日期依新順序重新推算
function moveStep(from, to) {
    const last = state.steps.length - 1;
    if (from === to || from < 1 || from >= last || to < 1 || to >= last) return false;
    snapshot();
    const [step] = state.steps.splice(from, 1);
    state.steps.splice(to, 0, step);
    saveState();
    refresh();
    buildStepsTable();
    return true;
}

// 用滑鼠、觸控或觸控筆拖曳 ⠿ 調整順序
function startDrag(e) {
    const handle = e.target.closest('.handle');
    if (!handle || handle.disabled) return;
    e.preventDefault();
    const body = $('steps-body');
    const tr = handle.closest('tr');
    const from = [...body.children].indexOf(tr);
    const last = body.children.length - 1;
    tr.classList.add('dragging');

    const move = ev => {
        // 依指標高度找出應插入的位置，直接移動該列當作預覽；只能落在第一列之後、最後一列之前
        const others = [...body.children].filter(r => r !== tr);
        let k = 1;
        while (k < others.length - 1) {
            const rect = others[k].getBoundingClientRect();
            if (ev.clientY < rect.top + rect.height / 2) break;
            k++;
        }
        if (tr.nextSibling !== others[k]) body.insertBefore(tr, others[k]);
    };
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        tr.classList.remove('dragging');
        const to = Math.min(Math.max([...body.children].indexOf(tr), 1), last - 1);
        if (!moveStep(from, to)) buildStepsTable();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function onHandleKey(e) {
    const handle = e.target.closest('.handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const step = rowStep(handle);
    const from = indexOf(step.id);
    if (moveStep(from, from + (e.key === 'ArrowUp' ? -1 : 1))) $(`step-handle-${step.id}`).focus();
}

let resetTimer = 0;
function resetSteps(e) {
    const btn = e.currentTarget;
    // 按兩次才重設，避免誤按
    if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = '再按一次確認重設';
        resetTimer = setTimeout(() => {
            btn.classList.remove('confirm');
            btn.textContent = '恢復預設流程';
        }, 3000);
        return;
    }
    clearTimeout(resetTimer);
    btn.classList.remove('confirm');
    btn.textContent = '恢復預設流程';
    snapshot();
    const keepDate = toKey(dates[0]);
    state.steps = defaultSteps();
    state.anchorId = state.steps[0].id;
    state.anchorDate = keepDate;
    state.activeId = state.steps[0].id;
    saveState();
    refresh();
    buildStepsTable();
}

function openSettings() {
    compute();
    buildStepsTable();
    pendingSnapshot = JSON.stringify(state);
    $('settings').showModal();
}

// ---------- 案名、備註 ----------
function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function syncHeader() {
    $('doc-title').value = state.title;
    $('doc-note').value = state.note;
    autoGrow($('doc-note'));
}

// ---------- 事件綁定 ----------
function bindEvents() {
    const weeks = $('weeks');
    weeks.addEventListener('click', e => {
        const btn = e.target.closest('.day');
        if (btn) setMilestone(state.activeId, btn.dataset.date);
    });
    weeks.addEventListener('mouseover', e => {
        const btn = e.target.closest('.day');
        if (btn) showReadout(btn.dataset.date);
    });
    weeks.addEventListener('focusin', e => {
        const btn = e.target.closest('.day');
        if (btn) showReadout(btn.dataset.date);
    });

    $('chips').addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        setActive(chip.dataset.id);
        const key = toKey(dates[indexOf(chip.dataset.id)]);
        const cell = cellOf(key);
        if (cell) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
        showReadout(key);
        flash(key);
    });

    $('doc-title').addEventListener('input', e => {
        state.title = e.target.value;
        saveState();
    });
    $('doc-note').addEventListener('input', e => {
        state.note = e.target.value;
        autoGrow(e.target);
        saveState();
    });

    $('btn-today').addEventListener('click', () => {
        const key = toKey(new Date());
        const cell = cellOf(key);
        if (cell) {
            cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
            showReadout(key);
            flash(key);
        } else {
            $('readout').textContent = `今天（${fmtDate(new Date())}）不在目前的時程範圍內。`;
        }
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-print').addEventListener('click', () => window.print());

    const body = $('steps-body');
    body.addEventListener('input', onStepInput);
    body.addEventListener('change', onStepChange);
    body.addEventListener('click', onStepClick);
    body.addEventListener('pointerdown', startDrag);
    body.addEventListener('keydown', onHandleKey);
    $('add-step').addEventListener('click', () => insertStep(state.steps.length - 1));
    $('reset-steps').addEventListener('click', resetSteps);
    document.querySelectorAll('input[name="startRule"]').forEach(radio => {
        radio.addEventListener('change', () => {
            snapshot();
            state.startRule = radio.value;
            saveState();
            refresh();
        });
    });

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
            !e.target.closest('input, textarea, select, dialog')) {
            e.preventDefault();
            undo();
        }
    });
    window.addEventListener('resize', updateIslandHeight);
}

// ---------- 初始化 ----------
function init() {
    bindEvents();
    syncHeader();
    refresh();
    updateUndoButton();
    showReadout(state.anchorDate);
}

init();
