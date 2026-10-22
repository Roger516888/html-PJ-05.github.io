// ===== 採購時程日曆 =====
// 多案件：點日期設定某個節點（例如上網公告、開標），後面的節點依「與前一節點相隔幾天」自動推算；
// 資料存在瀏覽器，在 Claude 版另存雲端自動同步；可匯出成單檔（含資料）、.json 備份與 .ics 行事曆。

const STORE_KEY = 'procure-calendar-v3';
const OLD_STORE_KEY = 'procure-calendar-v2';
const OLD_THEME_KEY = 'procure-calendar-theme';
const HOLIDAY_KEY_PREFIX = 'dyn-calendar-holidays-';
const HOLIDAY_CACHE_DAYS = 7;
const HOLIDAY_SOURCES = [
    year => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
    year => `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${year}.json`
];
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const UNIT_NAMES = { cal: '日曆天', work: '工作天' };
const SLOT_NAMES = { day: '全天', am: '上午', pm: '下午' };
const TIER_NAMES = { huge: '巨額', check: '查核金額以上', announce: '公告金額以上' };
const COLORS = ['#2f6fdf', '#0f9488', '#d9822b', '#c2410c', '#8b5cf6', '#db2777', '#16a34a', '#e0453a', '#0e7fa8', '#64748b'];
const DEFAULT_STEPS = [
    { name: '上網公告', offset: 0, unit: 'cal', slot: 'day', roll: false, note: '' },
    { name: '截止投標', offset: 28, unit: 'cal', slot: 'day', roll: true, note: '' },
    { name: '開標', offset: 1, unit: 'work', slot: 'am', roll: true, note: '' },
    { name: 'POC說明會', offset: 0.5, unit: 'cal', slot: 'pm', roll: true, note: '' },
    { name: 'POC', offset: 14, unit: 'cal', slot: 'day', roll: true, note: '廠商申請空域 14 天' },
    { name: '評選', offset: 7, unit: 'cal', slot: 'day', roll: true, note: '' },
    { name: '決標', offset: 3, unit: 'work', slot: 'day', roll: true, note: '' },
    { name: '備貨期限', offset: 180, unit: 'cal', slot: 'day', roll: false, note: '決標次日起 180 日' }
];
// 格子裡放不下的節日名稱改用簡稱
const SHORT_NAMES = {
    '開國紀念日': '元旦',
    '農曆除夕': '除夕',
    '兒童節及民族掃墓節': '兒童節',
    '孔子誕辰紀念日': '教師節',
    '臺灣光復暨金門古寧頭大捷紀念日': '光復節'
};
const MAX_STEPS = 16;
const MAX_CASES = 60;
const MAX_EXTRA_MONTHS = 36;
const DEFAULT_START_MONTH = '2025-01';   // 民國 114 年 1 月
const MAX_OFFSET = 1500;
const LOOP_LIMIT = 6000;
const APP_VERSION = '3.0';

const $ = id => document.getElementById(id);
const holidays = {};      // { 2026: { status: 'ok' | 'loading' | 'failed', days: { 'YYYY-MM-DD': {...} } } }
const inArtifact = !!(window.claude && typeof window.claude.use === 'function');
let undoStack = [];
let settings = { era: 'roc', theme: 'auto', currentId: '', hidden: [] };
let cases = {};           // id → 案件
let state = null;         // 目前的案件
let dates = [];           // 各節點的日期（Date）
let slots = [];           // 各節點的時段：day / am / pm
let rolled = [];          // 各節點是否因遇假日而順延
let periodMap = {};       // 'YYYY-MM-DD' → { i, label }：落在第 i 段期間及其天數標示
let pendingSnapshot = null;
let untouchedId = null;   // 自動建立、還沒改過的空白案件

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

// 年份依設定顯示民國或西元
function fmtYear(year) {
    return settings.era === 'ad' ? String(year) : String(year - 1911);
}

function fmtDate(date) {
    return `${fmtYear(date.getFullYear())}/${date.getMonth() + 1}/${date.getDate()}（${WEEK_NAMES[date.getDay()]}）`;
}

function fmtWhen(i) {
    return fmtDate(dates[i]) + (slots[i] !== 'day' ? SLOT_NAMES[slots[i]] : '');
}

function stamp() {
    const d = new Date();
    return `${fmtYear(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
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

function str(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function isoOrNow(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
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

function safeName(text) {
    return (text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '未命名';
}

let toastTimer = 0;
function toast(message, ms = 2600) {
    const box = $('toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

// ---------- 案件資料 ----------
function defaultSteps() {
    return DEFAULT_STEPS.map((step, i) => ({ ...step, id: newId(), color: COLORS[i % COLORS.length] }));
}

function cleanStep(s, i) {
    return {
        id: typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? s.id : newId(),
        name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 20) : `節點${i + 1}`,
        offset: clampHalf(s.offset),
        unit: s.unit === 'work' ? 'work' : 'cal',
        slot: s.slot === 'am' || s.slot === 'pm' ? s.slot : 'day',
        roll: !!s.roll,
        note: str(s.note, 40),
        color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : COLORS[i % COLORS.length]
    };
}

function newCase(name) {
    const steps = defaultSteps();
    const now = new Date().toISOString();
    return {
        id: newId(),
        caseNo: '',
        name: name || '',
        note: '',
        tier: '',
        startRule: 'next',
        anchorId: steps[0].id,
        anchorDate: toKey(new Date()),
        activeId: steps[0].id,
        extraBefore: 0,
        extraAfter: 0,
        startMonth: DEFAULT_START_MONTH,
        notes: {},
        steps,
        createdAt: now,
        updatedAt: now
    };
}

// 把任何來源（瀏覽器、雲端、匯入檔）的案件整理成固定格式；不像案件就回傳 null
function normalizeCase(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps) || raw.steps.length < 2) return null;
    const steps = raw.steps.slice(0, MAX_STEPS).map(cleanStep);
    const ids = steps.map(s => s.id);
    const notes = {};
    if (raw.notes && typeof raw.notes === 'object') {
        Object.keys(raw.notes).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && typeof raw.notes[k] === 'string' && raw.notes[k])
            .slice(0, 500).forEach(k => { notes[k] = raw.notes[k].slice(0, 200); });
    }
    return {
        id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newId(),
        caseNo: str(raw.caseNo, 30),
        name: str(raw.name !== undefined ? raw.name : raw.title, 80),
        note: str(raw.note, 2000),
        tier: TIER_NAMES[raw.tier] ? raw.tier : '',
        startRule: raw.startRule === 'same' ? 'same' : 'next',
        anchorId: ids.includes(raw.anchorId) ? raw.anchorId : ids[0],
        anchorDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.anchorDate) ? raw.anchorDate : toKey(new Date()),
        activeId: ids.includes(raw.activeId) ? raw.activeId : ids[0],
        extraBefore: clampInt(raw.extraBefore, 0, MAX_EXTRA_MONTHS),
        extraAfter: clampInt(raw.extraAfter, 0, MAX_EXTRA_MONTHS),
        startMonth: raw.startMonth === undefined ? DEFAULT_START_MONTH
            : /^\d{4}-\d{2}$/.test(raw.startMonth) ? raw.startMonth : '',
        notes,
        steps,
        createdAt: isoOrNow(raw.createdAt),
        updatedAt: isoOrNow(raw.updatedAt)
    };
}

function cloneCase(source, suffix) {
    const copy = normalizeCase(JSON.parse(JSON.stringify(source)));
    copy.id = newId();
    // 節點 id 也換新，避免和原案件混在一起
    const map = {};
    copy.steps.forEach(s => { map[s.id] = newId(); s.id = map[s.id]; });
    copy.anchorId = map[copy.anchorId] || copy.steps[0].id;
    copy.activeId = map[copy.activeId] || copy.steps[0].id;
    if (suffix) copy.name = (copy.name || '未命名') + suffix;
    copy.createdAt = copy.updatedAt = new Date().toISOString();
    return copy;
}

// ---------- 儲存（瀏覽器）----------
function loadLocal() {
    try {
        const saved = JSON.parse(storageGet(STORE_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            if (saved.settings) {
                settings.era = saved.settings.era === 'ad' ? 'ad' : 'roc';
                settings.theme = ['light', 'dark'].includes(saved.settings.theme) ? saved.settings.theme : 'auto';
                settings.currentId = str(saved.settings.currentId, 40);
                settings.hidden = Array.isArray(saved.settings.hidden)
                    ? saved.settings.hidden.filter(x => typeof x === 'string').slice(-200) : [];
            }
            if (saved.cases && typeof saved.cases === 'object') {
                Object.values(saved.cases).forEach(raw => {
                    const c = normalizeCase(raw);
                    if (c) cases[c.id] = c;
                });
            }
            return;
        }
    } catch (e) {
        // 損毀就當作空的
    }
    migrateOld();
}

// 舊版（單一案件）資料轉成第一個案件
function migrateOld() {
    try {
        const old = JSON.parse(storageGet(OLD_STORE_KEY) || 'null');
        if (old && Array.isArray(old.steps)) {
            const c = normalizeCase(old);
            if (c) {
                cases[c.id] = c;
                settings.currentId = c.id;
            }
            if (old.era === 'ad') settings.era = 'ad';
        }
        const theme = storageGet(OLD_THEME_KEY);
        if (theme === 'light' || theme === 'dark') settings.theme = theme;
    } catch (e) {
        // 忽略
    }
}

function persistLocal() {
    storageSet(STORE_KEY, JSON.stringify({ settings, cases }));
}

function saveSettings() {
    persistLocal();
}

// 目前案件有變動：記錄時間、存到瀏覽器，並排程寫到雲端
function saveState() {
    state.updatedAt = new Date().toISOString();
    if (state.id === untouchedId) untouchedId = null;
    persistLocal();
    cloudSchedule(state);
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
    const restored = normalizeCase(JSON.parse(undoStack.pop()));
    restored.id = state.id;
    cases[state.id] = restored;
    state = restored;
    saveState();
    refresh();
    syncHeader();
    if ($('settings').open) buildStepsTable();
    updateUndoButton();
    showReadout(toKey(dates[0]));
}

function updateUndoButton() {
    $('btn-undo').disabled = undoStack.length === 0;
}

// ---------- 雲端同步（Claude 版）----------
const cloud = { db: null, downloads: null, ready: false, unsub: null, timers: {}, chains: {}, deleting: {} };

function setSync(text, kind) {
    const node = $('sync');
    node.textContent = text;
    node.className = 'sync' + (kind ? ' ' + kind : '');
}

async function connectCloud() {
    if (!inArtifact) {
        setSync(window.EMBED ? '單檔版，資料存在這台電腦' : '資料存在這台裝置', 'local');
        return;
    }
    let db = null;
    let downloads = null;
    try {
        [db, downloads] = await Promise.all([window.claude.use('db'), window.claude.use('downloads')]);
    } catch (e) {
        db = null;
    }
    cloud.downloads = downloads || null;
    if (!db) {
        setSync('未登入，資料只存在這個瀏覽器', 'local');
        return;
    }
    cloud.db = db;
    setSync('雲端同步中…', 'busy');
    try {
        const snap = await db.collection('cases').get();
        let changedCurrent = false;
        snap.docs.forEach(doc => {
            const remote = normalizeCase(doc.data());
            if (!remote) return;
            remote.id = doc.id;
            const local = cases[remote.id];
            if (!local || remote.updatedAt > local.updatedAt) {
                cases[remote.id] = remote;
                if (state && remote.id === state.id) changedCurrent = true;
            }
        });
        // 雲端已有案件時，丟掉這裡自動建立、還沒動過的空白案件
        if (untouchedId && cases[untouchedId] && snap.docs.length) {
            const dropped = untouchedId;
            delete cases[dropped];
            untouchedId = null;
            if (state && state.id === dropped) {
                settings.currentId = sortedCases()[0].id;
                changedCurrent = true;
            }
        }
        // 這台裝置有、雲端沒有或比較舊的，推上去
        const remoteIds = new Set(snap.docs.map(d => d.id));
        Object.values(cases).forEach(c => {
            if (c.id === untouchedId) return;
            const doc = snap.docs.find(d => d.id === c.id);
            const remoteUpdated = doc ? (doc.data().updatedAt || '') : '';
            if (!remoteIds.has(c.id) || c.updatedAt > remoteUpdated) cloudSchedule(c);
        });
        cloud.ready = true;
        persistLocal();
        if (changedCurrent) {
            state = cases[settings.currentId] || cases[state.id];
            settings.currentId = state.id;
            persistLocal();
            undoStack = [];
            updateUndoButton();
            refresh();
            syncHeader();
            showReadout(toKey(dates[0]));
        }
        cloud.unsub = db.collection('cases').onSnapshot(onCloudSnapshot, () => setSync('雲端連線中斷，資料仍存在本機', 'bad'));
        setSync('雲端同步', 'ok');
        updateCaseButton();
    } catch (e) {
        setSync('雲端讀取失敗，資料存在本機', 'bad');
    }
}

function onCloudSnapshot(snap) {
    let touched = false;
    snap.docChanges().forEach(change => {
        const id = change.doc.id;
        if (change.type === 'removed') {
            if (cases[id] && !cloud.deleting[id]) {
                delete cases[id];
                touched = true;
                if (state && state.id === id) ensureCurrent();
            }
            return;
        }
        const remote = normalizeCase(change.doc.data());
        if (!remote) return;
        remote.id = id;
        const local = cases[id];
        if (!local || remote.updatedAt > local.updatedAt) {
            cases[id] = remote;
            touched = true;
            if (state && state.id === id) {
                state = remote;
                refresh();
                syncHeader();
                if ($('settings').open) buildStepsTable();
            }
        }
    });
    if (touched) {
        persistLocal();
        updateCaseButton();
        if ($('case-sheet').open) renderCaseList();
    }
}

// 同一份案件一次只寫一筆，並把連續的修改合併成一次寫入
function cloudSchedule(c) {
    if (!cloud.db) return;
    clearTimeout(cloud.timers[c.id]);
    cloud.timers[c.id] = setTimeout(() => cloudWrite(c.id), 800);
}

function cloudWrite(id) {
    const c = cases[id];
    if (!c || !cloud.db) return;
    const body = JSON.parse(JSON.stringify(c));
    cloud.chains[id] = (cloud.chains[id] || Promise.resolve()).then(async () => {
        setSync('雲端同步中…', 'busy');
        try {
            await cloud.db.doc('cases/' + id).set(body);
            setSync('雲端同步', 'ok');
        } catch (e) {
            setSync('雲端儲存失敗，資料仍存在本機', 'bad');
        }
    });
}

function cloudDelete(id) {
    if (!cloud.db) return;
    cloud.deleting[id] = true;
    clearTimeout(cloud.timers[id]);
    cloud.chains[id] = (cloud.chains[id] || Promise.resolve()).then(async () => {
        try {
            await cloud.db.doc('cases/' + id).delete();
        } catch (e) {
            // 刪不掉就留著，下次同步會再看到
        }
        setTimeout(() => { delete cloud.deleting[id]; }, 5000);
    });
}

// ---------- 國定假日 ----------
// 內建的精簡資料：只列與「平日上班、週末放假」不同的日子
function embeddedHolidays(year) {
    const rows = window.TW_HOLIDAYS && window.TW_HOLIDAYS[String(year)];
    if (!rows) return null;
    const days = {};
    rows.forEach(([md, description, isHoliday]) => {
        days[`${year}-${md.slice(0, 2)}-${md.slice(2, 4)}`] = { isHoliday: !!isHoliday, description: description || '' };
    });
    return days;
}

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

    const embedded = embeddedHolidays(year);
    if (embedded) {
        holidays[year] = { status: 'ok', days: embedded };
        return;
    }

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
    if (!yearData) return undefined;
    const info = yearData.days[toKey(date)];
    if (info) return info;
    // 精簡資料沒列的日子：平日上班、週末放假
    if (yearData.status === 'ok') {
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        return { isHoliday: weekend, description: '' };
    }
    return undefined;
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
    updateRangeButtons();
    renderSummary();
    renderMeta();
    if ($('settings').open) syncStepDates();
}

function caseLabel(c) {
    return c.name || c.caseNo || '未命名案件';
}

function updateCaseButton() {
    $('case-btn-no').textContent = state.caseNo || '';
    $('case-btn-name').textContent = state.name || (state.caseNo ? '' : '未命名案件');
    const n = Object.keys(cases).length;
    $('case-btn').title = `共 ${n} 個案件，點一下切換`;
}

function renderIsland() {
    updateCaseButton();
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

// 週曆範圍：從本月或最早節點所在月份（取較早者）開始，到最晚節點所在月份結束；
// 可再往前、往後多顯示幾個月，方便點選範圍外的日期
function stripRange() {
    const today = new Date();
    let min = new Date(today.getFullYear(), today.getMonth(), 1);
    // 指定了起始月份（例如民國 114 年 1 月）就至少從那個月開始
    if (state.startMonth) {
        const [y, m] = state.startMonth.split('-').map(Number);
        const fixed = new Date(y, m - 1, 1);
        if (fixed < min) min = fixed;
    }
    let max = dates[0];
    for (const d of dates) {
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return {
        start: mondayOf(new Date(min.getFullYear(), min.getMonth() - state.extraBefore, 1)),
        end: addDays(mondayOf(new Date(max.getFullYear(), max.getMonth() + 1 + state.extraAfter, 0)), 6)
    };
}

function extendRange(field, delta) {
    state[field] = clampInt(state[field] + delta, 0, MAX_EXTRA_MONTHS);
    saveState();
    refresh();
}

function updateRangeButtons() {
    $('range-reset').hidden = state.extraBefore === 0 && state.extraAfter === 0;
}

// 回傳是否有年份的假日資料剛從內建或快取取得
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
                if (first || day.getMonth() === 0) label.append(el('span', 'year', fmtYear(day.getFullYear()) + (settings.era === 'ad' ? '' : '年')));
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
            // 遇假日順延的節點另外標在這一行，不佔用節點標籤的寬度
            else if (ms.some(i => rolled[i])) btn.append(el('span', 'hol rolled', '遇假日順延'));

            if (ms.length) {
                const pills = el('span', 'pills');
                ms.forEach(i => {
                    const pill = el('span', 'pill');
                    pill.dataset.id = state.steps[i].id;
                    pill.style.setProperty('--c', state.steps[i].color);
                    pill.title = (slots[i] !== 'day' ? SLOT_NAMES[slots[i]] + ' ' : '') + state.steps[i].name + (rolled[i] ? '（遇假日順延）' : '');
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
        name.append(swatch, document.createTextNode(step.name));
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
    const parts = [`天數${rule}`];
    if (state.tier) parts.push(`金額級距：${TIER_NAMES[state.tier]}`);
    parts.push(`製表日期 ${fmtDate(new Date())}`);
    meta.append(document.createTextNode(parts.join('｜')));
    if (failed.length) {
        meta.append(document.createTextNode('｜'));
        meta.append(el('span', 'warn', `無法載入 ${failed.map(y => fmtYear(Number(y))).join('、')} 年國定假日，工作天僅扣除週末`));
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
// 整數天數：依起算方式換算從 prev 到 d 要相隔幾天（工作天只數上班日）
function wholeBetween(prev, d, step) {
    if (step.unit === 'cal') {
        const diff = diffDays(prev, d);
        return state.startRule === 'same' ? (diff === 0 ? 0 : diff + 1) : diff;
    }
    let count = 0;
    let x = state.startRule === 'same' ? prev : addDays(prev, 1);
    for (let guard = 0; x <= d && guard < LOOP_LIMIT; guard++) {
        if (isWorkday(x)) count++;
        x = addDays(x, 1);
    }
    // 點到非上班日：以工作天計會落在下一個上班日
    if (!isWorkday(d) && d > prev) count++;
    return count;
}

// 依點選的日期與時段反推「與前一節點相隔幾天」；比前一節點早則回傳 null
function offsetFor(prev, prevSlot, target, slot, step) {
    if (target < prev) return null;
    if (slot === 'day') return { offset: wholeBetween(prev, target, step), half: false };
    // 以半天為單位比較：上午、全天算前半天，下午算後半天
    const h = 2 * diffDays(prev, target) + (slot === 'pm' ? 1 : 0) - (prevSlot === 'pm' ? 1 : 0);
    if (h < 0) return null;
    if (h % 2 === 0) return { offset: wholeBetween(prev, target, step), half: false };
    // 差半天：前一節點在下午時，加半天會到隔天上午，所以整數天數算到前一天
    const d = prevSlot === 'pm' ? nextDay(target, step.unit, -1) : target;
    return { offset: wholeBetween(prev, d, step) + 0.5, half: true };
}

// 有分上午、下午的節點（時段不是全天，或相隔含半天）
function isHalfType(step) {
    return step.slot !== 'day' || step.offset % 1 !== 0;
}

let readoutLockUntil = 0;

// 設定某個節點的日期（與時段）：只調整它與前一節點的間隔，並帶動後面的節點；前面的節點不動
function setMilestone(id, key, half) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const i = indexOf(id);
    const step = state.steps[i];
    const target = fromKey(key);
    // 全天的節點不分上下午；分上下午的節點沒指定時沿用目前的時段
    const slot = !isHalfType(step) ? 'day' : (half || slots[i] || step.slot);

    let result = null;
    if (i > 0) {
        result = offsetFor(dates[i - 1], slots[i - 1], target, slot, step);
        if (!result) {
            const out = $('readout');
            out.replaceChildren(el('strong', 'warn', `「${step.name}」不能早於前一個節點「${state.steps[i - 1].name}」（${fmtWhen(i - 1)}）。`),
                el('span', '', `要整個時程提前，請改「${state.steps[0].name}」。`));
            readoutLockUntil = Date.now() + 2500;
            if ($('settings').open) syncStepDates();
            return;
        }
    }

    const before = cellOf(key);
    const beforeTop = before ? before.getBoundingClientRect().top : null;
    snapshot();
    step.slot = slot;
    if (i === 0) {
        state.anchorId = step.id;
        state.anchorDate = key;
    } else {
        step.offset = clampHalf(result.offset);
    }
    saveState();
    refresh();
    if ($('settings').open) buildStepsTable();

    // 版面範圍可能改變，讓點到的格子留在原來的位置
    const after = cellOf(key);
    if (after && beforeTop !== null) window.scrollBy(0, after.getBoundingClientRect().top - beforeTop);

    const landed = toKey(dates[i]);
    const out = $('readout');
    out.replaceChildren(el('span', '', `已設定「${step.name}」：`), el('strong', '', fmtWhen(i)));
    if (i > 0) {
        out.append(el('span', '', `｜與「${state.steps[i - 1].name}」相隔 ${offsetText(step)}` +
            (landed !== key ? `（${fmtDate(target)}不是上班日，${rolled[i] ? '遇假日順延' : '以工作天計'}到這天）` : '')));
    }
    // 剛設定完先保留這段說明，不被滑鼠移動的提示蓋掉
    readoutLockUntil = Date.now() + 2500;
    flash(landed);
}

function setActive(id) {
    state.activeId = id;
    saveState();
    renderIsland();
}

// ---------- 格子上半部＝上午、下半部＝下午；標籤可點選或拖曳 ----------
let dragState = null;
let justDragged = false;
let markedCell = null;

function halfAt(btn, y) {
    const rect = btn.getBoundingClientRect();
    return y < rect.top + rect.height / 2 ? 'am' : 'pm';
}

function markHalf(btn, half) {
    if (markedCell && markedCell !== btn) markedCell.classList.remove('hover-am', 'hover-pm');
    markedCell = btn;
    if (!btn) return;
    btn.classList.toggle('hover-am', half === 'am');
    btn.classList.toggle('hover-pm', half === 'pm');
}

function selectFromPill(id) {
    setActive(id);
    const step = state.steps[indexOf(id)];
    const out = $('readout');
    out.replaceChildren(el('span', '', '已選取'), el('strong', '', `「${step.name}」`),
        el('span', '', isHalfType(step) ? '：點日期上半部＝上午、下半部＝下午，也可以直接拖曳標籤。' : '：點日期或直接拖曳標籤即可移動。'));
    readoutLockUntil = Date.now() + 2500;
}

function startPillDrag(e) {
    const pill = e.target.closest('.pill');
    if (!pill || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragState = { id: pill.dataset.id, x: e.clientX, y: e.clientY, ghost: null, pill };
    window.addEventListener('pointermove', movePillDrag);
    window.addEventListener('pointerup', endPillDrag);
    window.addEventListener('pointercancel', endPillDrag);
}

function cellUnder(x, y) {
    const hit = document.elementFromPoint(x, y);
    return hit ? hit.closest('#weeks .day') : null;
}

function movePillDrag(e) {
    if (!dragState) return;
    if (!dragState.ghost) {
        if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 6) return;
        const ghost = dragState.pill.cloneNode(true);
        ghost.classList.add('drag-ghost');
        document.body.append(ghost);
        dragState.ghost = ghost;
        dragState.pill.classList.add('dragging');
    }
    e.preventDefault();
    dragState.ghost.style.left = `${e.clientX}px`;
    dragState.ghost.style.top = `${e.clientY}px`;
    const btn = cellUnder(e.clientX, e.clientY);
    const step = state.steps[indexOf(dragState.id)];
    markHalf(btn, btn && isHalfType(step) ? halfAt(btn, e.clientY) : 'day');
    if (btn) showReadout(btn.dataset.date, `把「${step.name}」移到：`);
}

function endPillDrag(e) {
    window.removeEventListener('pointermove', movePillDrag);
    window.removeEventListener('pointerup', endPillDrag);
    window.removeEventListener('pointercancel', endPillDrag);
    const drag = dragState;
    dragState = null;
    if (!drag || !drag.ghost) return;
    drag.ghost.remove();
    drag.pill.classList.remove('dragging');
    markHalf(null);
    // 拖曳結束後瀏覽器可能補送一次 click，先擋掉
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    const btn = e.type === 'pointerup' ? cellUnder(e.clientX, e.clientY) : null;
    if (!btn) return;
    setActive(drag.id);
    setMilestone(drag.id, btn.dataset.date, halfAt(btn, e.clientY));
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
    document.querySelectorAll('input[name="era"]').forEach(r => { r.checked = r.value === settings.era; });
    $('tier').value = state.tier;
    syncStartMonthInputs();
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
    // 刪掉的是第一個節點時，改由下一個節點當起點並保留它目前的日期
    if (i === 0) {
        state.anchorId = state.steps[1].id;
        state.anchorDate = toKey(dates[1]);
        state.steps[1].slot = slots[1];
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

// ---------- 外觀：跟隨系統／白天／黑夜 ----------
function applyTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll('[data-theme-pick]').forEach(btn => {
        btn.classList.toggle('on', btn.dataset.themePick === settings.theme);
        btn.setAttribute('aria-checked', String(btn.dataset.themePick === settings.theme));
    });
}

// ---------- 週曆起始月份 ----------
function syncStartMonthInputs() {
    const yearInput = $('start-year');
    $('start-year-unit').textContent = settings.era === 'ad' ? '年（西元）' : '年（民國）';
    if (state.startMonth) {
        const [y, m] = state.startMonth.split('-').map(Number);
        yearInput.value = settings.era === 'ad' ? y : y - 1911;
        $('start-month').value = m;
    } else {
        yearInput.value = '';
        $('start-month').value = '';
    }
    $('start-clear').disabled = !state.startMonth;
}

function applyStartMonth() {
    const yearValue = parseInt($('start-year').value, 10);
    const month = parseInt($('start-month').value, 10);
    if (!Number.isFinite(yearValue) || !Number.isFinite(month)) return;
    // 小於 1000 視為民國年
    const year = yearValue < 1000 ? yearValue + 1911 : yearValue;
    if (year < 1950 || year > 2200 || month < 1 || month > 12) return;
    state.startMonth = `${year}-${pad(month)}`;
    saveState();
    refresh();
    syncStartMonthInputs();
}

// ---------- 案號、案名、備註 ----------
function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function syncHeader() {
    $('doc-caseno').value = state.caseNo;
    $('doc-title').value = state.name;
    $('doc-note').value = state.note;
    autoGrow($('doc-note'));
    updateCaseButton();
}

// ---------- 底部面板 ----------
const sheetTimers = new WeakMap();

function openSheet(dialog) {
    // 正在收合時又被打開（例如連續兩個選擇）就取消收合
    clearTimeout(sheetTimers.get(dialog));
    sheetTimers.delete(dialog);
    dialog.classList.remove('closing');
    if (!dialog.open) dialog.showModal();
}

function closeSheet(dialog) {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    const animated = getComputedStyle(dialog).animationName !== 'none';
    const done = () => {
        sheetTimers.delete(dialog);
        if (!dialog.classList.contains('closing')) return;
        dialog.classList.remove('closing');
        if (dialog.open) dialog.close();
    };
    sheetTimers.set(dialog, setTimeout(done, animated ? 200 : 0));
}

// 通用選擇：回傳使用者按的 value；關閉或按取消回傳 null
function askChoice(title, message, options) {
    const dialog = $('choice-sheet');
    $('choice-title').textContent = title;
    $('choice-message').textContent = message || '';
    $('choice-message').hidden = !message;
    const box = $('choice-buttons');
    box.replaceChildren();
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            dialog.removeEventListener('close', onClose);
            closeSheet(dialog);
            resolve(value);
        };
        const onClose = () => finish(null);
        options.forEach(opt => {
            const btn = el('button', 'sheet-item' + (opt.kind ? ' ' + opt.kind : ''));
            btn.type = 'button';
            btn.append(el('span', 'sheet-item-title', opt.label));
            if (opt.sub) btn.append(el('span', 'sheet-item-sub', opt.sub));
            btn.addEventListener('click', () => finish(opt.value));
            box.append(btn);
        });
        dialog.addEventListener('close', onClose);
        openSheet(dialog);
    });
}

// ---------- 案件清單 ----------
function sortedCases() {
    return Object.values(cases).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function nextMilestoneText(c) {
    // 用案件自己的規則算一次，不碰目前案件的狀態
    const keep = { state, dates, slots, rolled, periodMap };
    state = c;
    compute();
    const today = new Date();
    let text = '';
    for (let i = 0; i < c.steps.length; i++) {
        if (dates[i] >= today) {
            text = `${c.steps[i].name} ${fmtDate(dates[i])}`;
            break;
        }
    }
    if (!text) text = `${c.steps[c.steps.length - 1].name} ${fmtDate(dates[c.steps.length - 1])}（已過）`;
    ({ state, dates, slots, rolled, periodMap } = keep);
    return text;
}

function renderCaseList() {
    const list = $('case-list');
    list.replaceChildren();
    sortedCases().forEach(c => {
        const li = el('li', 'case-row' + (c.id === state.id ? ' current' : ''));
        const main = el('button', 'case-main');
        main.type = 'button';
        main.append(el('span', 'case-row-no', c.caseNo || '（無案號）'));
        main.append(el('span', 'case-row-name', c.name || '未命名案件'));
        main.append(el('span', 'case-row-next', nextMilestoneText(c)));
        main.addEventListener('click', () => {
            switchCase(c.id);
            closeSheet($('case-sheet'));
        });
        const more = el('button', 'case-more', '⋯');
        more.type = 'button';
        more.setAttribute('aria-label', `「${caseLabel(c)}」的更多操作`);
        more.addEventListener('click', () => caseActions(c.id));
        li.append(main, more);
        list.append(li);
    });
    $('case-new').disabled = Object.keys(cases).length >= MAX_CASES;
}

async function caseActions(id) {
    const c = cases[id];
    if (!c) return;
    const choice = await askChoice(caseLabel(c), '', [
        { label: '複製成新案件', value: 'copy' },
        { label: '匯出這個案件…', value: 'export' },
        { label: '刪除這個案件', value: 'delete', kind: 'danger' },
        { label: '取消', value: null }
    ]);
    if (choice === 'copy') {
        const copy = cloneCase(c, '（複本）');
        cases[copy.id] = copy;
        persistLocal();
        cloudSchedule(copy);
        switchCase(copy.id);
        closeSheet($('case-sheet'));
        toast('已複製成新案件');
    } else if (choice === 'export') {
        switchCase(id);
        closeSheet($('case-sheet'));
        openSheet($('export-sheet'));
    } else if (choice === 'delete') {
        const sure = await askChoice(`確定刪除「${caseLabel(c)}」？`, '刪除後無法復原。', [
            { label: '確定刪除', value: 'yes', kind: 'danger' },
            { label: '取消', value: null }
        ]);
        if (sure === 'yes') deleteCase(id);
    }
}

function deleteCase(id) {
    delete cases[id];
    // 記住已刪除的案件，單檔附的資料不會讓它復活
    if (!settings.hidden.includes(id)) settings.hidden.push(id);
    if (settings.hidden.length > 200) settings.hidden.shift();
    cloudDelete(id);
    if (state.id === id) ensureCurrent();
    persistLocal();
    renderCaseList();
    toast('已刪除');
}

function addCase() {
    if (Object.keys(cases).length >= MAX_CASES) return;
    const c = newCase('');
    cases[c.id] = c;
    persistLocal();
    cloudSchedule(c);
    switchCase(c.id);
    closeSheet($('case-sheet'));
    $('doc-title').focus();
    toast('已新增案件，請在上方填案號與案名');
}

function switchCase(id) {
    if (!cases[id]) return;
    state = cases[id];
    settings.currentId = id;
    saveSettings();
    undoStack = [];
    updateUndoButton();
    syncHeader();
    refresh();
    showReadout(toKey(dates[0]));
}

// 確保一定有目前案件：沒有就建一個
function ensureCurrent() {
    if (settings.currentId && cases[settings.currentId]) {
        state = cases[settings.currentId];
    } else {
        const first = sortedCases()[0];
        if (first) {
            state = first;
        } else {
            // 還沒動過之前不推上雲端，雲端有案件時會直接改用雲端的
            state = newCase('');
            cases[state.id] = state;
            untouchedId = state.id;
        }
        settings.currentId = state.id;
    }
    persistLocal();
    undoStack = [];
    if ($('btn-undo')) updateUndoButton();
    if (document.body.dataset.ready) {
        syncHeader();
        refresh();
    }
}

// ---------- 匯入 ----------
// 從 .json 備份或單檔 .html 裡找出案件
function parseImport(text) {
    let data = null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        data = JSON.parse(trimmed);
    } else {
        const m = text.match(/\/\*__EMBED_START__\*\/([\s\S]*?)\/\*__EMBED_END__\*\//);
        if (!m) throw new Error('not-found');
        data = JSON.parse(m[1].replace(/<\\\//g, '</'));
    }
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.cases)) list = data.cases;
    else if (data && Array.isArray(data.steps)) list = [data];
    return list.map(normalizeCase).filter(Boolean);
}

// 把匯入的案件放進清單；同一案件已存在時依 mode 決定要不要問
async function mergeImported(list, ask) {
    let added = 0;
    let replaced = 0;
    let skipped = 0;
    for (const c of list) {
        const local = cases[c.id];
        if (!local) {
            cases[c.id] = c;
            settings.hidden = settings.hidden.filter(x => x !== c.id);
            cloudSchedule(c);
            added++;
            continue;
        }
        if (local.updatedAt === c.updatedAt) {
            skipped++;
            continue;
        }
        if (!ask && local.updatedAt > c.updatedAt) {
            skipped++;
            continue;
        }
        const newer = c.updatedAt > local.updatedAt ? '匯入的比較新' : '這裡的比較新';
        const choice = await askChoice(`「${caseLabel(c)}」已經有了`, `${newer}。要怎麼處理？`, [
            { label: '覆蓋這裡的', value: 'overwrite', sub: '用匯入的取代' },
            { label: '另存為新案件', value: 'copy', sub: '兩個都留著' },
            { label: '略過', value: null }
        ]);
        if (choice === 'overwrite') {
            cases[c.id] = c;
            cloudSchedule(c);
            replaced++;
            if (state.id === c.id) state = c;
        } else if (choice === 'copy') {
            const copy = cloneCase(c, '（匯入）');
            cases[copy.id] = copy;
            cloudSchedule(copy);
            added++;
        } else {
            skipped++;
        }
    }
    persistLocal();
    return { added, replaced, skipped };
}

async function importFromFile(file) {
    let list;
    try {
        list = parseImport(await file.text());
    } catch (e) {
        toast('讀不懂這個檔案，請選 .json 備份或這個工具匯出的單檔');
        return;
    }
    if (!list.length) {
        toast('檔案裡沒有案件');
        return;
    }
    const result = await mergeImported(list, true);
    const first = list.find(c => cases[c.id]);
    if (first && (result.added || result.replaced)) switchCase(cases[first.id] ? first.id : state.id);
    else refresh();
    if ($('case-sheet').open) renderCaseList();
    toast(`匯入完成：新增 ${result.added}、覆蓋 ${result.replaced}、略過 ${result.skipped}`);
}

// ---------- 匯出 ----------
function utf8ToB64(text) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function b64ToUtf8(b64) {
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

async function saveFile(filename, data, mime) {
    if (cloud.downloads) {
        try {
            await cloud.downloads.save({ filename, data });
            toast(`已儲存 ${filename}`);
            return true;
        } catch (e) {
            if (e && e.code === 'declined') return false;
            toast('儲存失敗：' + (e && e.message ? e.message : '請再試一次'));
            return false;
        }
    }
    if (inArtifact) {
        toast('這裡無法存檔，請用單檔版或登入後再試');
        return false;
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    // 太早移除連結，瀏覽器會拿不到檔名
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 5000);
    toast(`已下載 ${filename}`);
    return true;
}

function exportPayload(list) {
    return {
        format: 'procure-calendar',
        version: 3,
        app: APP_VERSION,
        exportedAt: new Date().toISOString(),
        cases: list.map(c => JSON.parse(JSON.stringify(c)))
    };
}

function exportJson(all) {
    const list = all ? sortedCases() : [state];
    const name = all ? `採購時程_全部案件_${stamp()}.json` : `採購時程_${safeName(state.caseNo || state.name)}_${stamp()}.json`;
    saveFile(name, JSON.stringify(exportPayload(list), null, 2), 'application/json');
}

// 單檔：把目前的程式（內建在頁面裡的範本）加上資料，產生一個可以離線開的 .html
function buildStandalone(list) {
    const node = document.getElementById('self-template');
    const b64 = node ? node.textContent.trim() : '';
    if (!b64) return null;
    const template = b64ToUtf8(b64);
    const data = JSON.stringify(exportPayload(list)).replace(/<\//g, '<\\/');
    const dataMark = '__DATA' + '__';
    const selfMark = '__SELF' + '__';
    return template.replace(dataMark, () => data).replace(selfMark, () => b64);
}

function exportHtml(all) {
    const list = all ? sortedCases() : [state];
    const html = buildStandalone(list);
    if (!html) {
        toast('這個版本沒有內建單檔範本，請用發行版');
        return;
    }
    const name = all ? `採購時程日曆_全部案件_${stamp()}.html` : `採購時程日曆_${safeName(state.caseNo || state.name)}_${stamp()}.html`;
    saveFile(name, html, 'text/html');
}

// ---------- 行事曆 .ics ----------
function icsEscape(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// 每行最多 75 個位元組，超過要折行（下一行以空白開頭）
function icsFold(line) {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;
    const out = [];
    let current = '';
    let size = 0;
    for (const ch of line) {
        const len = new TextEncoder().encode(ch).length;
        if (size + len > (out.length ? 74 : 75)) {
            out.push(current);
            current = '';
            size = 0;
        }
        current += ch;
        size += len;
    }
    if (current) out.push(current);
    return out.join('\r\n ');
}

function buildIcs(c) {
    const keep = { state, dates, slots, rolled, periodMap };
    state = c;
    compute();
    const now = new Date();
    const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//採購時程日曆//TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape((c.caseNo ? c.caseNo + ' ' : '') + (c.name || '採購時程'))}`];
    c.steps.forEach((step, i) => {
        const d = dates[i];
        const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
        const next = addDays(d, 1);
        const ymdNext = `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
        const slot = slots[i] !== 'day' ? SLOT_NAMES[slots[i]] : '';
        const desc = [c.name, i === 0 ? '起點' : `${c.steps[i - 1].name}後 ${offsetText(step)}`, step.note, rolled[i] ? '遇假日順延' : '']
            .filter(Boolean).join('｜');
        lines.push('BEGIN:VEVENT',
            `UID:${c.id}-${step.id}@procure-calendar`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART;VALUE=DATE:${ymd}`,
            `DTEND;VALUE=DATE:${ymdNext}`,
            `SUMMARY:${icsEscape((c.caseNo ? `【${c.caseNo}】` : '') + (slot ? slot + ' ' : '') + step.name)}`,
            `DESCRIPTION:${icsEscape(desc)}`,
            'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    ({ state, dates, slots, rolled, periodMap } = keep);
    return lines.map(icsFold).join('\r\n') + '\r\n';
}

// 最簡單的 zip（不壓縮），給無法直接存 .ics 的環境用
function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
}

function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const u16 = n => [n & 255, (n >> 8) & 255];
    const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    files.forEach(({ name, data }) => {
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(data);
        const local = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
            ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes]);
        parts.push(local, data);
        central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
            ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(0), ...u32(offset), ...nameBytes]));
        offset += local.length + data.length;
    });
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function exportIcs() {
    const ics = buildIcs(state);
    const base = `採購時程_${safeName(state.caseNo || state.name)}_${stamp()}`;
    if (cloud.downloads) {
        // Claude 版存檔只接受特定副檔名，.ics 先包成 .zip
        const zip = zipStore([{ name: `${base}.ics`, data: new TextEncoder().encode(ics) }]);
        saveFile(`${base}.zip`, zip, 'application/zip');
    } else {
        saveFile(`${base}.ics`, ics, 'text/calendar');
    }
}

// ---------- 事件綁定 ----------
function bindEvents() {
    const weeks = $('weeks');
    weeks.addEventListener('click', e => {
        if (justDragged) return;
        const pill = e.target.closest('.pill');
        if (pill) {
            selectFromPill(pill.dataset.id);
            return;
        }
        const btn = e.target.closest('.day');
        // 用鍵盤按的沒有滑鼠位置，沿用目前的時段
        if (btn) setMilestone(state.activeId, btn.dataset.date, e.detail ? halfAt(btn, e.clientY) : undefined);
    });
    weeks.addEventListener('mouseover', e => {
        const btn = e.target.closest('.day');
        if (btn && Date.now() > readoutLockUntil) showReadout(btn.dataset.date);
    });
    weeks.addEventListener('mousemove', e => {
        if (dragState) return;
        const btn = e.target.closest('.day');
        const step = state.steps[indexOf(state.activeId)];
        markHalf(btn && !e.target.closest('.pill') && isHalfType(step) ? btn : null, btn ? halfAt(btn, e.clientY) : '');
    });
    weeks.addEventListener('mouseleave', () => markHalf(null));
    weeks.addEventListener('pointerdown', startPillDrag);
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

    $('doc-caseno').addEventListener('input', e => {
        state.caseNo = e.target.value.slice(0, 30);
        saveState();
        updateCaseButton();
    });
    $('doc-title').addEventListener('input', e => {
        state.name = e.target.value.slice(0, 80);
        saveState();
        updateCaseButton();
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
    $('more-before').addEventListener('click', () => extendRange('extraBefore', 1));
    $('more-after').addEventListener('click', () => extendRange('extraAfter', 1));
    $('range-reset').addEventListener('click', () => {
        state.extraBefore = 0;
        state.extraAfter = 0;
        saveState();
        refresh();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-settings').addEventListener('click', openSettings);

    // 案件
    const openCases = () => {
        renderCaseList();
        openSheet($('case-sheet'));
    };
    $('btn-cases').addEventListener('click', openCases);
    $('case-btn').addEventListener('click', openCases);
    $('case-new').addEventListener('click', addCase);
    $('case-import').addEventListener('click', () => $('import-file').click());

    // 更多
    $('btn-more').addEventListener('click', () => {
        $('more-print-sub').textContent = inArtifact ? '這裡無法開啟列印視窗，請先「匯出單檔」再從檔案列印' : '直接開啟列印視窗，A4 直式';
        $('about').textContent = `採購時程日曆 ${APP_VERSION}｜${inArtifact ? 'Claude 版' : (window.EMBED ? '單檔版' : '網頁版')}｜假日資料：政府行政機關辦公日曆表 ${Object.keys(window.TW_HOLIDAYS || {}).map(y => fmtYear(Number(y))).join('、')} 年`;
        openSheet($('more-sheet'));
    });
    document.querySelectorAll('[data-theme-pick]').forEach(btn => {
        btn.addEventListener('click', () => {
            settings.theme = btn.dataset.themePick;
            saveSettings();
            applyTheme();
        });
    });
    $('more-export').addEventListener('click', () => {
        closeSheet($('more-sheet'));
        $('exp-ics-sub').textContent = cloud.downloads
            ? '節點變成行事曆事件；這裡會存成 .zip，解壓後匯入 Google 日曆'
            : '節點變成行事曆事件，匯入 Google 日曆（設定 → 匯入）';
        $('export-note').textContent = inArtifact && !cloud.downloads ? '這裡沒有存檔權限，請登入後再試，或在單檔版匯出。' : '';
        openSheet($('export-sheet'));
    });
    $('more-import').addEventListener('click', () => {
        closeSheet($('more-sheet'));
        $('import-file').click();
    });
    $('more-print').addEventListener('click', () => {
        closeSheet($('more-sheet'));
        if (inArtifact) {
            toast('這裡無法列印，請先匯出單檔再從檔案列印');
            return;
        }
        setTimeout(() => window.print(), 250);
    });

    // 匯出
    $('exp-html-one').addEventListener('click', () => exportHtml(false));
    $('exp-html-all').addEventListener('click', () => exportHtml(true));
    $('exp-json-one').addEventListener('click', () => exportJson(false));
    $('exp-json-all').addEventListener('click', () => exportJson(true));
    $('exp-ics').addEventListener('click', exportIcs);

    $('import-file').addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        closeSheet($('case-sheet'));
        closeSheet($('more-sheet'));
        await importFromFile(file);
    });

    document.querySelectorAll('.sheet-dialog').forEach(dialog => {
        dialog.addEventListener('cancel', e => {
            e.preventDefault();
            closeSheet(dialog);
        });
        dialog.addEventListener('click', e => {
            // 點到面板外的背景
            if (e.target === dialog) closeSheet(dialog);
        });
        dialog.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeSheet(dialog)));
    });

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
    $('tier').addEventListener('change', e => {
        state.tier = TIER_NAMES[e.target.value] ? e.target.value : '';
        saveState();
        renderMeta();
    });

    document.querySelectorAll('input[name="era"]').forEach(radio => {
        radio.addEventListener('change', () => {
            settings.era = radio.value === 'ad' ? 'ad' : 'roc';
            saveSettings();
            refresh();
            syncStartMonthInputs();
        });
    });
    $('start-year').addEventListener('change', applyStartMonth);
    $('start-month').addEventListener('change', applyStartMonth);
    $('start-clear').addEventListener('click', () => {
        state.startMonth = '';
        saveState();
        refresh();
        syncStartMonthInputs();
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
// 舊版可用任何節點當基準；現在一律以第一個節點為起點，換算後保留各節點目前的日期
function normalizeAnchor() {
    if (state.anchorId === state.steps[0].id) return;
    state.anchorDate = toKey(dates[0]);
    state.anchorId = state.steps[0].id;
    state.steps[0].slot = slots[0];
    saveState();
    refresh();
}

async function init() {
    loadLocal();
    applyTheme();
    bindEvents();

    // 單檔版：檔案裡附的案件先放進清單（這裡的資料比較新就不動）
    const embed = window.EMBED && Array.isArray(window.EMBED.cases) ? window.EMBED.cases.map(normalizeCase).filter(Boolean) : [];
    const hadNothing = Object.keys(cases).length === 0;
    if (embed.length) {
        embed.forEach(c => {
            const local = cases[c.id];
            if (!local && !settings.hidden.includes(c.id)) cases[c.id] = c;
        });
        if (hadNothing) settings.currentId = embed[0].id;
    }

    ensureCurrent();
    document.body.dataset.ready = '1';
    syncHeader();
    refresh();
    normalizeAnchor();
    updateUndoButton();
    showReadout(state.anchorDate);

    // 單檔版裡的案件比這台電腦存的還新：問一下要不要換成新的
    const newer = embed.filter(c => cases[c.id] && cases[c.id] !== c && c.updatedAt > cases[c.id].updatedAt);
    if (newer.length) {
        const result = await mergeImported(newer, true);
        if (result.replaced) {
            state = cases[state.id];
            syncHeader();
            refresh();
        }
    }
    connectCloud();
}

init();
