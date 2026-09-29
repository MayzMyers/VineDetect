"""Small real NaFlex forward tests; never download model weights."""

import numpy as np
import pytest
from PIL import Image

from vinedetect_retrieval.encoder import environment, normalize


def test_mock_amd_runtime_metadata():
    from types import SimpleNamespace

    runtime = SimpleNamespace(
        __version__="test",
        version=SimpleNamespace(cuda=None, hip="6.test"),
        cuda=SimpleNamespace(
            is_available=lambda: True,
            get_device_properties=lambda _: SimpleNamespace(
                name="AMD accelerator", total_memory=8 * 1024**3
            ),
        ),
    )
    info = environment("auto", runtime)
    assert info["selected_device"] == "cuda"
    assert info["device_name"] == "AMD accelerator"
    assert info["torch_version_hip"] == "6.test"
    assert info["torch_version_cuda"] is None


@pytest.mark.parametrize("patches", [256, 512])
def test_official_naflex_processor_and_get_image_features_with_tiny_model(patches):
    import torch
    from transformers import Siglip2Config, Siglip2ImageProcessor, Siglip2Model

    torch.manual_seed(0)
    torch.set_num_threads(2)
    config = Siglip2Config(
        text_config={
            "vocab_size": 16,
            "hidden_size": 16,
            "intermediate_size": 24,
            "num_hidden_layers": 1,
            "num_attention_heads": 2,
            "max_position_embeddings": 8,
        },
        vision_config={
            "hidden_size": 16,
            "intermediate_size": 24,
            "num_hidden_layers": 1,
            "num_attention_heads": 2,
            "patch_size": 16,
            "num_patches": 256,
        },
    )
    model = Siglip2Model(config).eval().requires_grad_(False)
    processor = Siglip2ImageProcessor(max_num_patches=patches, patch_size=16)
    inputs = processor(images=[Image.new("RGB", (38, 121), (128, 64, 32))], return_tensors="pt")
    assert inputs["pixel_values"].shape == (1, patches, 768)
    assert inputs["spatial_shapes"][0, 0] != inputs["spatial_shapes"][0, 1]
    with torch.inference_mode():
        embedding = model.get_image_features(**inputs).numpy()
    assert embedding.shape == (1, 16)
    np.testing.assert_allclose(np.linalg.norm(normalize(embedding), axis=1), 1, atol=1e-6)
