import React, { useState, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import jschardet from 'jschardet';
import { Upload, Download, Users, Clock, CreditCard, Trash2, AlertCircle, Eye, EyeOff, Settings2, ClipboardPaste, Loader2, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { processWorkHours, exportToExcel, SettlementResult, WorkRecord, normalizeData } from './lib/calculator';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [results, setResults] = useState<SettlementResult[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<'idle' | 'spinning' | 'success'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hourlyRate, setHourlyRate] = useState<number>(25);
  const [showAmount, setShowAmount] = useState(true);
  const [rawData, setRawData] = useState<WorkRecord[]>([]);

  // Re-calculate when hourlyRate changes
  useEffect(() => {
    if (rawData.length > 0) {
      const processed = processWorkHours(rawData, hourlyRate);
      setResults(processed);
    }
  }, [hourlyRate, rawData]);

  const processRawData = useCallback((data: any[][]) => {
    if (data.length === 0) {
      setError('没有检测到数据');
      return;
    }

    // Standard column names to check for headers
    const expectedHeaders = ['姓名', '一卡通号', '工作种类', '开始时间', '基础工时'];
    const firstRow = data[0].map(cell => String(cell || '').trim());
    
    // Check if the first row is a header row
    const isHeaderRow = expectedHeaders.some(header => firstRow.includes(header));
    
    let finalData: any[][];
    if (isHeaderRow) {
      // Map columns by name
      const headerMap = new Map<string, number>();
      firstRow.forEach((name, idx) => headerMap.set(name, idx));
      
      finalData = data.slice(1).map(row => {
        const record: any[] = new Array(11).fill('');
        const columns = [
          '活动名称', '姓名', '一卡通号', '工作种类', '开始时间', 
          '结束时间', '工时单', '基础工时', '节假日、期末周', '工作备注', '已结算'
        ];
        columns.forEach((col, idx) => {
          const sourceIdx = headerMap.get(col);
          if (sourceIdx !== undefined) {
            record[idx] = row[sourceIdx];
          }
        });
        return record;
      });
    } else {
      // Assume standard column order
      finalData = data;
    }

    const normalized = normalizeData(finalData);
    if (normalized.length === 0) {
      setError('无法解析数据，请确保格式正确');
      return;
    }

    setProcessingStatus('spinning');
    setError(null);

    // Stage 1: Spin for 0.5s
    setTimeout(() => {
      setProcessingStatus('success');
      
      // Stage 2: Show checkmark for 0.5s
      setTimeout(() => {
        setRawData(normalized);
        const processed = processWorkHours(normalized, hourlyRate);
        setResults(processed);
        setProcessingStatus('idle');
      }, 500);
    }, 500);
  }, [hourlyRate]);

  const handleFileUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        
        let workbook;
        if (file.name.toLowerCase().endsWith('.csv')) {
          const binaryString = uint8Array.reduce((data, byte) => data + String.fromCharCode(byte), '');
          const detection = jschardet.detect(binaryString);
          const encoding = detection.encoding || 'UTF-8';
          const decoder = new TextDecoder(encoding);
          const decodedString = decoder.decode(uint8Array);
          workbook = XLSX.read(decodedString, { type: 'string' });
        } else {
          workbook = XLSX.read(uint8Array, { type: 'array' });
        }

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        // Read as array of arrays to handle headerless tables
        const data = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
        processRawData(data);
      } catch (err) {
        console.error(err);
        setError('解析文件失败，请确保文件格式正确 (XLSX/CSV)');
      }
    };
    reader.readAsArrayBuffer(file);
  }, [processRawData]);

  // Handle Paste
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;

      // Check if we are in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      try {
        // Parse TSV (Excel paste format)
        const rows = text.split(/\r?\n/).filter(line => line.trim() !== '');
        const data = rows.map(row => row.split('\t'));
        
        if (data.length > 0) {
          processRawData(data);
        }
      } catch (err) {
        console.error('Paste error:', err);
        setError('粘贴数据解析失败');
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [processRawData]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const clearResults = () => {
    setResults([]);
    setRawData([]);
    setError(null);
  };

  const loadSampleData = () => {
    setProcessingStatus('spinning');
    const sampleData: WorkRecord[] = [
      {
        '活动名称': '测试活动 1',
        '姓名': '张三',
        '一卡通号': '213210001',
        '工作种类': '正式-灯光',
        '开始时间': '2026-03-01 08:00:00',
        '结束时间': '2026-03-01 18:00:00',
        '工时单': 'S001',
        '基础工时': 10,
        '节假日、期末周': '否',
        '工作备注': '',
        '已结算': '否'
      },
      {
        '活动名称': '测试活动 2',
        '姓名': '李四',
        '一卡通号': '213210002',
        '工作种类': '实习-音响',
        '开始时间': '2026-03-01 09:00:00',
        '结束时间': '2026-03-01 12:00:00',
        '工时单': 'S002',
        '基础工时': 3,
        '节假日、期末周': '是',
        '工作备注': '',
        '已结算': '否'
      },
      {
        '活动名称': '测试活动 3',
        '姓名': '张三',
        '一卡通号': '213210001',
        '工作种类': '正式-舞美',
        '开始时间': '2026-03-02 10:00:00',
        '结束时间': '2026-03-02 14:00:00',
        '工时单': 'S003',
        '基础工时': 4,
        '节假日、期末周': '否',
        '工作备注': '',
        '已结算': '否'
      }
    ];
    
    // Stage 1: Spin for 0.5s
    setTimeout(() => {
      setProcessingStatus('success');
      
      // Stage 2: Show checkmark for 0.5s
      setTimeout(() => {
        setRawData(sampleData);
        const processed = processWorkHours(sampleData, hourlyRate);
        setResults(processed);
        setProcessingStatus('idle');
        setError(null);
      }, 500);
    }, 500);
  };

  const totalHours = results.reduce((sum, r) => sum + r.结算工时, 0);
  const totalAmount = results.reduce((sum, r) => sum + r.结算金额, 0);

  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#F5F5F4]">
      {/* Header */}
      <header className="border-b border-[#141414]/10 bg-white/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-baseline gap-4">
            <h1 className="text-2xl font-bold tracking-tight">WStage</h1>
            <span className="text-[10px] uppercase tracking-widest opacity-40 font-bold hidden sm:inline">玩转舞台 · Work Hour Calculator</span>
          </div>
          
          <div className="flex items-center gap-3">
            {results.length > 0 && (
              <div className="flex items-center gap-2 mr-4 border-r border-[#141414]/10 pr-4">
                <button 
                  onClick={() => setShowAmount(!showAmount)}
                  className="p-2 hover:bg-[#141414]/5 rounded-full transition-colors"
                  title={showAmount ? "隐藏金额" : "显示金额"}
                >
                  {showAmount ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>
                <div className="flex items-center gap-2 bg-white border border-[#141414]/10 px-3 py-1.5 rounded-md">
                  <Settings2 size={14} className="opacity-40" />
                  <span className="text-xs font-bold opacity-40">时薪:</span>
                  <input 
                    type="number" 
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(Number(e.target.value))}
                    className="w-12 text-xs font-bold focus:outline-none bg-transparent"
                  />
                </div>
              </div>
            )}
            
            {results.length > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={() => exportToExcel(results)}
                  className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-[#F5F5F4] hover:bg-[#333] transition-colors font-bold text-xs uppercase tracking-wider rounded-md"
                >
                  <Download size={16} />
                  导出
                </button>
                <button
                  onClick={clearResults}
                  className="flex items-center gap-2 px-4 py-2 border border-[#141414]/20 hover:bg-[#141414]/5 transition-all font-bold text-xs uppercase tracking-wider rounded-md"
                >
                  <Trash2 size={16} />
                  清除
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6 relative">
        <AnimatePresence mode="wait">
          {processingStatus !== 'idle' ? (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="min-h-[400px] flex flex-col items-center justify-center bg-[#F5F5F4]/80 backdrop-blur-sm rounded-2xl border border-[#141414]/5"
            >
              <AnimatePresence mode="wait">
                {processingStatus === 'spinning' ? (
                  <motion.div
                    key="spinner"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.2 }}
                    className="flex flex-col items-center"
                  >
                    <Loader2 className="animate-spin text-[#141414] mb-4" size={48} />
                    <p className="text-sm font-bold uppercase tracking-widest opacity-40">正在处理数据...</p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.2 }}
                    className="flex flex-col items-center"
                  >
                    <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center mb-4 shadow-lg shadow-green-500/20">
                      <Check className="text-white" size={28} />
                    </div>
                    <p className="text-sm font-bold uppercase tracking-widest text-green-600">处理完成</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ) : results.length === 0 ? (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="grid md:grid-cols-3 gap-6"
            >
              {/* Upload Area */}
              <div className="md:col-span-2 space-y-6">
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                  className={cn(
                    "relative border-2 border-dashed border-[#141414]/20 rounded-xl p-12 md:p-20 flex flex-col items-center justify-center transition-all group bg-white",
                    isDragging ? "border-[#141414] bg-[#141414]/5" : "hover:border-[#141414]/40"
                  )}
                >
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={onFileChange}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <Upload size={40} className={cn("mb-4 transition-transform group-hover:-translate-y-1", isDragging ? "text-[#141414]" : "text-[#141414]/40")} />
                  <h2 className="text-xl font-bold mb-1">上传或直接粘贴 WStage 工时数据</h2>
                  <p className="text-xs opacity-40 uppercase tracking-widest mb-6">支持 XLSX, XLS, CSV (自动识别编码与无表头表格)</p>
                  
                  <div className="flex gap-3 z-10">
                    <button
                      onClick={(e) => { e.stopPropagation(); loadSampleData(); }}
                      className="px-5 py-2 border border-[#141414]/20 hover:bg-[#141414] hover:text-[#F5F5F4] transition-all text-[10px] uppercase tracking-widest font-bold rounded-full"
                    >
                      加载示例数据
                    </button>
                    <div className="flex items-center gap-2 px-5 py-2 bg-[#141414]/5 text-[10px] uppercase tracking-widest font-bold rounded-full opacity-60">
                      <ClipboardPaste size={12} />
                      支持直接粘贴 (Ctrl+V)
                    </div>
                  </div>
                  
                  {error && (
                    <div className="mt-6 flex items-center gap-2 text-red-600 bg-red-50 px-4 py-2 border border-red-100 rounded-lg">
                      <AlertCircle size={14} />
                      <span className="text-xs font-bold">{error}</span>
                    </div>
                  )}
                </div>

                <section className="grid sm:grid-cols-2 gap-6">
                  <div className="bg-white p-6 rounded-xl border border-[#141414]/5 space-y-4">
                    <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-30 border-b border-[#141414]/10 pb-2">使用说明</h3>
                    <ol className="space-y-3 text-xs leading-relaxed opacity-70">
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">01</span>
                        <span>从工作结算表中筛选当月的工时数据。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">02</span>
                        <span>将数据全选，复制到新的 Excel 表格中。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">03</span>
                        <span>保存为 CSV 或 XLSX 格式并上传。</span>
                      </li>
                    </ol>
                  </div>
                  <div className="bg-white p-6 rounded-xl border border-[#141414]/5 space-y-4">
                    <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-30 border-b border-[#141414]/10 pb-2">计算规则</h3>
                    <ul className="space-y-3 text-xs leading-relaxed opacity-70">
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span>当日累计超出 8 小时的部分双倍；23:00 - 次日 04:00 部分双倍。两者取更高的计算。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span>正式员工享受 1.25 倍系数。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span>节假日及期末周享受 2 倍系数。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span>最终工时向上取整到 0.5 小时。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span>仅统计“已结算”字段不为“是”的记录。</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="font-mono opacity-30">●</span>
                        <span className="text-red-600 font-bold">结算工时超过 40 小时将红色高亮显示。</span>
                      </li>
                    </ul>
                  </div>
                </section>
              </div>
              
              {/* Sidebar info */}
              <div className="bg-[#141414] text-[#F5F5F4] p-8 rounded-xl flex flex-col justify-center space-y-6">
                <div className="space-y-2">
                  <h4 className="text-[10px] uppercase tracking-widest opacity-50 font-bold">当前配置</h4>
                  <div className="text-3xl font-bold">¥{hourlyRate}/H</div>
                </div>
                <div className="h-px bg-white/10" />
                <p className="text-xs leading-relaxed opacity-60">
                  本工具专为 WStage (玩转舞台) 团队设计，自动处理复杂的工时倍率逻辑，确保结算准确无误。
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="space-y-6"
            >
              {/* Stats Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white p-5 rounded-xl border border-[#141414]/5 flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest opacity-40 font-bold">
                    <Users size={12} />
                    结算人数
                  </div>
                  <div className="text-2xl font-bold">{results.length} <span className="text-[10px] opacity-30">人</span></div>
                </div>
                <div className="bg-white p-5 rounded-xl border border-[#141414]/5 flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest opacity-40 font-bold">
                    <Clock size={12} />
                    总计工时
                  </div>
                  <div className="text-2xl font-bold">{totalHours.toFixed(1)} <span className="text-[10px] opacity-30">H</span></div>
                </div>
                <div className={cn(
                  "p-5 rounded-xl flex flex-col gap-1 transition-all duration-300",
                  showAmount ? "bg-[#141414] text-[#F5F5F4]" : "bg-white border border-[#141414]/5 text-[#141414]"
                )}>
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest opacity-40 font-bold">
                    <CreditCard size={12} />
                    总计金额
                  </div>
                  <div className="text-2xl font-bold">
                    {showAmount ? `¥${totalAmount.toLocaleString()}` : "••••••"}
                  </div>
                </div>
              </div>

              {/* Results Table */}
              <div className="bg-white rounded-xl border border-[#141414]/10 overflow-hidden shadow-sm">
                <div className={cn(
                  "grid p-3 text-[10px] uppercase tracking-widest font-bold border-b border-[#141414]/10 bg-[#F5F5F4]",
                  showAmount ? "grid-cols-4" : "grid-cols-3"
                )}>
                  <div className="px-3">姓名</div>
                  <div className="px-3">一卡通号</div>
                  <div className="px-3">结算工时</div>
                  {showAmount && <div className="px-3">结算金额</div>}
                </div>
                <div className="divide-y divide-[#141414]/5">
                  {results.map((row, idx) => (
                    <div key={idx} className={cn(
                      "grid p-3 hover:bg-[#141414]/5 transition-colors items-center",
                      showAmount ? "grid-cols-4" : "grid-cols-3"
                    )}>
                      <div className="px-3 font-bold text-sm">{row.姓名}</div>
                      <div className="px-3 font-mono text-[10px] opacity-40">{row.一卡通号}</div>
                      <div className="px-3">
                        <span className={cn(
                          "px-2 py-0.5 rounded font-bold text-sm inline-block transition-all",
                          row.结算工时 > 40 ? "bg-red-50 text-red-600 ring-1 ring-red-100" : ""
                        )}>
                          {row.结算工时.toFixed(1)}h
                        </span>
                      </div>
                      {showAmount && (
                        <div className="px-3 font-bold text-sm text-[#141414]">¥{row.结算金额.toFixed(2)}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-8 opacity-20 text-[9px] uppercase tracking-[0.3em] flex justify-between items-center">
        <span>WSTAGE CALCULATOR © 2026</span>
        <span>ENCODING: AUTO-DETECTED</span>
      </footer>
    </div>
  );
}
