"""Device selection and frozen official SigLIP2 feature extraction."""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path

import numpy as np

MODEL_ID = "google/siglip2-so400m-patch16-naflex"
MODEL_REVISION = "cc24074f717b612951c2dead130904ab9b65a81e"


def select_device(requested, torch):
    if requested not in ("auto", "cpu", "cuda"):
        raise ValueError("Device must be auto, cpu or cuda")
    available = torch.cuda.is_available()
    if requested == "cuda" and not available:
        raise ValueError(
            "--device cuda requested, but PyTorch detects no compatible CUDA/ROCm accelerator; use --device cpu"
        )
    return "cuda" if requested != "cpu" and available else "cpu"


def cpu_name():
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def environment(requested="auto", torch=None):
    if torch is None:
        import torch
    import transformers

    selected = select_device(requested, torch)
    info = {
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
        "torch_cuda_is_available": torch.cuda.is_available(),
        "torch_version_cuda": torch.version.cuda,
        "torch_version_hip": getattr(torch.version, "hip", None),
        "requested_device": requested,
        "selected_device": selected,
        "device_name": cpu_name(),
        "accelerator_total_memory_bytes": None,
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    if selected == "cuda":
        properties = torch.cuda.get_device_properties(0)
        info.update(
            device_name=properties.name, accelerator_total_memory_bytes=properties.total_memory
        )
    return info


def dtype_for(name, device, torch):
    if name not in ("float32", "float16", "bfloat16"):
        raise ValueError("Supported dtype options: float32, float16, bfloat16")
    if device == "cpu" and name != "float32":
        raise ValueError(
            "This CPU baseline supports float32 only; reduced precision requires a validated accelerator runtime"
        )
    if device == "cuda" and name == "bfloat16" and not torch.cuda.is_bf16_supported():
        raise ValueError("Explicit bfloat16 is unsupported by this accelerator runtime")
    return getattr(torch, name)


def normalize(vectors):
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2 or not np.isfinite(array).all():
        raise ValueError("Embeddings must be a finite 2D matrix")
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    if np.any(norms <= 0):
        raise ValueError("Zero image embedding")
    return np.ascontiguousarray(array / norms)


def peak_rss_bytes():
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(rss if platform.system() == "Darwin" else rss * 1024)
    except ImportError:
        return None


class SiglipEncoder:
    def __init__(
        self,
        *,
        model_id=MODEL_ID,
        revision=MODEL_REVISION,
        device="auto",
        dtype="float32",
        max_num_patches=256,
        batch_size=1,
        threads=6,
        cache_dir=None,
        offline=False,
    ):
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        import PIL
        import torch
        import transformers
        from transformers import (
            AutoConfig,
            AutoModel,
            AutoTokenizer,
            Siglip2ImageProcessor,
            Siglip2Processor,
        )

        if max_num_patches not in (256, 512) or batch_size < 1 or threads < 1:
            raise ValueError("Use 256/512 patches and positive batch size/threads")
        self.torch = torch
        self.environment = environment(device, torch)
        self.device = self.environment["selected_device"]
        self.dtype = dtype_for(dtype, self.device, torch)
        self.batch_size = batch_size
        self.max_num_patches = max_num_patches
        torch.set_num_threads(threads)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        # Use reproducible math attention on accelerators, not vendor-specific fast kernels.
        torch.backends.cuda.enable_flash_sdp(False)
        torch.backends.cuda.enable_mem_efficient_sdp(False)
        torch.backends.cuda.enable_math_sdp(True)
        print(
            f"Selected device: {self.device} ({self.environment['device_name']}); dtype={dtype}; batch_size={batch_size}",
            flush=True,
        )
        start = time.perf_counter()
        kwargs = dict(cache_dir=cache_dir, local_files_only=offline, trust_remote_code=False)
        config = AutoConfig.from_pretrained(model_id, revision=revision, **kwargs)
        resolved = config._commit_hash
        if not resolved:
            raise ValueError(
                "Model revision could not be resolved to a commit; use a pinned Hugging Face checkpoint"
            )
        self.processor = Siglip2Processor(
            image_processor=Siglip2ImageProcessor.from_pretrained(
                model_id, revision=resolved, **kwargs
            ),
            tokenizer=AutoTokenizer.from_pretrained(
                model_id, revision=resolved, use_fast=True, **kwargs
            ),
        )
        if type(self.processor.image_processor).__name__ != "Siglip2ImageProcessor":
            raise ValueError("Expected the official Siglip2ImageProcessor NaFlex implementation")
        self.processor.image_processor.max_num_patches = max_num_patches
        self.model = (
            AutoModel.from_pretrained(
                model_id, revision=resolved, dtype=self.dtype, attn_implementation="sdpa", **kwargs
            )
            .to(self.device)
            .eval()
        )
        self.model.requires_grad_(False)
        self.dimension = self.model.config.vision_config.hidden_size
        self.load_seconds = time.perf_counter() - start
        self.config = {
            "schema_version": "siglip-encoder/1",
            "requested_model_id": model_id,
            "requested_revision": revision,
            "resolved_revision": resolved,
            "transformers_version": transformers.__version__,
            "torch_version": torch.__version__,
            "numpy_version": np.__version__,
            "pillow_version": PIL.__version__,
            "processor_class": type(self.processor).__name__,
            "processor_config": self.processor.to_dict(),
            "image_processor_config": self.processor.image_processor.to_dict(),
            "vision_config": self.model.config.vision_config.to_dict(),
            "dtype": dtype,
            "device": self.device,
            "device_name": self.environment["device_name"],
            "torch_version_cuda": torch.version.cuda,
            "torch_version_hip": getattr(torch.version, "hip", None),
            "max_num_patches": max_num_patches,
            "patch_size": self.processor.image_processor.patch_size,
            "batch_size": batch_size,
            "torch_threads": torch.get_num_threads(),
            "seed": 0,
            "attention": "sdpa_math",
            "deterministic_algorithms": True,
            "tf32": False,
            "embedding_dimension": self.dimension,
            "input_policy": "PIL RGB; official NaFlex only; no external resize/crop",
            "normalization": "float32 L2",
            "processor_device": "cpu",
            "model_device": str(next(self.model.parameters()).device),
        }
        self.last_inputs = None

    def encode(self, images):
        torch = self.torch
        try:
            inputs = self.processor(
                images=images, return_tensors="pt", max_num_patches=self.max_num_patches
            )
            required = {"pixel_values", "pixel_attention_mask", "spatial_shapes"}
            if not required.issubset(inputs):
                raise ValueError(f"Missing NaFlex inputs: {required - set(inputs)}")
            self.last_inputs = {name: list(value.shape) for name, value in inputs.items()}
            inputs = {
                name: value.to(device=self.device, dtype=self.dtype)
                if value.is_floating_point()
                else value.to(self.device)
                for name, value in inputs.items()
            }
            if self.device == "cuda":
                torch.cuda.synchronize()
            with torch.inference_mode():
                features = self.model.get_image_features(**inputs)
            if self.device == "cuda":
                torch.cuda.synchronize()
            array = features.float().cpu().numpy()
            if array.shape != (len(images), self.dimension):
                raise ValueError(f"Unexpected embedding shape {array.shape}")
            return normalize(array)
        except (MemoryError, RuntimeError) as error:
            if isinstance(error, MemoryError) or "out of memory" in str(error).lower():
                raise RuntimeError(
                    "Embedding OOM: no images were skipped. Resume with lower --batch-size or --max-num-patches (incompatible caches are invalidated)."
                ) from error
            raise RuntimeError(
                f"SigLIP2 failed on explicit device/dtype {self.device}/{self.dtype}: {error}"
            ) from error

    def encode_text(self, texts):
        """Encode diagnostic prompts in the same frozen joint feature space."""
        if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("Text prompts must be non-empty strings")
        torch = self.torch
        try:
            inputs = self.processor(
                text=list(texts), padding="max_length", truncation=True, return_tensors="pt"
            )
            inputs = {name: value.to(self.device) for name, value in inputs.items()}
            if self.device == "cuda":
                torch.cuda.synchronize()
            with torch.inference_mode():
                features = self.model.get_text_features(**inputs)
            if self.device == "cuda":
                torch.cuda.synchronize()
            array = features.float().cpu().numpy()
            if array.shape != (len(texts), self.dimension):
                raise ValueError(f"Unexpected text embedding shape {array.shape}")
            return normalize(array)
        except (MemoryError, RuntimeError) as error:
            if isinstance(error, MemoryError) or "out of memory" in str(error).lower():
                raise RuntimeError("Text embedding OOM; use a smaller prompt batch") from error
            raise RuntimeError(
                f"SigLIP2 text encoding failed on {self.device}/{self.dtype}: {error}"
            ) from error

    def memory(self):
        result = {
            "process_peak_rss_bytes": peak_rss_bytes(),
            "accelerator_peak_allocated_bytes": None,
            "accelerator_peak_reserved_bytes": None,
        }
        if self.device == "cuda":
            result.update(
                accelerator_peak_allocated_bytes=self.torch.cuda.max_memory_allocated(),
                accelerator_peak_reserved_bytes=self.torch.cuda.max_memory_reserved(),
            )
        return result
