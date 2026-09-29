from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Dict, List, Literal

import torch
from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field
from transformers import AutoImageProcessor, AutoModelForZeroShotImageClassification, AutoTokenizer
from .dino import DINO_MODEL_ID, DINO_PRELOAD, detect_label as detect_dino_label, dino_loaded, dino_runtime
from .retrieval import (
    MODEL_ID as RETRIEVAL_MODEL_ID,
    MODEL_REVISION as RETRIEVAL_MODEL_REVISION,
    PRELOAD_RETRIEVAL,
    retrieval_loaded,
    retrieval_runtime,
    retrieve_top_k,
)

MODEL_ID = os.getenv("SIGLIP_MODEL", "google/siglip2-base-patch16-256")
MODEL_REVISION = os.getenv("SIGLIP_MODEL_REVISION", "950d2cab84b57b9d6cf03f95596bfa8fed3204d3")
SERVICE_TOKEN = os.getenv("SIGLIP_SERVICE_TOKEN", "").strip()
CONCEPT_ROOT = Path(os.getenv("SIGLIP_CONCEPT_ROOT", "/app/concepts"))
MAX_CANDIDATES = int(os.getenv("SIGLIP_MAX_CANDIDATES", "4"))
MAX_IMAGE_BYTES = int(os.getenv("SIGLIP_MAX_IMAGE_BYTES", str(4 * 1024 * 1024)))
RETRIEVAL_MAX_IMAGE_BYTES = int(
    os.getenv(
        "RETRIEVAL_MAX_IMAGE_BYTES",
        str(16 * 1024 * 1024),
    )
)
PRELOAD_MODEL = os.getenv("SIGLIP_PRELOAD", "true").strip().lower() in {"true", "1"}

V5_ENABLED = os.getenv("V5_ENABLED", "true").lower() in {"true", "1"}

_runtime = None
_runtime_lock = Lock()
_startup_ms = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _startup_ms
    startup_started = time.perf_counter()
    if PRELOAD_MODEL:
        runtime()
    if DINO_PRELOAD and not V5_ENABLED:
        dino_runtime()
    if PRELOAD_RETRIEVAL:
        retrieval_runtime()
    if V5_ENABLED:
        from .v5.pipeline import preload
        service = preload()
        if service.dino is not None:
            logging.getLogger("uvicorn.error").info(
                "DINOv3 local preload model=%s revision=%s path=%s device=%s local_files_only=True",
                service.dino.snapshot_manifest["modelId"],
                service.dino.snapshot_manifest["revision"],
                service.dino.snapshot_path, service.dino.device,
            )
    _startup_ms = (time.perf_counter() - startup_started) * 1000
    yield


app = FastAPI(title="VineDetect Vision Evidence Service", version="0.1.0", lifespan=lifespan)


class CandidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    imageBase64: str = Field(min_length=4, max_length=MAX_IMAGE_BYTES * 2)


class DinoLabelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageBase64: str = Field(min_length=4, max_length=MAX_IMAGE_BYTES * 2)
    prompt: str = Field(default="main wine label", min_length=1, max_length=200)
    threshold: float = Field(default=0.18, ge=0.0, le=1.0)
    textThreshold: float = Field(default=0.15, ge=0.0, le=1.0)


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    revision: str
    conceptSet: Literal["wine-label-v1"]
    candidates: List[CandidateRequest] = Field(min_length=1, max_length=MAX_CANDIDATES)


class CandidateResult(BaseModel):
    id: str
    positiveScore: float
    negativeScore: float
    semanticScore: float
    scores: Dict[str, float]


class BatchResponse(BaseModel):
    model: str
    revision: str
    candidates: List[CandidateResult]


def authorize(authorization: str | None = Header(default=None)) -> None:
    if SERVICE_TOKEN and authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid vision service token")


def load_concepts(concept_id: str) -> dict:
    path = CONCEPT_ROOT / f"{concept_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=400, detail="Unknown concept set")
    return json.loads(path.read_text(encoding="utf-8"))


def runtime():
    global _runtime
    if _runtime is not None:
        return _runtime
    with _runtime_lock:
        if _runtime is None:
            image_processor = AutoImageProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
            model = AutoModelForZeroShotImageClassification.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            model.to(device).eval()
            _runtime = (image_processor, tokenizer, model, device)
    return _runtime


def decode_image(value: str, max_bytes: int = MAX_IMAGE_BYTES) -> Image.Image:
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > max_bytes:
            raise ValueError("image exceeds byte limit")
        image = Image.open(io.BytesIO(raw))
        image.load()
        return ImageOps.exif_transpose(image).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid candidate image: {error}") from error


class RetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageBase64: str = Field(min_length=4, max_length=RETRIEVAL_MAX_IMAGE_BYTES * 2)
    limit: int = Field(default=20, ge=1, le=50)


@app.get("/health")
def health() -> dict:
    from .v5.pipeline import readiness
    v5 = readiness() if V5_ENABLED else {"v5Ready": False}
    return {
        **v5,
        "v5Enabled": V5_ENABLED,
        "status": "degraded" if V5_ENABLED and not v5["v5Ready"] else "ok",
        "coldStartupMs": _startup_ms,
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "loaded": _runtime is not None,
        "dinoModel": DINO_MODEL_ID,
        "dinoLoaded": dino_loaded(),
        "retrievalModel": RETRIEVAL_MODEL_ID,
        "retrievalRevision": RETRIEVAL_MODEL_REVISION,
        "retrievalLoaded": retrieval_loaded(),
    }


@app.get("/ready")
def ready() -> dict:
    state = health()
    if V5_ENABLED and not state["v5Ready"]:
        raise HTTPException(status_code=503, detail=state)
    return state


@app.post("/v1/dino/detect-label", dependencies=[Depends(authorize)])
def dino_detect_label(request: DinoLabelRequest) -> dict:
    image = decode_image(request.imageBase64)
    return detect_dino_label(
        image,
        prompt=request.prompt,
        threshold=request.threshold,
        text_threshold=request.textThreshold,
    )


@app.post(
    "/v1/retrieval/top-k",
    dependencies=[Depends(authorize)],
)
def retrieval_top_k(request: RetrievalRequest) -> dict:
    if request.limit < 1 or request.limit > 50:
        raise HTTPException(
            status_code=400,
            detail="limit must be between 1 and 50",
        )

    image = decode_image(
        request.imageBase64,
        max_bytes=RETRIEVAL_MAX_IMAGE_BYTES,
    )

    return retrieve_top_k(
        image=image,
        limit=request.limit,
    )


@app.post("/v1/siglip/score-batch", response_model=BatchResponse, dependencies=[Depends(authorize)])
def score_batch(request: BatchRequest) -> BatchResponse:
    if request.model != MODEL_ID or request.revision != MODEL_REVISION:
        raise HTTPException(status_code=409, detail="Requested model provenance does not match loaded service")
    if len({candidate.id for candidate in request.candidates}) != len(request.candidates):
        raise HTTPException(status_code=400, detail="Candidate IDs must be unique")
    concepts = load_concepts(request.conceptSet)
    positive = concepts["positive"]
    negative = concepts["negative"]
    entries = positive + negative
    texts = [entry["text"] for entry in entries]
    images = [decode_image(candidate.imageBase64) for candidate in request.candidates]
    image_processor, tokenizer, model, device = runtime()
    inputs = {
        **tokenizer(
            [text.lower() for text in texts],
            padding="max_length",
            truncation=True,
            max_length=64,
            return_tensors="pt",
        ),
        **image_processor(images=images, return_tensors="pt"),
    }
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        probabilities = torch.sigmoid(model(**inputs).logits_per_image).cpu().float()
    negative_weight = float(concepts.get("negativeWeight", 0.65))
    results = []
    for row, candidate in zip(probabilities, request.candidates):
        values = {entry["id"]: round(float(row[index].item()), 6) for index, entry in enumerate(entries)}
        positive_score = sum(values[entry["id"]] for entry in positive) / len(positive)
        negative_score = max(values[entry["id"]] for entry in negative)
        semantic_score = positive_score - negative_weight * negative_score
        results.append(CandidateResult(
            id=candidate.id,
            positiveScore=round(positive_score, 6),
            negativeScore=round(negative_score, 6),
            semanticScore=round(semantic_score, 6),
            scores=values,
        ))
    return BatchResponse(model=MODEL_ID, revision=MODEL_REVISION, candidates=results)


class V5TargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageBase64: str = Field(min_length=4, max_length=RETRIEVAL_MAX_IMAGE_BYTES * 2)


class V5Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    bottleBox: tuple[float, float, float, float] | None = None
    originalLabel: tuple[float, float, float, float] | None = None
    intentLabel: tuple[float, float, float, float] | None = None
    allLabels: list[tuple[float, float, float, float]] = Field(default_factory=list, max_length=900)
    targetDetectionMs: float = Field(default=0, ge=0)


class V5RecognizeRequest(V5TargetRequest):
    target: V5Target
    labelRoi: tuple[float, float, float, float] | None = None


@app.post("/v1/recognition/target", dependencies=[Depends(authorize)])
def recognition_target(request: V5TargetRequest):
    from .v5.pipeline import bottle_image, inference_lock, runtime
    from .v5.target import target
    image = decode_image(request.imageBase64, RETRIEVAL_MAX_IMAGE_BYTES)
    service = runtime()
    with inference_lock:
        try:
            if not service.target_available:
                raise RuntimeError("Grounding DINO unavailable at startup")
            result = target(image)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("V5 target detection unavailable; keeping full-view fallback")
            result = dict(width=image.width, height=image.height, bottleBox=None,
                          originalLabel=None, intentLabel=None, allLabels=[], targetDetectionMs=0)
        bottle = bottle_image(image, result["bottleBox"])
        encoded = None
        if bottle is not None:
            # PNG transports the already JPEG-decoded pixels losslessly to Node CV.
            buffer = io.BytesIO()
            bottle.save(buffer, format="PNG")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"target": result, "bottleImageBase64": encoded}


@app.post("/v1/recognition/v5", dependencies=[Depends(authorize)])
def recognition_v5(request: V5RecognizeRequest):
    from .v5.pipeline import inference_lock, runtime
    image = decode_image(request.imageBase64, RETRIEVAL_MAX_IMAGE_BYTES)
    if (request.target.width, request.target.height) != image.size:
        raise HTTPException(status_code=400, detail="Target/image dimensions differ")
    with inference_lock:
        return runtime().recognize(image, request.target.model_dump(), request.labelRoi)
