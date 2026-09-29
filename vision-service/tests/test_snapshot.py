import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from app.v5 import snapshot
from app.v5.catalog import DINO_ID, DINO_REVISION, sha256
from app.v5.models import DinoRetrieval


@pytest.fixture
def local_snapshot(tmp_path, monkeypatch):
    root = tmp_path / "model"
    root.mkdir()
    for name in snapshot.DINO_FILES:
        (root / name).write_bytes(name.encode())
    hashes = {name: sha256(root / name) for name in snapshot.DINO_FILES}
    monkeypatch.setattr(snapshot, "DINO_FILES", hashes)
    (root / snapshot.MANIFEST).write_text(json.dumps({
        "modelId": DINO_ID, "revision": DINO_REVISION,
        "snapshotIdentity": f"{DINO_ID}@{DINO_REVISION}", "files": hashes,
    }))
    return root


@pytest.mark.parametrize("damage", ["missing", "weights", "revision", "model", "manifest_hash",
                                     "extra", "symlink"])
def test_snapshot_rejects_invalid_artifacts(local_snapshot, damage):
    root = local_snapshot
    if damage == "missing":
        (root / "config.json").unlink()
    elif damage == "weights":
        (root / "model.safetensors").write_bytes(b"wrong weights")
    elif damage == "extra":
        (root / "pytorch_model.bin").write_bytes(b"alternative weights")
    elif damage == "symlink":
        path = root / "config.json"
        other = root.parent / "config"
        path.rename(other)
        path.symlink_to(other)
    else:
        path = root / snapshot.MANIFEST
        data = json.loads(path.read_text())
        if damage == "revision":
            data["revision"] = "main"
        elif damage == "model":
            data["modelId"] = "another/model"
        else:
            data["files"]["config.json"] = "0" * 64
        path.write_text(json.dumps(data))
    with pytest.raises(RuntimeError, match="provision_dinov3.py"):
        snapshot.verify_snapshot(root)


def test_runtime_uses_only_verified_local_files(local_snapshot, monkeypatch):
    calls = []
    model = SimpleNamespace(to=lambda device: model, eval=lambda: model)

    def load(path, **kwargs):
        calls.append((path, kwargs))
        return model

    monkeypatch.setenv("V5_DINOV3_MODEL_DIR", str(local_snapshot))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False)))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        AutoImageProcessor=SimpleNamespace(from_pretrained=load),
        AutoModel=SimpleNamespace(from_pretrained=load)))
    result = DinoRetrieval(SimpleNamespace(dino_gallery=object(), rows=[]))
    assert result.snapshot_path == local_snapshot
    assert calls == [(str(local_snapshot), {
        "local_files_only": True, "token": False, "trust_remote_code": False,
    })] * 2


def test_runtime_rejects_missing_snapshot_before_transformers(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid snapshot must never reach Transformers")
    monkeypatch.setenv("V5_DINOV3_MODEL_DIR", str(tmp_path / "absent"))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        AutoImageProcessor=SimpleNamespace(from_pretrained=forbidden),
        AutoModel=SimpleNamespace(from_pretrained=forbidden)))
    with pytest.raises(RuntimeError, match="local snapshot missing or invalid"):
        DinoRetrieval(SimpleNamespace(dino_gallery=object()))


@pytest.mark.parametrize("broken", [False, True])
def test_provision_publishes_only_verified_standalone_snapshot(local_snapshot, monkeypatch, broken):
    path = Path(__file__).resolve().parents[1] / "scripts/provision_dinov3.py"
    spec = importlib.util.spec_from_file_location("provision_dinov3", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = local_snapshot.parent / DINO_REVISION
    local_snapshot.rename(source)
    if broken:
        (source / "model.safetensors").write_bytes(b"corrupt")
    calls = []

    def download(**kwargs):
        calls.append(kwargs)
        return str(source)

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=download))
    output = source.parent / "published"
    if broken:
        with pytest.raises(RuntimeError):
            module.provision(output, local_files_only=True)
        assert not output.exists()
    else:
        module.provision(output, local_files_only=True)
        snapshot.verify_snapshot(output)
        assert all(not p.is_symlink() for p in output.iterdir())
        # Existing verified output is idempotent, without a Hub call.
        module.provision(output)
    assert len(calls) == 1
    assert calls[0]["repo_id"] == DINO_ID
    assert calls[0]["revision"] == DINO_REVISION
    assert calls[0]["local_files_only"] is True
    assert calls[0]["token"] is False
    assert not list(output.parent.glob(".dinov3-provision-*"))
