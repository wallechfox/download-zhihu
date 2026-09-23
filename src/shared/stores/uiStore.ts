import { create } from 'zustand';
import type { LogEntry, LogLevel } from '@/types/zhihu';

/**
 * 日志最大保留条数。导出大批量内容时会产生上万条日志，
 * 若无限累积会导致每次追加都全量复制数组并重渲染整个列表（O(N²)），
 * 表现为「导出越久越卡」。这里只保留最近 N 条，将成本钳为常数级。
 */
const MAX_LOGS = 500;

interface RetryInfo {
  count: number;
  max: number;
  waitMs: number;
}

interface FabPosition {
  right: number;
  bottom: number;
}

interface UIState {
  panelOpen: boolean;
  fabPos: FabPosition;
  logs: LogEntry[];
  retryInfo: RetryInfo | null;

  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  setFabPos: (pos: FabPosition) => void;
  addLog: (message: string, level: LogLevel) => void;
  clearLogs: () => void;
  setRetryInfo: (info: RetryInfo | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  panelOpen: false,
  fabPos: { right: 24, bottom: 100 },
  logs: [],
  retryInfo: null,

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  setFabPos: (pos) => set({ fabPos: pos }),
  addLog: (message, level) => set((s) => {
    const next = [...s.logs, {
      time: new Date().toLocaleTimeString(),
      message,
      level,
    }];
    // 超出上限时丢弃最旧的日志，保持数组长度有界
    return { logs: next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next };
  }),
  clearLogs: () => set({ logs: [] }),
  setRetryInfo: (info) => set({ retryInfo: info }),
}));
