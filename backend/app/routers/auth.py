"""登录与用户信息（§5.4：POST /auth/login、GET /me）。

登录走平台适配层：有 AppID/Secret 走真实 code2session，没有走 Mock，
响应里用 `platform_mode` 标明，前端/测试不会把 mock 当真实登录。
"""
from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, Depends, Request

from ..config import get_settings
from ..deps import current_user, envelope, get_db
from ..errors import AppError
from ..models import LoginRequest
from ..platform import PlatformError, SessionInfo, get_adapter
from ..quota import balance, grant_register_bonus, today_ad_count
from ..security import issue_token

router = APIRouter(tags=["登录/用户"])


def _now() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _membership(conn, user_id: str) -> dict:
    row = conn.execute("SELECT * FROM memberships WHERE user_id = ?", (user_id,)).fetchone()
    settings = get_settings()
    if row is None or row["expires_at"] <= _now():
        return {"active": False, "plan": None, "expires_at": None, "daily_limit": None}
    return {
        "active": True,
        "plan": row["plan"],
        "expires_at": row["expires_at"],
        "daily_limit": settings.member_daily_quota,
    }


def _is_admin(conn, user_id: str, settings) -> bool:
    """是否管理员：看 openid 在不在 QBL_ADMIN_OPENIDS 里（逗号分隔）。

    管理员在正式版也不限次数、不显示广告（AI版上架令 3.3）。
    openid 为空或名单为空一律 False，不做任何「猜」。
    """
    raw = (settings.admin_openids or "").strip()
    if not raw:
        return False
    allow = {x.strip() for x in raw.split(",") if x.strip()}
    if not allow:
        return False
    row = conn.execute("SELECT openid FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return False
    return (row["openid"] or "") in allow


def _user_payload(conn, user_id: str) -> dict:
    settings = get_settings()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    adapter = get_adapter(user["platform"], settings)
    stats = conn.execute(
        "SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN risk_level = 'red' THEN 1 ELSE 0 END), 0) AS red"
        " FROM reports WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    ad = adapter.ad_config()
    today = today_ad_count(conn, user_id)
    ad["today_count"] = today
    ad["remaining_today"] = max(0, int(ad.get("daily_cap", 0)) - today)
    return {
        "user_id": user["id"],
        "platform": user["platform"],
        "created_at": user["created_at"],
        "quota": {"balance": balance(conn, user_id)},
        "membership": _membership(conn, user_id),
        "checked_count": int(stats["c"] or 0),
        "red_count": int(stats["red"] or 0),
        "ad": ad,
        # 管理员：正式版也不限次数、不显示广告
        "is_admin": _is_admin(conn, user_id, settings),
    }


@router.post("/auth/login")
def login(body: LoginRequest, request: Request) -> dict:
    """平台 code 换登录态。openid 由平台适配层给出（真实平台或 Mock）。

    **生产环境（QBL_ENV=prod）走云托管身份**（AI版上架令第二节）：
    小程序用 `wx.cloud.callContainer` 调本接口时，微信网关会自动注入 `X-WX-OPENID` 头，
    所以生产环境直接读这个头，不再调 jscode2session，也不再需要 QBL_WX_SECRET。
    读不到就 401——绝不回落到 Mock，否则任何人只要不带这个头就能自造一个身份。

    开发登录通道（B 关口联调 / 没有正式 AppID 时用）：
    - 仅当服务端 `QBL_DEV_MODE=1` 时启用，生产必须关闭；
    - `code=mock` 换一个固定的开发账号；`code=mock:<任意串>` 或 `X-Debug-User` 头可换不同开发账号；
    - 响应带 `dev_login: true`，前端/测试一眼能看出这不是真实平台登录。
    """
    settings = get_settings()

    # ---- 生产：只认云托管注入的身份头 ----
    if settings.is_production:
        wx_openid = (request.headers.get("X-WX-OPENID") or "").strip()
        if not wx_openid:
            # 生产环境没有身份头：拒绝。不回落到 code2session，也不回落到 Mock。
            raise AppError("UNKNOWN", "缺少身份信息，请从小程序内访问", 401)
        session = SessionInfo(openid=wx_openid, mode="cloud", raw={"source": "X-WX-OPENID"})
        adapter = None
        dev_code = False
    else:
        if not (body.code or "").strip():
            raise AppError("VALIDATION_ERROR", "缺少登录 code", 400)
        dev_code = body.code == "mock" or body.code.startswith("mock:")
        if dev_code:
            if not settings.dev_mode:
                raise AppError("DEV_LOGIN_DISABLED", "开发登录通道未开启（生产环境不允许）", 403)
            debug_user = (request.headers.get("X-Debug-User") or "").strip()
            suffix = debug_user or (body.code.split(":", 1)[1] if ":" in body.code else "default")
            suffix = "".join(ch for ch in suffix if ch.isalnum() or ch in "_-")[:32] or "default"
            session = SessionInfo(openid=f"dev-{body.platform}-{suffix}", mode="dev", raw={"dev": True})
            adapter = None
        else:
            adapter = get_adapter(body.platform, settings)
            # 生产环境禁止 Mock 回落（本分支在 is_production 为假时才进入，
            # 这里再判一次是防「将来有人改坏上面的分支」；开发/测试环境允许 Mock，
            # 否则 backend/tests 里的接口测试全部没法跑）。
            if settings.is_production and adapter.login_mode == "mock":
                raise AppError("PLATFORM_ERROR", "未配置平台凭据，无法真实登录", 502)
            try:
                session = adapter.code2session(body.code)
            except PlatformError as exc:
                raise AppError("PLATFORM_ERROR", str(exc), 502) from exc

    db = get_db(settings)
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT id FROM users WHERE platform = ? AND openid = ?", (body.platform, session.openid)
        ).fetchone()
        if row is None:
            user_id = "u_" + uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO users (id, platform, openid, unionid, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
                (user_id, body.platform, session.openid, session.unionid, _now()),
            )
            grant_register_bonus(conn, user_id, settings.free_quota)
        else:
            user_id = row["id"]

    with db.connect() as conn:
        payload = _user_payload(conn, user_id)
    payload["token"] = issue_token(user_id, settings.token_secret, settings.token_ttl_seconds)
    payload["is_new_user"] = row is None
    payload["platform_mode"] = session.mode          # mock / live / dev
    payload["dev_login"] = dev_code                  # 开发登录通道标记，前端不得在正式环境依赖
    return envelope(payload, request)


@router.get("/me")
def me(request: Request, user: dict = Depends(current_user)) -> dict:
    with get_db().connect() as conn:
        payload = _user_payload(conn, user["id"])
    settings = get_settings()
    payload["platform_mode"] = get_adapter(user["platform"], settings).login_mode
    return envelope(payload, request)
