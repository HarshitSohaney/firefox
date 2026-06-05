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


@pytest.fixture(autouse=True)
def clear_store():
    from main import file_store

    file_store.clear()
    yield
    file_store.clear()


TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xd9"
)


@pytest.mark.anyio
async def test_fetch_file(client):
    from main import file_store, FileEntry

    file_store["fetch-uuid"] = FileEntry(
        data=TINY_JPEG,
        content_type="image/jpeg",
        filename="photo.jpg",
        created_at=time.time(),
    )

    resp = await client.get("/file/fetch-uuid")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == TINY_JPEG
    # File should be deleted after fetch
    assert "fetch-uuid" not in file_store


@pytest.mark.anyio
async def test_fetch_file_not_found(client):
    resp = await client.get("/file/nonexistent-uuid")
    assert resp.status_code == 404
