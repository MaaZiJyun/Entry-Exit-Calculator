// 全局状态
let records = [];
let chartInstance = null;
let latestCsvFromServer = '';
let sortOrder = 'desc';           // 日期排序：desc=最新在前，asc=最旧在前
const API_URL = '/parse_images';

// DOM 引用
const tbody = document.getElementById('tableBody');
const totalCountEl = document.getElementById('totalCount');
const totalDaysEl = document.getElementById('totalDays');
const taxProgressFill = document.getElementById('taxProgressFill');
const taxProgressLabel = document.getElementById('taxProgressLabel');
const taxGapMsg = document.getElementById('taxGapMsg');
const cityProgressFill = document.getElementById('cityProgressFill');
const cityProgressLabel = document.getElementById('cityProgressLabel');
const cityGapMsg = document.getElementById('cityGapMsg');
const eduSelect = document.getElementById('eduSelect');
const citySelect = document.getElementById('citySelect');
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const addRowBtn = document.getElementById('addRowBtn');
const statusMsg = document.getElementById('statusMsg');
const inferProgressWrap = document.getElementById('inferProgressWrap');
const inferProgressFill = document.getElementById('inferProgressFill');
const inferProgressText = document.getElementById('inferProgressText');
const inferProgressPct = document.getElementById('inferProgressPct');

let inferProgressTimer = null;
let inferProgressValue = 0;

// 工具函数
function parseDate(dateStr) {
    if (!dateStr) return null;
    const cleaned = dateStr.replace(/\//g, '-');
    const parts = cleaned.split('-');
    if (parts.length === 3) {
        const y = parseInt(parts[0]), m = parseInt(parts[1]) - 1, d = parseInt(parts[2]);
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return new Date(y, m, d);
    }
    return null;
}
function formatDate(d) {
    if (!d) return '';
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function calcTotalDays(records) {
    if (!records.length) return 0;

    // 按原始顺序（OCR 读出顺序 = seq 顺序）两两配对
    // 每对格式：(入境, 出境) —— 但个别图片可能是 (出境, 入境)，兼容处理
    // 境外天数 = 入境日期 - 出境日期
    let totalDays = 0;
    let i = 0;

    while (i + 1 < records.length) {
        const a = records[i];
        const b = records[i + 1];

        let entryDate = null;  // 入境日期
        let exitDate = null;   // 出境日期

        if (a.type === '入境' && b.type === '出境') {
            entryDate = parseDate(a.date);
            exitDate = parseDate(b.date);
        } else if (a.type === '出境' && b.type === '入境') {
            entryDate = parseDate(b.date);
            exitDate = parseDate(a.date);
        }

        if (entryDate && exitDate) {
            const diffMs = entryDate - exitDate;
            const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
            totalDays += Math.max(1, diffDays); // 同天至少 1 天
        }
        i += 2;
    }

    // 奇数条：最后一条是入境（无对应出境），累积到今天
    if (records.length % 2 === 1) {
        const last = records[records.length - 1];
        if (last.type === '入境') {
            const d = parseDate(last.date);
            if (d) {
                const now = new Date();
                now.setHours(0, 0, 0, 0);
                const diffMs = now - d;
                const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
                totalDays += Math.max(1, diffDays);
            }
        }
    }

    return totalDays;
}
function showStatus(msg, isError = false) {
    statusMsg.style.display = 'inline-block';
    statusMsg.textContent = msg;
    statusMsg.style.background = isError ? '#c74a4a' : '#2c4a7a';
    setTimeout(() => { statusMsg.style.display = 'none'; }, 5000);
}

function setInferenceProgress(value, text = '', isError = false) {
    const pct = Math.max(0, Math.min(100, value));
    inferProgressValue = pct;
    inferProgressWrap.style.display = 'block';
    inferProgressFill.style.width = `${pct}%`;
    inferProgressPct.textContent = `${Math.round(pct)}%`;
    if (text) {
        inferProgressText.textContent = text;
    }
    inferProgressFill.classList.toggle('error', isError);
}

function startInferenceProgress() {
    setInferenceProgress(0, '正在上传文件...');

    if (inferProgressTimer) {
        clearInterval(inferProgressTimer);
    }

    inferProgressTimer = setInterval(() => {
        if (inferProgressValue >= 92) return;

        const step = inferProgressValue < 30 ? 6 : inferProgressValue < 70 ? 3 : 1.2;
        const next = Math.min(92, inferProgressValue + step);

        let text = '上传完成，等待服务响应...';
        if (next >= 65) {
            text = '模型推理中，请稍候...';
        } else if (next >= 35) {
            text = '正在加载并识别页面...';
        }
        setInferenceProgress(next, text);
    }, 500);
}

function finishInferenceProgress(success, text) {
    if (inferProgressTimer) {
        clearInterval(inferProgressTimer);
        inferProgressTimer = null;
    }

    if (success) {
        setInferenceProgress(100, text || '识别完成');
        setTimeout(() => {
            inferProgressWrap.style.display = 'none';
        }, 1000);
    } else {
        setInferenceProgress(Math.max(10, inferProgressValue), text || '识别失败', true);
    }
}

// 渲染表格
function renderTable() {
    if (!records.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="padding:20px;color:#7a8aa5;">暂无数据，请上传图片或加载示例</td></tr>`;
        return;
    }

    // 按日期排序显示（不影响原始 records 数组）；日期相同按 seq 排
    const sorted = [...records].sort((a, b) => {
        const da = parseDate(a.date);
        const db = parseDate(b.date);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        const dateDiff = sortOrder === 'desc' ? db - da : da - db;
        if (dateDiff !== 0) return dateDiff;
        // 日期相同：按 seq（序号）排
        const sa = parseInt(a.seq, 10) || 0;
        const sb = parseInt(b.seq, 10) || 0;
        return sortOrder === 'desc' ? sb - sa : sa - sb;
    });

    let html = '';
    sorted.forEach((r) => {
        html += `<tr>
            <td contenteditable="true" data-field="seq">${r.seq || ''}</td>
            <td contenteditable="true" data-field="type">${r.type || ''}</td>
            <td contenteditable="true" data-field="date">${r.date || ''}</td>
            <td contenteditable="true" data-field="docName">${r.docName || ''}</td>
            <td contenteditable="true" data-field="docNum">${r.docNum || ''}</td>
            <td contenteditable="true" data-field="port">${r.port || ''}</td>
            <td contenteditable="true" data-field="flight">${r.flight || ''}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('td[contenteditable]').forEach(td => {
        td.addEventListener('blur', function () {
            const row = this.parentElement;
            // 编辑后需要找到该行在 records 中的真实索引（基于 seq 匹配）
            const seqVal = row.querySelector('td[data-field="seq"]')?.textContent?.trim() || '';
            const idx = records.findIndex(r => r.seq === seqVal);
            if (idx >= 0) {
                const field = this.dataset.field;
                records[idx][field] = this.textContent.trim();
                updateAll();
            }
        });
    });

    // 更新排序指示器
    const indicator = document.getElementById('sortIndicator');
    if (indicator) indicator.textContent = sortOrder === 'desc' ? '▼' : '▲';
}

function toggleSortOrder() {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    renderTable();
}

function setRecords(newRecords) {
    records = newRecords.map(r => ({ ...r }));
    updateAll();
}

// 更新所有统计、图表、进度条
function updateAll() {
    renderTable();
    const total = records.length;
    const days = calcTotalDays(records);
    totalCountEl.textContent = total;
    totalDaysEl.textContent = days;

    // 免税车
    const TAX_THRESHOLD = 270;
    const taxPct = Math.min(100, (days / TAX_THRESHOLD) * 100);
    taxProgressFill.style.width = taxPct + '%';
    taxProgressLabel.textContent = `${days} / ${TAX_THRESHOLD} 天`;
    const taxGap = Math.max(0, TAX_THRESHOLD - days);
    taxGapMsg.innerHTML = taxGap === 0 ? '✅ 已达标，具备资格' : `差距：还需 ${taxGap} 天`;
    taxGapMsg.style.color = taxGap === 0 ? '#2a7a5a' : '#c74a4a';

    // 落户
    updateCityProgress(days);

    // 图表
    updateChart(records);
}

function updateCityProgress(days) {
    const CITY_THRESHOLDS = {
        '北京': { '本科': 365, '硕士': 365, '博士': 365 },
        '上海': { '本科': 360, '硕士': 360, '博士': 360 },
        '广州': { '本科': 180, '硕士': 180, '博士': 180 },
        '深圳': { '本科': 180, '硕士': 180, '博士': 180 },
        '杭州': { '本科': 180, '硕士': 180, '博士': 180 }
    };
    const city = citySelect.value;
    const edu = eduSelect.value;
    const threshold = CITY_THRESHOLDS[city]?.[edu] || 360;
    const pct = Math.min(100, (days / threshold) * 100);
    cityProgressFill.style.width = pct + '%';
    cityProgressLabel.textContent = `${days} / ${threshold} 天`;
    const gap = Math.max(0, threshold - days);
    cityGapMsg.innerHTML = gap === 0 ? '✅ 已达标，具备资格' : `差距：还需 ${gap} 天`;
    cityGapMsg.style.color = gap === 0 ? '#2a7a5a' : '#c74a4a';
}

function updateChart(records) {
    if (!records.length) {
        clearChart();
        return;
    }

    const monthMap = new Map(); // "YYYY-MM" → 天数

    // 与 calcTotalDays 一致的配对逻辑，逐天统计到月份
    for (let i = 0; i + 1 < records.length; i += 2) {
        const a = records[i];
        const b = records[i + 1];
        let entryDate, exitDate;
        if (a.type === '入境' && b.type === '出境') {
            entryDate = parseDate(a.date);
            exitDate = parseDate(b.date);
        } else if (a.type === '出境' && b.type === '入境') {
            entryDate = parseDate(b.date);
            exitDate = parseDate(a.date);
        } else continue;
        if (!entryDate || !exitDate) continue;

        if (exitDate.getTime() === entryDate.getTime()) {
            // 同天往返：当天算 1 天
            addDay(monthMap, exitDate);
        } else {
            // 逐天累加（从出境日到入境日前一天）
            const cur = new Date(exitDate);
            while (cur < entryDate) {
                addDay(monthMap, cur);
                cur.setDate(cur.getDate() + 1);
            }
        }
    }

    // 奇数条：最后一条入境未配对，统计到今天
    if (records.length % 2 === 1) {
        const last = records[records.length - 1];
        if (last.type === '入境') {
            const d = parseDate(last.date);
            if (d) {
                const now = new Date();
                now.setHours(0, 0, 0, 0);
                const cur = new Date(d);
                while (cur <= now) {
                    addDay(monthMap, cur);
                    cur.setDate(cur.getDate() + 1);
                }
            }
        }
    }

    const sorted = Array.from(monthMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = sorted.map(item => item[0]);
    const data = sorted.map(item => item[1]);

    const ctx = document.getElementById('monthChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    if (labels.length === 0) {
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: ['无数据'], datasets: [{ label: '天数', data: [0], backgroundColor: '#dce3ef' }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
        return;
    }
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: '境外居留天数', data, backgroundColor: '#4a7ec7', borderRadius: 4 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } }
        }
    });
}

function addDay(map, date) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    map.set(key, (map.get(key) || 0) + 1);
}

function clearChart() {
    const ctx = document.getElementById('monthChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['无数据'], datasets: [{ label: '天数', data: [0], backgroundColor: '#dce3ef' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

// ---------- API 调用 ----------
async function handleFiles(files) {
    const imageFiles = Array.from(files || []);
    if (!imageFiles.length) return;

    const formData = new FormData();
    imageFiles.forEach((file) => formData.append('files', file));
    startInferenceProgress();
    showStatus(`正在识别 ${imageFiles.length} 张图片中的表格...`, false);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) throw new Error('服务器错误');

        const json = await response.json();
        if (json.data && json.data.length) {
            setRecords(json.data);
            latestCsvFromServer = json.csv || '';

            finishInferenceProgress(true, `识别完成，提取 ${json.data.length} 条记录`);
            showStatus(`成功解析 ${json.data.length} 条记录`, false);
        } else {
            finishInferenceProgress(false, '未识别到表格数据');
            showStatus('未识别到表格数据，请检查图片质量', true);
        }
    } catch (err) {
        finishInferenceProgress(false, '解析失败，请重试');
        showStatus('解析失败: ' + err.message, true);
    }
}

// ---------- 导出CSV ----------
function exportCSV() {
    if (records.length === 0) { alert('没有数据'); return; }
    const headers = ['序号', '出境/入境', '出入境日期', '证件名称', '证件号码', '出入境口岸', '航班号'];
    let fallbackCsv = headers.join(',') + '\n';
    records.forEach(r => {
        const row = [r.seq, r.type, r.date, r.docName, r.docNum, r.port, r.flight].map(v => `"${v}"`).join(',');
        fallbackCsv += row + '\n';
    });

    const csvToExport = latestCsvFromServer || fallbackCsv;
    const blob = new Blob(['\uFEFF' + csvToExport], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '出入境记录_多图识别.csv';
    link.click();
    URL.revokeObjectURL(link.href);
}

// ---------- 示例数据 ----------
function loadSample() {
    const sample = [
        { seq: '1', type: '出境', date: '2026-06-10', docName: '往来港澳通行证', docNum: '', port: '罗湖口岸', flight: '' },
        { seq: '2', type: '入境', date: '2026-06-18', docName: '往来港澳通行证', docNum: '', port: '罗湖口岸', flight: '' },
    ];
    latestCsvFromServer = '';
    setRecords(sample);
}

// ---------- 事件绑定 ----------
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#4a7ec7'; });
uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = '#b3c6e7'; });
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#b3c6e7';
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
    fileInput.value = '';
});

loadSampleBtn.addEventListener('click', loadSample);
exportCsvBtn.addEventListener('click', exportCSV);
addRowBtn.addEventListener('click', () => {
    const newRow = { seq: records.length + 1, type: '', date: '', docName: '', docNum: '', port: '', flight: '' };
    records.push(newRow);
    updateAll();
});
document.getElementById('sortDateHeader')?.addEventListener('click', toggleSortOrder);
citySelect.addEventListener('change', () => updateCityProgress(calcTotalDays(records)));
eduSelect.addEventListener('change', () => updateCityProgress(calcTotalDays(records)));

// 初始化加载示例
loadSample();