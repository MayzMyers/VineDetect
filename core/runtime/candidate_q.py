"""Frozen query-only R90 extension; reference OCR is never changed here."""
import hashlib
from rot_ocr_lite_merge import merge,rotate

def acquire(image,zero,ocr_model,source_crop_sha256):
 import cv2,numpy as np
 from app.v8.backend import jpeg95
 from app.v8vc.build import extract
 rotated=rotate(image)
 results=list(ocr_model.predict(cv2.cvtColor(np.asarray(jpeg95(rotated)),cv2.COLOR_RGB2BGR)))
 raw=extract(results)
 merged,appended,suppressed=merge(zero,raw,source_crop_sha256,query=True)
 return merged,dict(R90_CW=raw,appended=appended,suppressed=suppressed)

def attach(backend,audit_callback=None):
 original_read_text=backend.read_text
 def query_only(image):
  zero=original_read_text(image)
  # Optional fresh-run provenance: pixel binding only, no effect on recognition.
  binding=hashlib.sha256(image.mode.encode()+str(image.size).encode()+image.tobytes()).hexdigest()
  merged,audit=acquire(image,zero,backend.ocr.model,binding)
  if audit_callback:audit_callback(dict(source_crop_binding_kind='RGB_PIXEL_SHA256',source_crop_sha256=binding,**audit))
  return merged
 backend.read_text=query_only
 return backend

def load_model(root=None,audit_callback=None):
 from release_runtime import load_model as load_B
 model,state=load_B(root);attach(model.pipeline.backend,audit_callback)
 state=dict(state,name='FINAL-ENDGAME-Q-UNRELEASED',query_ocr_views=['0','R90_CW'],reference_ocr_views=['0'],post_hoc_selected_release_candidate=True)
 return model,state
