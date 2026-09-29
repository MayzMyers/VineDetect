"""Opt-in evaluation ASGI app; no production route is replaced."""

import base64
import os
from pathlib import Path
from threading import Lock
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from .backend import Backend
from .pipeline import Pipeline
from .config import Config
from .target import TargetUnavailable

app = FastAPI(title="V8-simple evaluation only")
lock = Lock()
pipeline = None


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageBase64: str = Field(min_length=4, max_length=32 * 1024 * 1024)


@app.post("/v8/evaluate")
def evaluate(request: Request):
    global pipeline
    try:
        raw = base64.b64decode(request.imageBase64, validate=True)
    except ValueError:
        raise HTTPException(400, "Invalid base64")
    with lock:
        if pipeline is None:
            import json

            config_path = os.getenv("V8_CONFIG")
            config = (
                Config(**json.loads(Path(config_path).read_text()))
                if config_path
                else Config()
            )
            pipeline = Pipeline(Backend(), config)
        try:
            import uuid

            from .checkpoint import atomic_json
            from .diagnostics import label_identities

            directory = Path(os.getenv("V8_DEBUG_DIR", ".generated/v8/service")) / str(
                uuid.uuid4()
            )
            trace = pipeline.analyze(raw, debug_dir=directory)
            label_identities(trace, pipeline.backend.catalog)
            atomic_json(directory / "trace.json", trace)
            return {"slug": trace["slug"]}
        except TargetUnavailable as exc:
            atomic_json(directory / "trace.json", exc.diagnostics)
            raise HTTPException(422, "No target bottle detected")
