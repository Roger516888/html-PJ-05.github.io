const I18N = {
    'zh-TW': {
        htmlLang: 'zh-TW',
        title: '自動排班工具 - 5月班表',
        heading: '自動排班工具 - 2025年5月班表',
        generate: '生成班表',
        language: '語言：',
        date: '日期',
        weekday: '星期',
        morning: '早班',
        afternoon: '午班',
        evening: '晚班',
        weekdays: ['日', '一', '二', '三', '四', '五', '六'],
        statsTitle: '排班統計',
        statsRow: '{name}：{count} 班',
        selfCheckTitle: '自我檢查',
        checkOk: '✓ 每位員工班數差距不超過 2 班',
        checkFail: '✗ 員工班數分配不均',
        checkFull: '✓ 每日皆已完整排班',
    },
    'zh-CN': {
        htmlLang: 'zh-CN',
        title: '自动排班工具 - 5月班表',
        heading: '自动排班工具 - 2025年5月班表',
        generate: '生成班表',
        language: '语言：',
        date: '日期',
        weekday: '星期',
        morning: '早班',
        afternoon: '午班',
        evening: '晚班',
        weekdays: ['日', '一', '二', '三', '四', '五', '六'],
        statsTitle: '排班统计',
        statsRow: '{name}：{count} 班',
        selfCheckTitle: '自我检查',
        checkOk: '✓ 每位员工班数差距不超过 2 班',
        checkFail: '✗ 员工班数分配不均',
        checkFull: '✓ 每日皆已完整排班',
    },
    'en': {
        htmlLang: 'en',
        title: 'Auto Scheduler - May Schedule',
        heading: 'Auto Scheduler - May 2025 Schedule',
        generate: 'Generate Schedule',
        language: 'Language:',
        date: 'Date',
        weekday: 'Weekday',
        morning: 'Morning',
        afternoon: 'Afternoon',
        evening: 'Evening',
        weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        statsTitle: 'Schedule Statistics',
        statsRow: '{name}: {count} shifts',
        selfCheckTitle: 'Self-check',
        checkOk: '✓ Shift count per employee differs by at most 2',
        checkFail: '✗ Shifts are unevenly distributed',
        checkFull: '✓ Every day is fully scheduled',
    },
};

const EMPLOYEES = ['Alice', 'Bob', 'Carol', 'David', 'Eve'];
const SHIFT_KEYS = ['morning', 'afternoon', 'evening'];

let currentLang = 'zh-TW';
let lastSchedule = null;

function t(key) {
    return I18N[currentLang][key];
}

function applyStaticTranslations() {
    document.documentElement.lang = t('htmlLang');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        el.textContent = t(key);
    });
}

function generateSchedule() {
    const year = 2025;
    const month = 4; // May (0-indexed)
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const schedule = [];
    let empIndex = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const shifts = {};
        for (const shiftKey of SHIFT_KEYS) {
            shifts[shiftKey] = EMPLOYEES[empIndex % EMPLOYEES.length];
            empIndex++;
        }
        schedule.push({ day, weekday: date.getDay(), shifts });
    }
    lastSchedule = schedule;
    render();
}

function render() {
    if (!lastSchedule) return;
    renderSchedule(lastSchedule);
    renderStats(lastSchedule);
    renderSelfCheck(lastSchedule);
}

function renderSchedule(schedule) {
    const headers = [t('date'), t('weekday'), t('morning'), t('afternoon'), t('evening')];
    const rows = schedule.map((entry) => {
        const weekday = t('weekdays')[entry.weekday];
        return `<tr>
            <td>${entry.day}</td>
            <td>${weekday}</td>
            <td>${entry.shifts.morning}</td>
            <td>${entry.shifts.afternoon}</td>
            <td>${entry.shifts.evening}</td>
        </tr>`;
    }).join('');
    document.getElementById('schedule-output').innerHTML = `
        <table>
            <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderStats(schedule) {
    const counts = Object.fromEntries(EMPLOYEES.map((name) => [name, 0]));
    for (const entry of schedule) {
        for (const shiftKey of SHIFT_KEYS) {
            counts[entry.shifts[shiftKey]]++;
        }
    }
    const rows = EMPLOYEES.map((name) =>
        `<li>${t('statsRow').replace('{name}', name).replace('{count}', counts[name])}</li>`
    ).join('');
    document.getElementById('stats-output').innerHTML = `
        <h3>${t('statsTitle')}</h3>
        <ul>${rows}</ul>
    `;
}

function renderSelfCheck(schedule) {
    const counts = Object.fromEntries(EMPLOYEES.map((name) => [name, 0]));
    for (const entry of schedule) {
        for (const shiftKey of SHIFT_KEYS) {
            counts[entry.shifts[shiftKey]]++;
        }
    }
    const values = Object.values(counts);
    const balanced = Math.max(...values) - Math.min(...values) <= 2;
    const fullyStaffed = schedule.every((entry) =>
        SHIFT_KEYS.every((key) => !!entry.shifts[key])
    );
    const items = [
        balanced ? t('checkOk') : t('checkFail'),
        fullyStaffed ? t('checkFull') : '',
    ].filter(Boolean);
    document.getElementById('self-check-output').innerHTML = `
        <h3>${t('selfCheckTitle')}</h3>
        <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
    `;
}

function setLanguage(lang) {
    if (!I18N[lang]) return;
    currentLang = lang;
    document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
    applyStaticTranslations();
    render();
}

document.addEventListener('DOMContentLoaded', () => {
    applyStaticTranslations();
    document.getElementById('generate-btn').addEventListener('click', generateSchedule);
    document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.addEventListener('click', () => setLanguage(btn.getAttribute('data-lang')));
    });
});
