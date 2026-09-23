import { create } from 'zustand';
import type { ContentItem, ExportFormat, DocxImageMode, ExportProgress } from '@/types/zhihu';

export const ALL_EXPORT_TYPES = ['article', 'answer', 'question', 'pin', 'collection', 'column'] as const;
export type ExportTypeKey = typeof ALL_EXPORT_TYPES[number];

export const TYPE_FOLDER_NAMES: Record<string, string> = {
  article: '文章',
  answer: '回答',
  question: '问题',
  pin: '想法',
  collection: '收藏夹',
  column: '专栏',
};

interface ExportState {
  dirHandle: FileSystemDirectoryHandle | null;
  format: ExportFormat;
  docxImageMode: DocxImageMode;
  wantImages: boolean;
  items: ContentItem[];
  progressData: ExportProgress | null;
  isExportingArticles: boolean;
  exportProgress: { current: number; total: number; text: string } | null;
  enabledTypes: Record<ExportTypeKey, boolean>;
  exportWithComments: boolean;

  setDirHandle: (handle: FileSystemDirectoryHandle | null) => void;
  setFormat: (format: ExportFormat) => void;
  setDocxImageMode: (mode: DocxImageMode) => void;
  setWantImages: (want: boolean) => void;
  setItems: (items: ContentItem[]) => void;
  setProgressData: (data: ExportProgress | null) => void;
  setIsExportingArticles: (v: boolean) => void;
  setExportProgress: (p: ExportState['exportProgress']) => void;
  markArticleExported: (id: string) => void;
  setEnabledType: (key: ExportTypeKey, value: boolean) => void;
  setExportWithComments: (v: boolean) => void;
}

const defaultEnabledTypes: Record<ExportTypeKey, boolean> = {
  article: true,
  answer: true,
  question: true,
  pin: true,
  collection: true,
  column: true,
};

export const useExportStore = create<ExportState>((set) => ({
  dirHandle: null,
  format: 'md',
  docxImageMode: 'embed',
  wantImages: true,
  items: [],
  progressData: null,
  isExportingArticles: false,
  exportProgress: null,
  enabledTypes: { ...defaultEnabledTypes },
  exportWithComments: true,

  setDirHandle: (handle) => set({ dirHandle: handle }),
  setFormat: (format) => set({ format }),
  setDocxImageMode: (mode) => set({ docxImageMode: mode }),
  setWantImages: (want) => set({ wantImages: want }),
  setItems: (items) => set({ items }),
  setProgressData: (data) => set({ progressData: data }),
  setIsExportingArticles: (v) => set({ isExportingArticles: v }),
  setExportProgress: (p) => set({ exportProgress: p }),
  markArticleExported: (id) => set((s) => {
    if (!s.progressData) return s;
    const ids = [...s.progressData.articles.exportedIds, id];
    return {
      progressData: {
        ...s.progressData,
        articles: { ...s.progressData.articles, exportedIds: ids, totalExported: ids.length },
      },
    };
  }),
  setEnabledType: (key, value) => set((s) => ({
    enabledTypes: { ...s.enabledTypes, [key]: value },
  })),
  setExportWithComments: (v) => set({ exportWithComments: v }),
}));
