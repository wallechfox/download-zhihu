import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, Switch, Segmented, Progress, Typography, Space, Divider, List, Tag } from 'antd';
import { useExportStore, ALL_EXPORT_TYPES, TYPE_FOLDER_NAMES } from '@/shared/stores/exportStore';
import type { ExportTypeKey } from '@/shared/stores/exportStore';
import { useUIStore } from '@/shared/stores/uiStore';
import { pickFolderAndLoadProgress } from './FolderPicker';
import { fetchCollectionPage, fetchColumnPage, fetchProfilePage, checkPaidAccess, fetchFullContent, fetchAllComments } from '@/shared/api/zhihu-api';
import {
  sanitizeFilename,
  buildFrontmatter,
  batchDownloadImages,
  batchDownloadImagesToFolder,
  writeTextFile,
  writeBlobFile,
  buildImageDataMap,
  TYPE_LABELS,
  buildTocMarkdown,
  formatDatePrefix,
  buildCommentsHtml,
} from '@/shared/utils/export-utils';
import { addExportedArticle } from '@/shared/utils/progress';
import type { ContentItem, PaginatedResult, ZhihuComment } from '@/types/zhihu';

interface Props {
  collectionId: string;
  collectionName: string;
  collectionApiUrl: string;
  sourceType: 'collection' | 'column' | 'profile';
  /** 个人主页各类型数量（来自主页标签栏） */
  typeCounts?: Record<string, number>;
}

function buildItemName(item: ContentItem, typeLabel: string, num: number): string {
  switch (item.type) {
    case 'article':
      return item.title || `${item.author}的文章_${num}`;
    case 'answer':
      return item.title
        ? `${item.title}-${item.author}的回答`
        : `${item.author}的回答_${num}`;
    case 'question':
      return item.title
        ? `${item.title}-${item.author}的问题`
        : `${item.author}的问题_${num}`;
    case 'pin':
      return item.title
        ? `${item.title}-${item.author}的想法`
        : `${item.author}的想法_${num}`;
    case 'collection':
      return item.title || `${item.author}的收藏夹_${num}`;
    case 'column':
      return item.title || `${item.author}的专栏_${num}`;
    default:
      return item.title
        ? `${item.title}-${item.author}的${typeLabel}`
        : `${item.author}的${typeLabel}_${num}`;
  }
}

const TYPE_CHECKBOX_LABELS: Record<ExportTypeKey, string> = {
  article: '文章',
  answer: '回答',
  question: '问题',
  pin: '想法',
  collection: '收藏夹',
  column: '专栏',
};

export function ArticleList({
  collectionId,
  collectionName,
  collectionApiUrl,
  sourceType,
  typeCounts,
}: Props) {
  const format = useExportStore((s) => s.format);  const setFormat = useExportStore((s) => s.setFormat);
  const docxImageMode = useExportStore((s) => s.docxImageMode);
  const wantImages = useExportStore((s) => s.wantImages);
  const setWantImages = useExportStore((s) => s.setWantImages);
  const progressData = useExportStore((s) => s.progressData);
  const isExportingArticles = useExportStore((s) => s.isExportingArticles);
  const setIsExportingArticles = useExportStore((s) => s.setIsExportingArticles);
  const exportProgress = useExportStore((s) => s.exportProgress);
  const setExportProgress = useExportStore((s) => s.setExportProgress);
  const setItems = useExportStore((s) => s.setItems);
  const enabledTypes = useExportStore((s) => s.enabledTypes);
  const setEnabledType = useExportStore((s) => s.setEnabledType);
  const exportWithComments = useExportStore((s) => s.exportWithComments);
  const setExportWithComments = useExportStore((s) => s.setExportWithComments);
  const addLog = useUIStore((s) => s.addLog);

  // 目录列表（打开页面先加载第 1 页，可手动加载全部）
  const [listItems, setListItems] = useState<ContentItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [allLoaded, setAllLoaded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);

  const resumeUrlRef = useRef<string | null>(collectionApiUrl);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const stopRequestedRef = useRef(false); // 仅控制目录加载循环
  const [loadPaused, setLoadPaused] = useState(false);

  const appendItems = useCallback((pageItems: ContentItem[]) => {
    const fresh = pageItems.filter((i) => i.id && !seenIdsRef.current.has(i.id));
    for (const i of fresh) seenIdsRef.current.add(i.id);
    if (fresh.length > 0) setListItems((prev) => [...prev, ...fresh]);
  }, []);

  // 目录分页拉取：支持起始 URL 与自定义停止条件（用于快速首屏 + 断点续载）
  const fetchPages = useCallback(
    async (
      startUrl: string,
      onPage: (items: ContentItem[], pageNum: number) => Promise<void>,
      shouldStop?: (pageNum: number, totalFetched: number) => boolean,
    ) => {
      const fetchFn = sourceType === 'profile' ? fetchProfilePage : sourceType === 'column' ? fetchColumnPage : fetchCollectionPage;
      let nextPageUrl: string | null = startUrl;
      let pageNum = 0;
      let totalFetched = 0;

      while (nextPageUrl) {
        if (shouldStop && shouldStop(pageNum + 1, totalFetched)) {
          return; // 调用方要求停止（首屏凑满 / 用户点击停止加载），剩余页面可从 resumeUrlRef 续载
        }
        resumeUrlRef.current = nextPageUrl;
        pageNum++;
        addLog(`正在请求第 ${pageNum} 页...`, 'info');

        let result: PaginatedResult;
        try {
          result = await fetchFn(nextPageUrl);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog(`加载第 ${pageNum} 页目录失败: ${msg}`, 'error');
          addLog(`已加载 ${totalFetched} 篇，后续页面未加载`, 'warn');
          return;
        }

        totalFetched += result.items.length;
        addLog(`第 ${pageNum} 页返回 ${result.items.length} 篇（累计 ${totalFetched} 篇）`, 'info');

        for (const item of result.items) {
          if (!item.id) {
            addLog(`警告：发现无 ID 条目，标题="${item.title || '无'}"，类型=${item.type}，将跳过`, 'warn');
          } else if (!item.html && item.type !== 'unknown') {
            addLog(`注意：条目 ${item.id}（${item.title || '无标题'}）内容为空`, 'warn');
          }
        }

        if (result.items.length > 0) {
          await onPage(result.items, pageNum);
        }

        nextPageUrl = result.nextUrl;
        resumeUrlRef.current = nextPageUrl;
        if (!nextPageUrl) {
          addLog(`全部页面加载完成，共 ${pageNum} 页 ${totalFetched} 篇`, 'info');
          return;
        }
        if (shouldStop && shouldStop(pageNum, totalFetched)) {
          return; // 暂停，剩余页面可从 resumeUrlRef 续载
        }
      }
    },
    [sourceType, addLog],
  );

  // 打开页面先快速加载一批条目（凑满约 20 篇或最多 10 页即停），完整目录由按钮按需加载
  useEffect(() => {
    let cancelled = false;
    setListItems([]);
    seenIdsRef.current = new Set();
    resumeUrlRef.current = collectionApiUrl;
    setAllLoaded(false);
    setListLoading(true);
    stopRequestedRef.current = false;
    fetchPages(collectionApiUrl, async (pageItems) => {
      if (!cancelled) appendItems(pageItems);
    }, (pageNum, total) => stopRequestedRef.current || total >= 20 || pageNum >= 10).finally(() => {
      if (!cancelled) {
        setListLoading(false);
        if (!resumeUrlRef.current) setAllLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [fetchPages, collectionApiUrl, appendItems]);

  const handleLoadAll = useCallback(async () => {
    const start = resumeUrlRef.current;
    if (!start || listLoading) return;
    setListLoading(true);
    stopRequestedRef.current = false;
    setLoadPaused(false);
    try {
      await fetchPages(start, async (pageItems) => {
        appendItems(pageItems);
      }, () => stopRequestedRef.current);
      if (!resumeUrlRef.current) setAllLoaded(true);
    } finally {
      setListLoading(false);
    }
  }, [listLoading, fetchPages, appendItems]);

  const handleStopLoading = useCallback(() => {
    stopRequestedRef.current = true;
    setLoadPaused(true);
    addLog('已停止加载目录，可点击"继续加载"续载', 'warn');
  }, [addLog]);

  const exportedSet = useMemo(
    () => new Set(progressData?.articles.exportedIds || []),
    [progressData],
  );

  const updateReadme = useCallback(
    async (collectionFolder: FileSystemDirectoryHandle) => {
      try {
        const allEntries: Array<{ num: number; title: string; author: string; type: string; filename: string; url: string }> = [];
        let idx = 0;

        for (const typeKey of ALL_EXPORT_TYPES) {
          const folderName = TYPE_FOLDER_NAMES[typeKey];
          let subFolder: FileSystemDirectoryHandle;
          try {
            subFolder = await collectionFolder.getDirectoryHandle(folderName);
          } catch { continue; }

          const fileNames: string[] = [];
          for await (const [name, handle] of (subFolder as any).entries()) {
            if (handle.kind !== 'file') continue;
            if (!name.endsWith('.md') && !name.endsWith('.docx')) continue;
            fileNames.push(name);
          }
          fileNames.sort();
          for (const name of fileNames) {
            idx++;
            allEntries.push({
              num: idx,
              title: name.replace(/\.(md|docx)$/, '').replace(/^\d{8}-/, ''),
              author: '',
              type: TYPE_LABELS[typeKey] || typeKey,
              filename: `${folderName}/${name}`,
              url: '',
            });
          }
        }

        if (allEntries.length > 0) {
          const tocMd = buildTocMarkdown(collectionName, allEntries);
          await writeTextFile(collectionFolder, 'README.md', tocMd);
        }
      } catch {
        // README update failure should not affect the main flow
      }
    },
    [collectionName],
  );

  const handleExport = useCallback(async () => {
    let store = useExportStore.getState();
    if (store.isExportingArticles) return;

    // 目录加载与导出共用抓取循环，先令进行中的目录加载停止，避免两个循环并发
    stopRequestedRef.current = true;

    if (!store.dirHandle || !store.progressData) {
      // 尚未选择文件夹：点击导出时直接弹出目录选择器
      const ok = await pickFolderAndLoadProgress(collectionId, collectionName);
      stopRequestedRef.current = false;
      if (!ok) return;
      store = useExportStore.getState();
      if (!store.dirHandle || !store.progressData) return;
    }

    const activeTypes = ALL_EXPORT_TYPES.filter((t) => store.enabledTypes[t]);
    if (activeTypes.length === 0) {
      addLog('请至少选择一种内容类型', 'warn');
      return;
    }

    setIsExportingArticles(true);

    const selectedSet = selectedIdsRef.current;
    const hasSelection = selectedSet.size > 0;

    const currentFormat = store.format;
    const currentDocxImgMode = store.docxImageMode;
    const currentWantImg = currentFormat === 'md' ? store.wantImages : (currentDocxImgMode === 'embed');
    const currentDirHandle = store.dirHandle;
    const currentProgressData = store.progressData;
    const currentExportWithComments = store.exportWithComments;

    try {
      const { htmlToMarkdown, extractImageUrls, buildCommentsMarkdown } = await import('@/shared/converters/html-to-markdown');

      const collectionFolder = await currentDirHandle.getDirectoryHandle(
        sanitizeFilename(collectionName),
        { create: true },
      );

      // 懒创建子文件夹：有内容才建目录，images 同样按需创建
      const typeFolders: Record<string, FileSystemDirectoryHandle> = {};
      const typeImagesFolders: Record<string, FileSystemDirectoryHandle> = {};
      const getFolder = async (typeKey: string) => {
        if (!typeFolders[typeKey]) {
          typeFolders[typeKey] = await collectionFolder.getDirectoryHandle(TYPE_FOLDER_NAMES[typeKey], { create: true });
        }
        return typeFolders[typeKey];
      };
      const getImagesFolder = async (typeKey: string) => {
        if (!typeImagesFolders[typeKey]) {
          const parent = await getFolder(typeKey);
          typeImagesFolders[typeKey] = await parent.getDirectoryHandle('images', { create: true });
        }
        return typeImagesFolders[typeKey];
      };

      const exportedIds = new Set(currentProgressData.articles.exportedIds || []);
      const usedNames = new Set<string>();
      let exportedInBatch = 0;
      let skippedCount = 0;
      let failedCount = 0;
      const allItems: ContentItem[] = [];
      const typeCounters: Record<string, number> = {};

      await fetchPages(collectionApiUrl, async (pageItems, pageNum) => {
        appendItems(pageItems);
        allItems.push(...pageItems);

        const noIdItems = pageItems.filter((item) => !item.id);
        if (noIdItems.length > 0) {
          skippedCount += noIdItems.length;
        }

        const pending = pageItems.filter((item) => {
          if (!item.id || exportedIds.has(item.id)) return false;
          if (!activeTypes.includes(item.type as ExportTypeKey)) return false;
          if (hasSelection && !selectedSet.has(item.id)) return false;
          return true;
        });
        const filteredByType = pageItems.filter((item) => item.id && !exportedIds.has(item.id) && !activeTypes.includes(item.type as ExportTypeKey));
        const alreadyExported = pageItems.length - noIdItems.length - pending.length - filteredByType.length;

        if (pending.length === 0) {
          addLog(`第 ${pageNum} 页：${pageItems.length} 篇全部已导出或不在选择范围内，跳过`, 'info');
          return;
        }

        addLog(
          `第 ${pageNum} 页：${pageItems.length} 篇（待导出 ${pending.length}，已导出 ${alreadyExported}${noIdItems.length > 0 ? `，无ID跳过 ${noIdItems.length}` : ''}）`,
          'info',
        );

        for (const item of pending) {
          const itemLabel = `${item.title || item.id}（${item.type}, id=${item.id}）`;
          const itemType = item.type as ExportTypeKey;

          try {
            exportedInBatch++;
            const targetFolder = await getFolder(itemType);
            typeCounters[itemType] = (typeCounters[itemType] || 0) + 1;
            const num = typeCounters[itemType];
            const typeLabel = TYPE_LABELS[item.type] || item.type;
            let baseName = sanitizeFilename(buildItemName(item, typeLabel, num));

            const datePrefix = formatDatePrefix(item.created_time || Math.floor(Date.now() / 1000));
            if (datePrefix) {
              baseName = `${datePrefix}-${baseName}`;
            }

            if (usedNames.has(baseName)) baseName = `${baseName}_${num}`;
            usedNames.add(baseName);

            let filename = currentFormat === 'docx' ? `${baseName}.docx` : `${baseName}.md`;
            try {
              await targetFolder.getFileHandle(filename);
              filename = currentFormat === 'docx' ? `${baseName}_${num}.docx` : `${baseName}_${num}.md`;
              addLog(`文件名冲突，改用: ${filename}`, 'warn');
            } catch {
              /* File doesn't exist — normal */
            }

            setExportProgress({
              current: 0,
              total: 1,
              text: `第 ${pageNum} 页 - 正在处理: ${(item.title || '').slice(0, 20)}...`,
            });
            addLog(`处理 [${exportedInBatch}]: ${itemLabel} → ${TYPE_FOLDER_NAMES[itemType]}/${filename}`, 'info');

            if (item.isTruncated && (item.type === 'article' || item.type === 'answer')) {
              let shouldFetch = true;

              if (item.isPaidContent) {
                addLog('  付费内容，检查购买状态...', 'info');
                const hasPaid = await checkPaidAccess(item.type, item.id);
                if (hasPaid) {
                  addLog('  已购买，请求完整内容...', 'info');
                } else {
                  addLog('  未购买，跳过补全', 'warn');
                  shouldFetch = false;
                }
              } else {
                addLog('  内容被截断，请求完整内容...', 'info');
              }

              if (shouldFetch) {
                try {
                  const fullHtml = await fetchFullContent(item.type, item.url);
                  if (fullHtml && fullHtml.length > (item.html || '').length) {
                    addLog(`  内容补全: ${(item.html || '').length} → ${fullHtml.length}`, 'info');
                    item.html = fullHtml;
                  }
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  addLog(`  补全失败: ${msg}，使用截断内容`, 'warn');
                }
              }
            }

            let comments: ZhihuComment[] = [];
            if (currentExportWithComments && (item.type === 'article' || item.type === 'answer' || item.type === 'pin')) {
              try {
                addLog('  获取评论...', 'info');
                comments = await fetchAllComments(item.type, item.id);
                if (comments.length > 0) {
                  addLog(`  获取到 ${comments.length} 条评论`, 'info');
                }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                addLog(`  评论获取失败: ${msg}，继续导出不含评论`, 'warn');
              }
            }

            if (currentFormat === 'docx') {
              let imageData = new Map<string, { buffer: ArrayBuffer; ext: string }>();
              let combinedHtml = `<h1>${(item.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>` + (item.html || '');

              if (currentWantImg && combinedHtml) {
                const imgUrls = extractImageUrls(combinedHtml);
                if (imgUrls.length > 0) {
                  const prefix = `${String(num).padStart(3, '0')}_`;
                  const imgResult = await batchDownloadImages(imgUrls, prefix);
                  imageData = buildImageDataMap(imgResult.imageMapping, imgResult.imageFiles);
                  addLog(`  图片: ${imgUrls.length} 张，嵌入 ${imageData.size} 张`, 'info');
                }
              }

              if (comments.length > 0) {
                combinedHtml += buildCommentsHtml(comments);
              }

              const { htmlToDocx } = await import('@/shared/converters/html-to-docx');
              const docxBlob = await htmlToDocx(combinedHtml, {
                images: currentDocxImgMode,
                imageData,
                frontMatter: {
                  id: item.id,
                  title: item.title,
                  author: item.author,
                  url: item.url,
                  createdTime: item.created_time || undefined,
                  updatedTime: item.updated_time || undefined,
                },
              });

              await writeBlobFile(targetFolder, filename, docxBlob);
            } else {
              let imageMapping: Record<string, string> = {};
              if (currentWantImg && item.html) {
                const imgUrls = extractImageUrls(item.html);
                if (imgUrls.length > 0) {
                  const imagesFolder = await getImagesFolder(itemType);
                  const prefix = `${String(num).padStart(3, '0')}_`;
                  const imgResult = await batchDownloadImagesToFolder(imgUrls, prefix, imagesFolder);
                  imageMapping = imgResult.imageMapping;
                  addLog(`  图片: ${imgUrls.length} 张，成功 ${Object.keys(imgResult.imageMapping).length} 张`, 'info');
                }
              }

              let md = htmlToMarkdown(item.html || '', imageMapping);
              md = buildFrontmatter(item) + `# ${item.title || ''}\n\n` + md;

              if (comments.length > 0) {
                const commentMd = buildCommentsMarkdown(comments, item.title || itemLabel, {});
                md += '\n\n' + commentMd;
              }

              await writeTextFile(targetFolder, filename, md);
            }

            await addExportedArticle(currentDirHandle, collectionId, currentProgressData, item.id);
            exportedIds.add(item.id);
            useExportStore.getState().markArticleExported(item.id);
          } catch (err: unknown) {
            failedCount++;
            const msg = err instanceof Error ? err.message : String(err);
            addLog(`导出失败 [${itemLabel}]: ${msg}`, 'error');
          }
        }
      });

      if (allItems.length > 0) {
        setItems(allItems);
      }
      if (!resumeUrlRef.current) setAllLoaded(true);

      const summary = [
        `导出完成：本次导出 ${exportedInBatch - failedCount} 篇，共已导出 ${useExportStore.getState().progressData?.articles.totalExported ?? 0} 篇`,
      ];
      if (failedCount > 0) summary.push(`失败 ${failedCount} 篇`);
      if (skippedCount > 0) summary.push(`跳过 ${skippedCount} 篇`);

      if (exportedInBatch > 0 || failedCount > 0) {
        await updateReadme(collectionFolder);
        addLog(summary.join('，'), failedCount > 0 ? 'warn' : 'success');
      } else {
        addLog('没有需要导出的新内容', 'warn');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`导出失败: ${msg}`, 'error');
    } finally {
      setIsExportingArticles(false);
      setExportProgress(null);
    }
  }, [
    collectionId,
    collectionName,
    fetchPages,
    appendItems,
    updateReadme,
    addLog,
    setIsExportingArticles,
    setExportProgress,
    setItems,
  ]);

  const exported = progressData?.articles.totalExported ?? 0;
  const totalCount = typeCounts
    ? ALL_EXPORT_TYPES.reduce((sum, t) => sum + (typeCounts[t] ?? 0), 0)
    : null;
  const dateInfo = progressData?.articles.newestExportedTime
    ? `（截至 ${new Date(progressData.articles.newestExportedTime).toLocaleDateString('zh-CN')}）`
    : '';

  const buttonText = isExportingArticles
    ? '导出中...'
    : selectedIds.size > 0
      ? `导出选中的 ${selectedIds.size} 篇`
      : exported > 0
        ? '导出全部（跳过已导出）'
        : '开始导出';

  const progressPercent =
    exportProgress && exportProgress.total > 0
      ? Math.round((exportProgress.current / exportProgress.total) * 100)
      : 0;

  return (
    <Card title={<><span className="title-decoration">二</span>文章导出</>}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 20px', marginBottom: 12 }}>
        <Space size={6}>
          <Typography.Text style={{ fontSize: 13 }}>格式</Typography.Text>
          <Segmented
            value={format}
            onChange={(v) => setFormat(v as 'md' | 'docx')}
            options={[
              { label: 'Markdown', value: 'md' },
              { label: 'Word', value: 'docx' },
            ]}
            size="small"
          />
        </Space>
        <Space size={6}>
          <Typography.Text style={{ fontSize: 13 }}>下载图片</Typography.Text>
          <Switch checked={wantImages} onChange={setWantImages} size="small" />
        </Space>
        <Space size={6}>
          <Typography.Text style={{ fontSize: 13 }}>同时导出评论</Typography.Text>
          <Switch checked={exportWithComments} onChange={setExportWithComments} size="small" />
        </Space>
      </div>

      <Divider style={{ margin: '8px 0' }} />

      <Typography.Text style={{ fontSize: 13, marginBottom: 6, display: 'block' }}>
        导出内容类型{totalCount !== null ? `（总数量 ${totalCount}）` : ''}
      </Typography.Text>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 8 }}>
        {ALL_EXPORT_TYPES.map((typeKey) => (
          <Checkbox
            key={typeKey}
            checked={enabledTypes[typeKey]}
            onChange={(e) => setEnabledType(typeKey, e.target.checked)}
          >
            {TYPE_CHECKBOX_LABELS[typeKey]}
            {typeCounts && typeCounts[typeKey] !== undefined && (
              <span style={{ color: 'var(--mo-faint, #7B8A9A)', marginLeft: 4 }}>{typeCounts[typeKey]}</span>
            )}
          </Checkbox>
        ))}
      </div>

      <Divider style={{ margin: '8px 0' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Typography.Text style={{ minWidth: 0 }}>
          已导出 {exported} / {listItems.length}{allLoaded ? '' : '+'} 篇{dateInfo}
        </Typography.Text>
        <Button
          type="primary"
          onClick={handleExport}
          loading={isExportingArticles}
        >
          {buttonText}
        </Button>
      </div>

      <div style={{ marginTop: 4 }}>
        <span className="note-text">每类内容存入单独文件夹，文件名含日期前缀</span>
      </div>

      {exportProgress && (
        <div style={{ marginTop: 8 }}>
          <Progress percent={progressPercent} size="small" />
          <Typography.Text type="secondary">{exportProgress.text}</Typography.Text>
        </div>
      )}

      {(listItems.length > 0 || listLoading) && (
        <>
          <Divider style={{ margin: '12px 0 8px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Typography.Text style={{ fontSize: 13 }}>
              文章列表（{listItems.length} 篇{listLoading ? '，加载中...' : allLoaded ? '' : '，已部分加载'}）
            </Typography.Text>
            <Space size={4}>
              {listLoading && (
                <Button size="small" danger onClick={handleStopLoading}>
                  停止加载
                </Button>
              )}
              {!allLoaded && !listLoading && (
                <Button size="small" type="link" onClick={handleLoadAll} disabled={isExportingArticles}>
                  {loadPaused ? '继续加载' : '加载全部目录'}
                </Button>
              )}
              <Button
                size="small"
                onClick={() => setSelectedIds(new Set(listItems.map((i) => i.id)))}
                disabled={isExportingArticles}
              >
                全选
              </Button>
              <Button
                size="small"
                onClick={() => setSelectedIds(new Set())}
                disabled={isExportingArticles}
              >
                全不选
              </Button>
              <Button
                size="small"
                onClick={() => setSelectedIds(new Set(listItems.filter((i) => !exportedSet.has(i.id)).map((i) => i.id)))}
                disabled={isExportingArticles}
              >
                选中未导出
              </Button>
            </Space>
          </div>
          {listLoading && (
            <div style={{ marginBottom: 8 }}>
              <Progress percent={100} status="active" showInfo={false} size="small" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                正在加载目录{listItems.length > 0 ? `，已加载 ${listItems.length} 篇` : ''}…
              </Typography.Text>
            </div>
          )}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <List
              size="small"
              dataSource={listItems}
              renderItem={(item) => {
                const isExported = exportedSet.has(item.id);
                return (
                  <List.Item style={{ padding: '6px 0' }}>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Checkbox
                        checked={selectedIds.has(item.id)}
                        onChange={(e) => setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(item.id); else next.delete(item.id);
                          return next;
                        })}
                        disabled={isExportingArticles}
                      />
                      <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                        {item.title || `${item.author}的${TYPE_LABELS[item.type] || item.type}`}
                      </Typography.Text>
                      <Tag style={{ flexShrink: 0, marginRight: 0 }}>{TYPE_LABELS[item.type] || item.type}</Tag>
                      <Tag color={isExported ? 'green' : undefined} style={{ flexShrink: 0, marginRight: 0 }}>
                        {isExported ? '已导出' : '未导出'}
                      </Tag>
                    </div>
                  </List.Item>
                );
              }}
            />
          </div>
        </>
      )}
    </Card>
  );
}
