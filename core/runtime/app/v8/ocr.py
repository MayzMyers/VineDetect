"""Catalog-only token statistics and structured exact canonical evidence; no switch semantics."""
import math
import re
from collections import Counter
from ..v5.ocr import normalize, translit

# Safe lexical equivalences from V7; no V7 policy/module is imported.
EQUIVALENCES = (
("fanagoria","fanagoriya","фанагория"),("brut","bryut","брют"),
("riesling","risling","рислинг"),("cabernet","kaberne","каберне"),
("sauvignon","sovinon","совиньон"),("chardonnay","shardone","шардоне"),
("merlot","merlo","мерло"),("syrah","shiraz","sira","сира","шираз"),
("white","beloe","belyi","белое","белый"),("red","krasnoe","krasnyi","красное","красный"),
("rose","roze","rozovoe","розе","розовое"),("semisweet","polusladkoe","полусладкое"),
("dry","suhoe","сухое"),("semidry","polusuhoe","полусухое"),
("sweet","sladkoe","сладкое"),("wine","vino","вино","wines","вина"),
("extra","ekstra","экстра"),("sparkling","igristoe","игристое"))
CANONICAL={translit(t):g[0] for g in EQUIVALENCES for t in g}
GENERIC={"wine","rossiya","russia","protected","zaschischennogo","naimenovaniya","proishozhdeniya",
         "geograficheskogo","ukazaniya","vysokogo","kachestva","ml","vol","collection","kollektsiya"}
CATEGORIES=dict(grape={"cabernet","sauvignon","chardonnay","merlot","syrah","riesling","saperavi",
                      "aligote","muskat","pinot","pino","noir","nuar","krasnostop","tsimlyanskii"},
                color_style={"white","red","rose","sparkling"},sweetness={"dry","semidry","sweet","semisweet"},
                brut={"brut","extra"})
FIELDS=("producer","product","grape","color_style","sweetness","brut","vintage","other")

def tokens(text):
    return {CANONICAL.get(translit(t),translit(t)) for t in normalize(text).split() if len(t)>=3}

def structured(row):
    title=tokens(row.get("title",""))
    all_tokens=title|tokens(row.get("category",""))|tokens(row.get("grapes",""))
    producer=set().union(*(tokens(row.get(k,"")) for k in ("winery","manufacturer","producer")))
    parts=dict(producer=producer)
    for k,v in CATEGORIES.items():
        parts[k]=all_tokens&v
    parts["grape"] |= tokens(row.get("grapes",""))-GENERIC
    parts["vintage"]={t for t in all_tokens if re.fullmatch(r"(19|20)\d{2}",t)}
    used=set().union(*parts.values())|GENERIC
    parts["product"]=title-used
    parts["other"]=tokens(row.get("official_slug",""))-used-parts["product"]
    # Slug trailing alcohol quantities are not discriminative identity.
    parts["other"]={t for t in parts["other"] if not t.isdigit()}
    return parts

class CatalogText:
    def __init__(self,rows,minimum=.45):
        self.parts={int(r["catalog_item_id"]):structured(r) for r in rows}
        df=Counter(t for p in self.parts.values() for t in set().union(*p.values()))
        self.idf={t:0. if t in GENERIC else math.log((len(rows)+1)/(n+1))/math.log(len(rows)+1)
                  for t,n in df.items()}
        self.minimum=minimum

    def features(self,text):
        query=tokens(text); result={}
        qattrs={k:query&v for k,v in CATEGORIES.items()}
        qattrs["vintage"]={t for t in query if re.fullmatch(r"(19|20)\d{2}",t)}
        for cid,parts in self.parts.items():
            fields={}
            for k in FIELDS:
                expected=parts[k]; matched=expected&query
                # A disjoint observed attribute is conflict; absence is never conflict.
                observed=qattrs.get(k,set())
                conflict=observed if observed and expected and not (observed&expected) else set()
                fields[k]=dict(matched=sorted(matched),conflicts=sorted(conflict),
                               missing=sorted(expected-query), absent=not bool(matched or conflict),
                               match_weight=sum(self.idf.get(t,0.) for t in matched))
            identity=set().union(*(set(fields[k]["matched"]) for k in ("producer","product","other")))
            discriminative=sorted(t for t in identity if self.idf.get(t,0)>=self.minimum)
            identity_score=min(1.,sum(self.idf.get(t,0) for t in identity)/2)
            attrs=[fields[k] for k in ("grape","color_style","sweetness","brut","vintage")]
            agree=sum(bool(x["matched"]) for x in attrs)/5
            conflict=sum(bool(x["conflicts"]) for x in attrs)/5
            result[cid]=dict(fields=fields, identity=identity_score, attribute_agreement=agree,
                             attribute_conflict=conflict, discriminative=discriminative,
                             available=bool(query))
        ranked=sorted((dict(id=cid,score=x["identity"],matched_tokens=x["discriminative"])
                       for cid,x in result.items() if x["discriminative"]),
                      key=lambda r:(-r["score"],r["id"]))
        return result,[dict(r,rank=i) for i,r in enumerate(ranked,1)]
