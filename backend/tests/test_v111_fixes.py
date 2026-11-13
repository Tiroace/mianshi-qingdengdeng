"""1.1.1 验收修复的回归用例。

1. 生产环境静默登录不带 code（前端 loginByCode('')），1.1.0 被 min_length=1 挡成 400；
2. 管理员（QBL_ADMIN_OPENIDS）调 /quota/consume 不扣次数；
3. /judge：必须登录、未配密钥返回 503、密钥只在服务器、入参校验、上游返回原样透传；
4. QBL_OCR_PREWARM=0 时生产不预热（看配置是否接上）。
"""
from __future__ import annotations

import base64

import pytest

from .conftest import PNG_1X1, auth


@pytest.fixture()
def prod_client(tmp_path, monkeypatch):
    monkeypatch.setenv("QBL_DB_PATH", str(tmp_path / "prod.db"))
    monkeypatch.setenv("QBL_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("QBL_REPORT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("QBL_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("QBL_ENGINE_MODEL", "mock")
    monkeypatch.setenv("QBL_ENV", "prod")
    monkeypatch.setenv("QBL_DEV_BYPASS", "0")
    monkeypatch.setenv("QBL_DEV_MODE", "0")
    monkeypatch.setenv("QBL_TOKEN_SECRET", "prod-test-secret-0123456789abcdef")
    monkeypatch.setenv("QBL_PAY_SECRET", "prod-pay-secret-0123456789abcdef")
    monkeypatch.setenv("QBL_ADMIN_TOKEN", "prod-admin-token-0123456789abcdef")
    monkeypatch.setenv("QBL_OCR_PREWARM", "0")
    monkeypatch.setenv("QBL_ADMIN_OPENIDS", "o-boss-001")
    monkeypatch.delenv("QBL_DEEPSEEK_KEY", raising=False)

    from backend.app import deps, worker
    from backend.app.main import app
    from fastapi.testclient import TestClient

    deps.reset_db()
    with TestClient(app) as c:
        yield c
    worker.shutdown(wait=True)


def _silent_login(client, openid: str) -> dict:
    # 与前端 session.js 的 loginSilently 完全一致：code 为空串
    r = client.post("/auth/login", json={"code": "", "platform": "weixin"}, headers={"X-WX-OPENID": openid})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_prod_silent_login_with_empty_code(prod_client):
    data = _silent_login(prod_client, "o-user-001")
    assert data["token"]
    assert data["is_admin"] is False


def test_prod_login_without_header_is_401(prod_client):
    r = prod_client.post("/auth/login", json={"code": "", "platform": "weixin"})
    assert r.status_code == 401


def test_dev_login_empty_code_rejected(client):
    r = client.post("/auth/login", json={"code": "", "platform": "weixin"})
    assert r.status_code == 400


def test_consume_deducts_and_is_idempotent(prod_client):
    tok = _silent_login(prod_client, "o-user-002")["token"]
    r1 = prod_client.post("/quota/consume", json={"idempotency_key": "rep-1"}, headers=auth(tok)).json()["data"]
    r2 = prod_client.post("/quota/consume", json={"idempotency_key": "rep-1"}, headers=auth(tok)).json()["data"]
    assert r1["granted"] is True and r2["reason"] == "duplicate"
    assert r2["balance"] == r1["balance"]


def test_admin_consume_not_deducted(prod_client):
    data = _silent_login(prod_client, "o-boss-001")
    assert data["is_admin"] is True
    before = data["quota"]["balance"]
    r = prod_client.post("/quota/consume", json={"idempotency_key": "rep-a"}, headers=auth(data["token"])).json()["data"]
    assert r["reason"] == "admin"
    assert r["balance"] == before


def test_judge_requires_login(prod_client):
    r = prod_client.post("/judge", json={"images": [base64.b64encode(PNG_1X1).decode()]})
    assert r.status_code == 401


def test_judge_without_server_key_is_503(prod_client):
    tok = _silent_login(prod_client, "o-user-003")["token"]
    r = prod_client.post("/judge", json={"images": [base64.b64encode(PNG_1X1).decode()]}, headers=auth(tok))
    assert r.status_code == 503


def test_judge_validates_and_proxies(prod_client, monkeypatch):
    monkeypatch.setenv("QBL_DEEPSEEK_KEY", "sk-test-only")
    from backend.app.routers import judge as judge_mod

    sent = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": '{"text": "招聘", "hits": []}'}}], "usage": {"t": 1}}

    def fake_post(url, json, headers, timeout):  # noqa: A002
        sent["url"], sent["auth"], sent["n"] = url, headers["Authorization"], len(json["messages"][1]["content"])
        return _Resp()

    monkeypatch.setattr(judge_mod.httpx, "post", fake_post)
    tok = _silent_login(prod_client, "o-user-004")["token"]
    b64 = base64.b64encode(PNG_1X1).decode()

    bad = prod_client.post("/judge", json={"images": [b64] * 4}, headers=auth(tok))
    assert bad.status_code == 400
    bad = prod_client.post("/judge", json={"images": ["not base64!!"]}, headers=auth(tok))
    assert bad.status_code == 400

    ok = prod_client.post("/judge", json={"images": [b64, b64]}, headers=auth(tok))
    assert ok.status_code == 200, ok.text
    assert ok.json()["data"]["raw"] == {"text": "招聘", "hits": []}
    assert sent["url"] == "https://api.deepseek.com/chat/completions"
    assert sent["auth"] == "Bearer sk-test-only"
    assert sent["n"] == 3  # 1 段文字 + 2 张图


def test_ocr_prewarm_flag_is_read(monkeypatch):
    monkeypatch.setenv("QBL_OCR_PREWARM", "0")
    from backend.app.config import get_settings

    assert get_settings().ocr_prewarm is False


# ---- 1.1.2：分块上传（云托管单次请求 ≤100KB）----
def test_judge_chunked_upload(prod_client, monkeypatch):
    monkeypatch.setenv("QBL_DEEPSEEK_KEY", "sk-test-only")
    from backend.app.routers import judge as judge_mod

    got = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": '{"text": "x", "hits": []}'}}]}

    def fake_post(url, json, headers, timeout):  # noqa: A002
        got["imgs"] = [c["image_url"]["url"].split(",", 1)[1] for c in json["messages"][1]["content"][1:]]
        return _Resp()

    monkeypatch.setattr(judge_mod.httpx, "post", fake_post)
    tok = _silent_login(prod_client, "o-user-chunk")["token"]
    big = base64.b64encode(PNG_1X1 * 3000).decode()  # 约 270KB base64，和真实压缩截图相当
    size = 60 * 1024
    parts = [big[i:i + size] for i in range(0, len(big), size)]
    assert len(parts) > 1
    for img in (0, 1):
        for seq, data in enumerate(parts):
            body = {"job": "job-12345678", "img": img, "seq": seq, "total": len(parts), "data": data}
            r = prod_client.post("/judge/part", json=body, headers=auth(tok))
            assert r.status_code == 200, r.text
            # 每块请求体都必须 < 100KB
            assert len(json_dumps(body)) < 100 * 1024
    ok = prod_client.post("/judge", json={"job": "job-12345678", "count": 2}, headers=auth(tok))
    assert ok.status_code == 200, ok.text
    assert got["imgs"] == [big, big]
    # 用完即删：再调一次同一个 job 必须失败
    again = prod_client.post("/judge", json={"job": "job-12345678", "count": 2}, headers=auth(tok))
    assert again.status_code == 400


def test_judge_incomplete_job_rejected(prod_client, monkeypatch):
    monkeypatch.setenv("QBL_DEEPSEEK_KEY", "sk-test-only")
    tok = _silent_login(prod_client, "o-user-chunk2")["token"]
    body = {"job": "job-abcdefgh", "img": 0, "seq": 0, "total": 2, "data": "AAAA"}
    assert prod_client.post("/judge/part", json=body, headers=auth(tok)).status_code == 200
    r = prod_client.post("/judge", json={"job": "job-abcdefgh", "count": 1}, headers=auth(tok))
    assert r.status_code == 400


def test_judge_part_is_per_user(prod_client, monkeypatch):
    monkeypatch.setenv("QBL_DEEPSEEK_KEY", "sk-test-only")
    a = _silent_login(prod_client, "o-user-a")["token"]
    b = _silent_login(prod_client, "o-user-b")["token"]
    body = {"job": "job-shared01", "img": 0, "seq": 0, "total": 1, "data": base64.b64encode(PNG_1X1).decode()}
    assert prod_client.post("/judge/part", json=body, headers=auth(a)).status_code == 200
    # 别人拿不到你的块
    r = prod_client.post("/judge", json={"job": "job-shared01", "count": 1}, headers=auth(b))
    assert r.status_code == 400


def json_dumps(obj) -> str:
    import json

    return json.dumps(obj)
