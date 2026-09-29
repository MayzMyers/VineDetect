import json,time,threading,resource
from pathlib import Path

def sample():
 import torch,cv2
 value=dict(timestamp=time.time(),rss_peak_KiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved(),opencv_threads=cv2.getNumThreads())
 for name in ['memory.current','memory.peak','memory.events','memory.stat','cpu.stat','cpu.max']:
  try:value[name]=Path('/sys/fs/cgroup',name).read_text()
  except OSError:value[name]=None
 return value

def start_monitor():
 def run():
  with Path('/audit/resource-samples.jsonl').open('x') as f:
   while True:
    f.write(json.dumps(sample())+'\n');f.flush();time.sleep(2)
 threading.Thread(target=run,daemon=True).start()
