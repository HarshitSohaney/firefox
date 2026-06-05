from httpx import AsyncClient, ASGITransport
import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    from main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_mobile_page_returns_html(client):
    resp = await client.get("/abc-123-uuid")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    body = resp.text
    assert 'accept="image/*"' in body
    assert "abc-123-uuid" in body
    assert "/upload/abc-123-uuid" in body


@pytest.mark.anyio
async def test_mobile_page_has_label_trigger(client):
    resp = await client.get("/some-uuid")
    body = resp.text
    assert 'for="fileInput"' in body
    assert '<label class="btn"' in body


@pytest.mark.anyio
async def test_mobile_page_has_success_view(client):
    resp = await client.get("/some-uuid")
    body = resp.text
    assert "kit-jump-hole-1.png" in body
    assert "Your files are on the way" in body
