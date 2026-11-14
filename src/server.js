'use strict';

/**
 * 本地 HTTP 服务：静态前端 + 仓库 API。
 * 仅依赖 Node 内置模块；数据持久化到 data/warehouse.json。
 *   node src/server.js [--port 3000] [--reset]
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { GridWarehouse } = require('./store');
const { INITIAL_LAYOUTS, INITIAL_EVENTS, REVISION_EVENTS, NEW_LAYOUT } = require('./scenario');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'warehouse.json');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 3000;
const RESET = process.argv.includes('--reset');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let wh;

function loadWarehouse() {
  if (!RESET && fs.existsSync(DATA_FILE)) {
    try {
      wh = GridWarehouse.fromJSON(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      return 'loaded';
    } catch (err) {
      console.warn(`持久化文件损坏，回退到空仓库: ${err.message}`);
    }
  }
  wh = new GridWarehouse();
  return 'empty';
}

let saveTimer = null;
function persist() {
  // 合并高频写入，落盘由服务器端完成（前端只调 API）
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(wh.toJSON(), null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 100);
}

// ---------- CSV（RFC4180 子集：引号、逗号、换行、转义引号） ----------
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '\n') {
      pushRow();
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('请求体超过 5MB 限制'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      layouts: wh.listLayouts(),
      counts: wh.counts(),
      partitions: Object.fromEntries(wh.layoutOrder.map((v) => [v, wh.listPartitions(v)])),
    });
  }

  if (method === 'POST' && p === '/api/layouts') {
    const body = JSON.parse(await readBody(req) || '{}');
    const result = wh.createLayout(body);
    persist();
    return sendJson(res, 201, result);
  }

  if (method === 'POST' && p === '/api/import') {
    const contentType = req.headers['content-type'] || '';
    const raw = await readBody(req);
    let rows;
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(raw || '{}');
      rows = Array.isArray(parsed) ? parsed : parsed.events;
      if (!Array.isArray(rows)) throw new Error('JSON 体应为事件数组或 {events: [...]}');
    } else {
      rows = parseCsv(raw);
    }
    const report = wh.importBatch(rows);
    persist();
    return sendJson(res, 200, { report, counts: wh.counts() });
  }

  if (method === 'GET' && p === '/api/cells') {
    const v = url.searchParams.get('version');
    const level = Number(url.searchParams.get('level'));
    const partition = url.searchParams.get('partition') || undefined;
    return sendJson(res, 200, wh.queryCells(v, level, partition ? { partition } : {}));
  }

  if (method === 'GET' && p === '/api/events') {
    const v = url.searchParams.get('version');
    const level = Number(url.searchParams.get('level'));
    const col = Number(url.searchParams.get('col'));
    const row = Number(url.searchParams.get('row'));
    return sendJson(res, 200, wh.queryEventsInCell(v, level, col, row));
  }

  if (method === 'GET' && p === '/api/reconcile') {
    const partition = url.searchParams.get('partition') || undefined;
    const v = url.searchParams.get('version');
    if (v) {
      const layout = wh.getLayout(v);
      if (url.searchParams.get('level') !== null) {
        const level = Number(url.searchParams.get('level'));
        return sendJson(res, 200, wh.reconcile(v, level, partition ? { partition } : {}));
      }
      // 不带 level：返回该版本全部层级
      const results = [];
      for (let level = 0; level <= layout.maxLevel; level++) {
        results.push(wh.reconcile(v, level, partition ? { partition } : {}));
      }
      return sendJson(res, 200, { results });
    }
    return sendJson(res, 200, { results: wh.reconcileAll(partition ? { partition } : {}) });
  }

  if (method === 'GET' && p === '/api/compare') {
    const v = url.searchParams.get('version');
    const level = Number(url.searchParams.get('level'));
    const partition = url.searchParams.get('partition') || undefined;
    const f = partition ? { partition } : {};
    const materialized = Object.fromEntries(wh.materializedCounts(v, level, f));
    const rollup = Object.fromEntries(wh.rollupCounts(v, level, f));
    const direct = Object.fromEntries(wh.directCounts(v, level, f));
    return sendJson(res, 200, {
      version: v, level, partition: partition || null,
      totals: {
        materialized: Object.values(materialized).reduce((a, b) => a + b, 0),
        rollup: Object.values(rollup).reduce((a, b) => a + b, 0),
        direct: Object.values(direct).reduce((a, b) => a + b, 0),
      },
      materialized, rollup, direct,
    });
  }

  if (method === 'GET' && p === '/api/quarantine') {
    return sendJson(res, 200, { entries: wh.listQuarantine(), counts: wh.counts() });
  }

  if (method === 'GET' && p === '/api/audit') {
    return sendJson(res, 200, { entries: wh.listAudit(Number(url.searchParams.get('limit')) || 200) });
  }

  if (method === 'GET' && p === '/api/events-list') {
    const events = Array.from(wh.events.values()).map((e) => ({
      eventId: e.eventId, status: e.status, lon: e.lon, lat: e.lat,
      timestamp: e.timestamp, partition: e.partition,
      revisions: e.revisions.length, quarantineReasons: e.quarantineReasons,
    }));
    return sendJson(res, 200, { events });
  }

  if (method === 'POST' && p === '/api/demo/load') {
    wh = new GridWarehouse();
    for (const spec of INITIAL_LAYOUTS) wh.createLayout(spec);
    const initial = wh.importBatch(INITIAL_EVENTS);
    persist();
    return sendJson(res, 200, { stage: 'initial', report: initial, counts: wh.counts() });
  }

  if (method === 'POST' && p === '/api/demo/revise') {
    const report = wh.importBatch(REVISION_EVENTS);
    persist();
    return sendJson(res, 200, { stage: 'revised', report, counts: wh.counts() });
  }

  if (method === 'POST' && p === '/api/demo/new-version') {
    const result = wh.createLayout(NEW_LAYOUT);
    persist();
    return sendJson(res, 201, { stage: 'v2', ...result, counts: wh.counts() });
  }

  if (method === 'POST' && p === '/api/reset') {
    wh = new GridWarehouse();
    try { await fsp.rm(DATA_FILE, { force: true }); } catch { /* 忽略 */ }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: `无此 API: ${method} ${p}` });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

const mode = loadWarehouse();
server.listen(PORT, () => {
  console.log(`地理点加工仓已启动: http://localhost:${PORT}  (仓库状态: ${mode})`);
  console.log(`数据文件: ${DATA_FILE}`);
});
