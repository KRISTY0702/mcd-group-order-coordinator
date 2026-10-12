#!/usr/bin/env node
/**
 * 下单前参数自检。
 *
 * 输入：scripts/coordinate.mjs 产出的 order-plan.json
 * 作用：在调用 create-order 之前，按 mcd-mcp 的参数铁律与 Skill 红线做最后一道把关。
 * 退出码：0 = 允许下单（mayCreateOrder=true）；1 = 存在阻断项
 */

import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.plan) {
  console.error('\n[validate] 用法：node scripts/validate-plan.mjs --plan out/order-plan.json\n');
  process.exit(1);
}

let plan;
try {
  plan = JSON.parse(readFileSync(args.plan, 'utf8'));
} catch (e) {
  console.error(`\n[validate] 无法读取 ${args.plan}：${e.message}\n`);
  process.exit(1);
}

const isSentinel = (v) => typeof v === 'string' && /^__.*__$/.test(v);
const missing = (v) => v === undefined || v === null || v === '' || isSentinel(v);

const errors = [];
const warns = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m, hint) => { console.log(`  FAIL  ${m}${hint ? `\n        → ${hint}` : ''}`); errors.push(m); };
const warn = (m, hint) => { console.log(`  WARN  ${m}${hint ? `\n        → ${hint}` : ''}`); warns.push(m); };

console.log('\n[validate] 下单前参数自检\n');

console.log('1. 就餐方式与下单能力');
const orderable = plan.orderable !== false;
ok(`就餐方式：${plan.diningLabel ?? '未知'}（${plan.diningMode ?? '未知'}）`);
if (!orderable) {
  ok('该就餐方式不支持下单，本 Skill 不会创建订单');
  if (plan.createOrderDraft !== null) bad('不可下单场景仍生成了 createOrderDraft', '应置为 null');
  else ok('createOrderDraft 为 null（正确）');
  if (plan.mayCreateOrder !== false) bad('不可下单场景 mayCreateOrder 应为 false');
  else ok('mayCreateOrder=false（正确）');
}

console.log('\n2. 门店与订单类型');
const s = plan.store || {};
const beType = Number(s.beType);
const orderType = Number(s.orderType);
const expectedOrderType = beType === 1 || beType === 5 ? 1 : 2;

if ([1, 2, 5, 6].includes(beType)) ok(`beType=${beType} 合法`);
else bad(`beType=${beType} 非法`, '仅允许 1 到店自取 / 2 麦乐送 / 5 得来速 / 6 企业团餐');

if (orderType === expectedOrderType) ok(`orderType=${orderType} 与 beType=${beType} 配对正确`);
else bad(`orderType=${orderType} 与 beType=${beType} 不匹配`, `应为 ${expectedOrderType}`);

if (beType === 1) {
  if (!missing(s.beCode)) bad('beType=1 不应传 beCode', '到店自取传 beCode 会报错');
  else ok('beType=1 未传 beCode（正确）');
} else {
  if (missing(s.beCode)) bad(`beType=${beType} 缺少 beCode`, '取自 delivery-query-stores 或 query-nearby-stores');
  else ok('beCode 已提供');
}

if (missing(s.storeCode)) bad('缺少 storeCode');
else if (!/^\d+$/.test(String(s.storeCode))) bad(`storeCode=${s.storeCode} 非全数字`, '门店编码必须全部由数字组成');
else ok(`storeCode=${s.storeCode} 格式正确`);

console.log('\n3. 下单草稿必填项');
const d = plan.createOrderDraft || {};
if (!orderable) {
  ok('跳过（不可下单场景）');
} else {
  if (orderType === 1) {
    if (missing(d.takeWayCode)) bad('orderType=1 缺少 takeWayCode', '取自 calculate-price 返回的 data.takeWayList[].code');
    else ok(`takeWayCode=${d.takeWayCode}`);
  } else {
    if (missing(d.addressId)) bad('orderType=2 缺少 addressId', '取自 delivery-query-addresses');
    else ok('addressId 已提供');
  }
  if (beType === 6) {
    if (missing(d.gmServiceCode)) bad('beType=6 缺少 gmServiceCode', '取自 query-meal-assistance');
    else ok('gmServiceCode 已提供');
  }
  if (!missing(d.reservationDate)) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.reservationDate)) ok(`reservationDate=${d.reservationDate} 格式正确`);
    else bad(`reservationDate=${d.reservationDate} 格式错误`, '应为 yyyy-MM-dd HH:mm');
  }
}

console.log('\n4. 商品明细与共享餐品');
const items = Array.isArray(d.items) ? d.items : [];
if (!orderable) {
  ok('跳过（不可下单场景）');
} else if (!items.length) {
  bad('items 为空');
} else {
  let allGood = true;
  for (const [i, it] of items.entries()) {
    if (missing(it.productCode)) { bad(`items[${i}] 缺少 productCode`, '取自 query-meals 的真实返回'); allGood = false; continue; }
    if (isSentinel(it.productCode)) { bad(`items[${i}].productCode 是哨兵值 ${it.productCode}`, '用 query-meals 的真实 code 替换'); allGood = false; continue; }
    if (!Number.isInteger(it.quantity) || it.quantity < 1) { bad(`items[${i}] quantity=${it.quantity} 非法`, '必须 ≥1 的整数'); allGood = false; }
  }
  if (allGood) ok(`${items.length} 个商品条目，共 ${items.reduce((a, b) => a + b.quantity, 0)} 件`);
}
if (plan.shared?.enabled) {
  ok(`共享餐品 ${plan.shared.items?.length ?? 0} 项，合计 ¥${Number(plan.shared.totalYuan || 0).toFixed(2)}，人均 ¥${Number(plan.shared.perHeadYuan || 0).toFixed(2)}`);
}

console.log('\n5. 金额与冲突');
if (plan.priceSource === 'calculate-price') ok('金额来源为 calculate-price（权威）');
else bad(`金额来源为 ${plan.priceSource}`, '下单前必须调 calculate-price，并用其返回覆盖 snapshot.priceResult');

const blocking = (plan.conflicts || []).filter((c) => c.level === 'block');
if (!blocking.length) ok('无阻断级冲突');
else for (const c of blocking) bad(`${c.code}：${c.message}`, c.hint);

console.log('\n6. 优惠券与风险');
const couponWarn = (plan.conflicts || []).find((c) => c.code === 'COUPON_CONSENT_REQUIRED');
if (couponWarn) warn(couponWarn.message, '未取得明确同意前不得建议或执行领券');
const riskNotices = (plan.conflicts || []).filter((c) => c.code === 'RISK_NOTICE');
if (riskNotices.length) warn(`有 ${riskNotices.length} 条过敏/严重忌口风险提示`, '需发起人自行核对官方餐品信息，本 Skill 不声称绝对安全');
if (!couponWarn && !riskNotices.length) ok('无优惠券同意待办、无过敏风险提示');

console.log('\n7. 确认门');
const saidConfirm = plan.mayCreateOrder === true;
if (saidConfirm) ok('发起人已明确确认，且参数全部通过 → 可调 create-order');
else warn('尚未满足下单条件（未确认 / 有阻断项 / 金额非权威 / 不支持下单）', '禁止调用 create-order');
const pending = (plan.members || []).filter((m) => m.status !== 'confirmed');
if (pending.length) warn(`${pending.map((m) => m.name).join('、')} 状态为「待本人确认」`, '需发起人向其核对后再下单');

console.log('\n────────────────────────────');
if (errors.length || !saidConfirm) {
  console.log(`[validate] 未放行：${errors.length} 个阻断项，${warns.length} 个提醒。禁止调用 create-order。\n`);
  process.exit(1);
}
console.log(`[validate] 通过（${warns.length} 个提醒）。可调 create-order。\n`);
process.exit(0);
