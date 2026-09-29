#!/usr/bin/env python3
"""Read-only health checks; optionally send one user-provided image to the BFF."""
import argparse,json,urllib.request,uuid
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--web',default='http://localhost:3000');p.add_argument('--api',default='http://localhost:8000');p.add_argument('--core',default='http://localhost:8765');p.add_argument('--image',type=Path);a=p.parse_args()
 for url in (a.api+'/health',a.core+'/ready',a.web+'/scan'):
  with urllib.request.urlopen(url,timeout=20) as r:print(r.status,url)
 if a.image:
  boundary=uuid.uuid4().hex
  body=('--'+boundary+'\r\nContent-Disposition: form-data; name="image"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n').encode()+a.image.read_bytes()+('\r\n--'+boundary+'--\r\n').encode()
  req=urllib.request.Request(a.web+'/api/recognition/jobs',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
  with urllib.request.urlopen(req,timeout=130) as r:result=json.load(r)
  assert result['slug']==result['product']['slug']
  print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
