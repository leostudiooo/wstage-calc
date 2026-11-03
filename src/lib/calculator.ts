import * as XLSX from 'xlsx';

export interface WorkRecord {
  '活动名称': string;
  '姓名': string;
  '一卡通号': string;
  '工作种类': string;
  '场馆-去重引用': string;
  '开始时间': string | Date;
  '结束时间': string | Date;
  '工时单': string;
  '基础工时': number;
  '节假日、期末周': string;
  '工作备注': string;
  '已结算': string;
}

export interface SettlementResult {
  '姓名': string;
  '一卡通号': string;
  '原始工时': number;
  '结算工时': number;
  '结算金额': number;
}

const HOURLY_RATE = 25;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseShanghaiDate(value: string | Date): Date {
  if (value instanceof Date) return new Date(value);

  const text = String(value).trim();
  // Spreadsheet timestamps without an offset represent Shanghai local time.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return new Date(`${text.replace(' ', 'T')}+08:00`);
  }

  return new Date(text);
}

function getShanghaiParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function getDayKey(date: Date): string {
  const parts = getShanghaiParts(date);
  const d = new Date(Date.UTC(parts.year, parts.month, parts.day));
  if (parts.hour < 4) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().split('T')[0];
}

function getLate23Hours(row: WorkRecord): number {
  const startTime = parseShanghaiDate(row['开始时间']);
  const endTime = parseShanghaiDate(row['结束时间']);

  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return 0;

  const hours = Number(row['基础工时']) || 0;
  if (hours <= 0) return 0;

  // Determine the "day" this shift belongs to (same logic as getDayKey: day starts at 04:00)
  const startParts = getShanghaiParts(startTime);
  const dayDate = new Date(Date.UTC(startParts.year, startParts.month, startParts.day));
  if (startParts.hour < 4) {
    dayDate.setUTCDate(dayDate.getUTCDate() - 1);
  }

  // Night work runs from 23:00 through 04:00 the following day.
  const nightStart = new Date(dayDate.getTime() + 23 * 60 * 60 * 1000 - SHANGHAI_OFFSET_MS);
  const nightEnd = new Date(dayDate.getTime() + 28 * 60 * 60 * 1000 - SHANGHAI_OFFSET_MS);

  const totalDuration = endTime.getTime() - startTime.getTime();
  if (totalDuration <= 0) return 0;

  const lateStart = Math.max(startTime.getTime(), nightStart.getTime());
  const lateEnd = Math.min(endTime.getTime(), nightEnd.getTime());
  const lateDuration = Math.max(0, lateEnd - lateStart);

  return hours * (lateDuration / totalDuration);
}

function isVenueWork(jobType: string): boolean {
  const type = String(jobType || '');
  return type.includes('正式') || type.includes('实习');
}

export function normalizeData(rawData: any[]): WorkRecord[] {
  if (rawData.length === 0) return [];

  const firstRow = rawData[0];
  const isArray = Array.isArray(firstRow);
  
  // Standard column order from instructions
  const columns = [
    '活动名称', '姓名', '一卡通号', '工作种类', '场馆-去重引用', '开始时间',
    '结束时间', '工时单', '基础工时', '节假日、期末周', '工作备注', '已结算'
  ];

  // If it's an array of arrays (no headers or forced index mapping)
  if (isArray) {
    return rawData.map(row => {
      const record: any = {};
      columns.forEach((col, idx) => {
        record[col] = row[idx] !== undefined ? row[idx] : '';
      });
      return record as WorkRecord;
    });
  }

  // If it's an array of objects, check if it has the expected headers
  const hasHeaders = columns.every(col => col in firstRow);
  
  if (hasHeaders) {
    return rawData as WorkRecord[];
  }

  // If headers are missing or different, try to map by index if the object keys look like "EMPTY", "COLUMN_A", etc.
  // or if they are just random keys, we might need to treat them as data if they don't match our expected headers.
  // However, sheet_to_json with {header: 1} is safer for headerless.
  return rawData as WorkRecord[];
}

export function processWorkHours(
  data: WorkRecord[],
  hourlyRate: number,
  includeSettled = false,
  venues?: string[]
): SettlementResult[] {
  // 不传 venues 时不过滤（全量）；显式传空数组表示「一个场馆都没选」，返回空结果。
  // App 在「取消全部勾选」时走的就是空数组这条路，所以这里的语义必须是「筛掉全部」。
  const records: { name: string; card: string; rawHours: number; adjustedHours: number }[] = [];
  
  // Group by Name, Card, and Day
  const grouped = new Map<string, WorkRecord[]>();
  
  data.forEach(row => {
    // Skip rows that don't have a name or start time
    if (!row['姓名'] || !row['开始时间']) return;
    // venues 未传 = 不过滤；传了数组（哪怕为空）= 只保留列出的场馆
    if (venues && !venues.includes(String(row['场馆-去重引用'] || '').trim())) return;

    // By default calculate unsettled rows; the optional mode includes all rows.
    const isSettled = String(row['已结算'] || '').trim() === '是';
    if (!includeSettled && isSettled) return;

    const startTime = parseShanghaiDate(row['开始时间']);
    // Check if date is valid
    if (isNaN(startTime.getTime())) return;

    const dayKey = getDayKey(startTime);
    const groupKey = `${row['姓名']}|${row['一卡通号']}|${dayKey}`;
    
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, []);
    }
    grouped.get(groupKey)!.push(row);
  });

  grouped.forEach((group, key) => {
    const [name, card] = key.split('|');
    
    // Split into venue and non-venue work
    const venueWork = group.filter(r => isVenueWork(r['工作种类']))
      .sort((a, b) => parseShanghaiDate(a['开始时间']).getTime() - parseShanghaiDate(b['开始时间']).getTime());
    
    const nonVenueWork = group.filter(r => !isVenueWork(r['工作种类']));

    // Process Venue Work
    let cumulative = 0;
    venueWork.forEach(row => {
      const hours = Number(row['基础工时']) || 0;
      if (hours <= 0) return;

      // Rule 1: hours beyond 8 per day are doubled
      const rate2x = Math.max(0, hours - Math.max(0, 8 - cumulative));
      cumulative += hours;

      // Rule 2: hours after 23:00 (day runs 04:00–28:00) are doubled
      const lateHours = getLate23Hours(row);

      // Take the higher overtime amount from the two rules
      const overtime = Math.max(rate2x, lateHours);
      let adjusted = hours + overtime;
      
      const isFormal = String(row['工作种类'] || '').includes('正式');
      const isHoliday = String(row['节假日、期末周'] || '').trim() === '是';

      if (isFormal) adjusted *= 1.25;
      if (isHoliday) adjusted *= 2;

      records.push({ name, card, rawHours: hours, adjustedHours: adjusted });
    });

    // Process Non-Venue Work
    nonVenueWork.forEach(row => {
      const hours = Number(row['基础工时']) || 0;
      if (hours <= 0) return;
      records.push({ name, card, rawHours: hours, adjustedHours: hours });
    });
  });

  // Aggregate by person
  const summaryMap = new Map<string, { name: string; card: string; rawHours: number; totalHours: number }>();
  
  records.forEach(rec => {
    const key = `${rec.name}|${rec.card}`;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, { name: rec.name, card: rec.card, rawHours: 0, totalHours: 0 });
    }
    summaryMap.get(key)!.rawHours += rec.rawHours;
    summaryMap.get(key)!.totalHours += rec.adjustedHours;
  });

  return Array.from(summaryMap.values()).map(item => {
    // Round up to nearest 0.5
    const settlementHours = Math.ceil(item.totalHours * 2) / 2;
    return {
      '姓名': item.name,
      '一卡通号': item.card,
      '原始工时': item.rawHours,
      '结算工时': settlementHours,
      '结算金额': settlementHours * hourlyRate
    };
  });
}

export function exportToExcel(results: SettlementResult[]) {
  const ws = XLSX.utils.json_to_sheet(results);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "工时计算结果");
  XLSX.writeFile(wb, "工时计算结果.xlsx");
}
