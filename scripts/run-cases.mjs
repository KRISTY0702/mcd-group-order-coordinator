#!/usr/bin/env node
/**
 * 跑 A-D 验证用例（tests/cases.json）。
 *
 * 纯离线：把每个 case 的 request / snapshot 写到临时目录，调用真实的
 * scripts/coordinate.mjs，再对产出的 order-plan.json 做断言。
 * 用例里的餐品数据均为占位测试数据，不触碰 MCP、不碰账户。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const COORDINATE = join(HERE, 'coordinate.mjs');

const casesFile = join(ROOT, 'tests', 'cases.json');
const all = JSON.parse(readFileSync(casesFile, 'utf8'));
const cases = all.cases || [];

const work = join(tmpdir(), 'mcd-goc-cases');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

let failed = 0;
let passed = 0;

for (const c of cases) {
  console.log(`\n──── 用例 ${c.id}：${c.title}`);
  const reqPath = join(work, `${c.id}-request.json`);
  const snapPath = join(work, `${c.id}-snapshot.json`);
  const outPath = join(work, `${c.id}-plan.json`);
  writeFileSync(reqPath, JSON.stringify(c.request, null, 2), 'utf8');
  writeFileSync(snapPath, JSON.stringify(c.snapshot, null, 2), 'utf8');

  let plan;
  try {
    execFileSync(process.execPath, [COORDINATE, '--request', reqPath, '--snapshot', snapPath, '--out', outPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    plan = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch (e) {
    console.log(`  FAIL  脚本执行失败：${e.stderr?.toString() || e.message}`);
    failed++;
    continue;
  }

  const catOf = new Map((c.snapshot.meals || []).map((m) => [m.code, m.category]));

  for (const a of c.assert) {
    let ok = false;
    let desc = '';

    if (a.path !== undefined) {
      const actual = getPath(plan, a.path);
      if ('equals' in a) { ok = actual === a.equals; desc = `${a.path} === ${JSON.stringify(a.equals)}（实际 ${JSON.stringify(actual)}）`; }
      else if ('notEquals' in a) { ok = actual !== a.notEquals; desc = `${a.path} !== ${JSON.stringify(a.notEquals)}（实际 ${JSON.stringify(actual)}）`; }
      else if (a.isTrue) { ok = actual === true; desc = `${a.path} 为 true（实际 ${JSON.stringify(actual)}）`; }
      else if (a.isFalse) { ok = actual === false; desc = `${a.path} 为 false（实际 ${JSON.stringify(actual)}）`; }
    } else if (a.hasConflict) {
      const hit = (plan.conflicts || []).some((x) => x.code === a.hasConflict);
      ok = hit;
      desc = `包含冲突 ${a.hasConflict}`;
    } else if (a.conflictMention) {
      const hit = (plan.conflicts || []).some((x) => x.code === a.conflictMention.code && `${x.message}${x.hint || ''}`.includes(a.conflictMention.text));
      ok = hit;
      desc = `冲突 ${a.conflictMention.code} 提到「${a.conflictMention.text}」`;
    } else if (a.memberStatus) {
      const m = (plan.members || []).find((x) => x.name === a.memberStatus.name);
      ok = m && m.status === a.memberStatus.equals;
      desc = `${a.memberStatus.name} 状态为 ${a.memberStatus.equals}（实际 ${m?.status}）`;
    } else if (a.allItemsOfCategory) {
      const m = (plan.members || []).find((x) => x.name === a.allItemsOfCategory.member);
      ok = Boolean(m && m.items.length && m.items.every((i) => catOf.get(i.code) === a.allItemsOfCategory.category));
      desc = `${a.allItemsOfCategory.member} 的餐品全部属于「${a.allItemsOfCategory.category}」（实际 ${m ? m.items.map((i) => `${i.name}[${catOf.get(i.code)}]`).join(',') : '无'}）`;
    } else if (a.noDuplicateItems !== undefined) {
      const dup = (plan.members || []).filter((m) => new Set(m.items.map((i) => i.code)).size !== m.items.length);
      ok = dup.length === 0;
      desc = `每位成员的餐品互不重复（重复者：${dup.map((m) => m.name).join('、') || '无'}）`;
    } else if (a.noItemMatching) {
      const m = (plan.members || []).find((x) => x.name === a.noItemMatching.member);
      const re = new RegExp(a.noItemMatching.regex);
      ok = Boolean(m && !m.items.some((i) => re.test(i.name)));
      desc = `${a.noItemMatching.member} 的餐品不含 /${a.noItemMatching.regex}/（实际 ${m ? m.items.map((i) => i.name).join(',') : '无'}）`;
    } else if (a.itemMatching) {
      const m = (plan.members || []).find((x) => x.name === a.itemMatching.member);
      const re = new RegExp(a.itemMatching.regex);
      ok = Boolean(m && m.items.some((i) => re.test(i.name)));
      desc = `${a.itemMatching.member} 的餐品含 /${a.itemMatching.regex}/（实际 ${m ? m.items.map((i) => i.name).join(',') : '无'}）`;
    } else if (a.memberAllergen) {
      const m = (plan.members || []).find((x) => x.name === a.memberAllergen.member);
      if (a.memberAllergen.isNull) {
        ok = Boolean(m && m.allergen === null);
        desc = `${a.memberAllergen.member} 无致敏原限制（实际 ${JSON.stringify(m?.allergen)}）`;
      } else {
        ok = Boolean(m && m.allergen && m.allergen.groups.includes(a.memberAllergen.includes));
        desc = `${a.memberAllergen.member} 命中致敏原组「${a.memberAllergen.includes}」（实际 ${JSON.stringify(m?.allergen?.groups)}）`;
      }
    }

    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}${a._why ? `\n        ↳ ${a._why}` : ''}`);
    ok ? passed++ : failed++;
  }
}

rmSync(work, { recursive: true, force: true });
console.log(`\n────────────────────────────`);
console.log(`[run-cases] ${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
