"""Preregistered fixed R90 acquisition; pure merge with frozen downstream normalizer."""
import copy
from app.v82.parser import words
from app.v5.ocr import normalize

def norm(text):
 return ' '.join(w['value'] for w in words(str(text)))

def merge(zero, rotated, crop_sha, query=False):
 # 0-degree observations are immutable; do not upgrade their confidence.
 out=copy.deepcopy(zero)
 represented={norm(x) for x in zero.get('texts',[]) if norm(x)}
 groups={};order=[];suppressed=[]
 for i,line in enumerate(rotated.get('lines',[])):
  raw=line['text'];conf=line.get('confidence');n=norm(raw)
  occurrence=dict(copy.deepcopy(line),raw_text=raw,normalized_text=n,source_angle='R90_CW',source_crop_sha256=crop_sha,rotated_line_index=i)
  if not n or (query and ((conf if conf is not None else 1.)<.35 or not normalize(raw))):
   suppressed.append(dict(occurrence,reason='EXISTING_QUERY_OCR_FILTER' if query else 'EMPTY_NORMALIZED_SPAN'));continue
  if n in represented:
   suppressed.append(dict(occurrence,reason='NORMALIZED_ZERO_SPAN_DUPLICATE'));continue
  if n not in groups:groups[n]=[];order.append(n)
  groups[n].append(occurrence)
 appended=[]
 for n in order:
  occurrences=groups[n];best=max(occurrences,key=lambda x: x['confidence'] or 0.)
  span=dict(copy.deepcopy(best),provenance=occurrences)
  appended.append(span)
  out.setdefault('texts',[]).append(span['raw_text'])
  out.setdefault('confidences',[]).append(span['confidence'] or 0.)
  if 'lines' in out:out['lines'].append({k:span[k] for k in ['text','confidence','polygon','box']})
 if appended:out['text']=' '.join(out['texts'])
 return out,appended,suppressed

def rotate(image):
 from PIL import Image
 return image.transpose(Image.Transpose.ROTATE_270)

def selftest():
 from PIL import Image
 a=Image.new('L',(3,2));a.putdata([1,2,3,4,5,6]);b=rotate(a)
 assert b.size==(2,3) and list(b.getdata())==[4,1,5,2,6,3]
 z=dict(text='BRUT',texts=['BRUT'],confidences=[.81],lines=[dict(text='BRUT',confidence=.81,polygon=None,box=None)])
 lines=[dict(text=t,confidence=c,polygon=None,box=None) for t,c in [('brut',.99),('WHITE',.86),('white',.98),('noise',.2)]]
 r=dict(lines=lines);before=copy.deepcopy(z);out,added,supp=merge(z,r,'crop',True)
 assert z==before and out['texts']==['BRUT','white'] and out['confidences']==[.81,.98]
 assert out['lines'][:1]==z['lines'] and len(added[0]['provenance'])==2
 assert len(supp)==2 and norm('BRUT')==norm('\u0431\u0440\u044e\u0442')
 assert merge(z,dict(lines=[]),'crop',True)[0]==z
 return dict(clockwise_non_square_pixels=True,zero_prefix_exact=True,duplicate_zero_not_upgraded=True,r90_duplicate_max_confidence=True,all_duplicate_provenance=True,existing_normalizer=True,existing_query_threshold=True,empty_merge_identity=True)
