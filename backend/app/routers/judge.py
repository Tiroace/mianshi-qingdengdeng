"""DeepSeek 识图转发（1.1.1）。

为什么要有这个接口：1.1.0 把 DeepSeek 密钥在构建时写进了小程序包
（dist/build/mp-weixin/common/config.js 里是明文 sk-...），任何人解包就能拿走密钥刷余额。
1.1.1 起手机只把压缩后的截图发到这里，由服务器带着密钥去调 DeepSeek，再把模型原始 JSON 原样返回；
前端的白名单校验、证据校验、拼报告逻辑一律不变。

底线：
- 密钥只从环境变量 QBL_DEEPSEEK_KEY 读，不落盘、不进日志；
- 截图和文字只在内存里转一手，不写盘、不写库、不写日志（隐私政策：服务器不存截图和文字）；
- 必须已登录，并按人限速，防止有人拿接口刷余额；
- 失败统一返回错误码，前端照旧静默退回原流程。
"""
from __future__ import annotations

import base64
import collections
import json
import logging
import time
from functools import lru_cache

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..config import get_settings
from ..deps import current_user, envelope
from ..errors import AppError, rate_limited

logger = logging.getLogger("qbl")
router = APIRouter(tags=["识图"])

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MAX_IMAGES = 3
# 单张 base64 上限：前端压到 ≤200KB，base64 约 270KB，这里给到 600KB 余量
MAX_B64_CHARS = 600 * 1024

_buckets: dict[str, collections.deque] = {}


class JudgeRequest(BaseModel):
    images: list[str] = Field(default_factory=list, description="压缩后的 JPEG base64（不带 data: 前缀），1-3 张")


@lru_cache(maxsize=1)
def _system_prompt() -> str:
    path = get_settings().project_root / "rules" / "prompt_v1.txt"
    return path.read_text(encoding="utf-8")


def _check_rate(user_id: str, per_minute: int) -> None:
    bucket = _buckets.setdefault(user_id, collections.deque())
    cutoff = time.time() - 60
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= max(1, per_minute):
        raise rate_limited("识图太频繁，请稍后再试")
    bucket.append(time.time())


def _validate_images(images: list[str]) -> list[str]:
    imgs = [str(x or "").strip() for x in images if str(x or "").strip()]
    if not imgs:
        raise AppError("VALIDATION_ERROR", "缺少截图", 400)
    if len(imgs) > MAX_IMAGES:
        raise AppError("VALIDATION_ERROR", f"一次最多 {MAX_IMAGES} 张截图", 400)
    for b64 in imgs:
        if len(b64) > MAX_B64_CHARS:
            raise AppError("VALIDATION_ERROR", "截图太大", 400)
        try:
            base64.b64decode(b64, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise AppError("VALIDATION_ERROR", "截图格式不对", 400) from exc
    return imgs


def _call_deepseek(images: list[str]) -> dict:
    settings = get_settings()
    content: list[dict] = [{"type": "text", "text": "请识别并判断这些招聘截图。"}]
    for b64 in images:
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}})
    payload = {
        "model": settings.deepseek_model,
        "temperature": 0,
        "max_tokens": 2000,
        "response_format": {"type": "json_object"},
        # 关思考模式：实测 8-11 秒降到 2.4-2.7 秒（与 1.1.0 前端写法一致）
        "thinking": {"type": "disabled"},
        "messages": [
            {"role": "system", "content": _system_prompt()},
            {"role": "user", "content": content},
        ],
    }
    try:
        resp = httpx.post(
            DEEPSEEK_URL,
            json=payload,
            headers={"Authorization": "Bearer " + settings.deepseek_key},
            timeout=max(3, settings.deepseek_timeout),
        )
    except httpx.HTTPError as exc:
        logger.warning("DeepSeek 调用失败：%s", type(exc).__name__)
        raise AppError("UPSTREAM_ERROR", "识图服务暂时不可用", 502) from exc
    if resp.status_code != 200:
        # 只记状态码（402 余额不足 / 401 密钥失效），不记响应体
        logger.warning("DeepSeek 返回 HTTP %s", resp.status_code)
        raise AppError("UPSTREAM_ERROR", f"识图服务返回 {resp.status_code}", 502)
    try:
        body = resp.json()
        msg = ((body.get("choices") or [{}])[0] or {}).get("message") or {}
        out = json.loads(msg.get("content") or "{}")
    except (ValueError, AttributeError, IndexError) as exc:
        raise AppError("UPSTREAM_ERROR", "识图结果格式不对", 502) from exc
    if not isinstance(out, dict):
        raise AppError("UPSTREAM_ERROR", "识图结果格式不对", 502)
    return {"raw": out, "usage": body.get("usage")}


@router.post("/judge")
def judge(body: JudgeRequest, request: Request, user: dict = Depends(current_user)) -> dict:
    """截图 → DeepSeek → 原始 JSON。不扣次数（扣次数仍走 /quota/consume）。"""
    settings = get_settings()
    if not settings.deepseek_key:
        raise AppError("UPSTREAM_ERROR", "识图服务未配置", 503)
    images = _validate_images(body.images)
    _check_rate(user["id"], settings.judge_per_minute)
    return envelope(_call_deepseek(images), request)
