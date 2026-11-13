// 截图识图：一次调用完成「认出文字 + 判断套路」。
//
// 1.1.1 起：手机不再直连 DeepSeek，也不再持有密钥（1.1.0 把密钥明文打进了包）。
// 截图压缩后发到自己服务器 POST /judge，服务器带密钥调 DeepSeek，原样返回模型 JSON。
// - 压缩复用云托管上传那套（≤200KB、长边 ≤1080），最多 3 张，避免撞 callContainer 请求体上限；
// - 要求模型把截图文字完整抄进 text，前端用 text 校验 evidence，找不到就丢；
// - 失败一律抛出，由上层静默退回服务器流程。
import { JUDGE_TIMEOUT, hasRealBackend } from '@/common/config.js';
import { PATTERN_IDS } from '@/common/patterns.js';
import { compressToBase64 } from '@/platform/image.js';
import { request } from '@/services/api.js';

export async function toBase64(filePath) {
  try {
    const img = await compressToBase64(filePath);
    return (img && img.base64) || null;
  } catch (e) {
    return null;
  }
}

// 只要接了真后端就可用；服务器没配密钥时 /judge 会报错，上层照旧退回旧流程
export function isVisionJudgeAvailable() {
  return hasRealBackend();
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// 调服务器 /judge：images 是 base64 数组（1-3 张）
export function judgeImages(images, { timeout = JUDGE_TIMEOUT } = {}) {
  if (!images || !images.length) return Promise.reject(new Error('NO_IMAGE'));
  return withTimeout(request('/judge', 'POST', { images: images.slice(0, 3) }), timeout).then((data) => {
    const raw = data && data.raw;
    if (!raw || typeof raw !== 'object') throw new Error('BAD_JSON');
    return { raw, usage: (data && data.usage) || null };
  });
}

// 前端校验：编号必须在白名单里；证据必须在模型抄录的 text 里（去空白后）逐字找到
export function validateHits(raw, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const body = norm(text);
  const seen = new Set();
  const hits = raw && Array.isArray(raw.hits) ? raw.hits : [];
  return hits
    .filter((h) => h && PATTERN_IDS.has(h.pattern_id) && h.evidence && body && body.includes(norm(h.evidence)))
    .filter((h) => (seen.has(h.pattern_id) ? false : (seen.add(h.pattern_id), true)));
}
