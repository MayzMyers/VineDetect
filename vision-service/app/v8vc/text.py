"""Conservative OCR observations; identity dictionaries never assert per-row truth."""
import math
import re
from collections import Counter,defaultdict
from ..v82.parser import Parser,words,recognize,GENERIC_MORE,ATTRS,FIELDS

MIN_CONFIDENCE=.8
HIGH_CONFIDENCE=.9
LEGAL_GENERIC=GENERIC_MORE | {"vino","rossii","rossiyskoe","krym","kryma","crimea","russian","soderzhit","sulfity","sulfites","contains","bottled","alc","alcohol","alkogol","proizvedeno","product","urozhai","urozhaya"}

def document(ocr):
    tokens={};phrases={}
    for line,conf in zip(ocr.get("texts",[]),ocr.get("confidences",[])):
        if conf is None or conf<MIN_CONFIDENCE:continue
        ws=[w["value"] for w in words(line)]
        for w in ws:
            if len(w)>=3 and not w.isdigit():tokens[w]=max(tokens.get(w,0),conf)
        for a,b in zip(ws,ws[1:]):
            if len(a)>=2 and len(b)>=2 and not (a.isdigit() or b.isdigit()):
                key=a+" "+b;phrases[key]=max(phrases.get(key,0),conf)
    return dict(tokens=tokens,phrases=phrases)

def fit_idf(documents):
    n=len(documents)
    return {field:{v:math.log((n+1)/(df+1))/math.log(n+1) for v,df in
             Counter(v for d in documents for v in d[field]).items()} for field in ["tokens","phrases"]}

def similarity(a,b,idf):
    keys=set(a)|set(b)
    # Unseen query terms use maximal IDF; only shared reference terms earn credit.
    av={k:a.get(k,0)*idf.get(k,1) for k in keys};bv={k:b.get(k,0)*idf.get(k,1) for k in keys}
    den=math.sqrt(sum(x*x for x in av.values())*sum(x*x for x in bv.values()))
    return sum(av[k]*bv[k] for k in keys)/den if den else 0.

def structured(a,b):
    """Compare only present same-axis observations. Missing attributes are neutral."""
    details=[];matches=[];conflicts=[]
    for field in ATTRS:
        axes={x["axis"] for x in a.get(field,[])} & {x["axis"] for x in b.get(field,[])}
        for axis in axes:
            aa=[x for x in a[field] if x["axis"]==axis and x["confidence"]>=MIN_CONFIDENCE]
            bb=[x for x in b[field] if x["axis"]==axis and x["confidence"]>=MIN_CONFIDENCE]
            if not aa or not bb:continue
            shared=[(x,y) for x in aa for y in bb if Parser.compatible(x["normalized_value"],y["normalized_value"])]
            match=max((min(x["confidence"],y["confidence"]) for x,y in shared),default=0.)
            conflict=0.
            if not shared and min(x["confidence"] for x in aa+bb)>=HIGH_CONFIDENCE:
                conflict=min(x["confidence"] for x in aa+bb)
            matches.append(match);conflicts.append(conflict)
            details.append(dict(field=field,axis=axis,match=match,conflict=conflict,
                                query=aa,reference=bb))
    return dict(match=sum(matches)/len(matches) if matches else 0.,
                conflict=sum(conflicts)/len(conflicts) if conflicts else 0.,details=details)

class VisibleParser:
    def __init__(self,rows):
        self.base=Parser(rows)
        lex=defaultdict(lambda:defaultdict(set))
        for cid,fields in self.base.expected.items():
            for field in ["producer","product"]:
                for e in fields[field]:
                    value=e["normalized_value"];parts=value.split()
                    if field=="product" and (len(parts)<2 or all(x in GENERIC_MORE for x in parts)):continue
                    if all(x in GENERIC_MORE for x in parts):continue
                    lex[tuple(parts)][field].add(cid)
        self.identity=defaultdict(list)
        for phrase,fields in lex.items():
            # Roles that collide between producer and product remain untyped text.
            if len(fields)!=1:continue
            field,ids=next(iter(fields.items()))
            self.identity[phrase[0]].append((phrase,field,sorted(ids)))
    def extract(self,ocr):
        text,ws,features=self.base.query(ocr)
        out={f:[] for f in FIELDS}
        for f,hits in features.items():
            for h in hits:
                if f=="vintage":
                    # A foundation year must never silently become a harvest year.
                    line_ids=h["ocr_span"]["lines"]
                    context=" ".join(ocr.get("texts",[])[max(0,min(line_ids)-1):max(line_ids)+2]).casefold()
                    if re.search(r"\b(since|founded|established|est|osnovan)\b|основан",context):
                        continue
                if h["confidence"]>=MIN_CONFIDENCE:
                    out[f].append(dict(h,source="reference_label_ocr",field_role="attribute_lexicon",
                        interpretation="visible_year_candidate" if f=="vintage" else "visible_phrase"))
        values=[w["value"] for w in ws]
        for i,w in enumerate(ws):
            for phrase,field,ids in self.identity.get(w["value"],[]):
                if tuple(values[i:i+len(phrase)])!=phrase:continue
                h=self.base.observation(text,ws,i,i+len(phrase)," ".join(phrase),"identity","catalog_wide_exact_visible_phrase")
                if h["confidence"]>=MIN_CONFIDENCE:
                    out[field].append(dict(h,source="reference_label_ocr",field_role="catalog_dictionary_role_unverified",
                        dictionary_catalog_ids=ids,interpretation="exact_visible_span_only"))
        # Link every observation to raw polygons/confidences; never synthesize boxes.
        for hits in out.values():
            for h in hits:
                h["ocr_lines"]=[dict(index=i,**ocr.get("lines",[])[i]) for i in h["ocr_span"]["lines"]
                                if i<len(ocr.get("lines",[]))]
        return out

def metadata_conflicts(observed,expected):
    results=[]
    for field in ["producer"]+list(ATTRS):
        aa=[x for x in observed.get(field,[]) if x["confidence"]>=HIGH_CONFIDENCE]
        bb=[x for x in expected.get(field,[]) if x.get("genuinely_typed")]
        for axis in {x["axis"] for x in aa}&{x["axis"] for x in bb}:
            left=[x for x in aa if x["axis"]==axis];right=[x for x in bb if x["axis"]==axis]
            if not any(Parser.compatible(x["normalized_value"],y["normalized_value"]) for x in left for y in right):
                results.append(dict(field=field,axis=axis,observed=left,official=right,
                    status="suspected_disjoint_visible_values_not_proven_catalog_truth"))
    return results

def usable_identity(doc):
    return len([w for w in doc["tokens"] if w not in LEGAL_GENERIC and len(w)>=3])>=2
