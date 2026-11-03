# ref/ 规则实验台

工时规则的对照实验室。把「结算规则」抽象成一组开关，同一份数据跑出各方案的差异。

## 用法

```bash
npx tsx ref/rules-lab.ts <数据.tsv>            # 所有方案汇总
npx tsx ref/rules-lab.ts <数据.tsv> --verify   # 校验 OLD 配置 == src/lib/calculator.ts
npx tsx ref/rules-lab.ts <数据.tsv> --month    # 逐月对比
npx tsx ref/rules-lab.ts <数据.tsv> --people H # 逐人对比（H 可换任意方案名）
npx tsx ref/rules-lab.ts <数据.tsv> --records H # 逐条记录影响
npx tsx ref/rules-lab.ts <数据.tsv> --check    # 数据自查
```

也可以把它当模块导入，写一次性分析：

```ts
import { load, mergeCards, core, CONFIGS } from './ref/rules-lab.ts';
const rows = mergeCards(load('data.tsv'));
const detail = core(rows, CONFIGS.OLD.cfg).detail;   // 逐条记录
```

数据格式：制表符分隔，首行表头，12 列固定顺序（与 App 页面上传的格式一致）。
可以从 Excel 直接全选复制粘贴成 `.tsv`。

样本数据不入库（含真实姓名与一卡通号，已列入 `.gitignore`）。
需要跑的话，从工作结算表导出一份放本地即可。

**任何方案对比前先跑 `--verify`**：确认引擎的 `OLD` 配置仍然逐人复现
`src/lib/calculator.ts`。如果那边改了规则而这里没跟上，校验会失败。

## 内置方案

| 名称 | 规则 |
|---|---|
| `OLD` | 现行：8h / 23:00 取较高 ×2，正式 ×1.25 叠乘，节假日 ×2 再叠乘 |
| `G` | 节假日整班 ×2，正式 1.25 叠上去（2.5× 封顶） |
| `H` | 节假日整班 ×2，正式系数只在平日生效（2× 封顶） |
| `H12` | 同 H，正式系数 1.2 |
| `F` | 节假日整班 ×2，正式 1.2 叠上去（2.4× 封顶） |
| `ANCIENT` | 老规则：正式 1.2 + 节假日 ×2，无任何加班补贴 |

加方案就是往 `CONFIGS` 里加一条，`Cfg` 的开关已覆盖下列维度：

- `formalRate` 正式系数
- `formalOnBase` 系数只压在未翻倍的基数上
- `formalNeedsNoOther` 只有在没有其它倍率时才给系数
- `formalStacks` 系数与节假日叠乘
- `holidayFlatDouble` 节假日整班 ×2（不叠加班）
- `holidayTakesMax` 节假日整班×2 与普通计算取更高
- `noOvertime` 完全关闭加班补贴
- `multipliersOnAllWork` 加班/倍率是否作用于「其他工作」

## 两个容易踩的点

**一卡通号不一致会把一个人拆成两个人。** 读入时按姓名合并到出现次数最多的卡号。
不合并的话，每人各自的「向上取整到 0.5h」会重复执行，总额偏高。

**逐月口径 ≠ 全表口径。** 按月独立跑时，每人每月各自取整一次，合计会比全表一次计算高
（这批数据差约 9h）。对比月度数字要和月度数字比。

## 数据自查会报什么

- 缺姓名 / 开始时间无法解析的行（算法会静默丢弃）
- 基础工时与「时段长度向上取整到 0.5h」不符的行
- 完全重复的行（同一人同一时段同一工时出现多次）
- 同一姓名多个一卡通号（已读入时合并，故通常为 0）

## 背景

2026-11 的一次规则讨论里，用一批历史数据（787 行 / 44 人 / 原始 4,066.5h）得出的结论：
现行算法结算 5,445.5h（溢价 +33.9%），天花板是 6 月那几个「节假日 × 正式 × 加班」
三重叠乘的班次，最高 3.57×。削掉叠乘结构（方案 H）能降到 5,103.5h，
但降幅的 69% 集中在 6 月，其余月份几乎不动。

最终决定**不改规则**。本目录仅为后续讨论保留对照工具，不参与构建。
