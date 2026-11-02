/* ============================================================
   賽道倒數計時
   - 計時器模式：以「結束時刻」為準（不是每秒減 1），分頁在背景也不會失準
   - 目標日期模式：倒數到指定的日期時間
   - 最後 5 秒點亮起跑燈，歸零熄滅
   ============================================================ */
(() => {
    'use strict';

    /* ---------- 常數與小工具 ---------- */
    const SEC = 1000;
    const MIN = 60 * SEC;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const MAX_MS = ((99 * 60 + 59) * 60 + 59) * SEC;      // 99:59:59
    const STORE_KEY = 'pit-countdown:v1';
    const BASE_TITLE = document.title;

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /* 快速預設（排位表）。代號為三個英文字母，仿賽車計時塔的車手縮寫 */
    const PRESETS = [
        { code: 'POM', name: '專注工作', ms: 25 * MIN, color: '#e10600' },
        { code: 'SBR', name: '短休息',   ms: 5 * MIN,  color: '#00d2be' },
        { code: 'LBR', name: '長休息',   ms: 15 * MIN, color: '#ff8700' },
        { code: 'PRS', name: '簡報演講', ms: 10 * MIN, color: '#3671c6' },
        { code: 'PIT', name: '泡麵進站', ms: 3 * MIN,  color: '#f596c8' },
        { code: 'HRS', name: '一小時',   ms: HOUR,     color: '#229971' },
        { code: 'LGT', name: '起跑燈測試', ms: 10 * SEC, color: '#b44aff' },
    ];

    /* 各階段的旗號文字 [標籤, 說明] */
    const FLAGS = {
        idle:   ['待命',   '按下開始，準備起跑'],
        run:    ['綠旗',   '計時中，全力衝刺'],
        warn:   ['黃旗',   '即將結束，注意時間'],
        crit:   ['黃旗',   '最後衝刺！'],
        paused: ['紅旗',   '賽事中斷，已暫停'],
        done:   ['方格旗', '時間到！熄燈，出發'],
    };

    /* ---------- 本機儲存（失敗時靜默略過） ---------- */
    const store = {
        load() {
            try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
            catch { return {}; }
        },
        save() {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({
                    mode: state.mode,
                    sound: state.sound,
                    duration: state.timer.total,
                    eventName: state.event.name,
                    eventTarget: state.event.target,
                }));
            } catch { /* 隱私模式或儲存空間被封鎖，忽略 */ }
        },
    };

    /* ---------- 狀態 ---------- */
    const defaultEventTarget = () => new Date(new Date().getFullYear() + 1, 0, 1, 0, 0, 0, 0).getTime();

    const saved = store.load();
    const savedDuration = Number(saved.duration);
    const initialTotal = Number.isFinite(savedDuration) && savedDuration >= SEC && savedDuration <= MAX_MS
        ? Math.round(savedDuration / SEC) * SEC
        : 25 * MIN;

    const state = {
        mode: saved.mode === 'event' ? 'event' : 'timer',
        sound: saved.sound !== false,
        timer: { total: initialTotal, remaining: initialTotal, status: 'idle', endAt: 0 },
        event: {
            name: typeof saved.eventName === 'string' ? saved.eventName.slice(0, 40) : '新年',
            target: Number.isFinite(saved.eventTarget) ? saved.eventTarget : defaultEventTarget(),
        },
        lastSec: null,        // 上一次處理過的「剩餘秒數（進位）」，用來判斷是否換秒
        prevStatus: null,     // 上一次渲染的狀態，用來偵測「進行中 → 完成」
        lit: -1,              // 目前亮起的起跑燈數量（-1 代表尚未繪製）
    };

    /* ---------- DOM ---------- */
    const el = {
        app: $('#app'),
        stage: $('#stage'),
        gantry: $('#gantry'),
        pods: $$('.pod'),
        flagChip: $('#flagChip'),
        flagText: $('#flagText'),
        flagMeta: $('#flagMeta'),
        clock: $('#clock'),
        clockMain: $('#clockMain'),
        clockMs: $('#clockMs'),
        board: $('#board'),
        units: Object.fromEntries($$('.num', $('#board')).map(n => [n.dataset.unit, n])),
        sectors: $$('.sector'),
        btnStart: $('#btnStart'),
        btnReset: $('#btnReset'),
        btnSound: $('#btnSound'),
        btnFull: $('#btnFull'),
        modeBtns: $$('.mode'),
        tower: $('#tower'),
        lockHint: $('#lockHint'),
        customForm: $('#customForm'),
        inH: $('#inH'),
        inM: $('#inM'),
        inS: $('#inS'),
        btnSet: $('#btnSet'),
        customMsg: $('#customMsg'),
        eventForm: $('#eventForm'),
        evName: $('#evName'),
        evTime: $('#evTime'),
        eventMsg: $('#eventMsg'),
    };

    /* ---------- 時間格式 ---------- */
    function splitTime(ms) {
        const totalSec = Math.floor(ms / SEC);
        return {
            h: Math.floor(totalSec / 3600),
            m: Math.floor((totalSec % 3600) / 60),
            s: totalSec % 60,
            ms: Math.floor(ms % SEC),
        };
    }

    function fmtClock(ms, withHours) {
        const t = splitTime(ms);
        return withHours ? `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}` : `${pad(t.m)}:${pad(t.s)}`;
    }

    function fmtShort(ms) {
        const t = splitTime(ms);
        return t.h > 0 ? `${t.h}:${pad(t.m)}:${pad(t.s)}` : `${pad(t.m)}:${pad(t.s)}`;
    }

    function fmtDateTime(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function toLocalInput(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /* ---------- 渲染輔助：只在內容改變時才寫入 DOM ---------- */
    let cache = {};

    function setText(node, key, value) {
        if (cache[key] !== value) { node.textContent = value; cache[key] = value; }
    }

    function setAttr(node, key, name, value) {
        if (cache[key] !== value) { node.setAttribute(name, value); cache[key] = value; }
    }

    /* 把字串拆成固定寬度的字元格，數字變動時版面不會晃動 */
    function setCells(box, text) {
        if (box._text === text) return;
        if (!box._cells || box._cells.length !== text.length) {
            box.textContent = '';
            box._cells = Array.from(text, ch => {
                const cell = document.createElement('span');
                cell.className = /\d/.test(ch) ? 'c d' : 'c p';
                box.append(cell);
                return cell;
            });
        }
        for (let i = 0; i < text.length; i++) {
            if (box._cells[i].textContent !== text[i]) box._cells[i].textContent = text[i];
        }
        box._text = text;
    }

    /* ---------- 音效 ---------- */
    let audio = null;

    function ensureAudio() {
        if (!state.sound) return null;
        try {
            if (!audio) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                audio = new AC();
            }
            if (audio.state === 'suspended') audio.resume().catch(() => {});
            return audio;
        } catch {
            return null;
        }
    }

    function tone(freq, dur, vol = 0.18, type = 'square') {
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    /* ---------- 螢幕常亮（計時中避免手機自動休眠） ---------- */
    let wakeLock = null;

    async function syncWakeLock() {
        if (!('wakeLock' in navigator)) return;
        const want = state.mode === 'timer' && state.timer.status === 'running' && document.visibilityState === 'visible';
        try {
            if (want && !wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
            } else if (!want && wakeLock) {
                await wakeLock.release();
                wakeLock = null;
            }
        } catch { /* 瀏覽器拒絕時忽略 */ }
    }

    /* ---------- 計時邏輯 ---------- */
    function timerRemaining() {
        const t = state.timer;
        return t.status === 'running' ? Math.max(0, t.endAt - Date.now()) : t.remaining;
    }

    /* 目前顯示模式的快照：剩餘毫秒、總長、狀態 */
    function snapshot() {
        if (state.mode === 'timer') {
            return { remaining: timerRemaining(), total: state.timer.total, status: state.timer.status };
        }
        const remaining = Math.max(0, state.event.target - Date.now());
        return { remaining, total: null, status: remaining > 0 ? 'running' : 'done' };
    }

    function phaseOf(s) {
        if (s.status !== 'running') return s.status;               // idle | paused | done
        const total = s.total || Infinity;
        const warnAt = Math.min(MIN, total * 0.25);                  // 最後一分鐘（短計時則取 25%）
        const critAt = Math.min(10 * SEC, total * 0.1);              // 最後十秒（短計時則取 10%）
        if (s.remaining <= critAt) return 'crit';
        if (s.remaining <= warnAt) return 'warn';
        return 'run';
    }

    function start() {
        if (state.mode !== 'timer') return;
        const t = state.timer;
        if (t.status === 'running') return;
        ensureAudio();                                               // 在使用者點擊時解鎖音效
        if (t.status === 'done') reset();
        if (t.remaining <= 0) return;
        t.endAt = Date.now() + t.remaining;
        t.status = 'running';
        afterChange();
        kickFrames();
    }

    function pause() {
        const t = state.timer;
        if (t.status !== 'running') return;
        t.remaining = timerRemaining();
        t.status = 'paused';
        afterChange();
    }

    function reset() {
        if (state.mode !== 'timer') return;
        const t = state.timer;
        t.remaining = t.total;
        t.status = 'idle';
        state.lastSec = null;
        afterChange();
    }

    function toggleRun() {
        if (state.mode !== 'timer') return;
        if (state.timer.status === 'running') pause(); else start();
    }

    function setDuration(ms) {
        const t = state.timer;
        if (t.status === 'running' || t.status === 'paused') return false;
        t.total = t.remaining = clamp(Math.round(ms / SEC) * SEC, SEC, MAX_MS);
        t.status = 'idle';
        state.lastSec = null;
        syncCustomFields();
        markPreset();
        afterChange();
        return true;
    }

    function setMode(mode) {
        if (mode === state.mode) return;
        if (state.timer.status === 'running') return;                // 計時中不允許切換
        state.mode = mode;
        state.lastSec = null;
        state.prevStatus = null;                                     // 換模式不算「進行中 → 完成」，避免誤響
        state.lit = -1;
        cache = {};
        afterChange();
    }

    /* 任何狀態改變後：存檔、更新控制項、重畫 */
    function afterChange() {
        el.app.dataset.mode = state.mode;
        renderControls();
        render();
        store.save();
        syncWakeLock();
    }

    /* ---------- 時間到 ---------- */
    function onFinish() {
        tone(1568, 1.1, 0.22, 'square');
        if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
        el.stage.classList.remove('flash');
        void el.stage.offsetWidth;                                   // 重新觸發動畫
        el.stage.classList.add('flash');
    }

    /* ---------- 主渲染 ---------- */
    function render() {
        const s = snapshot();
        const phase = phaseOf(s);
        const secLeft = Math.ceil(s.remaining / SEC);
        const isTimer = state.mode === 'timer';

        /* 換秒：最後 5 秒每秒嗶一聲 */
        if (s.status === 'running' && secLeft !== state.lastSec) {
            if (secLeft >= 1 && secLeft <= 5) tone(784, 0.12);
            state.lastSec = secLeft;
        }
        /* 進行中 → 完成 */
        if (state.prevStatus === 'running' && s.status === 'done') onFinish();
        state.prevStatus = s.status;

        /* 階段與旗號 */
        if (el.stage.dataset.phase !== phase) el.stage.dataset.phase = phase;
        const [chip, msg] = flagCopy(phase);
        setText(el.flagChip, 'chip', chip);
        setText(el.flagText, 'msg', msg);
        setText(el.flagMeta, 'meta', isTimer ? `總時間 ${fmtShort(state.timer.total)}` : fmtDateTime(state.event.target));

        /* 起跑燈：最後 5 秒由 1 盞亮到 5 盞，歸零全滅 */
        const lit = (s.status === 'running' || s.status === 'paused') && secLeft >= 1 && secLeft <= 5 ? 6 - secLeft : 0;
        if (state.lit !== lit) {
            el.pods.forEach((pod, i) => pod.classList.toggle('on', i < lit));
            el.gantry.setAttribute('aria-label', lit ? `起跑燈：亮起 ${lit} 盞` : '起跑燈：全部熄滅');
            state.lit = lit;
        }

        let titleTime = '';

        if (isTimer) {
            const hasHours = s.total >= HOUR;
            if (cache.hours !== hasHours) { el.clock.classList.toggle('hours', hasHours); cache.hours = hasHours; }
            const t = splitTime(s.remaining);
            const main = fmtClock(s.remaining, hasHours);
            setCells(el.clockMain, main);
            setCells(el.clockMs, `.${pad(t.ms, 3)}`);
            setAttr(el.clock, 'clockLabel', 'aria-label', `剩餘 ${t.h * 60 + t.m} 分 ${t.s} 秒`);
            titleTime = main;

            /* 分段進度：已走完的分段轉紫色 */
            const progress = s.total ? 1 - s.remaining / s.total : 0;
            el.sectors.forEach((sec, i) => {
                const frac = clamp(progress * 3 - i, 0, 1);
                const key = `sec${i}`;
                const rounded = Math.round(frac * 1000) / 1000;
                if (cache[key] !== rounded) {
                    sec.style.setProperty('--p', rounded);
                    sec.classList.toggle('full', rounded >= 1);
                    cache[key] = rounded;
                }
            });
        } else {
            /* 目標日期不顯示毫秒，秒數進位，才會和起跑燈同步 */
            const r = secLeft * SEC;
            const d = Math.floor(r / DAY);
            const h = Math.floor((r % DAY) / HOUR);
            const m = Math.floor((r % HOUR) / MIN);
            const sec = Math.floor((r % MIN) / SEC);
            setCells(el.units.d, pad(d));
            setCells(el.units.h, pad(h));
            setCells(el.units.m, pad(m));
            setCells(el.units.s, pad(sec));
            setAttr(el.board, 'boardLabel', 'aria-label', `距離目標還有 ${d} 天 ${h} 小時 ${m} 分 ${sec} 秒`);
            titleTime = `${d > 0 ? d + '天 ' : ''}${pad(h)}:${pad(m)}:${pad(sec)}`;
        }

        /* 分頁標題：切到別的分頁也看得到剩餘時間 */
        let title = BASE_TITLE;
        if (s.status === 'running' || s.status === 'paused') title = `${titleTime} · ${BASE_TITLE}`;
        else if (s.status === 'done') title = `時間到！· ${BASE_TITLE}`;
        if (document.title !== title) document.title = title;
    }

    function flagCopy(phase) {
        if (state.mode === 'timer') return FLAGS[phase];
        const name = state.event.name.trim() || '目標時刻';
        switch (phase) {
            case 'crit': return ['黃旗', `「${name}」即將到來！`];
            case 'warn': return ['黃旗', `距離「${name}」不到一分鐘`];
            case 'done': return ['方格旗', `「${name}」到了！`];
            default:     return ['綠旗', `距離「${name}」還有`];
        }
    }

    /* 控制項狀態：只在模式或計時狀態改變時更新 */
    function renderControls() {
        const t = state.timer;
        const running = t.status === 'running';
        const locked = running || t.status === 'paused';

        el.btnStart.textContent = { idle: '開始', running: '暫停', paused: '繼續', done: '再來一次' }[t.status];
        el.btnReset.disabled = t.status === 'idle';

        $$('.row', el.tower).forEach(b => { b.disabled = locked; });
        [el.inH, el.inM, el.inS, el.btnSet].forEach(n => { n.disabled = locked; });
        el.lockHint.hidden = !locked;

        el.modeBtns.forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
            b.disabled = running && b.dataset.mode !== state.mode;
            b.title = b.disabled ? '計時進行中，無法切換模式' : '';
        });

        el.btnSound.setAttribute('aria-pressed', String(state.sound));
    }

    /* ---------- 動畫迴圈 ---------- */
    let raf = 0;

    function tick() {
        if (state.mode === 'timer') {
            const t = state.timer;
            if (t.status === 'running' && Date.now() >= t.endAt) {
                t.remaining = 0;
                t.status = 'done';
                renderControls();
                store.save();
                syncWakeLock();
            }
        }
        render();
    }

    function frame() {
        raf = 0;
        tick();
        /* 只在計時中且分頁可見時用 rAF，這樣毫秒才會順暢；其餘交給下面的 100ms 計時器 */
        if (state.mode === 'timer' && state.timer.status === 'running' && !document.hidden) {
            raf = requestAnimationFrame(frame);
        }
    }

    function kickFrames() {
        if (!raf) raf = requestAnimationFrame(frame);
    }

    /* 背景保底：分頁在背景時 rAF 會暫停，這個計時器仍會偵測時間到、更新標題 */
    setInterval(tick, 100);

    document.addEventListener('visibilitychange', () => {
        tick();
        kickFrames();
        syncWakeLock();
    });

    /* ---------- 排位表（預設） ---------- */
    function buildTower() {
        PRESETS.forEach((p, i) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'row';
            btn.dataset.ms = String(p.ms);
            btn.style.setProperty('--team', p.color);
            btn.setAttribute('aria-pressed', 'false');

            const pos = document.createElement('span');
            pos.className = 'pos';
            pos.textContent = String(i + 1);

            const bar = document.createElement('span');
            bar.className = 'bar';

            const who = document.createElement('span');
            who.className = 'who';
            const code = document.createElement('b');
            code.textContent = p.code;
            const name = document.createElement('small');
            name.textContent = p.name;
            who.append(code, name);

            const time = document.createElement('span');
            time.className = 'time';
            time.textContent = fmtShort(p.ms);

            btn.append(pos, bar, who, time);
            btn.setAttribute('aria-label', `${p.name}，${fmtShort(p.ms)}`);
            li.append(btn);
            el.tower.append(li);
        });
    }

    function markPreset() {
        $$('.row', el.tower).forEach(b => {
            b.setAttribute('aria-pressed', String(Number(b.dataset.ms) === state.timer.total));
        });
    }

    function syncCustomFields() {
        const t = splitTime(state.timer.total);
        el.inH.value = t.h;
        el.inM.value = t.m;
        el.inS.value = t.s;
        el.customMsg.textContent = '';
    }

    /* ---------- 事件綁定 ---------- */
    el.btnStart.addEventListener('click', toggleRun);
    el.btnReset.addEventListener('click', reset);

    el.tower.addEventListener('click', e => {
        const row = e.target.closest('.row');
        if (row) setDuration(Number(row.dataset.ms));
    });

    el.customForm.addEventListener('submit', e => {
        e.preventDefault();
        const num = (input, max) => clamp(parseInt(input.value, 10) || 0, 0, max);
        const ms = (num(el.inH, 99) * 3600 + num(el.inM, 59) * 60 + num(el.inS, 59)) * SEC;
        if (ms < SEC) { el.customMsg.textContent = '請至少設定 1 秒。'; return; }
        setDuration(ms);
    });

    el.modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    el.evName.addEventListener('input', () => {
        state.event.name = el.evName.value.slice(0, 40);
        cache = {};
        store.save();
        render();
    });

    el.evTime.addEventListener('change', () => {
        const ms = new Date(el.evTime.value).getTime();
        if (!Number.isFinite(ms)) {
            el.eventMsg.textContent = '請輸入完整的日期與時間。';
            el.evTime.value = toLocalInput(state.event.target);
            return;
        }
        el.eventMsg.textContent = '';
        state.event.target = ms;
        state.lastSec = null;
        state.prevStatus = snapshot().status;                        // 改成過去時間不要觸發「時間到」音效
        cache = {};
        store.save();
        render();
    });
    el.eventForm.addEventListener('submit', e => e.preventDefault());

    function toggleSound() {
        state.sound = !state.sound;
        if (state.sound) tone(784, 0.12);                            // 開啟時給一聲回饋（也順便解鎖音效）
        renderControls();
        store.save();
    }
    el.btnSound.addEventListener('click', toggleSound);

    /* 全螢幕（不支援的瀏覽器直接隱藏按鈕，例如 iPhone 的 Safari） */
    function toggleFullscreen() {
        if (!document.fullscreenEnabled) return;
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
    }
    if (!document.fullscreenEnabled) el.btnFull.hidden = true;
    el.btnFull.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
        document.documentElement.classList.toggle('fs', Boolean(document.fullscreenElement));
    });

    /* 鍵盤快捷鍵 */
    document.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return;
        const target = e.target;
        if (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)) return;
        const onButton = Boolean(target.closest && target.closest('button, a'));

        switch (e.code) {
            case 'Space':
                if (onButton) return;                                // 讓按鈕自己處理空白鍵
                e.preventDefault();
                toggleRun();
                break;
            case 'KeyR': reset(); break;
            case 'KeyF': toggleFullscreen(); break;
            case 'KeyM': toggleSound(); break;
        }
    });

    /* 第一次互動就解鎖音效（目標日期模式使用者可能不會按開始） */
    window.addEventListener('pointerdown', () => ensureAudio(), { once: true });

    /* ---------- 初始化 ---------- */
    buildTower();
    syncCustomFields();
    markPreset();
    el.evName.value = state.event.name;
    el.evTime.value = toLocalInput(state.event.target);
    state.prevStatus = snapshot().status;
    el.app.dataset.mode = state.mode;
    renderControls();
    render();
})();
