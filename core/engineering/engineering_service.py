"""Production HTTP packaging adapter; recognition is the byte-pinned RC2 model."""
import hashlib,json,os,time
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path

def main():
 from engineering import load_model
 started=time.perf_counter();model,parent_state=load_model()
 state=dict(parent_state,name='SEM-ORG-FINAL-v3-EVAL-10S-ENGINEERING',recognition_parent='SEM-ORG-FINAL-v3-RC2-R90-GATED',ready=True,FINAL_V3_RECOGNITION_BEHAVIOR_EQUALS_RC2=True,complete_startup_seconds=time.perf_counter()-started)
 from resource_monitor import start_monitor
 start_monitor()
 print('READY '+json.dumps(state,ensure_ascii=False),flush=True)
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def send(self,status,value):
   body=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf-8');self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  def do_GET(self):
   if self.path in ('/health','/ready','/readyz'):self.send(200,state)
   else:self.send(404,{'error':'not_found'})
  def do_POST(self):
   if self.path!='/v1/eval/predict':self.send(404,{'error':'not_found'});return
   try:
    size=int(self.headers.get('Content-Length','0'))
    if not 0<size<=64*1024*1024:self.send(400,{'error':'invalid_image_size'});return
    payload=self.rfile.read(size);ctype=self.headers.get('Content-Type','application/octet-stream')
    if ctype.lower().startswith('multipart/form-data'):
     msg=BytesParser(policy=default).parsebytes(('Content-Type: '+ctype+'\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii')+payload)
     parts=[p for p in msg.iter_parts() if p.get_param('name',header='content-disposition')=='image']
     if len(parts)!=1:self.send(400,{'error':'exactly_one_image_required'});return
     payload=parts[0].get_payload(decode=True)
    if not payload:self.send(400,{'error':'empty_image'});return
    result=model.analyze(payload)
    print('PREDICTION '+json.dumps(dict(source_sha256=hashlib.sha256(payload).hexdigest(),catalog_item_id=result['top1'],slug=result['slug']),ensure_ascii=False),flush=True)
    self.send(200,{'slug':result['slug']})
    if os.environ.get('ENGINEERING_CAPTURE')=='1':
     from engineering import descriptor_hash
     actual={str(cid):descriptor_hash(value) for cid,value in model.pipeline.engineering_reference_objects.items()}
     assert actual==model.pipeline.engineering_audit['references'],'REFERENCE_DESCRIPTOR_MISMATCH'
     model.pipeline.engineering_reference_objects={}
     model.pipeline.engineering_audit['references']=actual
     destination=Path('/audit/records')/(hashlib.sha256(payload).hexdigest()+'.json')
     if destination.exists():
      destination=destination.with_name(destination.stem+'-'+str(time.time_ns())+'.json')
     with destination.open('x') as f:json.dump(dict(result=result,descriptors=model.pipeline.engineering_audit),f,ensure_ascii=False)
   except Exception as exc:self.send(500,{'error':type(exc).__name__,'message':str(exc)})
 HTTPServer(('0.0.0.0',8765),Handler).serve_forever()
if __name__=='__main__':main()
