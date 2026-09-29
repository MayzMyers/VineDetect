import hashlib
import io
import os
import time
import uuid
from collections import OrderedDict
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageDraw,ImageOps
from .backend import jpeg95
from .config import Config
from .geometry import descriptors,compare
from .ocr import CatalogText
from .pool import build_pool
from .rerank import rank
from .target import crop,select_bottle,select_label,TargetUnavailable
from .checkpoint import atomic_json

def pixels(image):
    return hashlib.sha256(image.mode.encode()+str(image.size).encode()+image.tobytes()).hexdigest()

class Pipeline:
    def __init__(self,backend,config=None):
        self.backend=backend;self.config=config or Config()
        self.text=CatalogText(backend.catalog.rows,self.config.ocr_min_idf)
        self.references=OrderedDict()
        self.cache_hits=self.cache_misses=0
        self.disk_hits=0

    def reference(self,cid):
        if cid in self.references:
            self.cache_hits+=1;self.references.move_to_end(cid);return self.references[cid]
        self.cache_misses+=1
        reference_path=self.backend.catalog.reference_path(cid)
        cache_root=os.getenv("V8_REFERENCE_CACHE")
        cache_path=None
        value=None
        if cache_root:
            from . import reference_cache
            cache_path=Path(cache_root)/(reference_cache.key(self.backend.catalog.by_id[cid]["reference_sha256"])+".npz")
            value=reference_cache.load(cache_path)
            if value is not None:self.disk_hits+=1
        if value is None:
            image=cv2.imread(str(reference_path),cv2.IMREAD_COLOR)
            if image is None: raise ValueError("Cannot decode catalog reference")
            value=descriptors(image)
            if cache_path is not None:reference_cache.save(cache_path,value)
        self.references[cid]=value
        while len(self.references)>self.config.reference_cache_size:
            self.references.popitem(last=False)
        return value

    def analyze(self,raw,debug_dir=None,explore=False):
        start=time.perf_counter();timings={};failures=[]
        hits,misses,disk=self.cache_hits,self.cache_misses,self.disk_hits
        def timed(name,action):
            t=time.perf_counter()
            try: return action()
            finally: timings[name]=timings.get(name,0)+(time.perf_counter()-t)*1000
        def optional(name,action,fallback):
            try: return timed(name,action)
            except Exception as exc:
                failures.append(dict(stage=name,error=type(exc).__name__,message=str(exc)))
                return fallback
        def decode():
            with Image.open(io.BytesIO(raw)) as original:
                source_size=original.size
                image=ImageOps.exif_transpose(original).convert("RGB")
            return image,source_size
        image,source_size=timed("decode",decode)
        trace=dict(trace_id=str(uuid.uuid4()),input_sha256=hashlib.sha256(raw).hexdigest(),
                   source_dimensions=source_size,canonical_dimensions=image.size,canonical_pixel_hash=pixels(image),
                   config=self.config.json(),failures=failures)
        target=timed("target_selection",lambda:select_bottle(
            self.backend.detect(image,"wine bottle."),image.width,image.height))
        trace["target"]=target
        if not target["selected"]:
            trace["timings_ms"]=timings
            raise TargetUnavailable(trace)
        bottle=timed("target_crop",lambda:jpeg95(crop(image,target["selected_box"])))
        label_info=timed("label_selection",lambda:select_label(
            self.backend.detect(bottle,"main wine label."),bottle.width,bottle.height,self.config))
        label=crop(bottle,label_info["selected_box"])
        trace.update(label=label_info,target_pixel_hash=pixels(bottle),label_pixel_hash=pixels(label))
        sources=dict(siglip=timed("siglip",lambda:self.backend.siglip(bottle,self.config.retrieval_depth)),
                     dino=[],ocr=[],label_siglip=[])
        if explore or self.config.kd:
            sources["dino"]=optional("dino",lambda:self.backend.dinov3(bottle,self.config.retrieval_depth),[])
        ocr=dict(text="",texts=[],confidences=[])
        if label_info["trusted"] and (explore or self.config.ko):
            ocr=optional("ocr",lambda:self.backend.read_text(label),ocr)
        text_features,ocr_ranking=timed("ocr_catalog",lambda:self.text.features(ocr["text"]))
        sources["ocr"]=ocr_ranking[:self.config.retrieval_depth]
        if label_info["trusted"] and (explore or self.config.kl):
            sources["label_siglip"]=optional("label_siglip",lambda:self.backend.siglip(label,self.config.retrieval_depth),[])
        pool,nominations=build_pool(sources,self.config)
        # Development feature collection verifies the union of every allowed grid pool.
        # This is explicitly excluded from deployment latency estimates.
        if explore:
            limits=dict(siglip=30,dino=20,ocr=10,label_siglip=15)
            ids=sorted({r["id"] for s,k in limits.items() for r in sources[s][:k]})
        else: ids=sorted(r["id"] for r in pool)
        query=None
        if label_info["trusted"] and (explore or self.config.geometry_enabled):
            query=timed("query_descriptors",lambda:descriptors(cv2.cvtColor(np.asarray(label),cv2.COLOR_RGB2BGR)))
        evidence={}
        for cid in ids:
            geom=dict(available=False,abstain_reason="no_trustworthy_target_label" if not label_info["trusted"] else "disabled")
            if query is not None:
                try:
                    ref=timed("reference_descriptors",lambda:self.reference(cid))
                    geom=dict(available=True)
                    for mode in ("sift","root"):
                        geom[mode]=timed(mode+"_verification",lambda:compare(query,ref,mode))
                except Exception as exc:
                    geom=dict(available=False,abstain_reason=type(exc).__name__)
                    failures.append(dict(stage="geometry",id=cid,message=str(exc)))
            evidence[cid]=dict(ocr=text_features[cid],geometry=geom)
        ordered=timed("reranker",lambda:rank(pool,evidence,sources,self.config))
        if not ordered: raise RuntimeError("Empty primary retrieval pool")
        for candidate in ordered:
            candidate["slug"]=self.backend.catalog.by_id[candidate["id"]]["official_slug"]
        trace.update(sources=sources,ocr=ocr,nominations=nominations,pool_ids=[r["id"] for r in pool],
                     evidence=evidence,ordered=ordered,top1=ordered[0]["id"],
                     top2=ordered[1]["id"] if len(ordered)>1 else None,
                     margin=ordered[0]["score"]-ordered[1]["score"] if len(ordered)>1 else None,
                     slug=ordered[0]["slug"],verified_candidates=len(ids),exploration=explore,
                     cache=dict(hits=self.cache_hits-hits,misses=self.cache_misses-misses,
                                disk_hits=self.disk_hits-disk,references=len(self.references),bound=self.config.reference_cache_size))
        timings["total_inference"]=(time.perf_counter()-start)*1000
        trace["timings_ms"]=timings
        if debug_dir is not None:
            directory=Path(debug_dir);directory.mkdir(parents=True,exist_ok=True)
            bottle.save(directory/"target.png");label.save(directory/"label.png")
            overlay=image.copy();draw=ImageDraw.Draw(overlay)
            for row in target["candidates"]:
                x,y,w,h=row["box"]
                draw.rectangle((x,y,x+w,y+h),outline="lime" if row is target["selected"] else "red",width=4)
            overlay.save(directory/"target-overlay.jpg",quality=90)
            overlay=bottle.copy();draw=ImageDraw.Draw(overlay)
            for row in label_info["proposals"]:
                x,y,w,h=row["box"]
                draw.rectangle((x,y,x+w,y+h),outline="lime" if row is label_info["selected"] else "red",width=3)
            overlay.save(directory/"label-overlay.jpg",quality=90)
            atomic_json(directory/"trace.json",trace)
        return trace

    def recognize(self,raw,debug_dir=None):
        trace=self.analyze(raw,debug_dir=debug_dir)
        return {"slug":trace["slug"]}
