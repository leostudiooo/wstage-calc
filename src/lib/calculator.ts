import * as XLSX from 'xlsx';

export interface WorkRecord {
  '活动名称': string;
  '姓名': string;
  '一卡通号': string;
  '工作种类': string;
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
  '结算工时': number;
  '结算金额': number;
}

const HOURLY_RATE = 25;

function getDayKey(date: Date): string {
  const d = new Date(date);
  if (d.getHours() < 4) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split('T')[0];
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
    '活动名称', '姓名', '一卡通号', '工作种类', '开始时间', 
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

export function processWorkHours(data: WorkRecord[], hourlyRate: number): SettlementResult[] {
  const records: { name: string; card: string; adjustedHours: number }[] = [];
  
  // Group by Name, Card, and Day
  const grouped = new Map<string, WorkRecord[]>();
  
  data.forEach(row => {
    // Skip rows that don't have a name or start time
    if (!row['姓名'] || !row['开始时间']) return;

    // Skip rows that are already settled ("是")
    if (String(row['已结算'] || '').trim() === '是') return;

    const startTime = new Date(row['开始时间']);
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
      .sort((a, b) => new Date(a['开始时间']).getTime() - new Date(b['开始时间']).getTime());
    
    const nonVenueWork = group.filter(r => !isVenueWork(r['工作种类']));

    // Process Venue Work
    let cumulative = 0;
    venueWork.forEach(row => {
      const hours = Number(row['基础工时']) || 0;
      if (hours <= 0) return;

      let rate1x = 0;
      let rate2x = 0;
      let remaining = hours;

      if (cumulative < 8) {
        const available = 8 - cumulative;
        const take = Math.min(remaining, available);
        rate1x += take;
        remaining -= take;
        cumulative += take;
      }

      if (remaining > 0) {
        rate2x += remaining;
        cumulative += remaining;
      }

      let adjusted = rate1x + rate2x * 2;
      
      const isFormal = String(row['工作种类'] || '').includes('正式');
      const isHoliday = String(row['节假日、期末周'] || '').trim() === '是';

      if (isFormal) adjusted *= 1.25;
      if (isHoliday) adjusted *= 2;

      records.push({ name, card, adjustedHours: adjusted });
    });

    // Process Non-Venue Work
    nonVenueWork.forEach(row => {
      const hours = Number(row['基础工时']) || 0;
      if (hours <= 0) return;
      records.push({ name, card, adjustedHours: hours });
    });
  });

  // Aggregate by person
  const summaryMap = new Map<string, { name: string; card: string; totalHours: number }>();
  
  records.forEach(rec => {
    const key = `${rec.name}|${rec.card}`;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, { name: rec.name, card: rec.card, totalHours: 0 });
    }
    summaryMap.get(key)!.totalHours += rec.adjustedHours;
  });

  return Array.from(summaryMap.values()).map(item => {
    // Round up to nearest 0.5
    const settlementHours = Math.ceil(item.totalHours * 2) / 2;
    return {
      '姓名': item.name,
      '一卡通号': item.card,
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
