"""Deployment entry point for the byte-pinned SEM-ORG cache architecture."""
import hashlib,json,os,sys,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer

def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def configure(root=None):
 root=Path(root or os.environ.get('SEM_ORG_RELEASE_ROOT',Path(__file__).parent)).resolve()
 if str(root) in sys.path:sys.path.remove(str(root))
 sys.path.insert(0,str(root))
 for name,value in {'RETRIEVAL_GALLERY_ROOT':root/'gallery','V5_ASSET_ROOT':root/'assets','SEM_ORG_DESCRIPTOR_ARRAYS':root/'descriptor-arrays','V8_REFERENCE_CACHE':'/tmp/sem-org-reference-writeback'}.items():os.environ[name]=str(value)
 os.environ['V8_SIGLIP_URL']=''
 return root

def validate_package(root):
 manifest=json.loads((root/'runtime-manifest.json').read_text())
 for name,h in manifest['files_sha256'].items():
  p=root/name
  if not p.is_file() or sha(p)!=h:raise RuntimeError('RELEASE_INPUT_MISSING_OR_CHANGED: '+name)
 return manifest

def load_model(root=None):
 root=configure(root);start=time.perf_counter();manifest=validate_package(root)
 import torch,cv2
 from app.v8.backend import Backend
 from app.v8.pipeline import Pipeline
 from app.v8.config import Config
 from app.v8vc.text import VisibleParser
 from app.sem075_live import LiveSEM,LAMBDA
 cv2.setNumThreads(2);torch.set_num_threads(2)
 cfg=json.loads((root/'config.json').read_text());refs=json.loads((root/'references.json').read_text())
 if LAMBDA!=.75 or not cfg['geometry_enabled'] or not all(x['reference_reliability']['factor']==1 for x in refs):raise RuntimeError('FROZEN_ARCHITECTURE_MISMATCH')
 m=LiveSEM.__new__(LiveSEM);m.references={x['catalogItemId']:x for x in refs};m.idf=json.loads((root/'reference-idf.json').read_text())['idf'];m.parser=VisibleParser([x['official_metadata'] for x in refs]);m.pipeline=Pipeline(Backend(),Config(**cfg))
 from app.v8 import reference_cache
 keys={reference_cache.key(x['reference_sha256']) for x in m.pipeline.backend.catalog.rows}
 if keys!=set(manifest['descriptor_keys']):raise RuntimeError('DESCRIPTOR_BINDING_MISMATCH')
 torch.cuda.synchronize()
 state=dict(ready=True,name='SEM-ORG-FINAL',startup_s=time.perf_counter()-start,cache=True,geometry=True,h2=False,dq2=False,historical_reliability=False,supplemental_reference_ids=[],lambda_sem=LAMBDA,catalog_count=len(m.pipeline.backend.catalog.rows),descriptor_keys=len(keys),runtime_manifest_sha256=sha(root/'runtime-manifest.json'),config=cfg)
 return m,state

def response(result):return json.dumps(dict(catalogItemId=result['top1'],slug=result['slug']),ensure_ascii=False,separators=(',',':')).encode('utf-8')
def make_server(model,state,host='127.0.0.1',port=8765,observer=None):
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def send(self,status,body):
   self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  def do_GET(self):
   self.send(200,json.dumps(state).encode()) if self.path=='/health' else self.send(404,b'{}')
  def do_POST(self):
   if self.path!='/v1/recognize':self.send(404,b'{}');return
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=64*1024*1024:self.send(400,b'{"error":"invalid_image_size"}');return
   try:
    result=model.analyze(self.rfile.read(size));body=response(result)
    if observer:observer(result)
    self.send(200,body)
   except Exception as exc:self.send(500,json.dumps(dict(error=type(exc).__name__,message=str(exc))).encode())
 return HTTPServer((host,port),Handler)

if __name__=='__main__':
 m,state=load_model();server=make_server(m,state,os.environ.get('SEM_ORG_HOST','0.0.0.0'),int(os.environ.get('SEM_ORG_PORT','8765')));print(json.dumps(state),flush=True);server.serve_forever()
