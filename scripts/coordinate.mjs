#!/usr/bin/env node
/**
 * 麦友多人点餐协调员 — 协调编排主体
 *
 * 纯离线计算：不发网络请求、不直连 MCP。
 * 输入「发起人需求」+「MCP 真实返回快照」，输出订单方案 JSON + 结构化确认单。
 *
 * 所有来自麦当劳 MCP 的字段（storeCode / beCode / productCode / 价格 / 优惠）
 * 只能由模型从真实工具返回填入。哨兵值（形如 "__FILL_FROM_query-meals__"）
 * 会触发 MISSING_MCP_DATA 并指明该调哪个工具，绝不编造。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FEN = 100;

// ---------------------------------------------------------------- 基础工具

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(`无法读取或解析 JSON：${path}\n  ${e.message}`);
  }
}
function die(msg) {
  console.error(`\n[coordinate] 错误：${msg}\n`);
  process.exit(1);
}
const isSentinel = (v) => typeof v === 'string' && /^__.*__$/.test(v);
const missing = (v) => v === undefined || v === null || v === '' || isSentinel(v);
const yuan = (fen) => (Number(fen || 0) / FEN).toFixed(2);

// ---------------------------------------------------------------- 官方团餐搭配档位
// 来源：mcd-mcp `query-meals` 工具声明中「企业团餐场景下，可按照这个规则给用户进行搭配」

const TIERS = [
  { label: '20元以下', variants: [['小食']] },
  { label: '20-30元', variants: [['汉堡', '小食'], ['汉堡', '饮料']] },
  { label: '30-40元', variants: [['汉堡', '薯条', '饮料'], ['汉堡', '小食', '饮料']] },
  { label: '40-50元', variants: [['汉堡', '薯条', '小食', '饮料']] },
  { label: '50元以上', variants: [['汉堡', '薯条', '小食', '饮料', '甜品'], ['汉堡', '薯条', '小食', '饮料']] },
];
const tierIndexFor = (fen) => (fen < 2000 ? 0 : fen < 3000 ? 1 : fen < 4000 ? 2 : fen < 5000 ? 3 : 4);

const SLOT_MATCH = {
  汉堡: (m) => m.category === '汉堡' || /堡|卷|鸡腿|牛|鱼/.test(m.name || ''),
  薯条: (m) => m.category === '薯条' || /薯条|薯格/.test(m.name || ''),
  小食: (m) => m.category === '小食' || m.category === '甜品' || /鸡块|鸡翅|玉米|派|薯/.test(m.name || ''),
  饮料: (m) => m.category === '饮料' || /可乐|雪碧|橙汁|咖啡|奶昔|茶|水|汽水/.test(m.name || ''),
  甜品: (m) => m.category === '甜品' || /派|冰淇淋|甜筒|麦旋风|新地/.test(m.name || ''),
};
const slotMatches = (meal, slot) => (SLOT_MATCH[slot] || (() => false))(meal);

// 过敏 / 严重忌口关键词：只做风险提示，绝不声称安全
const RISK_KEYWORDS = ['过敏', '敏感', '花生', '坚果', '海鲜', '芒果', '乳制品', '牛奶', '麸质', '芝麻', '蛋', '严重'];
const DRINK_MODIFIERS = ['少冰', '去冰', '多冰', '常温', '热', '少糖', '无糖', '半糖', '不加糖'];

function hitsAvoid(meal, avoidList) {
  const hay = `${meal.name || ''} ${meal.desc || ''}`;
  return (avoidList || []).filter((a) => a && hay.includes(a));
}
function riskHitsIn(list, text) {
  return [...new Set(list.filter((k) => (text || '').includes(k)))];
}

// ---------------------------------------------------------------- 高危致敏原黑名单
// 原则：「宁可错杀，不可放过」。
// MCP 不返回成分表与致敏原清单，只能靠餐品名/描述做关键字匹配。
// 命中黑名单的餐品对该成员一律排除出候选，且**不因预算或偏好压力放宽**。
//
// member: 成员忌口/风险描述里命中即视为对该组致敏
// meal:   餐品名或描述里命中即视为含该组致敏原
// 两组都刻意写得比实际更宽，宁可多排除。

const ALLERGEN_GROUPS = [
  { id: 'peanut', label: '花生/坚果', member: ['花生', '坚果', '果仁'], meal: ['花生', '坚果', '果仁', '杏仁', '巴旦木', '腰果', '开心果', '榛子', '夏威夷果', '核桃'] },
  { id: 'seafood', label: '海鲜/鱼类', member: ['海鲜', '鱼', '虾', '蟹', '贝', '鱿'], meal: ['鱼', '虾', '蟹', '贝', '鱿', '海鲜', '鳕'] },
  { id: 'dairy', label: '乳制品', member: ['乳制品', '牛奶', '奶制品', '乳糖', '奶酪', '芝士', '黄油'], meal: ['奶', '芝士', '奶酪', '乳酪', '黄油', '冰淇淋', '新地', '麦旋风', '奶昔'] },
  { id: 'egg', label: '蛋类', member: ['鸡蛋', '蛋类', '蛋'], meal: ['蛋'] },
  { id: 'gluten', label: '麸质/小麦', member: ['麸质', '小麦', '面粉', '面筋'], meal: ['面包', '堡', '卷', '饼'] },
  { id: 'sesame', label: '芝麻', member: ['芝麻'], meal: ['芝麻'] },
  { id: 'soy', label: '大豆', member: ['大豆', '黄豆', '豆制品'], meal: ['豆浆', '豆腐'] },
  { id: 'mango', label: '芒果', member: ['芒果'], meal: ['芒果'] },
];

// 严格模式默认开启；只有在发起人显式声明 allergenPolicy.strict=false 时才降级为「仅提示」
const strictAllergen = () => request?.allergenPolicy?.strict !== false;

function allergenGroupsFor(member) {
  const text = [...(member.avoid || []), member.riskNote || ''].filter(Boolean).join(' ');
  return ALLERGEN_GROUPS.filter((g) => g.member.some((k) => text.includes(k)));
}
function allergenHitsFor(meal, groups) {
  const hay = `${meal.name || ''} ${meal.desc || ''}`;
  const hits = groups.filter((g) => g.meal.some((k) => hay.includes(k))).map((g) => g.label);
  return [...new Set(hits)];
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { pick: {}, render: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--render') out.render = true;
    else if (a === '--pick') {
      const v = argv[++i] || '';
      const idx = v.lastIndexOf('=');
      if (idx > 0) out.pick[v.slice(0, idx)] = Number(v.slice(idx + 1));
      else die(`--pick 格式应为「昵称=序号」，收到：${v}`);
    } else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.request) die('缺少 --request <group-request.json>');
if (!args.snapshot) die('缺少 --snapshot <mcd-snapshot.json>');

const request = readJson(args.request);
const snapshot = readJson(args.snapshot);
const conflicts = [];
const push = (code, level, message, hint) =>
  conflicts.push({ code, level, message, ...(hint ? { hint } : {}) });

// ---------------------------------------------------------------- 1. 就餐方式与参数配对

const DINING = {
  delivery: { beType: 2, orderType: 2, label: '外送·麦乐送', orderable: true },
  group_delivery: { beType: 6, orderType: 2, label: '外送·企业团餐', orderable: true },
  pickup: { beType: 1, orderType: 1, label: '到店自取', orderable: true },
  drive_thru: { beType: 5, orderType: 1, label: '得来速', orderable: true },
  dine_in: { beType: 1, orderType: 1, label: '堂食', orderable: false },
};

let diningMode = request.diningMode || 'group_delivery';
if (!DINING[diningMode]) die(`diningMode="${diningMode}" 非法，可选：${Object.keys(DINING).join(' / ')}`);

// 外送且人数较多时，默认走企业团餐（解锁满减与助餐服务）
if (diningMode === 'delivery') {
  const n = (request.members || []).length;
  if (missing(snapshot.store?.beType) ? n >= 3 : Number(snapshot.store.beType) === 6) {
    diningMode = 'group_delivery';
  }
}

const spec = DINING[diningMode];
const store = snapshot.store || {};
const beType = Number(store.beType ?? spec.beType);
const orderType = Number(store.orderType ?? spec.orderType);
const orderable = spec.orderable;

if (!orderable) {
  push('DINE_IN_NOT_ORDERABLE', 'block', `就餐方式为「${spec.label}」，MCP 无堂食下单能力，本 Skill 只出清单，不创建订单`, '如需下单请改为到店自取或外送');
}

const needsBeCode = beType === 5 || beType === 2 || beType === 6;
if (needsBeCode && missing(store.beCode)) {
  push('STORE_PARAM_MISMATCH', 'block', `beType=${beType} 必须提供 beCode`, '调 delivery-query-stores（外送/团餐）或 query-nearby-stores（得来速）');
}
if (beType === 1 && !missing(store.beCode)) {
  push('STORE_PARAM_MISMATCH', 'block', 'beType=1（到店自取）不能传 beCode，传了会报错', '去掉 beCode');
}
const expectedOrderType = beType === 1 || beType === 5 ? 1 : 2;
if (orderType !== expectedOrderType) {
  push('STORE_PARAM_MISMATCH', 'block', `beType=${beType} 对应 orderType 应为 ${expectedOrderType}，当前为 ${orderType}`, '按参数推导表修正');
}
if (missing(store.storeCode)) {
  push('MISSING_MCP_DATA', 'block', '缺少 storeCode', '调 delivery-query-stores 或 query-nearby-stores');
} else if (!/^\d+$/.test(String(store.storeCode))) {
  push('STORE_PARAM_MISMATCH', 'block', `storeCode=${store.storeCode} 非全数字`, '门店编码必须全部由数字组成');
}

// 时间
if (!missing(request.reservationDate)) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(request.reservationDate)) {
    push('TIME_CONFLICT', 'block', `reservationDate 格式应为 yyyy-MM-dd HH:mm，当前为「${request.reservationDate}」`);
  } else if (snapshot.nowTime && !missing(snapshot.nowTime.date)) {
    const now = new Date(snapshot.nowTime.datetime || snapshot.nowTime.date);
    const want = new Date(request.reservationDate.replace(' ', 'T'));
    if (!Number.isNaN(now.getTime()) && want.getTime() < now.getTime()) {
      push('TIME_CONFLICT', 'block', `预约时间 ${request.reservationDate} 早于当前时间`, '调 now-time-info 校正');
    }
  }
}

// ---------------------------------------------------------------- 2. 成员与预算

const membersRaw = Array.isArray(request.members) ? request.members : [];
if (!membersRaw.length) die('request.members 为空，至少需要 1 位成员');
const headcount = Number(request.headcount || membersRaw.length);
if (headcount !== membersRaw.length) {
  push('HEADCOUNT_MISMATCH', 'warn', `headcount=${headcount} 与 members 数量 ${membersRaw.length} 不一致，按 members 数量计算`);
}

const totalBudgetFen = missing(request.totalBudget) ? null : Math.round(Number(request.totalBudget) * FEN);
if (totalBudgetFen === null) {
  push('NO_BUDGET', 'warn', '未设置总预算，无法做超限校验，档位按 30-40 元默认档', '建议向发起人确认总预算');
}
const perPersonFen = totalBudgetFen === null ? 3500 : Math.round(totalBudgetFen / membersRaw.length);
const baseTierIdx = tierIndexFor(perPersonFen);

// 解析成员：区分「已确认」与「待本人确认」
function parseMember(m) {
  const drink = m.drink || '';
  const modifiers = DRINK_MODIFIERS.filter((x) => drink.includes(x));
  const drinkBase = DRINK_MODIFIERS.reduce((s, x) => s.split(x).join(''), drink).trim();

  const prefer = (m.prefer || []).filter((p) => p && p !== '随意');
  const isRandom = Boolean(m.random) || (m.prefer || []).some((p) => p === '随意') ||
    (!prefer.length && !drinkBase && !(m.avoid || []).length && !m.drinkOnly);

  const avoid = m.avoid || [];
  const riskKeys = riskHitsIn(RISK_KEYWORDS, [...avoid, m.riskNote || ''].join(' '));
  // 命中高危致敏原组（即便没写"过敏"二字）也按过敏对待，触发黑名单与风险提示
  const allergenGroups = allergenGroupsFor({ avoid, riskNote: m.riskNote });
  const isAllergy = Boolean(m.allergy) || riskKeys.length > 0 || allergenGroups.length > 0;

  return {
    name: m.name,
    avoid,
    prefer,
    drinkRaw: drink,
    drinkBase,
    drinkModifiers: modifiers,
    drinkOnly: Boolean(m.drinkOnly),
    random: isRandom,
    allergy: isAllergy,
    allergenGroups,
    riskKeys,
    riskNote: m.riskNote || null,
    budgetCapFen: missing(m.budgetCap) ? null : Math.round(Number(m.budgetCap) * FEN),
    status: isRandom ? 'pending' : 'confirmed',
  };
}

const members = membersRaw.map(parseMember);

// 群体主流口味：给「随意」成员兜底匹配
const mainstream = (() => {
  const counter = new Map();
  for (const m of members) {
    if (m.random) continue;
    for (const p of [...m.prefer, m.drinkBase].filter(Boolean)) counter.set(p, (counter.get(p) || 0) + 1);
  }
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
})();

for (const m of members) {
  if (m.random && mainstream) {
    m.inferredPrefer = [mainstream];
    m.note = '随意成员，已按群体主流口味匹配';
  } else {
    m.inferredPrefer = [];
  }
}

// 过敏 / 严重忌口：醒目风险提示
for (const m of members) {
  if (!m.allergy) continue;
  push(
    'RISK_NOTICE',
    'warn',
    `⚠️ ${m.name} 标注「${[...new Set([...m.avoid, ...m.riskKeys])].filter(Boolean).join('、')}」——本 Skill 无法确认餐品成分与交叉污染情况，不声称对过敏人群绝对安全`,
    '请发起人自行核对官方餐品信息后再确认'
  );
}

// ---------------------------------------------------------------- 3. 菜单快照

const meals = Array.isArray(snapshot.meals) ? snapshot.meals : [];
if (!meals.length) {
  push('MISSING_MCP_DATA', 'block', 'snapshot.meals 为空', '调 query-meals(storeCode, orderType, beType, beCode)');
} else {
  const bad = meals.filter((m) => missing(m.code) || missing(m.name) || missing(m.priceFen));
  if (bad.length) {
    push('MISSING_MCP_DATA', 'block', `snapshot.meals 中有 ${bad.length} 条缺少 code/name/priceFen`, '用 query-meals 的真实返回补齐，不要手写价格');
  }
}
const usable = (m) => !missing(m.code) && !missing(m.name) && !missing(m.priceFen);
for (const m of meals.filter((x) => x.soldOut)) {
  push('SOLD_OUT', 'warn', `餐品「${m.name}」在快照中标记为售罄/不可售，已排除出候选`, '如需替代，调 query-meals 看在售列表');
}

// 3.5 高危致敏原黑名单：按成员计算被排除的餐品
const strict = strictAllergen();
for (const m of members) {
  const groups = m.allergenGroups || [];
  if (!groups.length) {
    m.allergenBlocked = [];
    m.allergenBlockedCodes = new Set();
    continue;
  }
  const blocked = meals
    .filter(usable)
    .map((x) => ({ meal: x, hits: allergenHitsFor(x, groups) }))
    .filter((x) => x.hits.length);
  m.allergenBlocked = blocked.map((b) => ({
    code: b.meal.code,
    name: b.meal.name,
    groups: b.hits,
  }));
  m.allergenBlockedCodes = new Set(strict ? m.allergenBlocked.map((b) => b.code) : []);
  if (m.allergenBlocked.length) {
    const names = m.allergenBlocked.map((b) => b.name).join('、');
    push(
      'ALLERGEN_BLOCKED',
      strict ? 'warn' : 'warn',
      `${m.name}：${strict ? '已排除' : '建议避开'} ${m.allergenBlocked.length} 件餐品（致敏原组：${groups.map((g) => g.label).join('、')}）—— ${names}`,
      strict
        ? '关键字匹配为保守排除，不代表剩余餐品绝对安全；请自行核对官方成分信息'
        : '当前为非严格模式（allergenPolicy.strict=false），仅作提示未强制排除'
    );
  }
}

// ---------------------------------------------------------------- 4. 候选生成

function buildCandidates(member, tierIdx) {
  const tier = TIERS[tierIdx];
  const avoid = member.avoid || [];
  const prefer = [...(member.prefer || []), ...(member.inferredPrefer || []), member.drinkBase].filter(Boolean);
  const cap = member.budgetCapFen;

  const blocked = member.allergenBlockedCodes || new Set();
  const pool = (slot) =>
    meals
      .filter(usable)
      .filter((m) => slotMatches(m, slot))
      .filter((m) => !m.soldOut)
      .filter((m) => !blocked.has(m.code)) // 致敏原黑名单优先于一切，不可被预算/偏好放宽
      .map((m) => ({ meal: m, score: prefer.filter((p) => `${m.name}${m.desc || ''}`.includes(p)).length, avoidHits: hitsAvoid(m, avoid) }))
      .sort((a, b) => a.avoidHits.length - b.avoidHits.length || b.score - a.score || a.meal.priceFen - b.meal.priceFen);

  const variants = member.drinkOnly ? [['饮料']] : tier.variants;
  const combos = [];

  for (const variant of variants) {
    const pools = variant.map(pool);
    if (pools.some((p) => !p.length)) continue;
    for (let round = 0; round < 3; round++) {
      const chosen = [];

      for (let s = 0; s < pools.length; s++) {
        const start = s === 0 ? round : Math.min(round, pools[s].length - 1);
        // 同一组合内不重复选同一餐品（「别点重复」）；顺位往后找第一个未选中的
        let item = null;
        for (let k = start; k < pools[s].length; k++) {
          if (!chosen.some((c) => c.code === pools[s][k].meal.code)) { item = pools[s][k]; break; }
        }
        // 辅槽位取不到可去重项时，宁可少一件也不重复点同一份
        if (!item && s > 0) continue;
        // 主槽位（主食）取不到 → 该组合作废，绝不产出「没有主食、只靠低价胜出」的搭配
        if (!item) { chosen.length = 0; break; }
        chosen.push(item.meal);
      }
      if (!chosen.length) continue;
      const key = chosen.map((m) => m.code).join('|');
      if (combos.some((c) => c.key === key)) continue;
      const priceFen = chosen.reduce((s, m) => s + Number(m.priceFen), 0);
      const avoidHits = [...new Set(chosen.flatMap((m) => hitsAvoid(m, avoid)))];
      const riskHits = [...new Set(chosen.flatMap((m) => riskHitsIn(RISK_KEYWORDS, `${m.name} ${m.desc || ''}`)))];
      const score = chosen.reduce((s, m) => s + prefer.filter((p) => `${m.name}${m.desc || ''}`.includes(p)).length, 0);
      combos.push({
        key, items: chosen, priceFen, score, avoidHits, riskHits,
        overCap: cap !== null && priceFen > cap ? 1 : 0,
      });
    }
  }

  combos.sort(
    (a, b) =>
      a.overCap - b.overCap ||
      a.avoidHits.length - b.avoidHits.length ||
      b.score - a.score ||
      b.items.length - a.items.length ||
      a.priceFen - b.priceFen
  );
  return combos.slice(0, 3);
}

const candidateSets = members.map((m) => ({
  member: m,
  preferred: buildCandidates(m, baseTierIdx),
  safer: buildCandidates(m, Math.max(0, baseTierIdx - 1)),
  richer: buildCandidates(m, Math.min(TIERS.length - 1, baseTierIdx + 1)),
}));

// ---------------------------------------------------------------- 5. 共享小食与餐具

const sharedCfg = request.shared || { enabled: false };
const needTableware = Boolean(request.needTableware);
const sharedBudgetFen = sharedCfg.enabled ? Math.round(Number(sharedCfg.budgetYuan || 0) * FEN) : 0;

// 共享餐品人人都会吃到 → 取所有成员黑名单的并集
const sharedBlockedCodes = new Set(members.flatMap((m) => [...(m.allergenBlockedCodes || [])]));

function pickShared(fen) {
  if (fen <= 0) return [];
  const pool = meals
    .filter(usable)
    .filter((m) => !m.soldOut)
    .filter((m) => m.category === '小食' || m.category === '薯条')
    .filter((m) => !sharedBlockedCodes.has(m.code))
    .sort((a, b) => a.priceFen - b.priceFen);
  const out = [];
  let sum = 0;
  for (const m of pool) {
    if (sum + Number(m.priceFen) > fen || out.length >= 4) break;
    const found = out.find((x) => x.code === m.code);
    if (found) found.quantity += 1;
    else out.push({ code: m.code, name: m.name, priceFen: Number(m.priceFen), priceYuan: Number(yuan(m.priceFen)), quantity: 1 });
    sum += Number(m.priceFen);
  }
  return out;
}

const sharedPreferred = pickShared(sharedBudgetFen);
const sharedSafer = pickShared(Math.round(sharedBudgetFen * 0.5));
const sharedRicher = pickShared(Math.round(sharedBudgetFen * 1.5));
const sharedFen = (list) => list.reduce((s, x) => s + x.priceFen * x.quantity, 0);
const sharedPerHead = Math.round(sharedFen(sharedPreferred) / members.length);

// ---------------------------------------------------------------- 6. 三方案

function buildVariant(label, key, sharedList, pickMode) {
  const perMember = candidateSets.map((cs) => {
    const list = cs[key];
    let idx = 0;
    if (pickMode === 'safer') {
      const safe = list.findIndex((c) => c.avoidHits.length === 0 && c.riskHits.length === 0);
      idx = safe >= 0 ? safe : 0;
    } else if (pickMode === 'richer') {
      const rich = list.findIndex((c) => c.items.length === Math.max(...list.map((x) => x.items.length)) && c.overCap === 0);
      idx = rich >= 0 ? rich : 0;
    } else {
      idx = args.pick[cs.member.name] ?? 0;
    }
    const chosen = list[idx] || list[0] || null;
    return { member: cs.member, chosen };
  });

  if (pickMode === 'preferred') {
    for (const { member, chosen } of perMember) {
      if (!chosen) {
        const g = (member.allergenGroups || []).map((x) => x.label).join('、');
        push(
          'NO_CANDIDATE',
          'block',
          `成员「${member.name}」在当前菜单快照下没有可用候选${g ? `（已按致敏原黑名单排除 ${member.allergenBlocked?.length || 0} 件：${g}）` : ''}`,
          g
            ? '不要为凑单放宽致敏原黑名单；改为调整门店/就餐方式，或由该成员自行在官方渠道确认成分后单独点单'
            : '调 query-meals 确认该门店在售餐品'
        );
        continue;
      }
      if (chosen.avoidHits.length) {
        push('AVOID_CONFLICT', 'block', `成员「${member.name}」忌口 ${chosen.avoidHits.join('、')} 命中候选「${chosen.items.map((i) => i.name).join('+')}」`, '换候选，或用 query-meal-detail 的特调项去掉');
      }
      if (member.budgetCapFen !== null && chosen.priceFen > member.budgetCapFen) {
        push('PER_PERSON_OVER_CAP', 'block', `成员「${member.name}」候选 ¥${yuan(chosen.priceFen)} 超个人预算 ¥${yuan(member.budgetCapFen)}`, '降档或换候选');
      }
      // 纵深防御：即便候选池已过滤，仍复核一次致敏原
      const leaks = [...new Set(chosen.items.flatMap((i) => allergenHitsFor(i, member.allergenGroups || [])))];
      if (leaks.length) {
        push('AVOID_CONFLICT', 'block', `成员「${member.name}」的候选命中致敏原黑名单（${leaks.join('、')}），已拦截`, '这是纵深防御告警，说明黑名单未完全生效，必须换候选后再试算');
      }
    }
  }

  const goodsFen = perMember.reduce((s, p) => s + (p.chosen?.priceFen || 0), 0) + sharedFen(sharedList);
  return {
    label,
    shared: sharedList,
    sharedYuan: Number(yuan(sharedFen(sharedList))),
    goodsFen,
    goodsYuan: Number(yuan(goodsFen)),
    members: perMember.map(({ member, chosen }) => ({
      name: member.name,
      status: member.status,
      items: chosen ? chosen.items.map((i) => ({ code: i.code, name: i.name, priceYuan: Number(yuan(i.priceFen)) })) : [],
      priceYuan: chosen ? Number(yuan(chosen.priceFen)) : null,
      remarks: [member.drinkRaw, member.note].filter(Boolean).join('；') || null,
      avoid: member.avoid,
      allergy: member.allergy,
      allergen: (member.allergenGroups || []).length
        ? {
            groups: member.allergenGroups.map((g) => g.label),
            blockedCount: (member.allergenBlocked || []).length,
            blockedMeals: (member.allergenBlocked || []).map((b) => ({ name: b.name, groups: b.groups })),
          }
        : null,
    })),
  };
}

const variants = {
  preferred: buildVariant('首选方案', 'preferred', sharedPreferred, 'preferred'),
  safer: buildVariant('更稳妥', 'safer', sharedSafer, 'safer'),
  richer: buildVariant('更丰富', 'richer', sharedRicher, 'richer'),
};
const plan0 = variants.preferred;

// ---------------------------------------------------------------- 7. 优惠券

const coupons = Array.isArray(snapshot.coupons) ? snapshot.coupons : [];
let appliedCoupon = null;

for (const c of coupons) {
  if (c.applicable === false) {
    push('COUPON_NOT_APPLICABLE', 'warn', `优惠券「${c.name || c.couponId}」当前不可用（未满足使用条件），不默认套用`, '去掉该券后重新计算');
  }
}
const applicable = coupons.filter((c) => c.applicable !== false);
if (applicable.length && request.useCoupons === false) {
  // 发起人明确不用券
} else if (applicable.length) {
  const subtotal = plan0.goodsFen;
  const usableCoupons = applicable.filter((c) => missing(c.thresholdFen) || subtotal >= Number(c.thresholdFen));
  for (const c of applicable.filter((c) => !usableCoupons.includes(c))) {
    push('COUPON_NOT_APPLICABLE', 'warn', `优惠券「${c.name || c.couponId}」未达门槛（需 ¥${yuan(c.thresholdFen)}，当前商品 ¥${yuan(subtotal)}），不套用`, '增加商品或换券后重新计算');
  }
  if (usableCoupons.length) {
    appliedCoupon = usableCoupons.sort((a, b) => Number(b.offFen || 0) - Number(a.offFen || 0))[0];
  }
}

if (snapshot.suggestClaimCoupons && request.couponConsent !== true) {
  push('COUPON_CONSENT_REQUIRED', 'warn', '存在建议领取的优惠券，但尚未取得发起人明确同意', '必须先取得明确同意才可建议/执行领券；本 Skill 绝不自动领券');
}

// ---------------------------------------------------------------- 8. 金额

const pr = snapshot.priceResult;
let priceSource, subtotalFen, discountFen, deliveryFen, tablewareFen, totalFen;

if (pr && !missing(pr.totalFen)) {
  priceSource = 'calculate-price';
  subtotalFen = Number(pr.subtotalFen ?? plan0.goodsFen);
  discountFen = Number(pr.discountFen ?? 0);
  deliveryFen = Number(pr.deliveryFen ?? 0);
  tablewareFen = Number(pr.tablewareFen ?? 0);
  totalFen = Number(pr.totalFen);
} else {
  priceSource = 'ESTIMATE';
  subtotalFen = plan0.goodsFen;
  discountFen = appliedCoupon ? Number(appliedCoupon.offFen || 0) : 0;
  deliveryFen = Number(snapshot.fees?.deliveryFen ?? 0);
  tablewareFen = needTableware ? Number(snapshot.fees?.tablewareFen ?? 0) : 0;
  totalFen = subtotalFen - discountFen + deliveryFen + tablewareFen;
}

if (totalBudgetFen !== null && totalFen > totalBudgetFen) {
  push('BUDGET_EXCEEDED', 'block', `合计 ¥${yuan(totalFen)} 超总预算 ¥${yuan(totalBudgetFen)}（超出 ¥${yuan(totalFen - totalBudgetFen)}）`, '改用「更稳妥」方案，或减少共享小食');
}
if (priceSource === 'ESTIMATE') {
  push('PRICE_NOT_AUTHORITATIVE', 'warn', '当前金额为按餐品单价估算，不是 calculate-price 的真实结果', '下单前必须调 calculate-price 并用其返回覆盖 snapshot.priceResult');
}

// ---------------------------------------------------------------- 9. AA 分账

const weights = plan0.members.map((m, i) => (candidateSets[i].preferred[args.pick[m.name] ?? 0]?.priceFen || 0) + sharedPerHead);
const allocation = allocate(totalFen, weights);

function allocate(total, ws) {
  const sum = ws.reduce((s, w) => s + w, 0);
  if (sum === 0) return ws.map(() => Math.round(total / (ws.length || 1)));
  const raw = ws.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let rest = total - floored.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k++, rest--) floored[order[k % floored.length].i] += 1;
  return floored;
}
if (allocation.reduce((s, v) => s + v, 0) !== totalFen) {
  push('ALLOCATION_DRIFT', 'warn', '分账合计与总价不一致');
}

// ---------------------------------------------------------------- 10. 下单草稿与确认门

const items = [];
for (const m of plan0.members) {
  for (const it of m.items) {
    const found = items.find((x) => x.productCode === it.code);
    if (found) found.quantity += 1;
    else items.push({ productCode: it.code, quantity: 1 });
  }
}
for (const s of sharedPreferred) {
  const found = items.find((x) => x.productCode === s.code);
  if (found) found.quantity += s.quantity;
  else items.push({ productCode: s.code, quantity: s.quantity });
}

const createOrderDraft = orderable
  ? {
      storeCode: store.storeCode ?? null,
      beType,
      orderType,
      ...(needsBeCode ? { beCode: store.beCode ?? null } : {}),
      ...(orderType === 1 ? { takeWayCode: snapshot.takeWayCode ?? null } : {}),
      ...(orderType === 2 ? { addressId: snapshot.addressId ?? null } : {}),
      ...(beType === 6 ? { gmServiceCode: snapshot.gmServiceCode ?? null } : {}),
      ...(missing(request.reservationDate) ? {} : { reservationDate: request.reservationDate }),
      needTableware,
      items: items.map(({ productCode, quantity }) => ({ productCode, quantity })),
      ...(appliedCoupon ? { _couponHint: { couponId: appliedCoupon.couponId ?? null, couponCode: appliedCoupon.couponCode ?? null } } : {}),
    }
  : null;

const blocking = conflicts.filter((c) => c.level === 'block');
const saidConfirm = Boolean(request.confirmation?.saidConfirmOrder);
const readyToOrder = orderable && blocking.length === 0 && priceSource === 'calculate-price';
const mayCreateOrder = readyToOrder && saidConfirm;

const plan = {
  generatedAt: new Date().toISOString(),
  scene: request.scene ?? null,
  diningMode,
  diningLabel: spec.label,
  orderable,
  tier: TIERS[baseTierIdx].label,
  perPersonBudgetYuan: Number(yuan(perPersonFen)),
  mainstreamFlavor: mainstream,
  store: {
    name: store.name ?? null,
    storeCode: store.storeCode ?? null,
    beCode: needsBeCode ? store.beCode ?? null : null,
    beType,
    orderType,
  },
  priceSource,
  allergenPolicy: { strict, groups: ALLERGEN_GROUPS.map((g) => ({ id: g.id, label: g.label })) },
  needTableware,
  tablewareYuan: Number(yuan(tablewareFen)),
  shared: { enabled: sharedCfg.enabled, items: sharedPreferred, totalYuan: Number(yuan(sharedFen(sharedPreferred))), perHeadYuan: Number(yuan(sharedPerHead)) },
  coupon: appliedCoupon
    ? { couponId: appliedCoupon.couponId ?? null, couponCode: appliedCoupon.couponCode ?? null, name: appliedCoupon.name ?? null, offYuan: Number(yuan(discountFen)) }
    : null,
  money: {
    subtotalYuan: Number(yuan(subtotalFen)),
    discountYuan: Number(yuan(discountFen)),
    deliveryYuan: Number(yuan(deliveryFen)),
    tablewareYuan: Number(yuan(tablewareFen)),
    totalYuan: Number(yuan(totalFen)),
    perPersonYuan: Number(yuan(Math.round(totalFen / members.length))),
  },
  members: plan0.members.map((m, i) => ({ ...m, splitYuan: Number(yuan(allocation[i])) })),
  variants: {
    preferred: { ...variants.preferred, members: variants.preferred.members.map((m) => ({ name: m.name, items: m.items, priceYuan: m.priceYuan })) },
    safer: { ...variants.safer, members: variants.safer.members.map((m) => ({ name: m.name, items: m.items, priceYuan: m.priceYuan })) },
    richer: { ...variants.richer, members: variants.richer.members.map((m) => ({ name: m.name, items: m.items, priceYuan: m.priceYuan })) },
  },
  conflicts,
  readyToOrder,
  mayCreateOrder,
  requiresHumanConfirmation: true,
  createOrderDraft,
};

// ---------------------------------------------------------------- 11. 输出

if (args.out) {
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), JSON.stringify(plan, null, 2), 'utf8');
  console.log(`[coordinate] 方案已写入 ${args.out}`);
}
if (args.render || !args.out) render(plan);

function render(p) {
  const L = [];
  const m2 = (v) => Number(v || 0).toFixed(2);
  L.push('');
  L.push(`# 点餐确认单 · ${p.scene ?? '未命名场景'}`);
  L.push('');
  L.push('## 一、门店与就餐方式');
  L.push('');
  L.push(`- ${p.store.name ?? '（待填）'} · storeCode=${p.store.storeCode ?? '待填'} · beCode=${p.store.beCode ?? '本场景无'}`);
  L.push(`- 就餐方式：${p.diningLabel}（beType=${p.store.beType} / orderType=${p.store.orderType}）${p.orderable ? '' : ' · **不支持下单，仅出清单**'}`);
  if (!missing(request.reservationDate)) L.push(`- 期望时间：${request.reservationDate}`);
  L.push('');
  L.push('## 二、每人餐品');
  L.push('');
  L.push('| 成员 | 餐品 | 备注 | 状态 | 金额 | 分摊 |');
  L.push('|---|---|---|---|---|---|');
  for (const m of p.members) {
    const line = m.items.length ? m.items.map((i) => i.name).join(' + ') : '（无可用候选）';
    const price = m.priceYuan === null ? '—' : `¥${m2(m.priceYuan)}`;
    L.push(`| ${m.name} | ${line} | ${m.remarks ?? '—'} | ${m.status === 'confirmed' ? '已确认' : '待本人确认'} | ${price} | ¥${m2(m.splitYuan)} |`);
  }
  L.push('');
  L.push('## 三、共享餐品与餐具');
  L.push('');
  if (p.shared.enabled && p.shared.items.length) {
    for (const s of p.shared.items) L.push(`- ${s.name} ×${s.quantity}　¥${m2(s.priceYuan * s.quantity)}`);
    L.push(`- 共享合计 ¥${m2(p.shared.totalYuan)}，人均 ¥${m2(p.shared.perHeadYuan)}`);
  } else {
    L.push('- 无共享餐品');
  }
  L.push(`- 餐具：${p.needTableware ? '需要' : '不需要'}（¥${m2(p.tablewareYuan)}）`);
  L.push('');
  L.push('## 四、忌口及风险提示');
  L.push('');
  const risks = p.conflicts.filter((c) => c.code === 'RISK_NOTICE');
  const blocks = p.conflicts.filter((c) => c.code === 'ALLERGEN_BLOCKED');
  const avoids = p.members.filter((m) => m.avoid.length);
  if (!risks.length && !avoids.length && !blocks.length) L.push('- 无');
  for (const m of avoids) L.push(`- ${m.name}：${m.avoid.join('、')}`);
  for (const c of blocks) L.push(`- 🛑 ${c.message}`);
  for (const c of risks) L.push(`- ${c.message}`);
  if (risks.length || blocks.length) {
    L.push(`- 致敏原黑名单模式：**${p.allergenPolicy?.strict ? '严格（命中即排除）' : '宽松（仅提示）'}**，共 ${p.allergenPolicy?.groups?.length ?? 0} 组高危致敏原`);
    L.push('- 本 Skill 不声称任何餐品对过敏人群绝对安全，请自行核对官方餐品信息。');
  }
  L.push('');
  L.push('## 五、优惠券与价格明细');
  L.push('');
  L.push(`- 商品金额　　¥${m2(p.money.subtotalYuan)}`);
  L.push(`- 优惠　　　　-¥${m2(p.money.discountYuan)}${p.coupon ? `（${p.coupon.name ?? p.coupon.couponId ?? '适用券'}）` : ''}`);
  L.push(`- 配送费　　　¥${m2(p.money.deliveryYuan)}`);
  L.push(`- 餐具费　　　¥${m2(p.money.tablewareYuan)}`);
  L.push(`- **应付总价　¥${m2(p.money.totalYuan)}**`);
  L.push(`- 人均　　　　¥${m2(p.money.perPersonYuan)}`);
  L.push('');
  L.push('## 六、待处理事项');
  L.push('');
  const pending = p.members.filter((m) => m.status !== 'confirmed');
  const todos = [];
  if (pending.length) todos.push(`${pending.map((m) => m.name).join('、')} 状态为「待本人确认」，需向其核对`);
  if (risks.length || blocks.length) todos.push('过敏/严重忌口风险提示需自行核对官方餐品信息');
  if (blocks.length) todos.push('致敏原黑名单已排除部分餐品，剩余餐品仍未经官方成分核验');
  if (p.priceSource !== 'calculate-price') todos.push('金额尚未经 calculate-price 试算');
  for (const c of p.conflicts) if (c.level === 'block') todos.push(`${c.code}：${c.message}`);
  if (!todos.length) L.push('- 无');
  else for (const t of todos) L.push(`- ${t}`);
  L.push('');
  L.push('## 七、操作提示');
  L.push('');
  L.push('> 回复"确认下单"才会创建订单；回复具体修改内容可调整方案。');
  L.push('');
  L.push('### 备选方案');
  L.push('');
  for (const key of ['safer', 'richer']) {
    const v = p.variants[key];
    L.push(`**${v.label}**（商品 ¥${m2(v.goodsYuan)}${v.shared.length ? `，共享 ¥${m2(v.sharedYuan)}` : ''}）`);
    for (const m of v.members) {
      L.push(`- ${m.name}｜${m.items.map((i) => i.name).join(' + ') || '—'}｜¥${m.priceYuan === null ? '—' : m2(m.priceYuan)}`);
    }
    L.push('');
  }
  L.push('切换备选方案后需重新调用 calculate-price 试算。');
  L.push('');
  L.push(`金额来源：**${p.priceSource}**${p.priceSource === 'ESTIMATE' ? '（估算值）' : '（calculate-price 真实返回）'} · mayCreateOrder=**${p.mayCreateOrder}**`);
  L.push('');
  console.log(L.join('\n'));
}
