// 登录态与用户信息：轻量单例，页面通过 ensureLogin() / getUser() 取用。
// 字段按契约 2.1/2.2：{ user_id, platform, created_at, quota:{balance}, membership, platform_mode, ad }
import { loginByCode, fetchMe, setToken, clearToken, getToken, ApiError } from './api.js';
import { login as platformLogin, currentPlatform } from '@/platform/index.js';

let userCache = null;
let loginPromise = null;

export function getUser() {
  return userCache;
}

export function setUser(user) {
  userCache = user;
}

// 便捷取余额（契约里余额只有 quota.balance 一个口径）
export function getBalance() {
  return userCache && userCache.quota ? Number(userCache.quota.balance || 0) : 0;
}

export function isMember() {
  return !!(userCache && userCache.membership && userCache.membership.active);
}

// 确保已登录：已登录直接返回缓存，未登录则走平台登录 + 换 token
// 失败时抛错，由调用方决定是提示还是静默
export function ensureLogin() {
  if (userCache && getToken()) return Promise.resolve(userCache);
  if (loginPromise) return loginPromise;

  loginPromise = platformLogin()
    .then((res) =>
      // 契约 2.1：platform 取 toutiao / weixin
      loginByCode(res.code, currentPlatform.platform === 'weixin' ? 'weixin' : 'toutiao').then(
        (data) => {
          setToken(data.token);
          userCache = {
            user_id: data.user_id,
            platform: data.platform,
            created_at: data.created_at,
            quota: data.quota,
            membership: data.membership,
            platform_mode: data.platform_mode,
            ad: data.ad,
          };
          return userCache;
        }
      )
    )
    .then((user) => {
      loginPromise = null;
      return user;
    })
    .catch((err) => {
      loginPromise = null;
      throw err;
    });

  return loginPromise;
}

// 刷新用户信息（次数、会员状态）
export function refreshUser() {
  return fetchMe().then((u) => {
    userCache = u;
    return u;
  });
}

export function logoutLocal() {
  userCache = null;
  clearToken();
}

export function isLoggedIn() {
  return !!(userCache && getToken());
}

// ---- 1.1.0：启动时静默登录（AI版上架令第二节前端第 1、2 条）----
// 目标：打开小程序自动登录，用户不用点任何按钮。
// 三条硬规则：
//   1. 不阻塞首页——调用方不要 await，让它自己在后台跑；
//   2. 超过 5 秒没回来，当作「未登录」继续用，下次启动再试，不弹任何错误；
//   3. 失败不抛给用户，只记在内部状态里。

const SILENT_LOGIN_TIMEOUT = 5000;
let silentAttempted = false;

// 调 /auth/login 但不传 code（云托管会由微信网关带上 X-WX-OPENID）
function loginSilently() {
  return loginByCode('', 'weixin').then((data) => {
    setToken(data.token);
    userCache = {
      user_id: data.user_id,
      platform: data.platform,
      created_at: data.created_at,
      quota: data.quota,
      membership: data.membership,
      platform_mode: data.platform_mode,
      ad: data.ad,
      is_admin: data.is_admin === true,
    };
    return userCache;
  });
}

// 启动时调用一次。返回 Promise，但调用方**不要 await**（不阻塞首页）。
// 无论成功失败都 resolve，绝不 reject——登录不成功也不能让用户看到报错。
export function silentLogin() {
  if (silentAttempted) return Promise.resolve(userCache);
  if (userCache && getToken()) {
    silentAttempted = true;
    return Promise.resolve(userCache);
  }
  silentAttempted = true;

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    // 5 秒超时：当作未登录继续用（第 2 条）
    const timer = setTimeout(() => done(null), SILENT_LOGIN_TIMEOUT);
    loginSilently()
      .then((u) => {
        clearTimeout(timer);
        done(u);
      })
      .catch(() => {
        clearTimeout(timer);
        // 失败按未登录处理，次数先按本地算，下次启动再试
        done(null);
      });
  });
}

// 是否管理员：正式版也不限次数、不显示广告
export function isAdmin() {
  return !!(userCache && userCache.is_admin === true);
}

export { ApiError };
