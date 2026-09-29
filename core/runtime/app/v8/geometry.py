"""Uniform raw local verification with frozen descriptor/BF/RANSAC primitives."""
import time
import cv2
import numpy as np
from ..v5.geometry import descriptors, lowe_matches, grid_coverage, hull_coverage, span_coverage

def compare(query,reference,mode,seed=0):
    t=time.perf_counter()
    forward=lowe_matches(query[mode],reference[mode])
    backward=lowe_matches(reference[mode],query[mode])
    reverse={m.queryIdx:m.trainIdx for m in backward}
    mutual=[m for m in forward if reverse.get(m.trainIdx)==m.queryIdx]
    result=dict(good_matches=len(forward),mutual_matches=len(mutual),inliers=0,ratio=0.,
                grid=0.,hull=0.,span=0.,query_keypoints=len(query["kp"]),reference_keypoints=len(reference["kp"]),
                matching_ms=(time.perf_counter()-t)*1000,ransac_ms=0.)
    if len(mutual)>=4:
        src=np.float32([query["kp"][m.queryIdx].pt for m in mutual]).reshape(-1,1,2)
        dst=np.float32([reference["kp"][m.trainIdx].pt for m in mutual]).reshape(-1,1,2)
        cv2.setRNGSeed(seed)  # independent of candidate order or pool size
        t=time.perf_counter()
        _,mask=cv2.findHomography(src,dst,cv2.RANSAC,5.)
        result["ransac_ms"]=(time.perf_counter()-t)*1000
        if mask is not None:
            flags=mask.ravel().astype(bool); pts=src[flags].reshape(-1,2)
            result.update(inliers=int(flags.sum()),ratio=float(flags.mean()),grid=grid_coverage(pts,query["shape"]),
                          hull=hull_coverage(pts,query["shape"]),span=span_coverage(pts,query["shape"]))
    return result

def normalized(raw):
    if not raw or not raw.get("available"):
        return 0.
    scores=[]
    for mode in ("sift","root"):
        m=raw[mode]
        scores.append((min(m["inliers"]/30,1)+m["ratio"]+m["grid"]+
                       min(m["hull"]/.25,1)+min(m["span"]/.5,1))/5)
    return sum(scores)/2
