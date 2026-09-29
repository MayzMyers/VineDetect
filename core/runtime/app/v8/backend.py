"""Frozen loaders and raw evidence interfaces only. Never import a decision pipeline."""
import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
from contextlib import nullcontext
import cv2
import numpy as np
from ..v5.catalog import Catalog
from ..v5.models import DinoRetrieval,OcrRetrieval
from ..v5.ocr import extract_ocr

def jpeg95(image):
    from PIL import Image
    buffer=io.BytesIO();image.save(buffer,format="JPEG",quality=95);buffer.seek(0)
    with Image.open(buffer) as decoded:
        return decoded.convert("RGB")

class Backend:
    def __init__(self):
        from ..dino import dino_runtime
        self.catalog=Catalog(os.getenv("RETRIEVAL_GALLERY_ROOT","/gallery"),os.getenv("V5_ASSET_ROOT","/data/assets"))
        self.remote_siglip=os.getenv("V8_SIGLIP_URL","")
        dino_runtime()
        if not self.remote_siglip:
            from ..retrieval import retrieval_runtime
            retrieval_runtime()
        self.dino=DinoRetrieval(self.catalog)
        self.ocr=OcrRetrieval(self.catalog)

    def detect(self,image,prompt):
        from ..dino import detect_objects
        return detect_objects(image,prompt)

    def siglip(self,image,depth):
        if self.remote_siglip:
            buffer=io.BytesIO();image.save(buffer,format="PNG")
            request=urllib.request.Request(self.remote_siglip+"/v1/retrieval/top-k",
                json.dumps(dict(imageBase64=base64.b64encode(buffer.getvalue()).decode(),limit=depth)).encode(),
                {"Content-Type":"application/json"})
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(request,timeout=180) as response:
                        value=json.load(response)
                    break
                except (urllib.error.URLError,TimeoutError,ConnectionError):
                    if attempt==2:raise
                    time.sleep(1)
        else:
            from ..retrieval import retrieve_top_k
            value=retrieve_top_k(image,limit=depth)
        return [dict(id=r["catalogItemId"],rank=r["rank"],score=r["cosineSimilarity"]) for r in value["candidates"]]

    def dinov3(self,image,depth):
        model=self.dino;torch=model.torch
        inputs=model.processor(images=image,return_tensors="pt")
        inputs={k:v.to(model.device) if torch.is_tensor(v) else v for k,v in inputs.items()}
        autocast=torch.autocast(device_type="cuda",dtype=torch.float16) if model.device=="cuda" else nullcontext()
        with torch.inference_mode(),autocast:
            output=model.model(**inputs)
        pooled=getattr(output,"pooler_output",None)
        if pooled is None: pooled=output.last_hidden_state[:,0,:]
        vectors=pooled.float().detach().cpu().numpy()
        if vectors.shape!=(1,768): raise ValueError("Invalid DINO embedding")
        vectors/=np.maximum(np.linalg.norm(vectors,axis=-1,keepdims=True),1e-12)
        scores=model.gallery@vectors[0]
        order=sorted(range(len(scores)),key=lambda i:(-float(scores[i]),int(model.ids[i])))[:depth]
        return [dict(id=int(model.ids[i]),rank=rank,score=float(scores[i])) for rank,i in enumerate(order,1)]

    def read_text(self,image):
        # Same JPEG95 and BGR input as frozen OCR; one request-local intermediate.
        bgr=cv2.cvtColor(np.asarray(jpeg95(image)),cv2.COLOR_RGB2BGR)
        texts,confidences=extract_ocr(self.ocr.model.predict(bgr))
        return dict(text=" ".join(texts),texts=texts,confidences=confidences)
