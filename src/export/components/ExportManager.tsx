import React, { useEffect } from 'react';
import { Layout, Typography } from 'antd';
import styles from '@/shared/theme/ink-wash.module.css';
import { useUIStore } from '@/shared/stores/uiStore';
import { FolderPicker } from './FolderPicker';

import { ArticleList } from './ArticleList';
import { LogPanel } from './LogPanel';

const { Header, Content, Footer } = Layout;

export function ExportManager() {
  const params = new URLSearchParams(window.location.search);
  const collectionId = params.get('id') || '';
  const collectionName = params.get('name') || '未知';
  const collectionApiUrl = params.get('api') || '';
  const sourceType = (params.get('source') || 'collection') as 'collection' | 'column' | 'profile';
  const sourceLabel = sourceType === 'profile' ? '个人主页' : sourceType === 'column' ? '专栏' : '收藏夹';
  let typeCounts: Record<string, number> | undefined;
  try {
    const countsRaw = params.get('counts');
    if (countsRaw) typeCounts = JSON.parse(countsRaw);
  } catch { /* 数量解析失败不影响主流程 */ }
  const addLog = useUIStore((s) => s.addLog);

  useEffect(() => {
    document.title = `知乎文章下载器 V4.0 - ${sourceLabel} - ${collectionName}`;
    addLog(`已加载${sourceLabel}：${collectionName}（ID: ${collectionId}）`, 'info');
  }, []);

  return (
    <Layout className={`${styles.inkWashBg} export-app`} style={{ minHeight: '100vh', background: 'transparent' }}>
      <div className={styles.inkWash1} />
      <div className={styles.inkWash2} />
      <div className={styles.ricePaperTexture} />

      <Header className="app-header" style={{ background: 'transparent', height: 'auto', lineHeight: 'normal' }}>
        <div className="header-center">
          <Typography.Title level={2} className="app-title">知乎文章下载器 V4.0</Typography.Title>
          <Typography.Text className="app-subtitle">{sourceLabel}：{collectionName}</Typography.Text>
        </div>
        <div className="header-status">
          <span className="status-dot" />
          已就绪
        </div>
      </Header>

      <Content style={{ maxWidth: 1200, margin: '0 auto', padding: '1.5rem 2rem', width: '100%' }}>
        <div className="export-two-col">
          <div className="export-left-col">
            <FolderPicker collectionId={collectionId} collectionName={collectionName} />
            <ArticleList
              collectionId={collectionId}
              collectionName={collectionName}
              collectionApiUrl={collectionApiUrl}
              sourceType={sourceType}
              typeCounts={typeCounts}
            />
          </div>
          <div className="export-right-col">
            <LogPanel />
          </div>
        </div>
      </Content>

      <Footer className="app-footer" style={{ background: 'transparent' }}>
        <div className="footer-line" />
        <p>
          知乎文章下载器 V4.0 · 本项目开源，欢迎使用与反馈：
          <a href="https://github.com/wallechfox/download-zhihu" target="_blank" rel="noreferrer">
            https://github.com/wallechfox/download-zhihu
          </a>
          ，衍生自原作者
          <a href="https://github.com/chouheiwa/download-zhihu" target="_blank" rel="noreferrer">
            chouheiwa/download-zhihu
          </a>
        </p>
      </Footer>
    </Layout>
  );
}
