'use strict';

/**
 * 端到端守恒演示（不经过 HTTP，直接驱动仓库）：
 *   node scripts/demo.js
 * 退出码 0 = 全部断言通过。
 */

const assert = require('node:assert');
const { GridWarehouse } = require('../src/store');
const Grid = require('../src/grid');
const { INITIAL_LAYOUTS, INITIAL_EVENTS, REVISION_EVENTS, NEW_LAYOUT } = require('../src/scenario');

const line = (s = '') => console.log(s);
const h1 = (s) => line(`\n=== ${s} ===`);
const h2 = (s) => line(`\n--- ${s} ---`);
let failures = 0;
function check(name, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  line(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const wh = new GridWarehouse();

// ---------- 1. 建版本、导初始数据 ----------
h1('1. 建立 v1 布局并导入初始事件');
for (const spec of INITIAL_LAYOUTS) wh.createLayout(spec);
const layout = wh.getLayout('v1');
line(`  布局 ${layout.versionId}: factor=${layout.factor}, maxLevel=${layout.maxLevel}`);
for (let l = 0; l <= layout.maxLevel; l++) {
  const c = Grid.countsAtLevel(layout, l);
  line(`    level ${l}: ${c.lonCount} 列 × ${c.latCount} 行 = ${c.lonCount * c.latCount} 单元`);
}

const report = wh.importBatch(INITIAL_EVENTS);
line(`  导入报告: 新增=${report.imported} 重复/修订=${report.revised} 隔离=${report.quarantined} 批内重复id=${report.duplicates}`);
const c0 = wh.counts();
line(`  账本: 事件总数=${c0.eventsTotal} 有效=${c0.active} 开放隔离=${c0.quarantineOpen} 已恢复=${c0.quarantineRecovered}`);
check('15 条载荷（含 1 条批内重复 id）只产生 14 个事件', c0.eventsTotal === 14);
check('E001 重复上报不翻倍（有效事件 11 个：14 总事件 - 3 隔离）', c0.active === 11, `active=${c0.active}`);
check('3 条问题坐标进入隔离区且保持开放', c0.quarantineOpen === 3);

// ---------- 2. 边界点唯一性证明 ----------
h1('2. 边界归属证明（半开区间 + 变更线/极点单独规定）');
const boundaryCases = [
  ['E010', 0, 0], ['E011', 90, 45], ['E020', 180, 0], ['E021', -180, 0],
  ['E030', 0, 90], ['E031', -45, -90],
];
for (const [id, lon, lat] of boundaryCases) {
  const cells = Grid.assignAllLevels(layout, lon, lat).cells;
  const unique = new Set(cells.map((c) => c.cellId));
  const lvl0 = cells[0];
  line(`  ${id} (${lon}, ${lat}) -> level0 ${lvl0.key} 边界[lon ${lvl0.bounds.lonMin}, ${lvl0.bounds.lonMax}) [lat ${lvl0.bounds.latMin}, ${lvl0.bounds.latMax})`);
  check(`${id} 每层恰好落入 1 个单元（共 ${cells.length} 层、${unique.size} 个唯一单元）`, unique.size === cells.length);
}
const e020 = Grid.assignOne(layout, 0, 180, 0);
const e021 = Grid.assignOne(layout, 0, -180, 0);
check('+180 与 -180 归入同一最左列（变更线不产生两个单元）', e020.col === 0 && e021.col === 0 && e020.cellId === e021.cellId);
const pole = Grid.assignOne(layout, 0, 0, 90);
check('北极点归入最上行', pole.row === Grid.countsAtLevel(layout, 0).latCount - 1);
check('+180 不会落到编号越界的列', e020.col === 0);

// 浮点吸附：规则上的格线经二进制浮点运算后仍正确
const step1 = Grid.stepAtLevel(layout, 1).lonStep; // 45°
const snapped = Grid.assignOne(layout, 1, 45 - 1e-13, 0);
const exact = Grid.assignOne(layout, 1, 45, 0);
check('浮点表示误差吸附到格线（45°-1e-13 与 45° 同单元）', snapped.cellId === exact.cellId);

// ---------- 3. 三种口径 + 守恒核对 ----------
h1('3. 初始状态：三口径核对（物化 / 底层汇总 / 直接计算）');
for (let l = 0; l <= layout.maxLevel; l++) {
  const r = wh.reconcile('v1', l);
  line(`  level ${l}: ${r.checks.map((c) => (c.pass ? '✓' : '✗') + c.name).join(' | ')}`);
  check(`v1 level ${l} 四项守恒全部通过`, r.allPass);
}
const mat = wh.materializedCounts('v1', 1);
const rol = wh.rollupCounts('v1', 1);
const dir = wh.directCounts('v1', 1);
line(`  level 1 总量: 物化=${GridWarehouse._sum(mat)} 汇总=${GridWarehouse._sum(rol)} 直算=${GridWarehouse._sum(dir)}（应均为 ${c0.active}）`);
check('三种口径总量一致且等于有效事件数',
  GridWarehouse._sum(mat) === GridWarehouse._sum(rol) &&
  GridWarehouse._sum(rol) === GridWarehouse._sum(dir) &&
  GridWarehouse._sum(dir) === c0.active);

// 时间分区核对
const parts = wh.listPartitions('v1');
line(`  时间分区: ${parts.join(', ')}`);
check('非法时间戳进入 __UNKNOWN__ 分区且事件仍守恒', parts.includes('__UNKNOWN__'));
const rUnknown = wh.reconcile('v1', 2, { partition: '__UNKNOWN__' });
check('按 __UNKNOWN__ 分区核对通过（E043 计 1）', rUnknown.allPass && rUnknown.checks[0].materialized === 1);

// ---------- 4. 单元明细与下钻 ----------
h1('4. 单元明细与事件下钻');
const q = wh.queryCells('v1', 0);
line(`  level 0 共 ${q.cellCount} 个非空单元，事件合计 ${q.eventCount}`);
const top = q.cells[0];
line(`  最满单元 ${top.cellId} count=${top.count} 边界=${JSON.stringify(top.bounds)}`);
const drill = wh.queryEventsInCell('v1', top.level, top.col, top.row);
line(`  下钻事件: ${drill.events.map((e) => e.eventId).join(', ')}`);
check('下钻事件数与单元计数一致', drill.events.length === top.count);
check('下钻保留原始坐标', drill.events.every((e) => typeof e.lon === 'number' && e.raw));

// ---------- 5. 增量修订：先撤回后计入 ----------
h1('5. 增量修订批次（撤回 → 计入 / 隔离恢复 / 错误修订转隔离）');
const before = wh.counts();
const e002old = wh.events.get('E002');
const oldCell = Grid.assignOne(layout, layout.maxLevel, e002old.lon, e002old.lat).cellId;
const revReport = wh.importBatch(REVISION_EVENTS);
line(`  修订报告: 修订=${revReport.revised}（含转隔离） 新增=${revReport.imported}`);
const after = wh.counts();
line(`  账本变化: 有效 ${before.active} -> ${after.active}，开放隔离 ${before.quarantineOpen} -> ${after.quarantineOpen}，总数 ${before.eventsTotal} -> ${after.eventsTotal}`);
check('新增 1 个事件（E050），事件总数 +1', after.eventsTotal === before.eventsTotal + 1);
check('2 条隔离恢复 + 1 条转隔离：开放隔离 3 -> 2', after.quarantineOpen === 2);
check('有效事件 11 -> 13（恢复 2、转隔离 -1、新增 +1、净 +2）', after.active === before.active + 2);

const e002new = wh.events.get('E002');
const newCell = Grid.assignOne(layout, layout.maxLevel, e002new.lon, e002new.lat).cellId;
line(`  E002 迁移: ${oldCell} -> ${newCell}`);
check('E002 确实跨单元迁移', oldCell !== newCell);
const oldFact = wh.facts.get('v1').get(layout.maxLevel).get(oldCell);
const oldContains = oldFact ? oldFact.eventIds.includes('E002') : false;
const newFact = wh.facts.get('v1').get(layout.maxLevel).get(newCell);
check('旧单元已撤回 E002（无残留、无双计）', !oldContains);
check('新单元包含 E002 且仅一次', newFact.eventIds.filter((x) => x === 'E002').length === 1);
check('E002 保留修订历史（原始坐标未被覆盖）',
  e002new.revisions.length === 1 && e002new.revisions[0].from.lon === e002old.lon && e002new.lon !== e002old.lon);

const withdraws = wh.listAudit(50).filter((a) => a.type === 'event.withdraw');
check('每次修订都产生 withdraw 审计条目', withdraws.length >= 3);
const e010 = wh.events.get('E010');
check('E010 错误修订后状态为 quarantined 且不在任何事实表中',
  e010.status === 'quarantined' &&
  wh.directCounts('v1', 0).size === wh.materializedCounts('v1', 0).size);

h2('修订后再次全量守恒核对');
for (let l = 0; l <= layout.maxLevel; l++) {
  const r = wh.reconcile('v1', l);
  check(`v1 level ${l} 四项守恒全部通过`, r.allPass);
}

// ---------- 6. 规则改版：新版本，不混用布局 ----------
h1('6. 规则改版 v2（factor=3）：版本隔离与回填');
const { backfilled } = wh.createLayout(NEW_LAYOUT);
line(`  v2 创建并回填有效事件 ${backfilled} 个（v1 事实表不变）`);
check('v2 回填全部当前有效事件', backfilled === wh.counts().active);
const l2 = wh.getLayout('v2');
check('v2 层级结构与 v1 不同（证明布局独立）',
  Grid.countsAtLevel(l2, 0).lonCount === 6 && Grid.countsAtLevel(layout, 0).lonCount === 4);
for (const vid of ['v1', 'v2']) {
  const ly = wh.getLayout(vid);
  for (let l = 0; l <= ly.maxLevel; l++) {
    const r = wh.reconcile(vid, l);
    check(`${vid} level ${l} 守恒通过`, r.allPass);
  }
}
const v1sum = GridWarehouse._sum(wh.materializedCounts('v1', 0));
const v2sum = GridWarehouse._sum(wh.materializedCounts('v2', 0));
check('两版本同口径总量相同（同一批原始坐标），但单元 id 互不重叠',
  v1sum === v2sum &&
  !wh.materializedCounts('v1', 0).keys().some((k) => wh.materializedCounts('v2', 0).has(k)));
line(`  v1 level0 单元数=${wh.queryCells('v1', 0).cellCount}，v2 level0 单元数=${wh.queryCells('v2', 0).cellCount}`);

// ---------- 汇总 ----------
h1('汇总');
const all = wh.reconcileAll();
line(`  全版本逐层核对: ${all.length} 组，全部通过=${all.every((r) => r.allPass)}`);
line(`  审计日志 ${wh.audit.length} 条；隔离区 ${wh.quarantine.length} 条（开放 ${wh.counts().quarantineOpen} / 已恢复 ${wh.counts().quarantineRecovered}）`);
if (failures === 0) {
  line('\n所有守恒与边界断言通过 ✓');
  process.exit(0);
} else {
  line(`\n存在 ${failures} 个失败断言 ✗`);
  process.exit(1);
}
