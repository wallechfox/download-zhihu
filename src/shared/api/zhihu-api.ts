/**
 * 知乎 API 调用层
 * 从 detector.js 抽取，使用 throttledFetch 实现请求节流
 */

import * as throttle from './throttle';
import { proxyFetchWithRetry, type FetchLikeResponse } from './proxy-fetch';
import { ApiError } from '@/types/messages';
import { pinTitleFromHtml, decodeHtmlEntities } from '@/shared/utils/export-utils';
import type { PageInfo, ContentItem, PaginatedResult, ZhihuComment } from '@/types/zhihu';

// 检测是否运行在 Extension Page（非知乎域名）
const isExtensionPage = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';

type ApiFetchResponse = Response | FetchLikeResponse;

/**
 * API 请求：
 * - 在知乎页面（content script）：直接 fetch（同源）
 * - 在 Extension Page：通过 service worker → content script 代理（含 403 重试）
 */
async function apiFetch(url: string, responseType?: string): Promise<ApiFetchResponse> {
  await throttle.waitForInterval();

  if (isExtensionPage) {
    return proxyFetchWithRetry(url, responseType);
  }

  return throttle.throttledFetch(url, {
    credentials: 'include',
    headers: { 'Accept': '*/*' },
  });
}

// 知乎 API 的 paging.next 可能返回 http://，修正为 https://
function fixHttpUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.replace(/^http:\/\//, 'https://');
}

// ============================
// 页面类型检测（纯函数，无 DOM 依赖）
// ============================

export function detectPage(url: string): PageInfo | null {
  const patterns = [
    { type: 'answer' as const, regex: /zhihu\.com\/question\/(\d+)\/answer\/(\d+)/ },
    { type: 'article' as const, regex: /zhuanlan\.zhihu\.com\/p\/(\d+)/ },
    { type: 'question' as const, regex: /zhihu\.com\/question\/(\d+)\/?(\?|$|#)/ },
    { type: 'pin' as const, regex: /zhihu\.com\/pin\/(\d+)/ },
    { type: 'collection' as const, regex: /zhihu\.com\/collection\/(\d+)/ },
    { type: 'column' as const, regex: /zhihu\.com\/column\/([^/?#]+)/ },
    { type: 'column' as const, regex: /zhuanlan\.zhihu\.com\/([^/?#p][^/?#]*)/ },
    { type: 'profile' as const, regex: /zhihu\.com\/people\/([^/?#]+)/ },
  ];

  for (const { type, regex } of patterns) {
    const match = url.match(regex);
    if (match) {
      const id = type === 'answer' ? match[2] : match[1];
      return { type, id };
    }
  }
  return null;
}

// ============================
// 收藏夹 API
// ============================

export async function fetchCollectionPage(apiUrl: string): Promise<PaginatedResult> {
  const response = await apiFetch(apiUrl);

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  const data = await response.json() as any;
  const paging = data.paging || {};
  // 收藏夹的 item.content 是实际内容对象，item.created 是收藏时间（ISO 字符串）
  const items: ContentItem[] = (data.data || []).map((item: any) => {
    const collectedTime = item.created
      ? Math.floor(new Date(item.created).getTime() / 1000)
      : 0;
    return parseContentItem(item.content || {}, collectedTime);
  });

  return {
    items,
    nextUrl: paging.is_end ? null : fixHttpUrl(paging.next),
    totals: paging.totals || 0,
  };
}

// ============================
// 专栏 API
// ============================

/**
 * 解析单个内容条目（收藏夹和专栏共用）
 * 收藏夹的 c = item.content，专栏的 c = item 本身
 */
/** 想法 content 为段落数组时，递归提取其中的纯文本 */
function collectPinPlainText(segments: any[]): string {
  const out: string[] = [];
  const walk = (node: any): void => {
    if (!node) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node.type === 'image' || node.type === 'video') return;
    if (typeof node.text === 'string') out.push(node.text);
    if (node.data && typeof node.data.text === 'string') out.push(node.data.text);
    if (node.content !== undefined) walk(node.content);
  };
  walk(segments);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseContentItem(c: any, createdTime: number): ContentItem {
  const type = c.type || 'unknown';

  let title = '';
  let html = '';

  if (type === 'article') {
    title = c.title || '';
    html = c.content || '';
  } else if (type === 'answer') {
    title = c.question?.title || '';
    html = c.content || '';
  } else if (type === 'pin') {
    const plainFromSegments = Array.isArray(c.content) ? collectPinPlainText(c.content) : '';
    html = (typeof c.content === 'string' ? c.content : '') || (c.excerpt ? decodeHtmlEntities(c.excerpt) : '');
    if (Array.isArray(c.content)) {
      const imgsHtml = c.content
        .filter((e: any) => e?.type === 'image' && e?.url)
        .map((e: any) => `<img src="${e.url}" alt="" />`)
        .join('\n');
      if (plainFromSegments && !html) {
        html = plainFromSegments.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      if (imgsHtml) html += `\n${imgsHtml}`;
    }
    title = pinTitleFromHtml(html) || '想法';
  } else {
    html = (typeof c.content === 'string' ? c.content : '') || (c.excerpt ? decodeHtmlEntities(c.excerpt) : '');
    title = c.title || '';
  }

  const rawId = c.id || '';
  const id = rawId
    ? String(rawId)
    : (c.url || `${type}_${createdTime || Math.random()}`);

  return {
    id,
    type,
    url: c.url || '',
    title,
    author: c.author?.name || '知乎用户',
    html,
    isTruncated: !!(c.content_need_truncated),
    isPaidContent: c.is_free === 0,
    commentCount: c.comment_count || 0,
    created_time: c.created_time || c.created || createdTime,
    updated_time: c.updated_time || c.updated || 0,
    collected_time: createdTime || undefined,
  };
}

export async function fetchColumnPage(apiUrl: string): Promise<PaginatedResult> {
  const response = await apiFetch(apiUrl);

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  const data = await response.json() as any;
  const paging = data.paging || {};
  // 专栏的 items 直接就是内容对象（不像收藏夹有 item.content 嵌套）
  const items: ContentItem[] = (data.data || []).map((c: any) =>
    parseContentItem(c, c.created_time || c.created || 0)
  );

  return {
    items,
    nextUrl: paging.is_end ? null : fixHttpUrl(paging.next),
    totals: paging.totals || items.length,
  };
}

// ============================
// 评论 API
// ============================

const COMMENT_TYPE_MAP: Record<string, string> = {
  article: 'articles',
  answer: 'answers',
  pin: 'pins',
};

export async function fetchRootComments(type: string, id: string): Promise<{ comments: ZhihuComment[]; totals: number }> {
  const apiType = COMMENT_TYPE_MAP[type];
  if (!apiType) return { comments: [], totals: 0 };

  const comments: ZhihuComment[] = [];
  let totals = 0;
  let prevUrl = '';
  let nextUrl: string | null = `https://www.zhihu.com/api/v4/comment_v5/${apiType}/${id}/root_comment?order_by=score&limit=20&offset=`;

  while (nextUrl) {
    const response = await apiFetch(nextUrl);
    if (!response.ok) {
      const err = new ApiError(
        response.status === 403
          ? '请求被知乎限流（HTTP 403），可能需要完成验证码验证。请在知乎页面完成验证后重试。'
          : `评论 API 请求失败: ${response.status}`,
        response.status
      );
      throw err;
    }

    const data = await response.json() as any;
    const paging = data.paging || {};
    const pageData = data.data || [];
    totals = paging.totals ?? totals;

    // 防止死循环：data 为空或 next 指向自身则停止
    if (pageData.length === 0) break;

    comments.push(...pageData);

    if (paging.is_end) break;
    const candidate = paging.next || null;
    if (!candidate || candidate === prevUrl || candidate === nextUrl) break;
    prevUrl = nextUrl;
    nextUrl = candidate;
  }

  return { comments, totals };
}

export async function fetchChildComments(rootCommentId: string): Promise<ZhihuComment[]> {
  const children: ZhihuComment[] = [];
  let prevUrl = '';
  let nextUrl: string | null = `https://www.zhihu.com/api/v4/comment_v5/comment/${rootCommentId}/child_comment?order_by=score&limit=20&offset=`;

  while (nextUrl) {
    const response = await apiFetch(nextUrl);
    if (!response.ok) {
      throw new Error(`子评论请求失败: ${response.status}`);
    }

    const data = await response.json() as any;
    const paging = data.paging || {};
    const pageData = data.data || [];

    if (pageData.length === 0) break;

    children.push(...pageData);

    if (paging.is_end) break;
    const candidate = paging.next || null;
    if (!candidate || candidate === prevUrl || candidate === nextUrl) break;
    prevUrl = nextUrl;
    nextUrl = candidate;
  }

  return children;
}

export async function fetchAllComments(
  type: string,
  id: string,
  onProgress?: (done: number, total: number) => void
): Promise<ZhihuComment[]> {
  const { comments } = await fetchRootComments(type, id);

  let rateLimited = false;

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];

    if (comment.child_comment_count > 0) {
      try {
        comment.child_comments = await fetchChildComments(comment.id);
      } catch (err: any) {
        // 403 被限流时中断整个评论获取，提示用户
        if (err.httpStatus === 403 || err.message?.includes('403')) {
          rateLimited = true;
          comment.child_comments = [];
          break;
        }
        // 其他错误：跳过该评论的子评论，继续处理下一条
        console.warn(`子评论加载失败 (comment ${comment.id}):`, err.message);
        comment.child_comments = [];
      }
    }

    if (onProgress) onProgress(i + 1, comments.length);
  }

  if (rateLimited) {
    const err = new ApiError(
      '请求被知乎限流（HTTP 403），可能需要完成验证码验证。请在知乎页面完成验证后重试。',
      403
    );
    err.partialComments = comments;
    throw err;
  }

  return comments;
}

// ============================
// 单篇完整内容 API
// ============================

/**
 * 检查付费内容用户是否已购买
 * @returns true 表示已购买可访问完整内容
 */
export async function checkPaidAccess(type: string, id: string): Promise<boolean> {
  try {
    const apiUrl = `https://www.zhihu.com/api/v4/column/paid-column/card?content_type=${type}&content_id=${id}`;
    const response = await apiFetch(apiUrl);
    if (!response.ok) return false;
    const data = await response.json() as any;
    return !!(data.data?.has_purchased || data.data?.has_ownership);
  } catch {
    return false;
  }
}

/**
 * 获取单篇文章/回答的完整内容
 * 访问文章页面，从 initialData 和 DOM 两个来源提取，取更长的
 * 与单篇导出使用相同的逻辑
 */
export async function fetchFullContent(type: string, itemUrl: string): Promise<string | null> {
  if (!itemUrl) return null;

  const response = await apiFetch(itemUrl, 'text');
  if (!response.ok) return null;

  const pageHtml = await response.text() as string;
  if (!pageHtml) return null;

  const pageInfo = detectPage(itemUrl);
  if (!pageInfo) return null;

  // 来源 1：从 initialData 提取
  let fromData = '';
  const scriptMatch = pageHtml.match(/<script\s+id="js-initialData"\s+type="text\/json">([^<]+)<\/script>/);
  if (scriptMatch) {
    try {
      const initialData = JSON.parse(scriptMatch[1]);
      if (type === 'article') {
        fromData = initialData?.initialState?.entities?.articles?.[pageInfo.id]?.content || '';
      } else if (type === 'answer') {
        fromData = initialData?.initialState?.entities?.answers?.[pageInfo.id]?.content || '';
      }
    } catch { /* 解析失败 */ }
  }

  // 来源 2：从 DOM 提取
  let fromDOM = '';
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');
  if (type === 'article') {
    fromDOM = doc.querySelector('.Post-RichText')?.innerHTML || '';
  } else if (type === 'answer') {
    fromDOM = doc.querySelector('.RichContent-inner')?.innerHTML || '';
  }

  // 取更长的
  return fromDOM.length > fromData.length ? fromDOM : (fromData || null);
}

// ============================
// 个人主页动态 API
// ============================

/** 个人主页动态中需要导出的 verb 类型 */
const PROFILE_VERBS = new Set([
  'MEMBER_CREATE_ARTICLE',
  'MEMBER_ANSWER_QUESTION',
  'MEMBER_CREATE_PIN',
  'MEMBER_ASK_QUESTION',
]);

/** 从个人主页 API URL 提取用户 token */
function extractProfileToken(apiUrl: string): string | null {
  const match = apiUrl.match(/\/members\/([^/?]+)/);
  return match ? match[1] : null;
}

/** 解析收藏夹为 ContentItem */
function parseCollectionItem(c: any): ContentItem {
  return {
    id: `collection_${c.id || ''}`,
    type: 'collection',
    url: c.url || `https://www.zhihu.com/collection/${c.id}`,
    title: c.title || '未命名收藏夹',
    author: c.creator?.name || '知乎用户',
    html: c.description || '',
    isTruncated: false,
    isPaidContent: false,
    commentCount: 0,
    created_time: c.created_time || 0,
    updated_time: c.updated_time || 0,
  };
}

/** 解析专栏为 ContentItem */
function parseColumnItem(c: any): ContentItem {
  return {
    id: `column_${c.id || ''}`,
    type: 'column',
    url: c.url || `https://zhuanlan.zhihu.com/${c.id}`,
    title: c.title || '未命名专栏',
    author: c.author?.name || c.contributors?.[0]?.name || '知乎用户',
    html: c.description || '',
    isTruncated: false,
    isPaidContent: false,
    commentCount: 0,
    created_time: c.created_time || 0,
    updated_time: c.updated_time || 0,
  };
}

// 已附加过收藏夹/专栏条目的主页 token（避免分页重复附加）
const profileExtraAttached = new Set<string>();

export async function fetchProfilePage(apiUrl: string): Promise<PaginatedResult> {
  const response = await apiFetch(apiUrl);

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  const data = await response.json() as any;
  const paging = data.paging || {};

  const items: ContentItem[] = (data.data || [])
    .filter((item: any) => PROFILE_VERBS.has(item.verb))
    .map((item: any) => {
      const target = item.target || {};
      return parseContentItem(target, target.created_time || item.created_time || 0);
    });

  // 第一页时附加一次该用户的收藏夹和专栏
  const token = extractProfileToken(apiUrl);
  const isFirstPage = !paging.previous;
  if (token && isFirstPage && !profileExtraAttached.has(token)) {
    profileExtraAttached.add(token);
    try {
      const [collectionsRes, columnsRes] = await Promise.all([
        apiFetch(`https://www.zhihu.com/api/v4/people/${token}/collections`).catch(() => null),
        apiFetch(`https://www.zhihu.com/api/v4/columns?author=${token}`).catch(() => null),
      ]);

      if (collectionsRes?.ok) {
        const collData = await collectionsRes.json() as any;
        const collItems = (collData.data || []).map(parseCollectionItem);
        items.push(...collItems);
      }

      if (columnsRes?.ok) {
        const colData = await columnsRes.json() as any;
        const colItems = (colData.data || []).map(parseColumnItem);
        items.push(...colItems);
      }
    } catch {
      // 收藏夹/专栏获取失败不影响主流程
    }
  }

  return {
    items,
    nextUrl: paging.is_end ? null : fixHttpUrl(paging.next),
    totals: paging.totals || 0,
  };
}
