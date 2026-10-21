// ===== 採購時程日曆 =====
// 點日期設定某個節點（例如上網公告、開標），其他節點依「與前一節點相隔幾天」自動往前後推算；
// 版面為連續週曆長條，可直接用 A4 直式列印。

const STORE_KEY = 'procure-calendar-v1';
const HOLIDAY_KEY_PREFIX = 'dyn-calendar-holidays-';
const HOLIDAY_CACHE_DAYS = 7;
const HOLIDAY_SOURCES = [
    year => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
    year => `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${year}.json`
];
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const UNIT_NAMES = { cal: '日曆天', work: '工作天' };
const COLORS = ['#2f6fdf', '#0f9488', '#d9822b', '#8b5cf6', '#db2777', '#16a34a', '#e0453a', '#0e7fa8'];
const DEFAULT_STEPS = [
    { name: '上網公告', offset: 0, unit: 'cal', roll: false },
    { name: '結標', offset: 28, unit: 'cal', roll: true },
    { name: '開標', offset: 1, unit: 'work', roll: true },
    { name: 'POC', offset: 7, unit: 'cal', roll: true },
    { name: '評選', offset: 7, unit: 'cal', roll: true },
    { name: '決標', offset: 3, unit: 'work', roll: true },
    { name: '履約期限', offset: 180, unit: 'cal', roll: false }
];
// 格子裡放不下的節日名稱改用簡稱
const SHORT_NAMES = {
    '開國紀念日': '元旦',
    '農曆除夕': '除夕',
    '和平紀念日': '和平紀念日',
    '兒童節及民族掃墓節': '兒童節',
    '孔子誕辰紀念日': '教師節',
    '臺灣光復暨金門古寧頭大捷紀念日': '光復節',
    '行憲紀念日': '行憲紀念日'
};
const MAX_STEPS = 12;
const MAX_OFFSET = 1500;
const LOOP_LIMIT = 6000;

const $ = id => document.getElementById(id);
const holidays = {};      // { 2026: { status: 'ok' | 'loading' | 'failed', days: { 'YYYY-MM-DD': {...} } } }
const undoStack = [];
let state = loadState();
let dates = [];           // 各節點的日期（Date）
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

function clampInt(value, min, max) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
    return DEFAULT_STEPS.map((step, i) => ({ ...step, color: COLORS[i % COLORS.length] }));
}

function defaultState() {
    return {
        title: '',
        note: '',
        startRule: 'next',
        anchorIndex: 0,
        anchorDate: toKey(new Date()),
        active: 0,
        steps: defaultSteps()
    };
}

function loadState() {
    const base = defaultState();
    try {
        const saved = JSON.parse(storageGet(STORE_KEY) || 'null');
        if (!saved || !Array.isArray(saved.steps) || saved.steps.length < 2) return base;
        const steps = saved.steps.slice(0, MAX_STEPS).map((s, i) => ({
            name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 20) : `節點${i + 1}`,
            offset: clampInt(s.offset, 0, MAX_OFFSET),
            unit: s.unit === 'work' ? 'work' : 'cal',
            roll: !!s.roll,
            color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : COLORS[i % COLORS.length]
        }));
        return {
            title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : '',
            note: typeof saved.note === 'string' ? saved.note.slice(0, 2000) : '',
            startRule: saved.startRule === 'same' ? 'same' : 'next',
            anchorIndex: clampInt(saved.anchorIndex, 0, steps.length - 1),
            anchorDate: /^\d{4}-\d{2}-\d{2}$/.test(saved.anchorDate) ? saved.anchorDate : base.anchorDate,
            active: clampInt(saved.active, 0, steps.length - 1),
            steps
        };
    } catch (e) {
        return base;
    }
}

function saveState() {
    storageSet(STORE_KEY, JSON.stringify(state));
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
    showReadout(state.anchorDate);
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

function compute() {
    const steps = state.steps;
    const a = Math.min(state.anchorIndex, steps.length - 1);
    dates = new Array(steps.length);
    rolled = new Array(steps.length).fill(false);
    dates[a] = fromKey(state.anchorDate);

    for (let i = a + 1; i < steps.length; i++) {
        let d = forward(dates[i - 1], steps[i].offset, steps[i].unit);
        if (steps[i].roll && !isWorkday(d)) {
            d = rollTo(d, 1);
            rolled[i] = true;
        }
        dates[i] = d;
    }
    for (let i = a - 1; i >= 0; i--) {
        let d = backward(dates[i + 1], steps[i + 1].offset, steps[i + 1].unit);
        if (steps[i].roll && !isWorkday(d)) {
            d = rollTo(d, -1);
            rolled[i] = true;
        }
        dates[i] = d;
    }

    // 每段期間的天數標示：日曆天標「第 N 天」，工作天只在上班日標「第 N 工作天」
    periodMap = {};
    for (let i = 1; i < steps.length; i++) {
        const end = dates[i];
        let d = state.startRule === 'same' ? dates[i - 1] : addDays(dates[i - 1], 1);
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

function ruleText(i) {
    if (i === 0) return '起點';
    const step = state.steps[i];
    return `${state.steps[i - 1].name}後 ${step.offset} ${UNIT_NAMES[step.unit]}`;
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
    const active = state.steps[state.active];
    $('active-name').textContent = active.name;
    $('active-name').style.setProperty('--active-color', active.color);

    const list = $('chips');
    list.replaceChildren();
    state.steps.forEach((step, i) => {
        const chip = el('button', 'chip' + (i === state.active ? ' active' : ''));
        chip.type = 'button';
        chip.dataset.i = i;
        chip.style.setProperty('--c', step.color);
        chip.setAttribute('aria-pressed', String(i === state.active));
        chip.append(el('span', 'chip-name', step.name));
        chip.append(el('span', 'chip-date', fmtDate(dates[i])));
        const rule = i === 0 ? '起點' : `+${step.offset} ${UNIT_NAMES[step.unit]}`;
        chip.append(el('span', 'chip-rule', rule + (rolled[i] ? '・順延' : '')));
        if (i === state.anchorIndex) chip.append(el('span', 'chip-tag', '基準'));
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
            ms.forEach(i => aria.push(state.steps[i].name));
            if (period && period.label) aria.push(`${state.steps[period.i - 1].name}後${period.label}`);
            btn.setAttribute('aria-label', aria.join('，'));

            const top = el('span', 'day-top');
            const num = el('span', 'num' + (day.getDate() === 1 ? ' month-start' : ''),
                day.getDate() === 1 ? `${day.getMonth() + 1}/1` : String(day.getDate()));
            top.append(num);
            if (period && period.label) top.append(el('span', 'idx', period.label));
            btn.append(top);

            if (info.label) btn.append(el('span', 'hol' + (info.makeup ? ' workday' : ''), shortLabel(info.label)));

            if (ms.length) {
                const pills = el('span', 'pills');
                ms.forEach(i => {
                    const pill = el('span', 'pill' + (rolled[i] ? ' rolled' : ''), state.steps[i].name);
                    pill.style.setProperty('--c', state.steps[i].color);
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
        name.append(swatch, document.createTextNode(step.name + (i === state.anchorIndex ? '（基準）' : '')));
        tr.append(name);
        tr.append(el('td', '', fmtDate(dates[i]) + (rolled[i] ? '（遇假日順延）' : '')));
        tr.append(el('td', '', ruleText(i)));
        tr.append(el('td', '', i === 0 ? '—' : `${fmtDate(periodStart(i))} ～ ${fmtDate(dates[i])}`));
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
    dates.forEach((d, i) => { if (toKey(d) === key) ms.push(state.steps[i].name); });
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
function setMilestone(i, key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const before = cellOf(key);
    const beforeTop = before ? before.getBoundingClientRect().top : null;
    snapshot();
    state.anchorIndex = i;
    state.anchorDate = key;
    saveState();
    refresh();
    // 版面範圍可能改變，讓點到的格子留在原來的位置
    const after = cellOf(key);
    if (after && beforeTop !== null) window.scrollBy(0, after.getBoundingClientRect().top - beforeTop);
    showReadout(key, `已設定「${state.steps[i].name}」：`);
    flash(key);
}

function setActive(i) {
    state.active = i;
    saveState();
    renderIsland();
}

// ---------- 流程設定 ----------
function buildStepsTable() {
    const body = $('steps-body');
    body.replaceChildren();
    state.steps.forEach((step, i) => {
        const tr = el('tr');
        tr.dataset.i = i;

        const nameTd = el('td');
        const nameWrap = el('div', 'name-cell');
        const swatch = el('span', 'swatch');
        swatch.style.setProperty('--c', step.color);
        const name = el('input');
        name.type = 'text';
        name.id = `step-name-${i}`;
        name.maxLength = 20;
        name.value = step.name;
        name.dataset.field = 'name';
        name.setAttribute('aria-label', `第 ${i + 1} 個節點名稱`);
        nameWrap.append(swatch, name);
        nameTd.append(nameWrap);

        const gapTd = el('td');
        if (i === 0) {
            gapTd.append(el('span', 'muted', '起點'));
        } else {
            const gap = el('div', 'gap-cell');
            const offset = el('input');
            offset.type = 'number';
            offset.id = `step-offset-${i}`;
            offset.min = 0;
            offset.max = MAX_OFFSET;
            offset.value = step.offset;
            offset.dataset.field = 'offset';
            offset.setAttribute('aria-label', `${step.name}與前一節點相隔天數`);
            const unit = el('select');
            unit.id = `step-unit-${i}`;
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

        const rollTd = el('td');
        const roll = el('input');
        roll.type = 'checkbox';
        roll.id = `step-roll-${i}`;
        roll.checked = step.roll;
        roll.dataset.field = 'roll';
        roll.setAttribute('aria-label', `${step.name}遇假日順延`);
        rollTd.append(roll);

        const dateTd = el('td');
        const date = el('input');
        date.type = 'date';
        date.id = `step-date-${i}`;
        date.value = toKey(dates[i]);
        date.dataset.field = 'date';
        date.setAttribute('aria-label', `${step.name}日期`);
        dateTd.append(date);

        const delTd = el('td');
        const del = el('button', 'del', '✕');
        del.type = 'button';
        del.dataset.field = 'delete';
        del.disabled = state.steps.length <= 2;
        del.setAttribute('aria-label', `刪除「${step.name}」`);
        delTd.append(del);

        tr.append(nameTd, gapTd, rollTd, dateTd, delTd);
        body.append(tr);
    });
    document.querySelectorAll('input[name="startRule"]').forEach(r => { r.checked = r.value === state.startRule; });
}

function syncStepDates() {
    state.steps.forEach((step, i) => {
        const input = $(`step-date-${i}`);
        if (input && document.activeElement !== input) input.value = toKey(dates[i]);
    });
}

function onStepInput(e) {
    const field = e.target.dataset.field;
    const tr = e.target.closest('tr');
    if (!field || !tr) return;
    const i = Number(tr.dataset.i);
    const step = state.steps[i];

    if (field === 'name') {
        step.name = e.target.value.trim().slice(0, 20) || `節點${i + 1}`;
    } else if (field === 'offset') {
        step.offset = clampInt(e.target.value, 0, MAX_OFFSET);
    } else if (field === 'unit') {
        step.unit = e.target.value === 'work' ? 'work' : 'cal';
    } else if (field === 'roll') {
        step.roll = e.target.checked;
    } else {
        return;
    }
    saveState();
    refresh();
}

function onStepChange(e) {
    const field = e.target.dataset.field;
    if (field === 'date') {
        const i = Number(e.target.closest('tr').dataset.i);
        if (e.target.value) setMilestone(i, e.target.value);
        return;
    }
    if (field === 'offset') e.target.value = state.steps[Number(e.target.closest('tr').dataset.i)].offset;
    // 打字過程不記錄，每次改完一個欄位才存一筆可復原的紀錄
    if (pendingSnapshot && pendingSnapshot !== JSON.stringify(state)) {
        undoStack.push(pendingSnapshot);
        updateUndoButton();
    }
    pendingSnapshot = JSON.stringify(state);
}

function onStepClick(e) {
    if (e.target.dataset.field !== 'delete') return;
    const i = Number(e.target.closest('tr').dataset.i);
    if (state.steps.length <= 2) return;
    snapshot();
    // 刪掉的是基準節點時，改用第一個節點當基準並保留它目前的日期
    if (i === state.anchorIndex) {
        const keep = i === 0 ? 1 : 0;
        state.anchorDate = toKey(dates[keep]);
        state.anchorIndex = keep;
    }
    state.steps.splice(i, 1);
    if (state.anchorIndex > i) state.anchorIndex--;
    state.active = Math.min(state.active > i ? state.active - 1 : state.active, state.steps.length - 1);
    saveState();
    refresh();
    buildStepsTable();
}

function addStep() {
    if (state.steps.length >= MAX_STEPS) return;
    snapshot();
    const used = new Set(state.steps.map(s => s.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[state.steps.length % COLORS.length];
    state.steps.push({ name: `節點${state.steps.length + 1}`, offset: 7, unit: 'cal', roll: false, color });
    saveState();
    refresh();
    buildStepsTable();
    $(`step-name-${state.steps.length - 1}`).focus();
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
    state.anchorIndex = 0;
    state.anchorDate = keepDate;
    state.active = 0;
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
        if (btn) setMilestone(state.active, btn.dataset.date);
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
        const i = Number(chip.dataset.i);
        setActive(i);
        const key = toKey(dates[i]);
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
    $('add-step').addEventListener('click', addStep);
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
