"""Opt-in gate over frozen B/Q; RC1 files are unchanged."""
from pathlib import Path
import hashlib,importlib.util,json

def load_model(root=None):
    from release_runtime import load_model as load_B
    overlay=Path(__file__).resolve().parent
    manifest=json.loads((overlay/"runtime-overlay-manifest.json").read_text())
    for name,expected in manifest["files_sha256"].items():
        assert hashlib.sha256((overlay/name).read_bytes()).hexdigest()==expected,name
    model,state=load_B(root)
    spec=importlib.util.spec_from_file_location("app.v8.r90_gate_pipeline",overlay/"r90_gate_pipeline.py")
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    model.pipeline.__class__=module.Pipeline
    model.pipeline.r90_parser=model.parser
    model.pipeline.r90_references=model.references
    state=dict(state,name="SEM-ORG-FINAL-v3-RC2-R90-GATED-TEMPORARY",query_ocr_views=["0","R90_CW"],reference_ocr_views=["0"],R90_gate="PRE_R90_B_POOL_EXACT_SUPPORT",preregistration_sha256=manifest["preregistration_sha256"],geometry_unchanged=True)
    return model,state
