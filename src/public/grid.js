'use strict';

/**
 * 等经纬网规则引擎（前后端共用，UMD）
 *
 * 规则总纲（详见 README「格网规则」一节）：
 * 1. 全球范围：经度 [-180, 180)，纬度 [-90, 90)；等经纬网，单元为经纬度矩形。
 * 2. 边界归属一律使用半开区间 [low, high)：本初子午线、任意格线、赤道上的点
 *    只计入右/上侧（编号更大）的单元，任何边界点都不可能落入两个单元。
 * 3. 日期变更线单独规定：经度 ±180° 归一到变更线西侧列，即
 *    lon = +180 视为 -180，归入最左列（列号 0），不产生右越界单元。
 * 4. 极点单独规定：lat = +90（北极点）归入最上行，lat = -90 归入最下行，
 *    不产生极外单元；除极点外的越界坐标不做夹紧，直接进隔离区。
 * 5. 层级：level 0 为最粗层（一次四等分/九等分），level 越大单元越密；
 *    每层按 factor（2 或 3）沿经、纬方向同时细分。
 *
 * 浮点处理：距任一格线不超过 EPS（相对步长 1e-9，约亚毫米级）的坐标按
 * 吸附到该格线处理，避免二进制浮点把规则上的边界点算偏。该容差远小于
 * 任何业务定位精度，仅修正表示误差，不改变规则语义。
 */

const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;
const EPS_REL = 1e-9;

/**
 * 定义一个数据版本对应的格网布局。
 * @param {object} spec
 * @param {string} spec.versionId     版本标识，如 "v1"
 * @param {number} spec.factor        细分因子（2=四叉，3=九分），正整数
 * @param {number} spec.maxLevel      最大层级（含），非负整数
 * @param {string} [spec.description] 版本说明（规则改版原因等）
 * @returns {object} 布局定义（纯数据，可序列化）
 */
function defineLayout({ versionId, factor, maxLevel, description = '' }) {
  if (!versionId || typeof versionId !== 'string') {
    throw new Error('versionId 必须是非空字符串');
  }
  if (!Number.isInteger(factor) || factor < 2) {
    throw new Error('factor 必须是 >= 2 的整数');
  }
  if (!Number.isInteger(maxLevel) || maxLevel < 0) {
    throw new Error('maxLevel 必须是 >= 0 的整数');
  }
  return {
    kind: 'equirectangular',
    versionId,
    factor,
    maxLevel,
    description,
    createdAt: new Date().toISOString(),
  };
}

/** 某一层级的经、纬方向单元数（各层都完整覆盖全球，无跨层残块）。 */
function countsAtLevel(layout, level) {
  assertLevel(layout, level);
  const n = Math.pow(layout.factor, level + 1); // level 0 => factor 个
  return { lonCount: n * 2, latCount: n }; // 经度跨度 360°，纬度跨度 180°
}

/** 某一层级的单元步长（度）。 */
function stepAtLevel(layout, level) {
  const { lonCount, latCount } = countsAtLevel(layout, level);
  return { lonStep: 360 / lonCount, latStep: 180 / latCount };
}

function assertLevel(layout, level) {
  if (!Number.isInteger(level) || level < 0 || level > layout.maxLevel) {
    throw new Error(`level 必须是 [0, ${layout.maxLevel}] 内的整数，收到 ${level}`);
  }
}

/**
 * 单轴半开区间编号。
 * 单元 k 覆盖 [min + k*step, min + (k+1)*step)。
 * 末端值 max 按「变更线/极点单独规定」夹紧到最后一个单元（k = count-1），
 * 不产生编号 count 的越界单元。
 */
function axisIndex(value, min, max, count) {
  const span = max - min;
  const step = span / count;
  const eps = step * EPS_REL;
  // 表示误差吸附：贴在格线左侧（含 min/max 端点）的浮点值先拉到格线上
  let k = Math.floor((value - min) / step + EPS_REL);
  if (k < 0) {
    if (value >= min - eps && value < min) k = 0;
    else return { index: null, outOfRange: true };
  }
  if (k >= count) {
    if (value <= max + eps) k = count - 1; // 末端规则：max 归入末单元
    else return { index: null, outOfRange: true };
  }
  return { index: k, outOfRange: false };
}

/**
 * 坐标有效性校验（与业务规则分离，隔离判定只看这一个函数）。
 * 合法域：lon ∈ [-180, +180]，lat ∈ [-90, +90]，且均为有限数。
 * 注意 +180 合法，由变更线规则归入最左列；+90 合法，由极点规则归入最上行。
 */
function validateCoordinate(lon, lat) {
  const reasons = [];
  if (typeof lon !== 'number' || !Number.isFinite(lon)) {
    reasons.push('经度缺失或不是有限数');
  } else if (lon < LON_MIN || lon > LON_MAX) {
    reasons.push(`经度 ${lon} 超出 [-180, 180]`);
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat)) {
    reasons.push('纬度缺失或不是有限数');
  } else if (lat < LAT_MIN || lat > LAT_MAX) {
    reasons.push(`纬度 ${lat} 超出 [-90, 90]`);
  }
  return { valid: reasons.length === 0, reasons };
}

/** 变更线归一：+180 视作 -180（仅在已通过合法性校验后调用）。 */
function normalizeLongitude(lon) {
  return lon === LON_MAX ? LON_MIN : lon;
}

/** 紧凑单元标识，如 L2:c12,r3（同版本内唯一；跨版本使用全限定 id）。 */
function cellKey(level, col, row) {
  return `L${level}:c${col},r${row}`;
}

/** 全限定单元标识，版本隔离，查询绝不混用不同布局。 */
function fullCellId(versionId, level, col, row) {
  return `${versionId}/${cellKey(level, col, row)}`;
}

/**
 * 把一个合法坐标分配到指定层级的唯一单元。
 * @returns {{level,col,row,key,cellId,bounds}} 或 null（坐标非法时）
 */
function assignOne(layout, level, lon, lat) {
  assertLevel(layout, level);
  const check = validateCoordinate(lon, lat);
  if (!check.valid) return null;

  const { lonCount, latCount } = countsAtLevel(layout, level);
  const lonN = normalizeLongitude(lon);
  const cx = axisIndex(lonN, LON_MIN, LON_MAX, lonCount);
  const cy = axisIndex(lat, LAT_MIN, LAT_MAX, latCount);
  if (cx.outOfRange || cy.outOfRange) return null; // 理论上 validate 已拦截，防御性保留

  const { lonStep, latStep } = stepAtLevel(layout, level);
  const col = cx.index;
  const row = cy.index;
  return {
    level,
    col,
    row,
    key: cellKey(level, col, row),
    cellId: fullCellId(layout.versionId, level, col, row),
    bounds: {
      lonMin: LON_MIN + col * lonStep,
      lonMax: LON_MIN + (col + 1) * lonStep,
      latMin: LAT_MIN + row * latStep,
      latMax: LAT_MIN + (row + 1) * latStep,
    },
  };
}

/**
 * 一次分配到全部层级（同一事件在每一层各落一个单元，用于多级入仓）。
 * 坐标非法时返回 null，由调用方写入隔离区。
 */
function assignAllLevels(layout, lon, lat) {
  const check = validateCoordinate(lon, lat);
  if (!check.valid) return { valid: false, reasons: check.reasons, cells: [] };
  const cells = [];
  for (let level = 0; level <= layout.maxLevel; level++) {
    cells.push(assignOne(layout, level, lon, lat));
  }
  return { valid: true, reasons: [], cells };
}

/**
 * 父单元（上一层中完整包含本单元的那个单元）。
 * 细分因子同时作用于经、纬方向，故 col/row 直接整除 factor。
 * level 0 无父单元，返回 null。
 */
function parentCell(layout, level, col, row) {
  assertLevel(layout, level);
  if (level === 0) return null;
  const f = layout.factor;
  return {
    level: level - 1,
    col: Math.floor(col / f),
    row: Math.floor(row / f),
    key: cellKey(level - 1, Math.floor(col / f), Math.floor(row / f)),
    cellId: fullCellId(layout.versionId, level - 1, Math.floor(col / f), Math.floor(row / f)),
  };
}

/** 单元的经纬度边界（半开区间；变更线西侧首列 lonMax 为 +180 表示闭到变更线）。 */
function cellBounds(layout, level, col, row) {
  assertLevel(layout, level);
  const { lonCount, latCount } = countsAtLevel(layout, level);
  const { lonStep, latStep } = stepAtLevel(layout, level);
  if (col < 0 || col >= lonCount || row < 0 || row >= latCount) return null;
  return {
    lonMin: LON_MIN + col * lonStep,
    lonMax: LON_MIN + (col + 1) * lonStep,
    latMin: LAT_MIN + row * latStep,
    latMax: LAT_MIN + (row + 1) * latStep,
  };
}

/**
 * 时间分区：按 UTC 自然日分区（YYYY-MM-DD）。
 * 时间缺失/非法时不隔离坐标本身，而是归入固定分区 "__UNKNOWN__"，
 * 保证事件总数守恒、可被单独审计。
 */
function timePartition(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '__UNKNOWN__';
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '__UNKNOWN__';
  return d.toISOString().slice(0, 10);
}

const api = {
  LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, EPS_REL,
  defineLayout,
  countsAtLevel,
  stepAtLevel,
  assertLevel,
  validateCoordinate,
  normalizeLongitude,
  axisIndex,
  cellKey,
  fullCellId,
  assignOne,
  assignAllLevels,
  parentCell,
  cellBounds,
  timePartition,
};

// UMD：Node 走 module.exports，浏览器 <script> 走全局 GridEngine
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof globalThis !== 'undefined') {
  globalThis.GridEngine = api;
}
