"""Exact-byte residency and deterministic geometry scheduling. No recognition formulas."""
import os,json,time,hashlib,threading,types,importlib.util
from pathlib import Path
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import cv2,numpy as np

def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def descriptor_hash(v):
 if v is None:return None
 out={}
 for name in ('sift','root'):
  a=v[name]
  out[name]=None if a is None else dict(dtype=a.dtype.str,shape=list(a.shape),sha256=hashlib.sha256(a.tobytes(order='C')).hexdigest())
 points=np.asarray([k.pt for k in v['kp']],dtype=np.float64).reshape(-1,2)
 out['points']=dict(dtype=points.dtype.str,shape=list(points.shape),sha256=hashlib.sha256(points.tobytes()).hexdigest())
 out['shape']=[int(x) for x in v['shape']]
 return out

def private_compare():
 from app.v5 import geometry as base
 from app.v8 import geometry as geom
 lowe=types.FunctionType(base.lowe_matches.__code__,dict(base.lowe_matches.__globals__,MATCHER=cv2.BFMatcher(cv2.NORM_L2)),base.lowe_matches.__name__,base.lowe_matches.__defaults__)
 return types.FunctionType(geom.compare.__code__,dict(geom.compare.__globals__,lowe_matches=lowe),geom.compare.__name__,geom.compare.__defaults__)

_tls=threading.local()
def branch(query,ref,mode):
 if not hasattr(_tls,'compare'):_tls.compare=private_compare()
 return _tls.compare(query,ref,mode)

def candidate(query,ref,layout):
 try:
  if layout=='C4':
   values=[branch(query,ref,m) for m in ('sift','root')]
  else:
   if not hasattr(_tls,'branches'):_tls.branches=[ThreadPoolExecutor(max_workers=1,thread_name_prefix='private-'+m) for m in ('sift','root')]
   futures=[p.submit(branch,query,ref,m) for p,m in zip(_tls.branches,('sift','root'))]
   values=[f.result() for f in futures]
  return dict(available=True,sift=values[0],root=values[1]),None
 except Exception as e:return dict(available=False,abstain_reason=type(e).__name__),str(e)

class ImmutablePoints:
 __slots__=('points',)
 def __init__(self,keypoints):
  self.points=np.asarray([p.pt for p in keypoints],dtype=np.float64).reshape(-1,2)
  self.points.flags.writeable=False
 def __len__(self):return len(self.points)
 def __getitem__(self,index):return types.SimpleNamespace(pt=tuple(self.points[index]))

class Scheduler:
 def __init__(self,layout):
  assert layout in ('C4','C2P');self.layout=layout;self.pool=ThreadPoolExecutor(max_workers=4 if layout=='C4' else 2,thread_name_prefix=layout)
 def run(self,pipeline,ids,query,text_features,trusted,failures,timings,timed):
  start=time.perf_counter();refs={};errors={};audit=os.environ.get('ENGINEERING_CAPTURE')=='1'
  before=descriptor_hash(query) if audit else None
  if query is not None:
   for name in ('sift','root'):
    if query[name] is not None:query[name].flags.writeable=False
   for cid in ids:
    try:refs[cid]=timed('reference_descriptors',lambda:pipeline.reference(cid))
    except Exception as e:errors[cid]=(type(e).__name__,str(e))
  old_threads=cv2.getNumThreads();assert old_threads==2
  cv2.setNumThreads(1)
  try:
   jobs={cid:self.pool.submit(candidate,query,refs[cid],self.layout) for cid in ids if query is not None and cid in refs}
   evidence={}
   for cid in ids:
    geom=dict(available=False,abstain_reason='no_trustworthy_target_label' if not trusted else 'disabled')
    if cid in errors:
     name,message=errors[cid];geom=dict(available=False,abstain_reason=name);failures.append(dict(stage='geometry',id=cid,message=message))
    elif cid in jobs:
     geom,error=jobs[cid].result()
     if error is not None:failures.append(dict(stage='geometry',id=cid,message=error))
     elif geom['available']:
      for m in ('sift','root'):timings[m+'_verification']=timings.get(m+'_verification',0)+geom[m]['matching_ms']+geom[m]['ransac_ms']
    evidence[cid]=dict(ocr=text_features[cid],geometry=geom)
  finally:cv2.setNumThreads(old_threads)
  timings['geometry_wall']=(time.perf_counter()-start)*1000
  if audit:
   after=descriptor_hash(query);assert before==after,'QUERY_MUTATION'
   pipeline.engineering_reference_objects=refs
   pipeline.engineering_audit=dict(layout=self.layout,query=after,references={str(cid):pipeline.H_hashes[cid] for cid in ids if cid in refs},query_immutable=True,reference_immutable=True,geometry_opencv_threads=1,outside_opencv_threads=old_threads,candidate_order=ids)
  return evidence

def preload(pipeline):
 from app.v8 import reference_cache
 start=time.perf_counter();root=Path('/release');manifest=json.loads((root/'runtime-manifest.json').read_text());hashes={};cid_hashes={};cid_keys={};bindings={}
 for cid,row in pipeline.backend.catalog.by_id.items():
  pipeline.backend.catalog.reference_path(cid)
  key=reference_cache.key(row['reference_sha256'])
  if key not in hashes:
   value=reference_cache.load(Path('/tmp')/(key+'.npz'));assert value is not None,key
   hashes[key]=descriptor_hash(value);source={}
   for n in ('points','sift','root','shape'):
    rel='descriptor-arrays/'+key+'/'+n+'.npy';actual=sha(root/rel);assert actual==manifest['files_sha256'][rel];source[rel]=actual
   bindings[key]=source
  cid_hashes[cid]=hashes[key];cid_keys[cid]=key
 assert set(hashes)==set(manifest['descriptor_keys'])
 pipeline.H_hashes=types.MappingProxyType(cid_hashes)
 return dict(optimization='H_NATIVE_FROZEN_LRU_FALLBACK',RAM_preload='REJECTED_RESOURCE_OOM',all_catalog_ids=len(cid_hashes),unique_descriptor_keys=len(hashes),seconds=time.perf_counter()-start,immutable=True,loaded_descriptor_hashes=hashes,sealed_file_hashes=bindings,catalog_id_to_descriptor_key=cid_keys,opencv_version=cv2.__version__,source='/release/descriptor-arrays on existing Linux-native ext4',rebuild=False,request_time_descriptor_file_reads='original bounded32-entry cache, exact read-only NPY mmap loads on miss')

def load_model():
 from gated_release import load_model as original_load
 overlay=Path(__file__).parent
 manifest=json.loads((overlay/'manifest.json').read_text())
 for name,expected in manifest['files_sha256'].items():assert sha(overlay/name)==expected,name
 started=time.perf_counter();model,state=original_load(Path('/release'))
 h=preload(model.pipeline)
 overlay=Path(__file__).parent
 spec=importlib.util.spec_from_file_location('app.v8.engineering_pipeline',overlay/'engineering_pipeline.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 model.pipeline.__class__=module.Pipeline
 model.pipeline.engineering_scheduler=Scheduler(os.environ['ENGINEERING_LAYOUT'])
 Path('/audit/hot-assets-loaded.json').write_text(json.dumps(h,ensure_ascii=False))
 state=dict(state,name='SEM-ORG-FINAL-v3-EVAL-10S-ENGINEERING',layout=os.environ['ENGINEERING_LAYOUT'],H='NATIVE_HOT_ASSETS_ORIGINAL_LRU',complete_startup_seconds=time.perf_counter()-started,opencv_threads=cv2.getNumThreads(),OMP_NUM_THREADS=os.environ.get('OMP_NUM_THREADS'),MKL_NUM_THREADS=os.environ.get('MKL_NUM_THREADS'),no_new_resize=True)
 return model,state
