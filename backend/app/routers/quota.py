"""额度接口（AI版上架令第三节第 4 条）。

手机上完成检查后调 `POST /quota/consume` 扣 1 次。为什么单独建这个接口：
1.1.0 的检查在手机本地/在模型调用里完成，不走原来的「创建分析任务」流程，
但次数仍然要落在服务端（否则重装小程序就能无限次）。

两条底线：
- 幂等：用报告编号做 key，重复调用不会重复扣。
- 失败不拦用户：余额不足只返回 granted=false，不抛错；前端照常显示报告。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..config import get_settings
from ..deps import current_user, envelope, get_db
from ..errors import AppError
from ..quota import balance, consume_once, topup_daily
from .auth import _is_admin

router = APIRouter(tags=["额度"])


class ConsumeRequest(BaseModel):
    # 用报告编号做幂等键；没带就拒绝，避免无 key 无限扣
    idempotency_key: str = Field(default="", max_length=120)


@router.post("/quota/consume")
def consume(body: ConsumeRequest, request: Request, user: dict = Depends(current_user)) -> dict:
    """扣 1 次。出了有效报告才调；「不是招聘内容」不调。"""
    key = (body.idempotency_key or "").strip()
    if not key:
        raise AppError("VALIDATION_ERROR", "缺少 idempotency_key", 400)
    db = get_db()
    with db.transaction() as conn:
        # 管理员（QBL_ADMIN_OPENIDS）不扣次数，服务端说了算，不靠前端自觉
        if _is_admin(conn, user["id"], get_settings()):
            return envelope({"granted": True, "reason": "admin", "balance": balance(conn, user["id"])}, request)
        result = consume_once(conn, user["id"], key)
    return envelope(result, request)


@router.post("/quota/topup")
def topup(request: Request, user: dict = Depends(current_user)) -> dict:
    """每天第一次打开时补足次数（广告开通前用）。

    幂等键按北京日期，一天只补一次；`QBL_DAILY_TOPUP=0` 时不做任何事。
    管理员（is_admin）由前端判断是否还需要调用，这里照常执行。
    """
    settings = get_settings()
    db = get_db()
    with db.transaction() as conn:
        result = topup_daily(conn, user["id"], settings.daily_topup)
        result["balance"] = balance(conn, user["id"])
    return envelope(result, request)
