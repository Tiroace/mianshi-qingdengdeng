// 求助广场（社区）接口：**只给广场三个页面用**。
//
// 为什么单独一个文件（广场下架令 2026-11-10）：
// 1.0.7 因求助广场属于社交功能被驳回（个人主体不开放该品类）。审核看的是整个代码包，
// 不看入口能不能点到。把社区接口留在 api.js 的 export default 里，即使页面删了，
// 公共 JS 里仍有引用，包内仍会残留 /community/ 等字样。
//
// 所以：社区接口全部挪到这里，只有 pages/square、pages/post、pages/post-create 引用；
// 提审包在编译前就删掉这三个页面（build-engine.mjs），本文件因此不会被打进提审包。
//
// 源码保留：以后换成企业主体、申请到对应类目再启用。提审包里一点都不能有。
import { useMock } from '@/common/config.js';
import { getDeviceId } from '@/common/deviceId.js';
import { request } from '@/services/api.js';

// 社区接口带设备标识（D18 防刷）。取不到就不带，后端退回 openid+IP，不能因此报错。
// 以前这段在 api.js 里按路径前缀判断；现在社区请求只从这里发出，直接带上更明确，
// 也让 api.js 里不再出现任何 /community/ 字样（提审包自检要求为 0）。
function communityRequest(path, method = 'GET', data = null) {
  const deviceId = getDeviceId();
  const header = deviceId ? { 'X-Device-Id': deviceId } : {};
  return request(path, method, data, header);
}

// 判断某个错误是不是「社区未开放」
export function isCommunityClosed(err) {
  return !!(err && err.code === 'NOT_FOUND');
}

// 3.1 GET /community/posts —— 列表：sort=latest/active/voted，q 搜索
export function fetchPosts({ sort = 'latest', q = '', limit = 20, cursor = '' } = {}) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockListPosts({ sort, q, limit, cursor }));
  }
  const qs = [];
  if (sort) qs.push('sort=' + encodeURIComponent(sort));
  if (q) qs.push('q=' + encodeURIComponent(q));
  if (limit) qs.push('limit=' + limit);
  if (cursor) qs.push('cursor=' + encodeURIComponent(cursor));
  return communityRequest('/community/posts' + (qs.length ? '?' + qs.join('&') : ''));
}

// 3.1 GET /community/posts/{id} —— 详情
export function fetchPostDetail(postId) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockPostDetail(postId));
  }
  return communityRequest('/community/posts/' + encodeURIComponent(postId));
}

// 3.1 POST /community/posts —— 发帖（先审后发）
export function createPost(payload) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockCreatePost(payload));
  }
  return communityRequest('/community/posts', 'POST', payload);
}

// 3.1 POST /community/posts/{id}/vote —— 投票 value: 1/-1/0（0=取消）
export function votePost(postId, value, reason) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockVote(postId, value, reason));
  }
  return communityRequest('/community/posts/' + encodeURIComponent(postId) + '/vote', 'POST', {
    value,
    reason: reason || '',
  });
}

// 3.1 GET /community/posts/{id}/experiences
export function fetchExperiences(postId) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockExperiences(postId));
  }
  return communityRequest('/community/posts/' + encodeURIComponent(postId) + '/experiences');
}

// 3.1 POST /community/posts/{id}/experiences —— 补充经历（先审后发）
export function createExperience(postId, content) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockCreateExperience(postId, content));
  }
  return communityRequest('/community/posts/' + encodeURIComponent(postId) + '/experiences', 'POST', { content });
}

// 3.1 POST /community/posts/{id}/report —— 举报
export function reportPost(postId, reason) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockReport(postId, reason));
  }
  return communityRequest('/community/posts/' + encodeURIComponent(postId) + '/report', 'POST', { reason: reason || '' });
}

// 3.1 POST /community/appeals —— 企业申诉
export function createAppeal(payload) {
  if (useMock()) {
    return import('@/services/communityMock.js').then((m) => m.mockAppeal(payload));
  }
  return communityRequest('/community/appeals', 'POST', payload);
}
