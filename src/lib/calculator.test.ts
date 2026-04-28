import { describe, it, expect } from 'vitest';
import { processWorkHours, normalizeData, WorkRecord } from './calculator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WorkRecord. Defaults to venue work (实习). */
function makeRecord(overrides: Partial<WorkRecord> = {}): WorkRecord {
  return {
    '活动名称': '测试活动',
    '姓名': '张三',
    '一卡通号': '123456',
    '工作种类': '实习',
    '开始时间': '2024-01-15T09:00:00',
    '结束时间': '2024-01-15T17:00:00',
    '工时单': '',
    '基础工时': 8,
    '节假日、期末周': '',
    '工作备注': '',
    '已结算': '',
    ...overrides,
  };
}

/** Run a single record through the processor and return the settlement hours. */
function calcHours(record: WorkRecord): number {
  const results = processWorkHours([record], 25);
  return results[0]?.['结算工时'] ?? 0;
}

// ---------------------------------------------------------------------------
// normalizeData
// ---------------------------------------------------------------------------

describe('normalizeData', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeData([])).toEqual([]);
  });

  it('maps array-of-arrays to WorkRecord objects', () => {
    const row = ['活动A', '李四', '789', '实习', '2024-01-15', '2024-01-15', '', 4, '', '', ''];
    const [record] = normalizeData([row]);
    expect(record['姓名']).toBe('李四');
    expect(record['基础工时']).toBe(4);
  });

  it('passes through array-of-objects that already have expected headers', () => {
    const obj = makeRecord();
    const [record] = normalizeData([obj]);
    expect(record['姓名']).toBe('张三');
  });
});

// ---------------------------------------------------------------------------
// Non-venue work — no overtime applied
// ---------------------------------------------------------------------------

describe('非场地工作 (non-venue work)', () => {
  it('uses base hours directly without doubling', () => {
    const record = makeRecord({ '工作种类': '其他', '基础工时': 10 });
    expect(calcHours(record)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Already-settled rows
// ---------------------------------------------------------------------------

describe('已结算行 (settled rows)', () => {
  it('skips rows marked 已结算=是', () => {
    const record = makeRecord({ '已结算': '是', '基础工时': 8 });
    const results = processWorkHours([record], 25);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8-hour overtime rule
// ---------------------------------------------------------------------------

describe('八小时超时规则 (8-hour overtime)', () => {
  it('does not double hours within 8-hour threshold', () => {
    // 8 h before 23:00 → 8 settlement hours
    const record = makeRecord({
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T17:00:00',
      '基础工时': 8,
    });
    expect(calcHours(record)).toBe(8);
  });

  it('doubles hours beyond 8 in a single shift', () => {
    // 10 h before 23:00: 8 normal + 2 doubled = 12
    const record = makeRecord({
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T19:00:00',
      '基础工时': 10,
    });
    expect(calcHours(record)).toBe(12);
  });

  it('accumulates hours across multiple shifts in the same day', () => {
    // Shift 1: 6 h (normal). Shift 2: 4 h → 2 normal + 2 doubled = 6. Total = 6+6=12
    const shift1 = makeRecord({
      '开始时间': '2024-01-15T08:00:00',
      '结束时间': '2024-01-15T14:00:00',
      '基础工时': 6,
    });
    const shift2 = makeRecord({
      '开始时间': '2024-01-15T14:00:00',
      '结束时间': '2024-01-15T18:00:00',
      '基础工时': 4,
    });
    const results = processWorkHours([shift1, shift2], 25);
    expect(results[0]['结算工时']).toBe(12);
  });

  it('does not carry cumulative hours across different days', () => {
    const day1 = makeRecord({
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T17:00:00',
      '基础工时': 8,
    });
    const day2 = makeRecord({
      '开始时间': '2024-01-16T09:00:00',
      '结束时间': '2024-01-16T17:00:00',
      '基础工时': 8,
    });
    const results = processWorkHours([day1, day2], 25);
    // Each day: 8 h, no overtime → 8 h each → 16 total
    expect(results[0]['结算工时']).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// 23:00 late-night rule
// ---------------------------------------------------------------------------

describe('23:00夜间规则 (late-night doubling)', () => {
  it('does not double hours entirely before 23:00', () => {
    // 8 h, 09:00-17:00 → 8 settlement hours (no late night)
    const record = makeRecord({
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T17:00:00',
      '基础工时': 8,
    });
    expect(calcHours(record)).toBe(8);
  });

  it('doubles hours entirely after 23:00', () => {
    // 3 h, 23:00-02:00 → all late → 3+3=6 h
    const record = makeRecord({
      '开始时间': '2024-01-15T23:00:00',
      '结束时间': '2024-01-16T02:00:00',
      '基础工时': 3,
    });
    expect(calcHours(record)).toBe(6);
  });

  it('prorates hours spanning the 23:00 threshold', () => {
    // 4 h shift: 21:00-01:00. 2 h before 23:00, 2 h after.
    // lateHours=2, rate2x=0 (only 4h total, under 8). overtime=max(0,2)=2
    // adjusted = 4+2 = 6
    const record = makeRecord({
      '开始时间': '2024-01-15T21:00:00',
      '结束时间': '2024-01-16T01:00:00',
      '基础工时': 4,
    });
    expect(calcHours(record)).toBe(6);
  });

  it('treats hours between midnight and 04:00 as belonging to the previous day, after 23:00', () => {
    // Shift 00:30-02:30 on Jan 16 belongs to the Jan 15 day (04:00-28:00).
    // threshold23 = Jan 15 23:00. startTime 00:30 Jan 16 > 23:00 Jan 15 → all late.
    // 2 h all late → 2+2=4 h
    const record = makeRecord({
      '开始时间': '2024-01-16T00:30:00',
      '结束时间': '2024-01-16T02:30:00',
      '基础工时': 2,
    });
    expect(calcHours(record)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Both rules active — take the higher result
// ---------------------------------------------------------------------------

describe('两规则取高 (take higher of the two rules)', () => {
  it('8-hour rule wins when cumulative is high and few late hours', () => {
    // Day: shift1 = 8 h (09:00-17:00, fully normal). shift2 = 3 h (17:00-20:00, no late hours).
    // shift2: cumulative=8, rate2x=3, lateHours=0. overtime=max(3,0)=3. adjusted=3+3=6
    const shift1 = makeRecord({
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T17:00:00',
      '基础工时': 8,
    });
    const shift2 = makeRecord({
      '开始时间': '2024-01-15T17:00:00',
      '结束时间': '2024-01-15T20:00:00',
      '基础工时': 3,
    });
    const results = processWorkHours([shift1, shift2], 25);
    // shift1=8, shift2=6 → 14 total
    expect(results[0]['结算工时']).toBe(14);
  });

  it('23:00 rule wins when cumulative is low but shift is mostly late', () => {
    // 4 h shift entirely after 23:00. cumulative=0 before this shift.
    // rate2x=0 (only 4 h worked, under 8). lateHours=4. overtime=max(0,4)=4.
    // adjusted = 4+4 = 8
    const record = makeRecord({
      '开始时间': '2024-01-15T23:00:00',
      '结束时间': '2024-01-16T03:00:00',
      '基础工时': 4,
    });
    expect(calcHours(record)).toBe(8);
  });

  it('when both rules yield the same overtime, result is the same', () => {
    // 10 h shift: 2 h before 23:00 (21:00-23:00) + 8 h after (23:00-07:00... but day cap at 04:00).
    // Let's use 10 h starting 21:00. endTime = 07:00 next day. But day cutoff is 04:00.
    // Actually let's use a simpler case: cumulative=0, shift 14:00-00:00 (10h).
    // lateHours: threshold=23:00 Jan15. start=14:00<23:00, end=00:00 Jan16.
    // lateDuration = 00:00 Jan16 - 23:00 Jan15 = 1h. totalDuration=10h. lateHours=10*(1/10)=1.
    // rate2x = max(0, 10-(8-0)) = 2. overtime=max(2,1)=2.
    // adjusted = 10+2 = 12
    const record = makeRecord({
      '开始时间': '2024-01-15T14:00:00',
      '结束时间': '2024-01-16T00:00:00',
      '基础工时': 10,
    });
    expect(calcHours(record)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Multipliers: formal (正式) and holiday (节假日)
// ---------------------------------------------------------------------------

describe('倍率修正 (formal/holiday multipliers)', () => {
  it('applies 1.25x for 正式 work', () => {
    // 8 h 正式, no overtime → 8 * 1.25 = 10
    const record = makeRecord({ '工作种类': '正式', '基础工时': 8 });
    expect(calcHours(record)).toBe(10);
  });

  it('applies 2x for holiday work', () => {
    // 8 h 实习 holiday → 8 * 2 = 16
    const record = makeRecord({ '节假日、期末周': '是', '基础工时': 8 });
    expect(calcHours(record)).toBe(16);
  });

  it('applies both 1.25x and 2x for formal holiday work', () => {
    // 8 h 正式 holiday → 8 * 1.25 * 2 = 20
    const record = makeRecord({ '工作种类': '正式', '节假日、期末周': '是', '基础工时': 8 });
    expect(calcHours(record)).toBe(20);
  });

  it('applies overtime then multipliers for formal work exceeding 8 h', () => {
    // 10 h 正式 before 23:00: overtime=2 → adjusted=12. 12*1.25=15
    const record = makeRecord({
      '工作种类': '正式',
      '开始时间': '2024-01-15T09:00:00',
      '结束时间': '2024-01-15T19:00:00',
      '基础工时': 10,
    });
    expect(calcHours(record)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Settlement rounding
// ---------------------------------------------------------------------------

describe('结算舍入 (round up to 0.5)', () => {
  it('rounds up to the nearest 0.5', () => {
    // Shift 21:00-23:30 (2.5 h). lateHours: span 23:00-23:30 = 0.5h out of 2.5h. lateHours=0.5.
    // rate2x=0, overtime=0.5. adjusted=2.5+0.5=3. Already a multiple of 0.5.
    const record = makeRecord({
      '开始时间': '2024-01-15T21:00:00',
      '结束时间': '2024-01-15T23:30:00',
      '基础工时': 2.5,
    });
    expect(calcHours(record)).toBe(3);
  });
});
