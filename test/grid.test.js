'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Grid = require('../src/grid');
const { GridWarehouse } = require('../src/store');

const layout = Grid.defineLayout({ versionId: 't', factor: 2, maxLevel: 3 });
const layout3 = Grid.defineLayout({ versionId: 't3', factor: 3, maxLevel: 2 });

test('层级单元数：等经纬网，经向单元数恒为纬向两倍', () => {
  assert.deepStrictEqual(Grid.countsAtLevel(layout, 0), { lonCount: 4, latCount: 2 });
  assert.deepStrictEqual(Grid.countsAtLevel(layout, 1), { lonCount: 8, latCount: 4 });
  assert.deepStrictEqual(Grid.countsAtLevel(layout, 3), { lonCount: 32, latCount: 16 });
  assert.deepStrictEqual(Grid.countsAtLevel(layout3, 0), { lonCount: 6, latCount: 3 });
  assert.deepStrictEqual(Grid.countsAtLevel(layout3, 2), { lonCount: 54, latCount: 27 });
});

test('半开区间：格线点归入编号更大的单元', () => {
  // level 0: 经度 4 列步长 90°，纬度 2 行步长 90°
  const c = Grid.assignOne(layout, 0, 0, 0);
  assert.strictEqual(c.col, 2); // [0,90)
  assert.strictEqual(c.row, 1); // [0,90)
  const c2 = Grid.assignOne(layout, 0, 89.999, 89.999);
  assert.strictEqual(c2.col, 2);
  assert.strictEqual(c2.row, 1);
});

test('半开区间：左闭侧点归入本单元，不与左侧重复', () => {
  const left = Grid.assignOne(layout, 0, -90, -45);
  const right = Grid.assignOne(layout, 0, -89.999, -45);
  assert.strictEqual(left.col, 1); // [-90, 0)
  assert.strictEqual(right.col, 1);
  const far = Grid.assignOne(layout, 0, -90.001, -45);
  assert.strictEqual(far.col, 0);
});

test('变更线：+180 归一到最左列，与 -180 同单元', () => {
  const plus = Grid.assignOne(layout, 0, 180, 0);
  const minus = Grid.assignOne(layout, 0, -180, 0);
  assert.strictEqual(plus.col, 0);
  assert.strictEqual(minus.col, 0);
  assert.strictEqual(plus.cellId, minus.cellId);
  // 高一层同样成立
  const plusFine = Grid.assignOne(layout, 2, 179.999999999, 0);
  const exactFine = Grid.assignOne(layout, 2, 180, 0);
  const minusFine = Grid.assignOne(layout, 2, -180, 0);
  assert.strictEqual(exactFine.col, 0);
  assert.strictEqual(minusFine.col, 0);
  assert.notStrictEqual(plusFine.col, exactFine.col); // 179.999… 属于右末列，180 属于首列
});

test('极点：±90 归入首/末行，不产生越界', () => {
  const north = Grid.assignOne(layout, 0, 10, 90);
  const south = Grid.assignOne(layout, 0, 10, -90);
  assert.strictEqual(north.row, Grid.countsAtLevel(layout, 0).latCount - 1);
  assert.strictEqual(south.row, 0);
});

test('越界与缺失坐标判定为非法', () => {
  assert.strictEqual(Grid.validateCoordinate(180.0001, 0).valid, false);
  assert.strictEqual(Grid.validateCoordinate(-180.0001, 0).valid, false);
  assert.strictEqual(Grid.validateCoordinate(0, 90.0001).valid, false);
  assert.strictEqual(Grid.validateCoordinate(null, 0).valid, false);
  assert.strictEqual(Grid.validateCoordinate(0, undefined).valid, false);
  assert.strictEqual(Grid.validateCoordinate(NaN, NaN).valid, false);
  assert.strictEqual(Grid.validateCoordinate(180, 90).valid, true);
  assert.strictEqual(Grid.validateCoordinate(-180, -90).valid, true);
  assert.strictEqual(Grid.assignOne(layout, 0, 200, 0), null);
});

test('浮点吸附：二进制误差不把格线点算偏', () => {
  // factor=3 level1 步长 40°，浮点上 3*40 != 120
  const exact = Grid.assignOne(layout3, 1, 120, 40);
  const near = Grid.assignOne(layout3, 1, 120 + 1e-12, 40 - 1e-12);
  assert.strictEqual(near.cellId, exact.cellId);
  const step = Grid.stepAtLevel(layout, 1).lonStep;
  assert.strictEqual(Grid.assignOne(layout, 1, step - 1e-13, 0).cellId,
    Grid.assignOne(layout, 1, step, 0).cellId);
});

test('父单元：factor 整除，逐层包含且无重叠', () => {
  const f3 = Grid.assignOne(layout3, 2, 100, 50);
  const p1 = Grid.parentCell(layout3, 2, f3.col, f3.row);
  const p0 = Grid.parentCell(layout3, 1, p1.col, p1.row);
  assert.strictEqual(p1.level, 1);
  assert.strictEqual(p0.level, 0);
  assert.strictEqual(Grid.parentCell(layout3, 0, 0, 0), null);
  // 同一父单元下 factor×factor 个子单元
  const parentId = p1.cellId;
  const children = new Set();
  for (let c = 0; c < Grid.countsAtLevel(layout3, 2).lonCount; c++) {
    for (let r = 0; r < Grid.countsAtLevel(layout3, 2).latCount; r++) {
      const p = Grid.parentCell(layout3, 2, c, r);
      if (p.cellId === parentId) children.add(Grid.cellKey(2, c, r));
    }
  }
  assert.strictEqual(children.size, 9);
});

test('时间分区：UTC 日，非法值进 __UNKNOWN__', () => {
  assert.strictEqual(Grid.timePartition('2026-11-10T23:59:00Z'), '2026-11-10');
  assert.strictEqual(Grid.timePartition('bad'), '__UNKNOWN__');
  assert.strictEqual(Grid.timePartition(null), '__UNKNOWN__');
  assert.strictEqual(Grid.timePartition(''), '__UNKNOWN__');
});

test('单元边界半开区间可反查', () => {
  const b = Grid.cellBounds(layout, 0, 0, 0);
  assert.deepStrictEqual(b, { lonMin: -180, lonMax: -90, latMin: -90, latMax: 0 });
  assert.strictEqual(Grid.cellBounds(layout, 0, 99, 0), null);
});

test('仓库：导入、重复幂等、隔离、修订撤回与三口径守恒', () => {
  const wh = new GridWarehouse();
  wh.createLayout({ versionId: 'v1', factor: 2, maxLevel: 2 });
  wh.importEvent({ event_id: 'a', lon: 0, lat: 0, timestamp: '2026-11-10T00:00:00Z' });
  wh.importEvent({ event_id: 'a', lon: 0, lat: 0, timestamp: '2026-11-10T00:00:00Z' }); // 完全重复
  wh.importEvent({ event_id: 'b', lon: 10, lat: 10, timestamp: '2026-11-10T01:00:00Z' });
  wh.importEvent({ event_id: 'bad', lon: 999, lat: 0 });
  assert.strictEqual(wh.counts().eventsTotal, 3);
  assert.strictEqual(wh.counts().active, 2);
  assert.strictEqual(wh.counts().quarantineOpen, 1);

  // 修订：a 迁到新坐标（选跨单元的位置，level2 步长 22.5°）
  const oldCell = Grid.assignOne(wh.getLayout('v1'), 2, 0, 0).cellId;
  wh.importEvent({ event_id: 'a', lon: 100, lat: 50, timestamp: '2026-11-11T00:00:00Z' });
  const newCell = Grid.assignOne(wh.getLayout('v1'), 2, 100, 50).cellId;
  assert.notStrictEqual(oldCell, newCell);
  const oldFact = wh.facts.get('v1').get(2).get(oldCell);
  assert.ok(!oldFact || !oldFact.eventIds.includes('a'));
  assert.deepStrictEqual(wh.facts.get('v1').get(2).get(newCell).eventIds, ['a']);
  assert.strictEqual(wh.events.get('a').revisions.length, 1);

  // 三口径逐单元一致
  for (let l = 0; l <= 2; l++) {
    const r = wh.reconcile('v1', l);
    assert.ok(r.allPass, `level ${l} 守恒失败: ${JSON.stringify(r.checks)}`);
  }
  // 分区过滤后仍守恒（2026-11-11：修订后的 a；b 在 2026-11-10）
  const r = wh.reconcile('v1', 2, { partition: '2026-11-11' });
  assert.ok(r.allPass);
  assert.strictEqual(r.checks[0].materialized, 1);
  // 2026-11-10：a 修订后已迁到 11 日，仅剩 b
  const r2 = wh.reconcile('v1', 2, { partition: '2026-11-10' });
  assert.ok(r2.allPass);
  assert.strictEqual(r2.checks[0].materialized, 1);
});

test('仓库：隔离恢复与转隔离，审计完整', () => {
  const wh = new GridWarehouse();
  wh.createLayout({ versionId: 'v1', factor: 2, maxLevel: 1 });
  wh.importEvent({ event_id: 'x', lon: 999, lat: 0 });
  assert.strictEqual(wh.counts().quarantineOpen, 1);
  wh.importEvent({ event_id: 'x', lon: 10, lat: 10 }); // 恢复
  assert.strictEqual(wh.counts().quarantineOpen, 0);
  assert.strictEqual(wh.counts().quarantineRecovered, 1);
  assert.strictEqual(wh.events.get('x').status, 'active');
  wh.importEvent({ event_id: 'x', lon: -999, lat: 10 }); // 再转隔离
  assert.strictEqual(wh.counts().quarantineOpen, 1);
  assert.strictEqual(wh.events.get('x').status, 'quarantined');
  const types = wh.audit.map((a) => a.type);
  assert.ok(types.includes('event.withdraw'));
  assert.ok(wh.reconcileAll().every((r) => r.allPass));
});

test('仓库：新版本回填且布局物理隔离', () => {
  const wh = new GridWarehouse();
  wh.createLayout({ versionId: 'v1', factor: 2, maxLevel: 1 });
  wh.importBatch([
    { event_id: 'a', lon: 1, lat: 1 }, { event_id: 'b', lon: 100, lat: -50 },
  ]);
  const { backfilled } = wh.createLayout({ versionId: 'v2', factor: 3, maxLevel: 1 });
  assert.strictEqual(backfilled, 2);
  const v1Ids = Array.from(wh.materializedCounts('v1', 0).keys());
  const v2Ids = Array.from(wh.materializedCounts('v2', 0).keys());
  assert.ok(v1Ids.every((id) => id.startsWith('v1/')));
  assert.ok(v2Ids.every((id) => id.startsWith('v2/')));
  assert.ok(v2Ids.every((id) => !v1Ids.includes(id)));
  assert.throws(() => wh.createLayout({ versionId: 'v1', factor: 4, maxLevel: 1 }), /已存在/);
  assert.ok(wh.reconcileAll().every((r) => r.allPass));
});

test('持久化：序列化/反序列化后账本一致', () => {
  const wh = new GridWarehouse();
  wh.createLayout({ versionId: 'v1', factor: 2, maxLevel: 2 });
  wh.importBatch([
    { event_id: 'a', lon: 0, lat: 0 },
    { event_id: 'b', lon: 180, lat: 90 },
    { event_id: 'c', lon: 200, lat: 0 },
  ]);
  const json = JSON.stringify(wh.toJSON());
  const restored = GridWarehouse.fromJSON(JSON.parse(json));
  assert.deepStrictEqual(
    Array.from(restored.materializedCounts('v1', 1).entries()).sort(),
    Array.from(wh.materializedCounts('v1', 1).entries()).sort(),
  );
  assert.strictEqual(restored.counts().quarantineOpen, 1);
  assert.ok(restored.reconcileAll().every((r) => r.allPass));
});
