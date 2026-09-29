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
        # Freeze exact B before R90 affects any retrieval/scoring.
        gate_start=time.perf_counter()
        pool,nominations=build_pool(sources,self.config)
        from r90_support_rule import support
        from candidate_q import acquire
        from copy import deepcopy
        zero=deepcopy(ocr)
        bstate=dict(B_candidate_pool=[x["id"] for x in pool],
                    B_visual_nominations={s:deepcopy(sources[s]) for s in ("siglip","dino","label_siglip")},
                    B_OCR0_text=zero["text"],B_OCR0=zero,
                    B_parsed_query=self.r90_parser.extract(zero),B_sources=deepcopy(sources))
        prep_ms=(time.perf_counter()-gate_start)*1000+timings.get("ocr_catalog",0.)
        merged=zero;acquisition=None;classified=[]
        if label_info["trusted"] and (explore or self.config.ko) and not any(x["stage"]=="ocr" for x in failures):
            merged,acquisition=timed("r90_ocr_acquisition",lambda:acquire(label,zero,self.backend.ocr.model,pixels(label)))
        gate_start=time.perf_counter()
        subset={cid:self.r90_references[cid] for cid in bstate["B_candidate_pool"]}
        if acquisition is not None:
            classified=[support(span,subset,self.r90_parser) for span in acquisition["appended"]]
        enabled=any(x["catalog_supported"] for x in classified)
        branch_ms=(time.perf_counter()-gate_start)*1000
        trace["R90_gate"]=dict(gate="ON" if enabled else "OFF",pre_R90=bstate,
                               support=classified,acquisition_audit=acquisition,
                               B_state_preparation_ms=prep_ms,support_branch_ms=branch_ms,
                               incremental_gate_cpu_upper_bound_ms=prep_ms+branch_ms)
        if enabled:
            ocr=merged
            text_features,ocr_ranking=timed("q_ocr_catalog",lambda:self.text.features(ocr["text"]))
            sources["ocr"]=ocr_ranking[:self.config.retrieval_depth]
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
        evidence=self.engineering_scheduler.run(self,ids,query,text_features,label_info["trusted"],failures,timings,timed)
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
