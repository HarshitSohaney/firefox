import pytest
import time


@pytest.fixture(autouse=True)
def clear_store():
    from main import file_store

    file_store.clear()
    yield
    file_store.clear()


def test_cleanup_removes_expired_entries():
    from main import file_store, FileEntry, cleanup_expired

    # Entry created 6 minutes ago (expired)
    file_store["old-uuid"] = FileEntry(
        data=b"old-data",
        content_type="image/jpeg",
        filename="old.jpg",
        created_at=time.time() - 360,
    )
    # Entry created just now (not expired)
    file_store["new-uuid"] = FileEntry(
        data=b"new-data",
        content_type="image/jpeg",
        filename="new.jpg",
        created_at=time.time(),
    )

    cleanup_expired()

    assert "old-uuid" not in file_store
    assert "new-uuid" in file_store


def test_cleanup_leaves_fresh_entries():
    from main import file_store, FileEntry, cleanup_expired

    file_store["fresh-uuid"] = FileEntry(
        data=b"fresh",
        content_type="image/jpeg",
        filename="fresh.jpg",
        created_at=time.time() - 60,
    )

    cleanup_expired()

    assert "fresh-uuid" in file_store
