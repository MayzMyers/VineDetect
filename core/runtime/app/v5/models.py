"""Auxiliary models initialized only during service startup."""

import io
import os
import cv2
from contextlib import nullcontext

import numpy as np

from .snapshot import DEFAULT_DIRECTORY, verify_snapshot
from .ocr import build_index, extract_ocr, rank_catalog


class DinoRetrieval:
    def __init__(self, catalog):
        import torch
        from transformers import AutoImageProcessor, AutoModel

        if catalog.dino_gallery is None:
            raise RuntimeError("DINOv3 gallery is absent")
        self.snapshot_path, self.snapshot_manifest = verify_snapshot(
            os.getenv("V5_DINOV3_MODEL_DIR", DEFAULT_DIRECTORY)
        )
        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = AutoImageProcessor.from_pretrained(
            str(self.snapshot_path), local_files_only=True, token=False, trust_remote_code=False
        )
        self.model = (
            AutoModel.from_pretrained(str(self.snapshot_path), local_files_only=True, token=False, trust_remote_code=False)
            .to(self.device)
            .eval()
        )
        self.gallery = catalog.dino_gallery
        self.ids = np.asarray([int(row["catalog_item_id"]) for row in catalog.rows])

    def retrieve(self, image):
        torch = self.torch
        inputs = self.processor(images=image, return_tensors="pt")
        inputs = {
            k: v.to(self.device) if torch.is_tensor(v) else v for k, v in inputs.items()
        }
        autocast = (
            torch.autocast(device_type="cuda", dtype=torch.float16)
            if self.device == "cuda"
            else nullcontext()
        )
        with torch.inference_mode(), autocast:
            outputs = self.model(**inputs)
        pooled = getattr(outputs, "pooler_output", None)
        if pooled is None:
            pooled = outputs.last_hidden_state[:, 0, :]
        vectors = pooled.float().detach().cpu().numpy()
        if vectors.shape != (1, 768):
            raise RuntimeError("Invalid DINOv3 query embedding")
        vectors /= np.maximum(np.linalg.norm(vectors, axis=-1, keepdims=True), 1e-12)
        scores = self.gallery @ vectors[0]
        return [int(self.ids[i]) for i in np.argsort(-scores)[:20]]


class OcrRetrieval:
    def __init__(self, catalog):
        import torch
        from paddleocr import PaddleOCR

        self.model = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_recognition_model_name="eslav_PP-OCRv5_mobile_rec",
            engine="transformers",
            device="gpu:0" if torch.cuda.is_available() else "cpu",
        )
        self.index = build_index(catalog.rows)

    def retrieve(self, image):
        # Paddle's ndarray input is BGR, matching its file loader.
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=95)
        bgr = cv2.imdecode(
            np.frombuffer(buffer.getvalue(), dtype=np.uint8), cv2.IMREAD_COLOR
        )
        texts, _ = extract_ocr(self.model.predict(bgr))
        text = " ".join(texts)
        return text, rank_catalog(text, self.index)
