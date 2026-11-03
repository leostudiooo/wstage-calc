/**
 * rules-lab — 工时规则的对照实验室
 *
 * 把「结算规则」抽象成一组开关，用同一份 TSV 数据跑出各方案的差异。
 * 现行算法由 OLD 配置复现（`--verify` 会与 src/lib/calculator.ts 逐人比对）。
 *
 * 用法：
 *   npx tsx ref/rules-lab.ts <data.tsv>                    # 所有方案汇总
 *   npx tsx ref/rules-lab.ts <data.tsv> --verify           # 先校验 OLD == 现行实现
 *   npx tsx ref/rules-lab.ts <data.tsv> --month            # 逐月对比
 *   npx tsx ref/rules-lab.ts <data.tsv> --people           # 逐人对比
 *   npx tsx ref/rules-lab.ts <data.tsv> --records          # 逐条记录影响
 *   npx tsx ref/rules-lab.ts <data.tsv> --check            # 数据自查（时长/卡号/重复）
 *
 * 数据格式：制表符分隔，首行为表头，列名固定 12 列（见下方 COLUMNS）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { processWorkHours, type WorkRecord } from '../src/lib/calculator.ts';

const COLUMNS = [
  '活动名称', '姓名', '一卡通号', '工作种类', '场馆-去重引用', '开始时间',
  '结束时间', '工时单', '基础工时', '节假日、期末周', '工作备注', '已结算',
] as const;

// ---------------------------------------------------------------- 规则配置

export type Cfg = {
  formalRate: number;               // 正式系数
  formalOnBase: boolean;            // 系数只压在「未翻倍」的基数上
  formalNeedsNoOther: boolean;      // 只有在没有加班/节假日倍率时才给系数
  formalStacks: boolean;            // 系数与节假日叠乘
  holidayFlatDouble: boolean;       // 节假日整班 ×2（不叠加班）
  holidayTakesMax: boolean;         // 节假日：整班×2 与普通计算取更高
  noOvertime: boolean;              // 完全不给加班补贴
  multipliersOnAllWork: boolean;    // 加班/倍率也作用于「其他工作」
};

const base: Cfg = {
  formalRate: 1.25, formalOnBase: false, formalNeedsNoOther: false, formalStacks: true,
  holidayFlatDouble: false, holidayTakesMax: false, noOvertime: false, multipliersOnAllWork: false,
};

export const CONFIGS: Record<string, { cfg: Cfg; note: string }> = {
  OLD:     { cfg: base, note: '现行：1.25 叠乘，节假日再叠加班' },
  G:       { cfg: { ...base, formalOnBase: true, formalStacks: true, holidayFlatDouble: true },
             note: '节假日整班×2，正式 1.25 叠上去（2.5× 封顶）' },
  H:       { cfg: { ...base, formalOnBase: true, formalStacks: false, holidayFlatDouble: true },
             note: '节假日整班×2，正式系数只在平日（2× 封顶）' },
  H12:     { cfg: { ...base, formalRate: 1.2, formalOnBase: true, formalStacks: false, holidayFlatDouble: true },
             note: 'H 的正式系数降为 1.2' },
  F:       { cfg: { ...base, formalRate: 1.2, formalOnBase: true, formalStacks: true, holidayFlatDouble: true },
             note: '节假日整班×2，正式 1.2 叠上去（2.4× 封顶）' },
  ANCIENT: { cfg: { ...base, formalRate: 1.2, noOvertime: true },
             note: '老规则：1.2 + 节假日×2，无任何加班补贴' },
};

// ---------------------------------------------------------------- 日期工具

const SH = 8 * 3600e3;

function parse(v: string | Date): Date {
  if (v instanceof Date) return new Date(v);
  const t = String(v).trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) return new Date(`${t.replace(' ', 'T')}+08:00`);
  return new Date(t);
}

const parts = (d: Date) => {
  const s = new Date(d.getTime() + SH);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), h: s.getUTCHours() };
};

/** 工作日按 04:00 换日 */
export function dayKey(d: Date): string {
  const p = parts(d);
  const x = new Date(Date.UTC(p.y, p.m, p.d));
  if (p.h < 4) x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
}

/** 落在 23:00–次日 04:00 的工时（按墙钟比例折算到基础工时上） */
function lateHours(row: WorkRecord, hours: number): number {
  const s = parse(row['开始时间']), e = parse(row['结束时间']);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || hours <= 0) return 0;
  const p = parts(s);
  const day = new Date(Date.UTC(p.y, p.m, p.d));
  if (p.h < 4) day.setUTCDate(day.getUTCDate() - 1);
  const ns = day.getTime() + 23 * 3600e3 - SH;
  const ne = day.getTime() + 28 * 3600e3 - SH;
  const total = e.getTime() - s.getTime();
  if (total <= 0) return 0;
  return hours * Math.max(0, Math.min(e.getTime(), ne) - Math.max(s.getTime(), ns)) / total;
}

const isLMV = (k: string) => /灯控|音控|舞监/.test(k);      // 灯音舞（原 isVenueWork）
const isFormal = (k: string) => String(k).includes('正式');
const isHoliday = (r: WorkRecord) => String(r['节假日、期末周'] || '').trim() === '是';
const num = (v: any) => Number(v) || 0;
const ceil05 = (x: number) => Math.ceil(x * 2) / 2;
const r2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- 计算核心

export type Detail = {
  name: string; card: string; date: string; kind: string; hours: number;
  ot: number; adj: number; hol: boolean; frm: boolean; venue: boolean; act: string;
};

export function core(rows: WorkRecord[], cfg: Cfg) {
  const groups = new Map<string, WorkRecord[]>();

  for (const r of rows) {
    if (!String(r['姓名'] || '').trim() || !String(r['开始时间'] || '').trim()) continue;
    const st = parse(r['开始时间']);
    if (isNaN(st.getTime())) continue;
    const k = `${r['姓名']}|${r['一卡通号']}|${dayKey(st)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const per = new Map<string, { name: string; card: string; raw: number; adj: number }>();
  const detail: Detail[] = [];
  const add = (name: string, card: string, rawH: number, adjH: number, d: Omit<Detail, 'name' | 'card' | 'adj'>) => {
    const k = `${name}|${card}`;
    const o = per.get(k) ?? per.set(k, { name, card, raw: 0, adj: 0 }).get(k)!;
    o.raw += rawH;
    o.adj += adjH;
    detail.push({ ...d, name, card, adj: adjH });
  };

  for (const [key, group] of groups) {
    const [name, card] = key.split('|');
    const inScope = (r: WorkRecord) => isLMV(r['工作种类']) || cfg.multipliersOnAllWork;

    const venue = group.filter(inScope)
      .sort((a, b) => parse(a['开始时间']).getTime() - parse(b['开始时间']).getTime());
    const flat = group.filter(r => !inScope(r));

    let cum = 0;   // 当日已结算的工时，用于 8h 规则
    for (const row of venue) {
      const hours = num(row['基础工时']);
      if (hours <= 0) continue;

      const hol = isHoliday(row);
      const frm = isFormal(row['工作种类']);

      const over8 = Math.max(0, hours - Math.max(0, 8 - cum));
      cum += hours;
      const ot = cfg.noOvertime ? 0 : Math.max(over8, lateHours(row, hours));

      const m = frm ? cfg.formalRate : 1;
      let adj: number;

      if (hol && cfg.holidayTakesMax) {
        adj = Math.max(hours * 2, (hours - ot) * m + ot * 2);
      } else if (hol && cfg.holidayFlatDouble) {
        adj = hours * 2 * (frm && cfg.formalStacks ? cfg.formalRate : 1);
      } else if (hol) {
        adj = (hours + ot) * 2 * (frm && cfg.formalStacks ? cfg.formalRate : 1);
      } else if (cfg.formalOnBase) {
        adj = (hours - ot) * m + ot * 2;
      } else if (cfg.formalNeedsNoOther) {
        adj = ot > 0 ? hours + ot : hours * m;
      } else {
        adj = (hours + ot) * m;
      }

      add(name, card, hours, adj, {
        date: dayKey(parse(row['开始时间'])), kind: String(row['工作种类']),
        hours, ot, hol, frm, venue: true, act: String(row['活动名称'] || ''),
      });
    }

    for (const row of flat) {
      const hours = num(row['基础工时']);
      if (hours <= 0) continue;
      add(name, card, hours, hours, {
        date: dayKey(parse(row['开始时间'])), kind: String(row['工作种类']),
        hours, ot: 0, hol: isHoliday(row), frm: isFormal(row['工作种类']), venue: false,
        act: String(row['活动名称'] || ''),
      });
    }
  }

  const people = [...per.values()]
    .map(o => ({ ...o, settle: ceil05(o.adj) }))
    .sort((a, b) => b.settle - a.settle);

  return { people, detail };
}

export const run = (rows: WorkRecord[], cfg: Cfg) => core(rows, cfg).people;

// ---------------------------------------------------------------- 数据读取

function load(path: string): WorkRecord[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const rec: any = {};
    COLUMNS.forEach((c, i) => { rec[c] = cells[i] ?? ''; });
    return rec as WorkRecord;
  });
}

/**
 * 同一姓名出现多个一卡通号时，统一成出现次数最多的那个。
 * 不合并会被当成多个人，导致每人各自的 0.5h 向上取整被重复执行。
 */
function mergeCards(rows: WorkRecord[]): WorkRecord[] {
  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const n = String(r['姓名'] || '').trim();
    if (!n) continue;
    const m = tally.get(n) ?? tally.set(n, new Map()).get(n)!;
    m.set(String(r['一卡通号']).trim(), (m.get(String(r['一卡通号']).trim()) ?? 0) + 1);
  }
  return rows.map(r => {
    const n = String(r['姓名'] || '').trim();
    if (!n || !tally.get(n)) return r;
    const canon = [...tally.get(n)!.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { ...r, '一卡通号': canon };
  });
}

// ---------------------------------------------------------------- 输出

const fmt = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));

function rawTotalOf(rows: WorkRecord[]) {
  // 只统计算法真正采纳的行：缺姓名或开始时间无法解析的会被丢弃
  return r2(rows
    .filter(r => String(r['姓名'] || '').trim() && !isNaN(parse(r['开始时间']).getTime()))
    .reduce((s, r) => s + num(r['基础工时']), 0));
}

function summary(rows: WorkRecord[]) {
  const kept = rows.filter(r => String(r['姓名'] || '').trim() && !isNaN(parse(r['开始时间']).getTime()));
  const rawTotal = rawTotalOf(rows);

  console.log(`\n数据：${rows.length} 行，其中 ${kept.length} 行被采纳，原始工时 ${fmt(rawTotal)} h\n`);
  console.log(`${pad('方案', 9)}${pad('结算工时', 11)}${pad('vs 原始', 10)}${pad('平均倍率', 11)}${pad('最高倍率', 11)}说明`);

  for (const [name, { cfg, note }] of Object.entries(CONFIGS)) {
    const d = core(rows, cfg).detail.filter(x => x.hours > 0);
    const settle = r2(run(rows, cfg).reduce((s, o) => s + o.settle, 0));
    const mult = d.map(x => x.adj / x.hours);
    const avg = d.reduce((s, x) => s + x.adj, 0) / d.reduce((s, x) => s + x.hours, 0);
    console.log(
      pad(name, 9) + pad(fmt(settle), 11) +
      pad(`${settle >= rawTotal ? '+' : ''}${r2(settle - rawTotal)}`, 10) +
      pad(`${r2(avg)}x`, 11) + pad(`${r2(Math.max(...mult))}x`, 11) + note
    );
  }
}

function byMonth(rows: WorkRecord[]) {
  const months = new Map<string, WorkRecord[]>();
  for (const r of rows) {
    const k = String(r['开始时间']).slice(0, 7);
    (months.get(k) ?? months.set(k, []).get(k)!).push(r);
  }
  const names = Object.keys(CONFIGS);

  console.log(`\n${pad('月份', 9)}${pad('行', 6)}${pad('原始', 9)}` + names.map(n => pad(n, 10)).join(''));
  for (const [m, rs] of [...months.entries()].sort()) {
    const raw = rawTotalOf(rs);
    const cells = names.map(n => pad(fmt(r2(run(rs, CONFIGS[n].cfg).reduce((s, o) => s + o.settle, 0))), 10)).join('');
    console.log(pad(m, 9) + pad(String(rs.length), 6) + pad(fmt(raw), 9) + cells);
  }
  const raw = rawTotalOf(rows);
  const cells = names.map(n => pad(fmt(r2(run(rows, CONFIGS[n].cfg).reduce((s, o) => s + o.settle, 0))), 10)).join('');
  const keptRows = rows.filter(r => String(r['姓名'] || '').trim() && !isNaN(parse(r['开始时间']).getTime())).length;
  console.log(pad('合计', 9) + pad(String(keptRows), 6) + pad(fmt(raw), 9) + cells);
  console.log('\n注：逐月口径为每人每月各自向上取整 0.5h，合计会比全表一次计算略高。');
}

function byPeople(rows: WorkRecord[], target = 'H') {
  const baseMap = new Map(run(rows, CONFIGS.OLD.cfg).map(o => [o.name, o.settle]));
  const tgtMap = new Map(run(rows, CONFIGS[target].cfg).map(o => [o.name, o.settle]));
  const list = [...baseMap.entries()]
    .map(([n, v]) => [n, v, tgtMap.get(n) ?? 0, r2((tgtMap.get(n) ?? 0) - v)] as [string, number, number, number])
    .sort((a, b) => a[3] - b[3]);

  console.log(`\n${pad('姓名', 10)}${pad('现行', 9)}${pad(target, 9)}${pad('差', 9)}`);
  for (const [n, a, b, d] of list) {
    console.log(pad(n, 10) + pad(fmt(a), 9) + pad(fmt(b), 9) + pad(d ? String(d) : '—', 9));
  }
  const unchanged = list.filter(x => x[3] === 0).length;
  console.log(`\n${list.length} 人中 ${unchanged} 人无变化（${r2(unchanged / list.length * 100)}%）`);
}

function byRecords(rows: WorkRecord[], target = 'H') {
  const oldD = core(rows, CONFIGS.OLD.cfg).detail;
  const newD = core(rows, CONFIGS[target].cfg).detail;

  const changed = oldD
    .map((x, i) => ({ ...x, newAdj: newD[i].adj, d: r2(newD[i].adj - x.adj) }))
    .filter(x => Math.abs(x.d) > 1e-9)
    .sort((a, b) => a.d - b.d);

  console.log(`\n${target} vs 现行：${changed.length} / ${oldD.length} 个班次有变化`);
  console.log(`合计 ${r2(changed.reduce((s, x) => s + x.d, 0))} h` +
              `（其中 ${changed.filter(x => Math.abs(x.d) >= 0.5).length} 个差额 ≥0.5h，其余被取整吸收）\n`);

  console.log(`${pad('姓名', 10)}${pad('日期', 12)}${pad('工时', 7)}${pad('工种', 14)}${pad('加班', 7)}${pad('现行', 8)}${pad(target, 8)}差`);
  for (const x of changed.slice(0, 30)) {
    console.log(
      pad(x.name, 10) + pad(x.date, 12) + pad(fmt(x.hours), 7) +
      pad(x.kind.replace(/（.*?）/g, ''), 14) + pad(fmt(x.ot), 7) +
      pad(fmt(x.adj), 8) + pad(fmt(x.newAdj), 8) + x.d
    );
  }
  if (changed.length > 30) console.log(`… 另 ${changed.length - 30} 条`);
}

function check(rows: WorkRecord[]) {
  console.log('\n— 数据自查 —');
  const noName = rows.filter(r => !String(r['姓名'] || '').trim());
  if (noName.length) console.log(`缺姓名 ${noName.length} 行（会被算法丢弃）`);

  const badTime = rows.filter(r => isNaN(parse(r['开始时间']).getTime()));
  if (badTime.length) console.log(`开始时间无法解析 ${badTime.length} 行`);

  // 基础工时是「时段长度向上取整到 0.5」的结果，所以按取整后比对；
  // 不符的部分可能是错填，也可能是故意少报/多报。
  const dur = rows.filter(r => {
    const h = num(r['基础工时']);
    const s = parse(r['开始时间']), e = parse(r['结束时间']);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || h <= 0) return false;
    return Math.abs(ceil05((e.getTime() - s.getTime()) / 3600e3) - h) > 1e-9;
  });
  console.log(`基础工时与「时段长度取整到 0.5h」不符：${dur.length} 行`);
  dur.slice(0, 12).forEach(r => {
    const real = (parse(r['结束时间']).getTime() - parse(r['开始时间']).getTime()) / 3600e3;
    console.log(`  ${pad(r['姓名'], 10)} ${String(r['开始时间']).slice(0, 16)} 记 ${num(r['基础工时'])}h 实 ${r2(real)}h (取整 ${ceil05(real)}h)`);
  });
  if (dur.length > 12) console.log(`  … 另 ${dur.length - 12} 行`);

  const cards = new Map<string, Set<string>>();
  for (const r of rows) {
    const n = String(r['姓名'] || '').trim(), c = String(r['一卡通号']).trim();
    if (!n) continue;
    (cards.get(n) ?? cards.set(n, new Set()).get(n)!).add(c);
  }
  const multi = [...cards.entries()].filter(([, s]) => s.size > 1);
  // 注意：读入时已按姓名合并到众数卡号，这里只有在一卡通号为空时才可能报出来
  console.log(`同一姓名多个一卡通号：${multi.length} 人${multi.length ? '' : '（读入时已按姓名合并）'}`);
  multi.forEach(([n, s]) => console.log(`  ${n}: ${[...s].join(' / ')}`));

  const sig = (r: WorkRecord) => [r['姓名'], r['开始时间'], r['结束时间'], num(r['基础工时']), r['工作种类'], String(r['场馆-去重引用'] || '').trim()].join('|');
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(sig(r), (seen.get(sig(r)) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`完全重复的行：${dup.length} 组`);
}

// ---------------------------------------------------------------- 入口

// 作为模块被 import 时（比如写一次性分析脚本）不执行 CLI
// 只有「这个文件就是入口脚本」时才跑 CLI；被 import 或 tsx -e 里调用时保持静默
const stripExt = (p: string) => resolve(p).replace(/\.[cm]?[jt]sx?$/, '');
const isCli = !!process.argv[1] && stripExt(process.argv[1]) === stripExt(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('用法: npx tsx ref/rules-lab.ts <data.tsv> [--verify|--month|--people|--records|--check]');
    process.exit(1);
  }
  const rows = mergeCards(load(file));
  const flag = args.find(a => a.startsWith('--'));

  if (flag === '--verify') {
    // 不传 venues = 不筛选；传 [] 会按「一个都没选」返回空
    const ref = new Map(processWorkHours(rows, 25, true).map(r => [`${r['姓名']}|${r['一卡通号']}`, r['结算工时']]));
    const mine = run(rows, CONFIGS.OLD.cfg);
    const bad = mine.filter(o => ref.get(`${o.name}|${o.card}`) !== o.settle);
    const refTotal = r2([...ref.values()].reduce((a, b) => a + b, 0));
    const myTotal = r2(mine.reduce((s, o) => s + o.settle, 0));
    console.log(`现行实现 ${refTotal} h / 本引擎 OLD ${myTotal} h`);
    console.log(bad.length === 0 && refTotal === myTotal
      ? `✓ ${mine.length} 人逐人一致`
      : `✗ ${bad.length} 人不一致：` + bad.map(o => `${o.name} ${o.settle}≠${ref.get(`${o.name}|${o.card}`)}`).join(', '));
  } else if (flag === '--month') {
    byMonth(rows);
  } else if (flag === '--people') {
    byPeople(rows, args[args.indexOf('--people') + 1] ?? 'H');
  } else if (flag === '--records') {
    byRecords(rows, args[args.indexOf('--records') + 1] ?? 'H');
  } else if (flag === '--check') {
    check(rows);
  } else {
    summary(rows);
  }
}

if (isCli) main();

export { load, mergeCards, summary, byMonth, byPeople, byRecords, check, rawTotalOf };
