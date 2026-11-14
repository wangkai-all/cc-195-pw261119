'use strict';

/**
 * 演示场景：固定数据集，覆盖规则要点。
 * 每个事件带 note，前端与 demo 脚本用它解释「这条数据在演示什么」。
 */

const INITIAL_LAYOUTS = [
  { versionId: 'v1', factor: 2, maxLevel: 3, description: '首版规则：四叉细分（factor=2），4 个层级' },
];

const INITIAL_EVENTS = [
  // —— 常规点 ——
  { event_id: 'E001', lon: 116.391, lat: 39.907, timestamp: '2026-11-10T01:23:00Z', note: '常规事件（北京附近）' },
  { event_id: 'E002', lon: -74.006, lat: 40.713, timestamp: '2026-11-10T14:05:00Z', note: '常规事件（纽约附近）' },
  { event_id: 'E003', lon: 116.40, lat: 39.91, timestamp: '2026-11-11T03:00:00Z', note: '常规事件，与 E001 相邻但不同单元' },

  // —— 边界点：半开区间归属 ——
  { event_id: 'E010', lon: 0, lat: 0, timestamp: '2026-11-10T00:00:00Z', note: '本初子午线×赤道交点，半开区间归入右上单元，只能落一个单元' },
  { event_id: 'E011', lon: 90, lat: 45, timestamp: '2026-11-11T08:30:00Z', note: 'level 0 格线交点（90°E,45°N），归入编号更大的单元' },
  { event_id: 'E012', lon: -90, lat: -45, timestamp: '2026-11-12T08:30:00Z', note: 'level 0 格线交点（90°W,45°S）' },

  // —— 日期变更线（单独规定）——
  { event_id: 'E020', lon: 180, lat: 0, timestamp: '2026-11-12T20:00:00Z', note: '变更线 +180：归一到最左列（与 -180 同列），不产生越界单元' },
  { event_id: 'E021', lon: -180, lat: 0, timestamp: '2026-11-12T20:01:00Z', note: '变更线 -180：最左列；与 E020 同单元，验证 180° 不重复入两格' },

  // —— 极点（单独规定）——
  { event_id: 'E030', lon: 0, lat: 90, timestamp: '2026-11-13T12:00:00Z', note: '北极点：归入最上行，不产生极外单元' },
  { event_id: 'E031', lon: -45, lat: -90, timestamp: '2026-11-13T12:01:00Z', note: '南极点：归入最下行' },

  // —— 隔离区：越界与缺失 ——
  { event_id: 'E040', lon: 200, lat: 10, timestamp: '2026-11-13T09:00:00Z', note: '经度越界（200 > 180）：进隔离区，不计入任何单元' },
  { event_id: 'E041', lon: 10, lat: 95, timestamp: '2026-11-13T09:05:00Z', note: '纬度越界（95 > 90）：进隔离区' },
  { event_id: 'E042', lon: null, lat: null, timestamp: '2026-11-13T09:10:00Z', note: '坐标缺失：进隔离区' },
  { event_id: 'E043', lon: 120, lat: 30, timestamp: 'not-a-timestamp', note: '坐标合法但时间非法：正常入格，时间分区为 __UNKNOWN__' },

  // —— 重复事件（同 event_id 再次上报 = 修订语义）——
  { event_id: 'E001', lon: 116.391, lat: 39.907, timestamp: '2026-11-10T01:23:00Z', note: 'E001 完全重复上报：幂等，计数不翻倍' },
];

/** 增量修订批次（演示「先撤回、后计入」与隔离恢复）。 */
const REVISION_EVENTS = [
  { event_id: 'E002', lon: -100, lat: 60, timestamp: '2026-11-14T10:00:00Z', note: 'E002 坐标修订：先从旧格网撤回，再计入新单元（明确跨格网迁移）' },
  { event_id: 'E003', lon: 116.40, lat: 39.92, timestamp: '2026-11-14T10:05:00Z', note: 'E003 微调纬度：跨单元迁移，旧单元减 1、新单元加 1' },
  { event_id: 'E040', lon: 175.5, lat: 10, timestamp: '2026-11-14T10:10:00Z', note: 'E040 越界坐标修订为合法：从隔离区恢复并入仓' },
  { event_id: 'E042', lon: 130, lat: -20, timestamp: '2026-11-14T10:15:00Z', note: 'E042 补全缺失坐标：从隔离区恢复' },
  { event_id: 'E010', lon: 500, lat: 0, timestamp: '2026-11-14T10:20:00Z', note: 'E010 被错误修订成越界值：撤回入格贡献并转入隔离区' },
  { event_id: 'E050', lon: 45, lat: -45, timestamp: '2026-11-14T11:00:00Z', note: '增量新事件' },
];

/** 规则改版：新数据版本（factor 3），与 v1 物理隔离、查询不混用。 */
const NEW_LAYOUT = {
  versionId: 'v2', factor: 3, maxLevel: 2,
  description: '规则改版：九分细分（factor=3），3 个层级；历史 v1 保持不变，查询按版本隔离',
};

module.exports = { INITIAL_LAYOUTS, INITIAL_EVENTS, REVISION_EVENTS, NEW_LAYOUT };
