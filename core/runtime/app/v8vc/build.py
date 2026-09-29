"""Reference-only sequential worker. Never imports or opens query-image manifests."""
import argparse, hashlib, json, os, time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageOps
from ..v8.checkpoint import read,save,atomic_json,writer_lock,digest
from ..v8.target import select_bottle,select_label,crop
from ..v8.config import Config
from ..v8.backend import jpeg95
from ..v8 import reference_cache
from ..v5.geometry import descriptors
from ..v5.catalog import sha256

def plain(x):
    if isinstance(x,np.ndarray):return x.tolist()
    if isinstance(x,np.generic):return x.item()
    if isinstance(x,dict):return {str(k):plain(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [plain(v) for v in x]
    return x

def extract(results):
    lines=[];raw=[]
    for result in results:
        value=getattr(result,"json",result)
        if callable(value):value=value()
        if isinstance(value,str):value=json.loads(value)
        value=plain(value);r=value.get("res",value);raw.append(r)
        texts=r.get("rec_texts",[]); scores=r.get("rec_scores",[])
        polys=r.get("rec_polys",r.get("dt_polys",[])); boxes=r.get("rec_boxes",[])
        for i,text in enumerate(texts):
            lines.append(dict(text=str(text),confidence=float(scores[i]) if i<len(scores) else None,
                polygon=polys[i] if i<len(polys) else None,box=boxes[i] if i<len(boxes) else None))
    return dict(lines=lines,raw=raw,texts=[r["text"] for r in lines],
                confidences=[r["confidence"] or 0 for r in lines],text=" ".join(r["text"] for r in lines))

def phash(im):
    gray=cv2.cvtColor(np.asarray(im),cv2.COLOR_RGB2GRAY)
    small=cv2.resize(gray,(32,32)).astype(np.float32)
    low=cv2.dct(small)[:8,:8].ravel();med=np.median(low[1:])
    return format(sum(int(v>med)<<i for i,v in enumerate(low)), "016x")

def provenance(repo,row):
    files=[Path(__file__),repo/"vision-service/app/v8/target.py",repo/"vision-service/app/v8/config.py",
           repo/"vision-service/app/dino.py",repo/"vision-service/app/v5/geometry.py"]
    return dict(schema="v8vc-reference/1",reference_sha256=row["reference_sha256"],
                catalogItemId=row["catalog_item_id"],slug=row["official_slug"],
                code={p.name:sha256(p) for p in files},ocr_model="eslav_PP-OCRv5_mobile_rec",
                ocr_engine="transformers",jpeg_quality=95)

def valid(repo,row,out):
    p=out/"references"/f'{row["catalog_item_id"]}.json'
    r=read(p,provenance(repo,row))
    if not r:return None
    for rel,h in r.get("artifacts",{}).items():
        f=repo/rel
        if not f.exists() or sha256(f)!=h:return None
    return r

def run(args):
    repo=Path(args.repo);out=repo/".generated/v8vc"
    rows=json.loads((repo/".runtime/v5-rc1/catalog.json").read_text())["rows"]
    assert len(rows)==2103 and len({r["catalog_item_id"] for r in rows})==2103
    with writer_lock(out):
        missing=[r for r in rows if valid(repo,r,out) is None]
        atomic_json(out/"progress.json",dict(total=len(rows),complete=len(rows)-len(missing),remaining=len(missing)))
        if not missing or args.validate_only:return
        from ..dino import detect_objects,dino_runtime
        from paddleocr import PaddleOCR
        import torch
        dino_runtime()
        ocr=PaddleOCR(use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False,
            text_recognition_model_name="eslav_PP-OCRv5_mobile_rec",engine="transformers",
            device="gpu:0" if torch.cuda.is_available() else "cpu")
        gallery=json.loads((repo/".runtime/v5-rc1/rows.json").read_text())
        gallery={r["catalog_item_id"]:r for r in gallery}
        release=json.loads((repo/".runtime/v5-rc1/release.json").read_text())
        for row in missing[:args.limit]:
            start=time.time();cid=row["catalog_item_id"];artifacts={};path=Path(os.getenv("V5_ASSET_ROOT","/data/assets"))/row["reference_path"]
            assert sha256(path)==row["reference_sha256"]
            with Image.open(path) as image:im=ImageOps.exif_transpose(image).convert("RGB")
            target=select_bottle(detect_objects(im,"wine bottle."),*im.size)
            rec=dict(catalogItemId=cid,slug=row["official_slug"],reference_sha256=row["reference_sha256"],
                     reference_path=row["reference_path"],dimensions=im.size,phash=phash(im),target=target,
                     label=None,ocr=dict(text="",texts=[],confidences=[],lines=[],raw=[]),artifacts=artifacts)
            dest=out/"crops"/str(cid);dest.mkdir(parents=True,exist_ok=True)
            if target["selected"]:
                bottle=jpeg95(crop(im,target["selected_box"]))
                label=select_label(detect_objects(bottle,"main wine label."),*bottle.size,Config())
                rec["label"]=label
                for name,img in [("bottle",bottle),("label",crop(bottle,label["selected_box"]))]:
                    p=dest/(name+".png");img.save(p);artifacts[str(p.relative_to(repo))]=sha256(p)
                if label["trusted"]:
                    labelim=jpeg95(crop(bottle,label["selected_box"]))
                    rec["ocr"]=extract(ocr.predict(cv2.cvtColor(np.asarray(labelim),cv2.COLOR_RGB2BGR)))
                    rec["ocr"]["coordinate_frame"]="label_crop"
                    rec["ocr"]["bottle_box_in_reference"]=target["selected_box"]
                    rec["ocr"]["label_box_in_bottle"]=label["selected_box"]
            g=gallery[cid];assert g["sha256"]==row["reference_sha256"]
            rec["embeddings"]={name:dict(path=".runtime/v5-rc1/"+name,row_index=g["index"],sha256=release["files"][name],
                            reference_sha256=row["reference_sha256"],crop="frozen_original_reference") for name in ["embeddings.npy","dinov3.npy"]}
            cache=repo/".generated/v8/reference-cache"/(reference_cache.key(row["reference_sha256"])+".npz")
            value=reference_cache.load(cache)
            if value is None:
                cache=out/"descriptors"/(reference_cache.key(row["reference_sha256"])+".npz")
                value=reference_cache.load(cache)
                if value is None:
                    value=descriptors(cv2.imread(str(path),cv2.IMREAD_COLOR));reference_cache.save(cache,value)
            artifacts[str(cache.relative_to(repo))]=sha256(cache)
            rec["descriptors"]=dict(path=str(cache.relative_to(repo)),sha256=sha256(cache),
                       modes=["sift","root"],keypoints=len(value["kp"]),crop="frozen_original_reference")
            rec["status"]="ok" if rec["ocr"]["lines"] else "abstained"
            rec["seconds"]=time.time()-start
            save(out/"references"/f"{cid}.json",rec,provenance(repo,row))
            complete=len(rows)-len(missing)+missing.index(row)+1
            atomic_json(out/"progress.json",dict(total=len(rows),complete=complete,remaining=len(rows)-complete,last_id=cid))
            print(json.dumps(dict(id=cid,complete=complete,status=rec["status"],lines=len(rec["ocr"]["lines"]),seconds=rec["seconds"])),flush=True)
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--repo",default="/workspace");p.add_argument("--limit",type=int,default=75);p.add_argument("--validate-only",action="store_true")
    run(p.parse_args())
