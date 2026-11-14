'use strict';
/* 前端逻辑：原生 JS + SVG，不依赖任何地图服务或第三方库。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  layouts: [],
  counts: {},
  partitions: {},
  grid: { version: null, level: null, partition: '', data: null, selected: null },
  table: { version: null, level: null, partition: '', rows: [] },
};

// 顺序蓝阶 5 档（dataviz 调色板 ordinal 校验通过：单色相、亮度单调、ΔL≥0.06）
const SEQ_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
const SEQ_DARK = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
const isDark = () => document.documentElement.dataset.theme === 'dark';
const seq = () => (isDark() ? SEQ_DARK : SEQ_LIGHT);
const surface2 = () => (isDark() ? '#232321' : '#f3f2ee');
const inkMuted = () => (isDark() ? '#898781' : '#898781');
const inkSecondary = () => (isDark() ? '#c3c2b7' : '#52514e');

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': options.contentType || 'application/json' } : {},
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- 主题 ----------
function initTheme() {
  const saved = localStorage.getItem('ggw-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.dataset.theme = 'dark';
  }
  $('#btn-theme').addEventListener('click', () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    localStorage.setItem('ggw-theme', document.documentElement.dataset.theme);
    if (state.grid.data) renderGrid();
  });
}

// ---------- 标签页 ----------
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    if (tab.dataset.tab === 'reconcile' && state.layouts.length) loadReconcile();
    if (tab.dataset.tab === 'quarantine') { loadQuarantine(); loadAudit(); }
  });
}

// ---------- 全局状态刷新 ----------
async function refreshState() {
  const s = await api('/api/state');
  state.layouts = s.layouts;
  state.counts = s.counts;
  state.partitions = s.partitions;
  renderKpis();
  renderLayouts();
  syncSelectors();
}

function renderKpis() {
  $('#kpi-total').textContent = state.counts.eventsTotal ?? 0;
  $('#kpi-active').textContent = state.counts.active ?? 0;
  $('#kpi-quar').textContent = state.counts.quarantineOpen ?? 0;
  $('#kpi-versions').textContent = state.counts.versions ?? 0;
}

async function refreshConservationBadge() {
  if (!state.layouts.length) {
    const el = $('#kpi-conservation');
    el.className = 'banner-status';
    $('#kpi-conservation-text').textContent = '无布局';
    return;
  }
  const { results } = await api('/api/reconcile');
  const allPass = results.every((r) => r.allPass);
  const el = $('#kpi-conservation');
  el.className = `banner-status ${allPass ? 'ok' : 'bad'}`;
  $('#kpi-conservation-text').textContent = allPass
    ? `守恒 ✓（${results.length} 组全部通过）`
    : '守恒异常 ✗（请查看核对页）';
}

function renderLayouts() {
  const wrap = $('#layout-list');
  if (!state.layouts.length) {
    wrap.innerHTML = '<p class="hint">尚无布局。点击下方「一键演示」或创建第一个版本。</p>';
    return;
  }
  wrap.innerHTML = state.layouts.map((l) => {
    const dims = GridEngine.countsAtLevel(l, l.maxLevel);
    return `<div class="layout-item">
      <span class="vid">${l.versionId}<span class="pill">factor ${l.factor}</span></span>
      <div class="meta">层级 0..${l.maxLevel} · 最细层 ${dims.lonCount} 列 × ${dims.latCount} 行 · 创建于 ${l.createdAt.slice(0, 19).replace('T', ' ')}</div>
      <div class="desc">${escapeHtml(l.description || '（无说明）')}</div>
    </div>`;
  }).join('');
}

function versionOptions(selected) {
  return state.layouts.map((l) => `<option value="${l.versionId}" ${l.versionId === selected ? 'selected' : ''}>${l.versionId}（factor ${l.factor}）</option>`).join('');
}

function levelOptions(layout, selected) {
  if (!layout) return '';
  return Array.from({ length: layout.maxLevel + 1 }, (_, i) =>
    `<option value="${i}" ${i === selected ? 'selected' : ''}>level ${i}</option>`).join('');
}

function partitionOptions(version, selected) {
  const parts = (state.partitions[version] || []).map((p) =>
    `<option value="${p}" ${p === selected ? 'selected' : ''}>${p}</option>`).join('');
  return `<option value="">全部分区</option>${parts}`;
}

function getLayout(versionId) {
  return state.layouts.find((l) => l.versionId === versionId);
}

function syncSelectors() {
  if (!state.layouts.length) {
    ['#grid-version', '#table-version', '#rec-version', '#compare-level'].forEach((s) => { $(s).innerHTML = ''; });
    return;
  }
  if (!state.grid.version || !getLayout(state.grid.version)) state.grid.version = state.layouts[0].versionId;
  if (!state.table.version || !getLayout(state.table.version)) state.table.version = state.layouts[0].versionId;
  const gLayout = getLayout(state.grid.version);
  if (state.grid.level === null || state.grid.level > gLayout.maxLevel) state.grid.level = gLayout.maxLevel;

  $('#grid-version').innerHTML = versionOptions(state.grid.version);
  $('#grid-level').innerHTML = levelOptions(gLayout, state.grid.level);
  $('#grid-partition').innerHTML = partitionOptions(state.grid.version, state.grid.partition);

  $('#table-version').innerHTML = versionOptions(state.table.version);
  const tLayout = getLayout(state.table.version);
  if (!state.table.level || state.table.level > tLayout.maxLevel) state.table.level = tLayout.maxLevel;
  $('#table-level').innerHTML = levelOptions(tLayout, state.table.level);
  $('#table-partition').innerHTML = partitionOptions(state.table.version, state.table.partition);

  $('#rec-version').innerHTML = `<option value="">全部版本</option>` + versionOptions('');
  $('#rec-partition').innerHTML = partitionOptions(state.grid.version, '');
  $('#compare-level').innerHTML = levelOptions(gLayout, state.grid.level);
}

// ---------- 导入 ----------
const SAMPLE = JSON.stringify([
  { event_id: 'E900', lon: 12.5, lat: -30.2, timestamp: '2026-11-14T08:00:00Z' },
  { event_id: 'E901', lon: 180, lat: 0, timestamp: '2026-11-14T08:05:00Z' },
  { event_id: 'E902', lon: 999, lat: 10, timestamp: '2026-11-14T08:10:00Z' },
], null, 2);

function initIngest() {
  $('#btn-paste-sample').addEventListener('click', () => {
    $('#import-text').value = SAMPLE;
    $('#import-format').value = 'json';
  });
  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    $('#import-text').value = text;
    $('#import-format').value = file.name.endsWith('.csv') ? 'csv' : 'json';
  });
  $('#btn-import').addEventListener('click', doImport);
  $('#btn-clear').addEventListener('click', async () => {
    if (!confirm('确认清空整个仓库（全部版本、事件、审计）？此操作不可撤销。')) return;
    await api('/api/reset', { method: 'POST' });
    location.reload();
  });
  $('#btn-create-layout').addEventListener('click', createLayout);

  $('#btn-demo-load').addEventListener('click', () => demoStep('/api/demo/load'));
  $('#btn-demo-revise').addEventListener('click', () => demoStep('/api/demo/revise'));
  $('#btn-demo-v2').addEventListener('click', () => demoStep('/api/demo/new-version'));
}

async function doImport() {
  const text = $('#import-text').value.trim();
  const fmt = $('#import-format').value;
  if (!text) return showReport({ error: '导入内容为空' }, false);
  try {
    let body;
    const contentType = fmt === 'csv' ? 'text/plain' : 'application/json';
    if (fmt === 'json') {
      const parsed = JSON.parse(text);
      body = JSON.stringify(Array.isArray(parsed) ? parsed : parsed.events || []);
    } else {
      body = text;
    }
    const data = await api('/api/import', { method: 'POST', body, contentType });
    showImportReport(data.report);
    await afterMutation();
  } catch (err) {
    showReport({ error: err.message }, false);
  }
}

function showImportReport(r) {
  const ok = !r.error;
  const el = $('#import-report');
  el.hidden = false;
  el.className = `report ${ok ? 'ok' : 'bad'}`;
  if (!ok) { el.textContent = `导入失败：${r.error}`; return; }
  el.innerHTML = `<div class="kv">
    <span>新增 <b>${r.imported}</b></span>
    <span>修订 <b>${r.revised}</b></span>
    <span>幂等重复 <b>${r.duplicates}</b></span>
    <span>隔离 <b>${r.quarantined}</b></span>
  </div>
  <p class="hint">修订事件均执行「先撤回旧格网 → 再计入新格网」，可在审计页查看 withdraw 记录。</p>`;
}

function showReport(obj, ok) {
  const el = $('#import-report');
  el.hidden = false;
  el.className = `report ${ok ? 'ok' : 'bad'}`;
  el.textContent = ok ? JSON.stringify(obj) : `错误：${obj.error}`;
}

async function createLayout() {
  const versionId = $('#new-vid').value.trim();
  const factor = Number($('#new-factor').value);
  const maxLevel = Number($('#new-maxlevel').value);
  const description = $('#new-desc').value.trim();
  if (!versionId) return alert('请填写版本 ID');
  try {
    const r = await api('/api/layouts', {
      method: 'POST',
      body: JSON.stringify({ versionId, factor, maxLevel, description }),
    });
    showReport({ ok: true, message: `已创建 ${r.layout.versionId} 并回填 ${r.backfilled} 个在册事件` }, true);
    await afterMutation();
  } catch (err) {
    showReport({ error: err.message }, false);
  }
}

async function demoStep(url) {
  try {
    const data = await api(url, { method: 'POST' });
    if (data.report) showImportReport(data.report);
    else showReport({ ok: true, message: `演示步骤完成：${data.stage}（回填 ${data.backfilled ?? 0}）` }, true);
    await afterMutation();
  } catch (err) {
    showReport({ error: err.message }, false);
  }
}

async function afterMutation() {
  await refreshState();
  await Promise.all([loadGrid(), loadTable(), loadQuarantine(), loadAudit(), refreshConservationBadge()]);
}

// ---------- 格网视图 ----------
function initGridView() {
  $('#grid-version').addEventListener('change', async (e) => {
    state.grid.version = e.target.value;
    state.grid.partition = '';
    state.grid.selected = null;
    syncSelectors();
    await loadGrid();
  });
  $('#grid-level').addEventListener('change', async (e) => {
    state.grid.level = Number(e.target.value);
    state.grid.selected = null;
    await loadGrid();
  });
  $('#grid-partition').addEventListener('change', async (e) => {
    state.grid.partition = e.target.value;
    await loadGrid();
  });
}

async function loadGrid() {
  if (!state.grid.version) return;
  const q = new URLSearchParams({ version: state.grid.version, level: state.grid.level });
  if (state.grid.partition) q.set('partition', state.grid.partition);
  state.grid.data = await api(`/api/cells?${q}`);
  renderGrid();
}

function countColor(count, maxCount) {
  if (!count) return surface2();
  const ramp = seq();
  const idx = Math.min(ramp.length - 1, Math.floor((count - 1) / Math.max(1, maxCount) * ramp.length));
  return ramp[idx];
}

function renderGrid() {
  const d = state.grid.data;
  const layout = getLayout(state.grid.version);
  const svg = $('#grid-svg');
  const { lonCount, latCount } = d;
  const cell = Math.max(6, Math.min(34, Math.floor(900 / lonCount)));
  const M = { top: 28, right: 16, bottom: 40, left: 56 };
  const W = M.left + lonCount * cell + M.right;
  const H = M.top + latCount * cell + M.bottom;
  const countMap = new Map(d.cells.map((c) => [`${c.col}:${c.row}`, c]));
  const maxCount = Math.max(1, ...d.cells.map((c) => c.count));

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${isDark() ? '#1a1a19' : '#fcfcfb'}"/>`);

  // 轴标题
  parts.push(`<text class="axis-title" x="${M.left + lonCount * cell / 2}" y="${H - 8}" text-anchor="middle">经度（等距矩形投影，-180 → +180，半开区间）</text>`);
  parts.push(`<text class="axis-title" transform="translate(14 ${M.top + latCount * cell / 2}) rotate(-90)" text-anchor="middle">纬度（-90 → +90）</text>`);

  // 刻度（单元太多时抽稀，避免重叠）
  const tickEvery = Math.ceil(lonCount / 8);
  for (let c = 0; c <= lonCount; c += tickEvery) {
    const lon = -180 + (360 / lonCount) * c;
    const x = M.left + c * cell;
    parts.push(`<line x1="${x}" y1="${M.top + latCount * cell}" x2="${x}" y2="${M.top + latCount * cell + 4}" stroke="${inkMuted()}"/>`);
    parts.push(`<text class="axis-label" x="${x}" y="${M.top + latCount * cell + 17}" text-anchor="middle">${Math.abs(lon)}°${lon < 0 ? 'W' : lon > 0 ? 'E' : ''}</text>`);
  }
  const latEvery = Math.ceil(latCount / 5);
  for (let r = 0; r <= latCount; r += latEvery) {
    const lat = -90 + (180 / latCount) * r;
    const y = M.top + (latCount - r) * cell;
    parts.push(`<line x1="${M.left - 4}" y1="${y}" x2="${M.left}" y2="${y}" stroke="${inkMuted()}"/>`);
    parts.push(`<text class="axis-label" x="${M.left - 7}" y="${y + 3.5}" text-anchor="end">${Math.abs(lat)}°${lat < 0 ? 'S' : lat > 0 ? 'N' : ''}</text>`);
  }

  // 单元（row 0 在南，SVG 自顶向下，故 y 翻转）
  for (let r = 0; r < latCount; r++) {
    for (let c = 0; c < lonCount; c++) {
      const hit = countMap.get(`${c}:${r}`);
      const count = hit ? hit.count : 0;
      const x = M.left + c * cell;
      const y = M.top + (latCount - 1 - r) * cell;
      const sel = state.grid.selected && state.grid.selected.col === c && state.grid.selected.row === r;
      parts.push(`<rect class="grid-cell ${count ? '' : 'empty'} ${sel ? 'selected' : ''}"
        data-col="${c}" data-row="${r}" x="${x}" y="${y}" width="${cell}" height="${cell}"
        fill="${countColor(count, maxCount)}" rx="1.5"/>`);
    }
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
  $('#grid-meta').textContent = `${d.versionId} · level ${d.level} · ${lonCount}×${latCount} 单元 · 非空 ${d.cellCount} · 事件合计 ${d.eventCount}`;
  $('#legend-max').textContent = maxCount;
  $('#legend-min').textContent = '0';
  $('#legend-ramp').innerHTML = seq().map((c) => `<span style="background:${c}"></span>`).join('');
  $('#cell-detail').hidden = true;
  bindGridInteractions();
}

function bindGridInteractions() {
  const svg = $('#grid-svg');
  const tip = $('#grid-tooltip');
  const d = state.grid.data;
  const countMap = new Map(d.cells.map((c) => [`${c.col}:${c.row}`, c]));

  svg.onmousemove = (e) => {
    const rectEl = e.target.closest('.grid-cell');
    if (!rectEl || rectEl.classList.contains('empty')) { tip.hidden = true; return; }
    const col = Number(rectEl.dataset.col);
    const row = Number(rectEl.dataset.row);
    const hit = countMap.get(`${col}:${row}`);
    if (!hit) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = `<b>${hit.cellId}</b><br>计数：${hit.count}<br>
      经度 [${fmt(hit.bounds.lonMin)}, ${fmt(hit.bounds.lonMax)})<br>
      纬度 [${fmt(hit.bounds.latMin)}, ${fmt(hit.bounds.latMax)})<br>
      <span class="hint">点击查看事件明细</span>`;
    const wrap = $('.chart-wrap').getBoundingClientRect();
    tip.style.left = `${Math.min(wrap.width - 290, e.clientX - wrap.left + 14)}px`;
    tip.style.top = `${e.clientY - wrap.top + 14}px`;
  };
  svg.onmouseleave = () => { tip.hidden = true; };
  svg.onclick = async (e) => {
    const rectEl = e.target.closest('.grid-cell');
    if (!rectEl) return;
    const col = Number(rectEl.dataset.col);
    const row = Number(rectEl.dataset.row);
    state.grid.selected = { col, row };
    renderGrid();
    await showCellDetail(col, row);
  };
}

async function showCellDetail(col, row) {
  const q = new URLSearchParams({
    version: state.grid.version, level: state.grid.level, col, row,
  });
  const data = await api(`/api/events?${q}`);
  const el = $('#cell-detail');
  el.hidden = false;
  if (!data.events.length) {
    el.innerHTML = `<b>${data.cellId}</b><p class="hint">空单元（0 事件）。边界规则：半开区间 [low, high)。</p>`;
    return;
  }
  el.innerHTML = `<b>${data.cellId}</b> · ${data.events.length} 个事件 · 边界 lon [${fmt(data.bounds.lonMin)}, ${fmt(data.bounds.lonMax)}) lat [${fmt(data.bounds.latMin)}, ${fmt(data.bounds.latMax)})
    <table><thead><tr><th>事件 ID</th><th>原始经度</th><th>原始纬度</th><th>时间</th><th>分区</th></tr></thead>
    <tbody>${data.events.map((ev) => `<tr>
      <td>${escapeHtml(ev.eventId)}</td><td class="num">${ev.lon}</td><td class="num">${ev.lat}</td>
      <td>${escapeHtml(ev.timestamp ?? '—')}</td><td>${ev.partition}</td></tr>`).join('')}</tbody></table>
    <p class="hint">坐标为原始上报值，未做任何覆盖或投影变换。</p>`;
}

// ---------- 单元表格 ----------
function initTableView() {
  $('#table-version').addEventListener('change', async (e) => {
    state.table.version = e.target.value;
    state.table.partition = '';
    syncSelectors();
    await loadTable();
  });
  $('#table-level').addEventListener('change', async (e) => {
    state.table.level = Number(e.target.value);
    await loadTable();
  });
  $('#table-partition').addEventListener('change', (e) => {
    state.table.partition = e.target.value;
    loadTable();
  });
  $('#table-search').addEventListener('input', renderTable);
}

async function loadTable() {
  if (!state.table.version) return;
  const q = new URLSearchParams({ version: state.table.version, level: state.table.level });
  if (state.table.partition) q.set('partition', state.table.partition);
  const d = await api(`/api/cells?${q}`);
  state.table.rows = d.cells;
  renderTable();
}

function renderTable() {
  const kw = $('#table-search').value.trim().toLowerCase();
  const rows = kw ? state.table.rows.filter((r) => r.cellId.toLowerCase().includes(kw)) : state.table.rows;
  $('#cells-table tbody').innerHTML = rows.map((r) => `<tr>
    <td><code>${r.cellId}</code></td>
    <td class="num">${r.col}</td><td class="num">${r.row}</td>
    <td class="num"><b>${r.count}</b></td>
    <td class="num">[${fmt(r.bounds.lonMin)}, ${fmt(r.bounds.lonMax)})</td>
    <td class="num">[${fmt(r.bounds.latMin)}, ${fmt(r.bounds.latMax)})</td>
    <td>${Object.entries(r.byPartition).map(([p, n]) => `${p}:${n}`).join(' ')}</td>
    <td><button class="btn" data-drill="${r.col}:${r.row}" type="button">下钻</button></td>
  </tr>`).join('') || '<tr><td colspan="8" class="hint">无匹配单元</td></tr>';
  $('#table-summary').textContent = `非空单元 ${state.table.rows.length} 个，事件合计 ${state.table.rows.reduce((s, r) => s + r.count, 0)}（显示 ${rows.length} 行）`;
  $$('#cells-table [data-drill]').forEach((btn) => btn.addEventListener('click', async () => {
    const [col, row] = btn.dataset.drill.split(':').map(Number);
    await showCellDetailFromTable(col, row);
  }));
}

async function showCellDetailFromTable(col, row) {
  // 切到格网页并定位该单元
  $$('.tab').find((t) => t.dataset.tab === 'grid').click();
  state.grid.selected = { col, row };
  renderGrid();
  await showCellDetail(col, row);
}

// ---------- 守恒核对 ----------
function initReconcile() {
  $('#rec-version').addEventListener('change', () => {
    const v = $('#rec-version').value || state.grid.version;
    $('#rec-partition').innerHTML = partitionOptions(v, '');
    const layout = getLayout(v);
    if (layout) $('#compare-level').innerHTML = levelOptions(layout, layout.maxLevel);
    loadReconcile();
  });
  $('#rec-partition').addEventListener('change', () => loadReconcile());
  $('#btn-run-reconcile').addEventListener('click', () => loadReconcile());
  $('#btn-compare').addEventListener('click', loadCompare);
}

async function loadReconcile() {
  const version = $('#rec-version').value;
  const partition = $('#rec-partition').value;
  const q = new URLSearchParams();
  if (version) q.set('version', version);
  if (partition) q.set('partition', partition);
  const url = `/api/reconcile?${q}`;
  const data = await api(url);
  const results = data.results;
  $('#reconcile-results').innerHTML = results.map((r) => `
    <div class="rec-group ${r.allPass ? 'all-pass' : 'has-fail'}">
      <div class="rec-head">
        <span class="tag ${r.allPass ? 'ok' : 'bad'}">${r.allPass ? '全部通过' : '存在差异'}</span>
        ${r.versionId} · level ${r.level}${r.partition ? ` · 分区 ${r.partition}` : ''}
      </div>
      ${r.checks.map((c) => `
        <div class="check-row ${c.pass ? 'pass' : 'fail'}">
          <span class="mark">${c.pass ? '✓' : '✗'}</span><span>${c.name}</span>
          ${c.materialized !== undefined ? `<span class="hint">（物化 ${c.materialized} / 期望 ${c.expected}）</span>` : ''}
          ${c.rollupTotal !== undefined ? `<span class="hint">（汇总 ${c.rollupTotal} / 直算 ${c.directTotal}）</span>` : ''}
        </div>
        ${!c.pass && c.diffs ? `<div class="diff-box">${c.diffs.slice(0, 8).map((d) => `${d.cellId}: A=${d.a} B=${d.b}`).join('<br>')}${c.diffs.length > 8 ? '<br>…' : ''}</div>` : ''}
      `).join('')}
    </div>`).join('');
}

async function loadCompare() {
  const version = $('#rec-version').value || state.layouts[0]?.versionId;
  const level = Number($('#compare-level').value);
  const partition = $('#rec-partition').value;
  const q = new URLSearchParams({ version, level });
  if (partition) q.set('partition', partition);
  const d = await api(`/api/compare?${q}`);
  const ids = Array.from(new Set([
    ...Object.keys(d.materialized), ...Object.keys(d.rollup), ...Object.keys(d.direct),
  ])).sort();
  $('#compare-table tbody').innerHTML = ids.map((id) => {
    const m = d.materialized[id] || 0;
    const r = d.rollup[id] || 0;
    const dc = d.direct[id] || 0;
    const same = m === r && r === dc;
    return `<tr><td><code>${id}</code></td><td class="num">${m}</td><td class="num">${r}</td><td class="num">${dc}</td>
      <td><span class="tag ${same ? 'ok' : 'bad'}">${same ? '一致' : '差异'}</span></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="hint">无数据</td></tr>';
}

// ---------- 隔离区 / 审计 ----------
async function loadQuarantine() {
  const { entries } = await api('/api/quarantine');
  $('#quarantine-table tbody').innerHTML = entries.map((q) => `<tr>
    <td>${escapeHtml(q.eventId)}</td>
    <td class="num">${q.lon ?? '—'}</td><td class="num">${q.lat ?? '—'}</td>
    <td>${escapeHtml(q.timestamp ?? '—')}</td>
    <td>${q.reasons.map(escapeHtml).join('；')}</td>
    <td><span class="tag ${q.state === 'quarantined' ? 'warn' : 'muted'}">${q.state === 'quarantined' ? '隔离中' : '已恢复'}</span></td>
  </tr>`).join('') || '<tr><td colspan="6" class="hint">隔离区为空</td></tr>';

  const { events } = await api('/api/events-list');
  $('#events-table tbody').innerHTML = events.map((e) => `<tr>
    <td>${escapeHtml(e.eventId)}</td>
    <td><span class="tag ${e.status === 'active' ? 'ok' : 'warn'}">${e.status === 'active' ? '有效' : '隔离'}</span></td>
    <td class="num">${e.lon ?? '—'}</td><td class="num">${e.lat ?? '—'}</td>
    <td>${e.partition}</td><td class="num">${e.revisions}</td>
    <td>${e.quarantineReasons ? e.quarantineReasons.map(escapeHtml).join('；') : '—'}</td>
  </tr>`).join('');
}

async function loadAudit() {
  const { entries } = await api('/api/audit?limit=150');
  $('#audit-list').innerHTML = entries.map((a) => `
    <div class="audit-item">
      <span class="at">#${a.seq} ${a.at.slice(0, 19).replace('T', ' ')}</span><br>
      <span class="type">${a.type}</span>
      <pre style="margin:4px 0 0;white-space:pre-wrap;font-size:11.5px;color:${inkSecondary()}">${escapeHtml(JSON.stringify(a.detail))}</pre>
    </div>`).join('') || '<p class="hint">暂无审计记录</p>';
}

// ---------- 工具 ----------
function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ---------- 启动 ----------
async function main() {
  initTheme();
  initTabs();
  initIngest();
  initGridView();
  initTableView();
  initReconcile();
  await refreshState();
  if (state.layouts.length) {
    await Promise.all([loadGrid(), loadTable(), loadQuarantine(), loadAudit()]);
  } else {
    $('#grid-meta').textContent = '请先在「导入与版本」页创建布局或载入演示数据';
  }
  await refreshConservationBadge();
}

main().catch((err) => alert(`初始化失败：${err.message}`));
