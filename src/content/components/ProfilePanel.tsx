import React from 'react';
import { Button, Tag, Space, Typography } from 'antd';
import type { CollectionInfo } from '@/types/zhihu';

interface Props {
  info: CollectionInfo;
}

export function ProfilePanel({ info }: Props) {
  const openExportManager = () => {
    const countsParam = info.typeCounts && Object.keys(info.typeCounts).length > 0
      ? `&counts=${encodeURIComponent(JSON.stringify(info.typeCounts))}`
      : '';
    const exportUrl = chrome.runtime.getURL(
      `src/export/index.html?id=${encodeURIComponent(info.id)}&name=${encodeURIComponent(info.title)}&api=${encodeURIComponent(info.apiUrl)}&source=profile${countsParam}`
    );
    chrome.runtime.sendMessage({ action: 'openExportPage', url: exportUrl });
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div><Tag color="purple">个人主页</Tag></div>
      <Typography.Text strong>{info.title}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        导出该用户的文章、回答、问题、想法、收藏夹、专栏
      </Typography.Text>
      <Button type="primary" block onClick={openExportManager}>
        打开导出管理器
      </Button>
    </Space>
  );
}
