// 接口访问层（唯一出口）。
// 页面/组件只调这里，不关心后面是 mock 还是真后端。
//
// 对齐 docs/04-后端接口契约.md：
// - 响应封套 { ok, data, request_id }；失败 { ok:false, error:{code,message,detail} }
// - 前端按 error.code 分支（1.4 错误码表），不按文案
// - 默认走 services/mock.js；在「我的 → 开发自测」打开「使用真后端」后走真后端（不重新编译）
import { useMock, getApiBaseUrl } from '@/common/config.js';
import { getDeviceId } from '@/common/deviceId.js';
import { httpRequest, httpUploadAny } from '@/services/transport.js';
import mock from '@/services/mock.js';

const TOKEN_KEY = 'qiuzhibilei_token';

export function getToken() {
  try {
    return uni.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

export function setToken(token) {
  try {
    uni.setStorageSync(TOKEN_KEY, token || '');
  } catch (e) {
    // 忽略存储异常
  }
}

export function clearToken() {
  try {
    uni.removeStorageSync(TOKEN_KEY);
  } catch (e) {
    // 忽略存储异常
  }
}

// 统一的接口错误对象：页面按 code 分支
export class ApiError extends Error {
  constructor(code, message, detail) {
    super(message || '请求失败');
    this.code = code || 'INTERNAL_ERROR';
    this.detail = detail || {};
  }
}

// 客户端请求号（幂等键 / 广告领奖 request_id）
export function newRequestId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 真实网络请求（后端就绪后启用）
// 返回封套里的 data；失败抛 ApiError
// 传输层（云托管 callContainer / 普通 uni.request）在 services/transport.js 里选，这里不关心。
// 导出给 services/community.js 用（广场接口已按广场下架令挪到单独文件）。
// 注意：这里**不再有任何社区相关分支**——设备标识由 community.js 通过 extraHeader 自己带，
// 提审包里因此不会出现 /community/ 字样（自检会硬性核对）。
export function request(path, method = 'GET', data = null, extraHeader = {}) {
  const headers = {
    'content-type': 'application/json',
    'X-Request-Id': newRequestId(),
    Authorization: getToken() ? 'Bearer ' + getToken() : '',
  };

  return httpRequest({
    path,
    method,
    data,
    header: Object.assign(headers, extraHeader),
  }).then(
    (res) => {
      const body = res.data || {};
      if (body.ok === true) return body.data;
      const err = body.error || {};
      // 云托管对未匹配路由返回平台级错误体，统一成 INTERNAL_ERROR 更可读
      if (!err.code && res.statusCode >= 500) {
        throw new ApiError('INTERNAL_ERROR', '服务暂时不可用（' + res.statusCode + '）');
      }
      throw new ApiError(err.code, err.message, err.detail);
    },
    (e) => {
      throw new ApiError('INTERNAL_ERROR', (e && e.message) || '网络异常');
    }
  );
}

// 统一拆 mock 封套：ok → data；失败 → 抛 ApiError（与真实请求行为一致）
function unwrap(promise) {
  return promise.then((body) => {
    if (body && body.ok === true) return body.data;
    const err = (body && body.error) || {};
    throw new ApiError(err.code, err.message, err.detail);
  });
}

// ---------- 契约 12 个端点（前端用到 9 个） ----------

// 2.1 POST /auth/login
// 真后端模式下：没有正式 AppID 时，后端用 Mock 适配器（响应里 platform_mode='mock'），
// 前端照常把平台 login 拿到的 code 传过去即可，不需要额外 dev 通道。
// 真实 code2session 的请求体在 docs/04 定稿后按需调整（见 docs/07 待办）。
export function loginByCode(code, platform) {
  if (useMock()) return unwrap(mock.postAuthLogin({ code, platform }));
  return request('/auth/login', 'POST', { code, platform });
}

// 当前是否走真后端（给「开发自测」页展示用）
export function isRealBackend() {
  return !useMock();
}

// 2.2 GET /me
export function fetchMe() {
  if (useMock()) return unwrap(mock.getMe());
  return request('/me');
}

// 2.3a 截图上传（D9）：一次一张，多图循环调用，拿到 image_id 列表再提交分析。
// 走哪条通道由 transport 决定：云托管 → base64 JSON，本地/公网 → multipart。
export function uploadImage(filePath, { ocrText = '' } = {}) {
  if (useMock()) return unwrap(mock.postAnalysisUpload({ filePath, ocr_text: ocrText }));
  const header = {
    'X-Request-Id': newRequestId(),
    Authorization: getToken() ? 'Bearer ' + getToken() : '',
  };
  return httpUploadAny({
    path: '/analysis/upload',
    base64Path: '/analysis/upload-base64',
    filePath,
    name: 'image',
    formData: ocrText ? { ocr_text: ocrText } : {},
    header,
  }).then(
    (res) => {
      const body = res.data || {};
      if (body.ok === true) return body.data;
      const err = body.error || {};
      throw new ApiError(err.code, err.message, err.detail);
    },
    (e) => {
      throw new ApiError('INTERNAL_ERROR', (e && e.message) || '上传失败');
    }
  );
}

// 2.3b POST /analysis（D9：JSON {image_ids, idempotency_key}，立即返回 task_id，不等分析结果）
// 真实环境分两步：先 uploadImage 拿 image_ids，再 createAnalysis 提交。
export function createAnalysis({ files = [], imageIds = [], ocrText = '', idemKey = '', filePath = '' } = {}) {
  if (useMock()) return unwrap(mock.postAnalysis({ files, image_ids: imageIds, ocr_text: ocrText, idem_key: idemKey }));
  // 兼容旧式单文件直传（后端未开通 upload 前）：没给 imageIds 就走 multipart
  if (!imageIds.length) {
    return uploadImage(filePath, { ocrText }).then((up) =>
      request(
        '/analysis',
        'POST',
        { image_ids: [up.image_id], idempotency_key: idemKey || '' },
        idemKey ? { 'Idempotency-Key': idemKey } : {}
      )
    );
  }
  return request(
    '/analysis',
    'POST',
    { image_ids: imageIds, idempotency_key: idemKey || '', ocr_text: ocrText || undefined },
    idemKey ? { 'Idempotency-Key': idemKey } : {}
  );
}

// 2.4 GET /analysis/{id}（轮询）
export function fetchAnalysis(taskId) {
  if (useMock()) return unwrap(mock.getAnalysis(taskId));
  return request('/analysis/' + encodeURIComponent(taskId));
}

// 2.5 GET /reports
export function fetchReports(params) {
  if (useMock()) return unwrap(mock.getReports(params));
  const q = params && params.cursor ? '?cursor=' + encodeURIComponent(params.cursor) : '';
  return request('/reports' + q);
}

// 2.6 POST /ad/reward
// result 必须是 completed / no_fill / error；服务端对三种都发次数（§6.2 强制兜底）
export function claimAdReward({ requestId, adUnitId = '', result = 'completed' }) {
  if (useMock()) {
    return unwrap(mock.postAdReward({ request_id: requestId, ad_unit_id: adUnitId, result }));
  }
  return request('/ad/reward', 'POST', {
    request_id: requestId,
    ad_unit_id: adUnitId,
    result,
  });
}

// 2.7 POST /orders
export function createOrder(plan, channel) {
  if (useMock()) return unwrap(mock.postOrders({ plan, channel }));
  return request('/orders', 'POST', { plan, channel });
}

// 2.9 POST /feedback
export function submitFeedback(payload) {
  if (useMock()) return unwrap(mock.postFeedback(payload));
  return request('/feedback', 'POST', payload);
}

// GET /plans（只读定价，Chief 已批）：价格与权益由服务端下发，前端不写死
export function fetchMemberPlans() {
  if (useMock()) return unwrap(mock.getPlans()).then((d) => d.plans || []);
  return request('/plans').then((d) => (d && d.plans) || []);
}

// ---- 1.1.0：手机端检查完成后的次数接口（AI版上架令第三节第 4 条）----
// 检查在手机上完成，不走原来的任务流程，所以要一个轻接口把次数落到服务端。
// 失败不拦用户：调用方 catch 掉、先记本地，下次启动补报。

// POST /quota/consume —— 出了有效报告才调；「不是招聘内容」不调
export function consumeQuota(idempotencyKey) {
  return request('/quota/consume', 'POST', { idempotency_key: idempotencyKey || '' });
}

// POST /quota/topup —— 每天第一次打开时补足次数（广告开通前）
export function topupDaily() {
  return request('/quota/topup', 'POST', {});
}


// 求助广场的接口已整体挪到 services/community.js（广场下架令 2026-11-10），
// 这里不再导出，提审包里因此不会出现 /community/ 与广场相关字样。
export default {
  loginByCode,
  fetchMe,
  uploadImage,
  createAnalysis,
  fetchAnalysis,
  fetchReports,
  claimAdReward,
  createOrder,
  submitFeedback,
  fetchMemberPlans,
  consumeQuota,
  topupDaily,
  getToken,
  setToken,
  clearToken,
  newRequestId,
  ApiError,
};
