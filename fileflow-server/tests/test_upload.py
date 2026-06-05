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
async def test_upload_success(client):
    from main import file_store

    resp = await client.post(
        "/upload/test-uuid",
        files={"file": ("photo.jpg", TINY_JPEG, "image/jpeg")},
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert "test-uuid" in file_store
    assert file_store["test-uuid"].data == TINY_JPEG


@pytest.mark.anyio
async def test_upload_duplicate_rejected(client):
    await client.post(
        "/upload/dup-uuid",
        files={"file": ("photo.jpg", TINY_JPEG, "image/jpeg")},
    )
    resp = await client.post(
        "/upload/dup-uuid",
        files={"file": ("photo2.jpg", TINY_JPEG, "image/jpeg")},
    )
    assert resp.status_code == 409


@pytest.mark.anyio
async def test_upload_wrong_content_type(client):
    resp = await client.post(
        "/upload/bad-uuid",
        files={"file": ("doc.pdf", b"not-a-jpeg", "application/pdf")},
    )
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_upload_too_large(client):
    big_data = b"\xff\xd8" + (b"\x00" * (10 * 1024 * 1024 + 1))
    resp = await client.post(
        "/upload/big-uuid",
        files={"file": ("big.jpg", big_data, "image/jpeg")},
    )
    assert resp.status_code == 413


@pytest.mark.anyio
async def test_upload_png_success(client):
    from main import file_store

    png_data = b"\x89PNG\r\n\x1a\n"
    resp = await client.post(
        "/upload/png-uuid",
        files={"file": ("photo.png", png_data, "image/png")},
    )
    assert resp.status_code == 200
    assert "png-uuid" in file_store
