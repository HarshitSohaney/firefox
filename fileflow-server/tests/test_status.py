from httpx import AsyncClient, ASGITransport
import pytest
import time


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
async def test_status_not_ready(client):
    resp = await client.get("/status/some-uuid-1234")
    assert resp.status_code == 200
    assert resp.json() == {"ready": False}


@pytest.mark.anyio
async def test_status_ready(client):
    from main import file_store, FileEntry

    file_store["test-uuid"] = FileEntry(
        data=b"fake-jpeg-data",
        content_type="image/jpeg",
        filename="photo.jpg",
        created_at=time.time(),
    )
    try:
        resp = await client.get("/status/test-uuid")
        assert resp.status_code == 200
        assert resp.json() == {"ready": True}
    finally:
        file_store.pop("test-uuid", None)
