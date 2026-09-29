"""Exact descriptor arrays on disk, bounded RAM; never caches matches or RANSAC."""
import hashlib
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import cv2
import numpy as np
from ..v5 import geometry as frozen

def key(reference_sha256):
    return hashlib.sha256((reference_sha256+cv2.__version__+
                           hashlib.sha256(Path(frozen.__file__).read_bytes()).hexdigest()).encode()).hexdigest()

def load(path):
 import numpy as np
 from types import SimpleNamespace
 d=Path(os.environ["SEM_ORG_DESCRIPTOR_ARRAYS"])/Path(path).stem
 try:
  points,sift,root,shape=[np.load(d/(n+'.npy'),mmap_mode='r',allow_pickle=False) for n in ['points','sift','root','shape']]
  if points.shape!=(len(sift),2) or sift.shape!=root.shape or sift.shape[1:]!=(128,) or len(shape)!=2:return None
  if not all(np.isfinite(a).all() for a in (points,sift,root)):return None
  return dict(shape=tuple(shape),kp=[SimpleNamespace(pt=tuple(p)) for p in points],sift=sift if len(sift) else None,root=root if len(root) else None)
 except (OSError,ValueError,KeyError,EOFError):return None

def save(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(dir=path.parent,suffix=".tmp")
    try:
        with os.fdopen(fd,"wb") as stream:
            np.savez_compressed(stream,points=np.asarray([k.pt for k in value["kp"]],dtype=np.float64).reshape(-1,2),
                                shape=np.asarray(value["shape"]),sift=value["sift"] if value["sift"] is not None else np.empty((0,128),np.float32),
                                root=value["root"] if value["root"] is not None else np.empty((0,128),np.float32))
            stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)
