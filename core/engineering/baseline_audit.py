"""CPU-only baseline reconstruction/storage replay; no recognition inference."""
import os,json,time,hashlib,sys,io,statistics
from pathlib import Path
from collections import OrderedDict
import cv2,numpy as np
from PIL import Image,ImageOps
from engineering import descriptor_hash
from app.v8.geometry import descriptors,normalized
from app.v8.backend import jpeg95
from app.v8.target import crop
from app.v8 import reference_cache
from app.v5.catalog import Catalog
R=Path('/repo');S=Path('/audit');F=Path('/release');E=R/'.generated/final-endgame'
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def put(p,x):
 with p.open('x') as f:json.dump(x,f,ensure_ascii=False,indent=2)
def pixels(im):return hashlib.sha256(im.mode.encode()+str(im.size).encode()+im.tobytes()).hexdigest()
cv2.setNumThreads(2)
rows=load(S/'authority/development-population.json');out=[]
for i,x in enumerate(rows):
 raw=(R/x['source_path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==x['source_sha256']
 record=load(E/'r90-support-gate/fresh-output/records'/(x['source_sha256']+'.json'));t=record['result']['trace']
 with Image.open(io.BytesIO(raw)) as original:image=ImageOps.exif_transpose(original).convert('RGB')
 bottle=jpeg95(crop(image,t['target']['selected_box']));label=crop(bottle,t['label']['selected_box'])
 assert pixels(image)==t['canonical_pixel_hash'];assert pixels(bottle)==t['target_pixel_hash'];assert pixels(label)==t['label_pixel_hash']
 query=descriptors(cv2.cvtColor(np.asarray(label),cv2.COLOR_RGB2BGR)) if t['label']['trusted'] and t['config']['geometry_enabled'] else None
 start=time.perf_counter();values=[normalized(v['geometry']) for v in t['evidence'].values()];aggregate_ms=(time.perf_counter()-start)*1000
 out.append(dict(review_id=x['review_id'],source_sha256=x['source_sha256'],query=descriptor_hash(query),all_three_pixel_hashes_match=True,saved_authority_record_sha256=sha(E/'r90-support-gate/fresh-output/records'/(x['source_sha256']+'.json')),geometry_aggregation_ms=aggregate_ms))
 if i%20==0:print('BASELINE_DESCRIPTORS',i+1,len(rows),flush=True)
put(S/'profile/derived-query-descriptor-baseline.json',dict(method='Original frozen descriptor function on original source and saved exact target/label boxes; all three pixel hashes match; these hashes are derived now, absent from historical trace',rows=out))
print('QUERY_BASELINE_COMPLETE',flush=True)
manifest=load(F/'runtime-manifest.json');catalog_rows=load(F/'gallery/catalog.json');catalog_rows=catalog_rows['rows'] if isinstance(catalog_rows,dict) else catalog_rows
byid={int(x['catalog_item_id']):x for x in catalog_rows};keys={cid:reference_cache.key(x['reference_sha256']) for cid,x in byid.items()}
seq=[]
for x in rows:
 if x['population']=='org-real35':
  t=load(E/'r90-support-gate/fresh-output/records'/(x['source_sha256']+'.json'))['result']['trace'];seq+=sorted(t['pool_ids'])
# First prove all request-hot arrays and source images in this replay are exact bytes on D and native.
file_bindings={}
for cid in sorted(set(seq)):
 row=byid[cid];rel='assets/'+row['reference_path'];expected=manifest['files_sha256'][rel]
 for root in (F,Path('/Drelease')):assert sha(root/rel)==expected,(root,rel)
 file_bindings[rel]=expected
 for n in ('points','sift','root','shape'):
  rel='descriptor-arrays/'+keys[cid]+'/'+n+'.npy';expected=manifest['files_sha256'][rel]
  for root in (F,Path('/Drelease')):assert sha(root/rel)==expected,(root,rel)
  file_bindings[rel]=expected
print('STORAGE_BYTES_MATCH',len(file_bindings),flush=True)
results=[]
for root in (Path('/Drelease'),F):
 os.environ['SEM_ORG_DESCRIPTOR_ARRAYS']=str(root/'descriptor-arrays')
 for repeat in range(3):
  cache=OrderedDict();lookups=[];miss=0;value_hashes={};start=time.perf_counter()
  for cid in seq:
   t0=time.perf_counter()
   if cid in cache:value=cache[cid];cache.move_to_end(cid)
   else:
    row=byid[cid];assert sha(root/'assets'/row['reference_path'])==row['reference_sha256']
    # Reproduce the key's repeated frozen-code IO from the respective storage path.
    key=hashlib.sha256((row['reference_sha256']+cv2.__version__+sha(root/'app/v5/geometry.py')).encode()).hexdigest();assert key==keys[cid]
    value=reference_cache.load(Path('/tmp')/(key+'.npz'));assert value is not None;cache[cid]=value;miss+=1
    while len(cache)>32:cache.popitem(last=False)
   lookups.append((time.perf_counter()-t0)*1000)
  total=time.perf_counter()-start
  # Hash resulting objects outside timed lookup section.
  for cid,value in cache.items():value_hashes[str(cid)]=descriptor_hash(value)
  results.append(dict(root=str(root),repeat=repeat,warmup=repeat==0,lookup_count=len(seq),misses=miss,total_seconds=total,sum_lookup_seconds=sum(lookups)/1000,mean_lookup_ms=statistics.mean(lookups),final_cache_hashes=value_hashes))
  print('STORAGE_REPLAY',root,repeat,round(total,3),flush=True)
assert results[0]['final_cache_hashes']==results[-1]['final_cache_hashes']
put(S/'hot-assets/storage-replay.json',dict(timestamp=time.time(),method='Exact original reference miss path replay, 32-entry LRU, entire ORG35 sequence; one warmup then two repeats per path; hash proof before measured replay warms OS cache; no disk-cold claim; no GPU inference',file_bindings=file_bindings,unique_ids=len(set(seq)),results=results))
