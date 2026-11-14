'use strict';

/**
 * 多级格网仓库（内存态 + JSON 持久化）
 *
 * 入仓模型：
 * - 每个布局版本各自持有一套事实表 facts[version][level][cellId]，
 *   版本之间物理隔离，任何查询都必须带 versionId，不混用布局。
 * - 事实表在每一层都物化（level 0..maxLevel），因此：
 *     · 「底层汇总」= 从最细层沿父子关系向上 rollup
 *     · 「直接计算」= 用当前层规则对原始坐标重新落格计数
 *     · 「物化表」  = 入仓时直接写入的各层计数
 *   三者可两两核对，全部一致才算守恒。
 * - 每个单元记录 total 与 byPartition（UTC 日分区），事件明细另存 eventIds。
 * - 修订采用「先撤回、后计入」：先把旧坐标在全部版本/层级/分区的贡献删掉，
 *   再按新坐标写入，任何中间态都不会让一个事件被两个单元同时计数。
 * - 原始坐标永不覆盖：events 里保留首报值与每次修订记录。
 */

const Grid = require('./grid');

class GridWarehouse {
  constructor() {
    this.layouts = new Map();      // versionId -> layout
    this.layoutOrder = [];
    this.events = new Map();       // eventId -> eventRecord
    this.facts = new Map();        // versionId -> level -> cellId -> fact
    this.quarantine = [];          // 隔离区条目（含已恢复的，状态字段区分）
    this.audit = [];               // 不可变审计日志
    this.seq = 0;
  }

  // ---------- 布局 / 版本 ----------

  createLayout(spec) {
    const layout = Grid.defineLayout(spec);
    if (this.layouts.has(layout.versionId)) {
      throw new Error(`版本 ${layout.versionId} 已存在；规则改版必须新建版本，不得覆盖旧布局`);
    }
    this.layouts.set(layout.versionId, layout);
    this.layoutOrder.push(layout.versionId);
    const byLevel = new Map();
    for (let l = 0; l <= layout.maxLevel; l++) byLevel.set(l, new Map());
    this.facts.set(layout.versionId, byLevel);

    // 新版规则对全部在册有效事件回填，历史版本保持不动
    let backfilled = 0;
    for (const ev of this.events.values()) {
      if (ev.status !== 'active') continue;
      this._assignInto(layout, ev);
      backfilled++;
    }
    this._log('layout.create', { versionId: layout.versionId, factor: layout.factor, maxLevel: layout.maxLevel, backfilled });
    return { layout, backfilled };
  }

  listLayouts() {
    return this.layoutOrder.map((id) => this.layouts.get(id));
  }

  getLayout(versionId) {
    const layout = this.layouts.get(versionId);
    if (!layout) throw new Error(`未知布局版本: ${versionId}`);
    return layout;
  }

  // ---------- 导入 ----------

  /**
   * 导入一条事件（新增或按 eventId 修订）。
   * 原始载荷 raw 原样保留；返回处理结论供前端/演示展示。
   */
  importEvent(rawEvent) {
    const eventId = String(rawEvent.event_id ?? rawEvent.eventId ?? '').trim();
    if (!eventId) throw new Error('事件缺少 event_id');
    const lon = toNumberOrNull(rawEvent.lon ?? rawEvent.longitude ?? rawEvent.lng);
    const lat = toNumberOrNull(rawEvent.lat ?? rawEvent.latitude);
    const timestamp = rawEvent.timestamp ?? rawEvent.ts ?? rawEvent.time ?? null;
    const partition = Grid.timePartition(timestamp);
    const check = Grid.validateCoordinate(lon, lat);

    const existing = this.events.get(eventId);

    // 幂等短路：同 event_id 且坐标/时间完全一致的重复上报直接忽略，
    // 不写修订历史、不动事实表、计数不翻倍（演示中的重复事件走这里）。
    if (existing &&
      existing.status === 'active' &&
      numEqual(existing.lon, lon) && numEqual(existing.lat, lat) &&
      (existing.timestamp ?? null) === (timestamp ?? null)) {
      this._log('event.duplicate-ignored', { eventId });
      return { action: 'duplicate-ignored', eventId, reasons: [], cells: [] };
    }

    const base = {
      eventId,
      raw: rawEvent,
      firstSeenAt: existing ? existing.firstSeenAt : new Date().toISOString(),
      revisions: existing ? existing.revisions : [],
    };

    // 1) 坐标非法 → 隔离区（修订场景下先撤回旧贡献）
    if (!check.valid) {
      if (existing && existing.status === 'active') this._withdraw(existing);
      const record = {
        ...base,
        lon, lat, timestamp, partition,
        status: 'quarantined',
        quarantineReasons: check.reasons,
        updatedAt: new Date().toISOString(),
      };
      this.events.set(eventId, record);
      const q = {
        eventId, lon, lat, timestamp, partition,
        reasons: check.reasons,
        state: 'quarantined',
        at: new Date().toISOString(),
      };
      this.quarantine.push(q);
      this._log(existing ? 'event.quarantine-revision' : 'event.quarantine', {
        eventId, reasons: check.reasons, withdrew: !!(existing && existing.status === 'active'),
      });
      return { action: existing ? 'revised-to-quarantine' : 'quarantined', eventId, reasons: check.reasons, cells: [] };
    }

    // 2) 坐标合法
    const perVersion = [];
    if (existing) {
      // 修订：先整体撤回旧坐标贡献（无论旧态是 active 还是 quarantined）
      if (existing.status === 'active') this._withdraw(existing);
      const record = {
        ...base,
        lon, lat, timestamp, partition,
        status: 'active',
        quarantineReasons: null,
        updatedAt: new Date().toISOString(),
      };
      record.revisions = [
        ...existing.revisions,
        {
          from: { lon: existing.lon, lat: existing.lat, timestamp: existing.timestamp, status: existing.status },
          to: { lon, lat, timestamp, status: 'active' },
          at: record.updatedAt,
        },
      ];
      this.events.set(eventId, record);
      for (const versionId of this.layoutOrder) {
        const cells = this._assignInto(this.layouts.get(versionId), record);
        perVersion.push({ versionId, cells });
      }
      // 若此前在隔离区，标记为已恢复（隔离条目保留可审计）
      if (existing.status === 'quarantined') {
        for (let i = this.quarantine.length - 1; i >= 0; i--) {
          if (this.quarantine[i].eventId === eventId && this.quarantine[i].state === 'quarantined') {
            this.quarantine[i].state = 'recovered';
            this.quarantine[i].recoveredAt = record.updatedAt;
            break;
          }
        }
      }
      this._log('event.revise', {
        eventId,
        from: { lon: existing.lon, lat: existing.lat },
        to: { lon, lat },
        versions: this.layoutOrder.slice(),
      });
      return { action: 'revised', eventId, cells: perVersion[0]?.cells ?? [], perVersion };
    }

    // 新增
    const record = {
      ...base,
      lon, lat, timestamp, partition,
      status: 'active',
      quarantineReasons: null,
      updatedAt: new Date().toISOString(),
    };
    this.events.set(eventId, record);
    for (const versionId of this.layoutOrder) {
      const cells = this._assignInto(this.layouts.get(versionId), record);
      perVersion.push({ versionId, cells });
    }
    this._log('event.import', { eventId, lon, lat, partition, versions: this.layoutOrder.slice() });
    return { action: 'imported', eventId, cells: perVersion[0]?.cells ?? [], perVersion };
  }

  /** 批量导入：重复 event_id 走修订语义，完全重复走幂等，返回汇总报告。 */
  importBatch(rows) {
    const report = { imported: 0, revised: 0, quarantined: 0, duplicates: 0, details: [] };
    const seenInBatch = new Set();
    for (const row of rows) {
      const eventId = String(row.event_id ?? row.eventId ?? '').trim();
      if (seenInBatch.has(eventId)) report.duplicates++;
      seenInBatch.add(eventId);
      const r = this.importEvent(row);
      if (r.action === 'imported') report.imported++;
      else if (r.action === 'duplicate-ignored') report.duplicates++;
      else if (r.action === 'quarantined' || r.action === 'revised-to-quarantine') report.quarantined++;
      else report.revised++;
      report.details.push(r);
    }
    return report;
  }

  // ---------- 内部：计入 / 撤回 ----------

  _assignInto(layout, ev) {
    const result = Grid.assignAllLevels(layout, ev.lon, ev.lat);
    if (!result.valid) return [];
    const byLevel = this.facts.get(layout.versionId);
    const cells = [];
    for (const cell of result.cells) {
      const levelMap = byLevel.get(cell.level);
      let fact = levelMap.get(cell.cellId);
      if (!fact) {
        fact = { cellId: cell.cellId, level: cell.level, col: cell.col, row: cell.row, total: 0, byPartition: {}, eventIds: [] };
        levelMap.set(cell.cellId, fact);
      }
      fact.total += 1;
      fact.byPartition[ev.partition] = (fact.byPartition[ev.partition] || 0) + 1;
      fact.eventIds.push(ev.eventId);
      cells.push({ level: cell.level, col: cell.col, row: cell.row, key: cell.key, cellId: cell.cellId });
    }
    return cells;
  }

  /** 撤回一条 active 事件在全部版本/层级/分区的贡献（修订的前半步）。 */
  _withdraw(ev) {
    for (const versionId of this.layoutOrder) {
      const layout = this.layouts.get(versionId);
      const result = Grid.assignAllLevels(layout, ev.lon, ev.lat);
      if (!result.valid) continue;
      const byLevel = this.facts.get(versionId);
      for (const cell of result.cells) {
        const fact = byLevel.get(cell.level).get(cell.cellId);
        if (!fact || fact.total <= 0) {
          throw new Error(`撤回失败：${ev.eventId} 在 ${cell.cellId} 无物化贡献，账本已失衡`);
        }
        fact.total -= 1;
        fact.byPartition[ev.partition] -= 1;
        if (fact.byPartition[ev.partition] === 0) delete fact.byPartition[ev.partition];
        const idx = fact.eventIds.lastIndexOf(ev.eventId);
        if (idx >= 0) fact.eventIds.splice(idx, 1);
        if (fact.total === 0) byLevel.get(cell.level).delete(cell.cellId);
      }
    }
    this._log('event.withdraw', { eventId: ev.eventId, versions: this.layoutOrder.slice() });
  }

  // ---------- 查询 ----------

  _filter(versionId, level, filter = {}) {
    const layout = this.getLayout(versionId);
    Grid.assertLevel?.(layout, level);
    const levelMap = this.facts.get(versionId).get(level);
    const rows = [];
    for (const fact of levelMap.values()) {
      let count = fact.total;
      if (filter.partition) {
        count = fact.byPartition[filter.partition] || 0;
        if (count === 0) continue;
      }
      rows.push({
        cellId: fact.cellId,
        level: fact.level,
        col: fact.col,
        row: fact.row,
        count,
        total: fact.total,
        byPartition: { ...fact.byPartition },
        bounds: Grid.cellBounds(layout, level, fact.col, fact.row),
      });
    }
    rows.sort((a, b) => b.count - a.count || a.cellId.localeCompare(b.cellId));
    return rows;
  }

  /** 某版本某层的单元明细（可按时间分区过滤）。 */
  queryCells(versionId, level, filter = {}) {
    const layout = this.getLayout(versionId);
    const { lonCount, latCount } = Grid.countsAtLevel(layout, level);
    const rows = this._filter(versionId, level, filter);
    const sum = rows.reduce((s, r) => s + r.count, 0);
    return {
      versionId, level, lonCount, latCount,
      partition: filter.partition || null,
      cellCount: rows.length,
      eventCount: sum,
      cells: rows,
    };
  }

  /** 单元下钻：查看事件明细与原始坐标。 */
  queryEventsInCell(versionId, level, col, row) {
    const layout = this.getLayout(versionId);
    const cellId = Grid.fullCellId(versionId, level, col, row);
    const fact = this.facts.get(versionId).get(level).get(cellId);
    if (!fact) return { cellId, events: [] };
    const events = fact.eventIds.map((id) => this.events.get(id)).filter(Boolean).map((ev) => ({
      eventId: ev.eventId, lon: ev.lon, lat: ev.lat, timestamp: ev.timestamp,
      partition: ev.partition, status: ev.status, raw: ev.raw,
    }));
    return {
      cellId,
      bounds: Grid.cellBounds(layout, level, col, row),
      events,
    };
  }

  listQuarantine() {
    return this.quarantine.slice();
  }

  listAudit(limit = 200) {
    return this.audit.slice(-limit).reverse();
  }

  listPartitions(versionId) {
    this.getLayout(versionId);
    const set = new Set();
    for (const ev of this.events.values()) {
      if (ev.status === 'active') set.add(ev.partition);
    }
    return Array.from(set).sort();
  }

  counts() {
    let active = 0;
    let quarantined = 0;
    for (const ev of this.events.values()) {
      if (ev.status === 'active') active++;
      else quarantined++;
    }
    return {
      eventsTotal: this.events.size,
      active,
      quarantined,
      quarantineOpen: this.quarantine.filter((q) => q.state === 'quarantined').length,
      quarantineRecovered: this.quarantine.filter((q) => q.state === 'recovered').length,
      versions: this.layoutOrder.length,
    };
  }

  // ---------- 三种口径与守恒核对 ----------

  /**
   * 口径 A：物化表（入仓时各层直接写入的计数）。
   */
  materializedCounts(versionId, level, filter = {}) {
    const rows = this._filter(versionId, level, filter);
    return new Map(rows.map((r) => [r.cellId, r.count]));
  }

  /**
   * 口径 B：底层汇总 —— 从最细层（maxLevel）沿父子关系向上 rollup。
   * 不读取任何上层物化数据，只依赖最细层事实。
   */
  rollupCounts(versionId, targetLevel, filter = {}) {
    const layout = this.getLayout(versionId);
    const out = new Map();
    const fineMap = this.facts.get(versionId).get(layout.maxLevel);
    for (const fact of fineMap.values()) {
      let count = fact.total;
      if (filter.partition) {
        count = fact.byPartition[filter.partition] || 0;
        if (count === 0) continue;
      }
      // 逐层找父，直到目标层
      let level = layout.maxLevel;
      let col = fact.col;
      let row = fact.row;
      while (level > targetLevel) {
        const p = Grid.parentCell(layout, level, col, row);
        col = p.col; row = p.row; level = p.level;
      }
      const id = Grid.fullCellId(versionId, targetLevel, col, row);
      out.set(id, (out.get(id) || 0) + count);
    }
    return out;
  }

  /**
   * 口径 C：直接计算 —— 只用原始坐标按目标层规则重新落格，完全不读事实表。
   */
  directCounts(versionId, targetLevel, filter = {}) {
    const layout = this.getLayout(versionId);
    const out = new Map();
    for (const ev of this.events.values()) {
      if (ev.status !== 'active') continue;
      if (filter.partition && ev.partition !== filter.partition) continue;
      const cell = Grid.assignOne(layout, targetLevel, ev.lon, ev.lat);
      if (!cell) continue;
      out.set(cell.cellId, (out.get(cell.cellId) || 0) + 1);
    }
    return out;
  }

  static _sum(m) {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  }

  static _diffMaps(a, b) {
    const diffs = [];
    for (const [k, v] of a) {
      const w = b.get(k) || 0;
      if (v !== w) diffs.push({ cellId: k, a: v, b: w });
    }
    for (const [k, v] of b) {
      if (!a.has(k)) diffs.push({ cellId: k, a: 0, b: v });
    }
    return diffs;
  }

  /**
   * 守恒核对（单版本、单层、可选分区）：
   *  check 1  物化表事件总数 == 在册有效事件数（分区过滤后）
   *  check 2  底层汇总 == 直接计算（逐单元）
   *  check 3  物化表 == 底层汇总（逐单元）
   *  check 4  隔离区开放条目数 + 有效事件数 == 事件总数
   */
  reconcile(versionId, level, filter = {}) {
    const layout = this.getLayout(versionId);
    const materialized = this.materializedCounts(versionId, level, filter);
    const rollup = this.rollupCounts(versionId, level, filter);
    const direct = this.directCounts(versionId, level, filter);

    let activeScoped = 0;
    for (const ev of this.events.values()) {
      if (ev.status !== 'active') continue;
      if (filter.partition && ev.partition !== filter.partition) continue;
      activeScoped++;
    }

    const matSum = GridWarehouse._sum(materialized);
    const checks = [
      {
        name: '物化总数 = 在册有效事件数',
        pass: matSum === activeScoped,
        materialized: matSum,
        expected: activeScoped,
      },
      {
        name: '底层汇总 = 直接计算',
        pass: GridWarehouse._diffMaps(rollup, direct).length === 0,
        diffs: GridWarehouse._diffMaps(rollup, direct),
        rollupTotal: GridWarehouse._sum(rollup),
        directTotal: GridWarehouse._sum(direct),
      },
      {
        name: '物化表 = 底层汇总',
        pass: GridWarehouse._diffMaps(materialized, rollup).length === 0,
        diffs: GridWarehouse._diffMaps(materialized, rollup),
      },
    ];

    const openQ = this.quarantine.filter((x) => x.state === 'quarantined').length;
    checks.push({
      name: '有效事件 + 开放隔离 = 事件总数',
      pass: this.counts().active + openQ === this.events.size,
      active: this.counts().active,
      quarantineOpen: openQ,
      eventsTotal: this.events.size,
    });

    return {
      versionId,
      level,
      maxLevel: layout.maxLevel,
      partition: filter.partition || null,
      allPass: checks.every((c) => c.pass),
      checks,
    };
  }

  /** 全版本逐层核对（前端总览用）。 */
  reconcileAll(filter = {}) {
    const out = [];
    for (const versionId of this.layoutOrder) {
      const layout = this.layouts.get(versionId);
      for (let level = 0; level <= layout.maxLevel; level++) {
        out.push(this.reconcile(versionId, level, filter));
      }
    }
    return out;
  }

  // ---------- 审计 / 持久化 ----------

  _log(type, detail) {
    this.seq += 1;
    this.audit.push({ seq: this.seq, type, detail, at: new Date().toISOString() });
  }

  toJSON() {
    return {
      layoutOrder: this.layoutOrder,
      layouts: Object.fromEntries(this.layouts),
      events: Object.fromEntries(this.events),
      quarantine: this.quarantine,
      audit: this.audit,
      seq: this.seq,
      facts: this.layoutOrder.map((versionId) => [
        versionId,
        Array.from(this.facts.get(versionId), ([level, m]) => [level, Array.from(m.values())]),
      ]),
    };
  }

  static fromJSON(data) {
    const wh = new GridWarehouse();
    wh.layoutOrder = data.layoutOrder || [];
    wh.layouts = new Map(Object.entries(data.layouts || {}));
    wh.events = new Map(Object.entries(data.events || {}));
    wh.quarantine = data.quarantine || [];
    wh.audit = data.audit || [];
    wh.seq = data.seq || 0;
    wh.facts = new Map();
    for (const [versionId, levels] of data.facts || []) {
      const byLevel = new Map();
      for (const [level, factList] of levels) {
        const m = new Map();
        for (const fact of factList) m.set(fact.cellId, fact);
        byLevel.set(Number(level), m);
      }
      wh.facts.set(versionId, byLevel);
    }
    return wh;
  }
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a === b;
}

module.exports = { GridWarehouse };
