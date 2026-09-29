"""The only identity decision stage. Global weights; deterministic ID tie breaking."""
from .config import GROUPS, SOURCES
from .geometry import normalized

def rank(pool, evidence, sources, config):
    lookups={s:{r["id"]:r for r in sources.get(s,[])} for s in SOURCES}
    scales={}
    for s,rows in sources.items():
        values=[r["score"] for r in rows]
        scales[s]=(min(values),max(values)) if values else (0.,0.)
    ranked=[]
    for nomination in pool:
        cid=nomination["id"]; raw=evidence[str(cid)] if str(cid) in evidence else evidence[cid]
        semantic={}; scores={}
        for s in ("siglip","dino","label_siglip"):
            row=lookups[s].get(cid); lo,hi=scales.get(s,(0.,0.))
            semantic[s]=dict(score=row["score"] if row else None,rank=row["rank"] if row else None,
                             missing=row is None, outside_k=row is None)
            # Missing stays explicit; zero contribution is not a fabricated raw similarity.
            scores[s]=0. if row is None else .75*((row["score"]-lo)/(hi-lo) if hi>lo else 1.)+.25/row["rank"]
        dw=config.dino_weight if config.kd else 0.; lw=config.label_weight if config.kl else 0.
        sem=(scores["siglip"]+dw*scores["dino"]+lw*scores["label_siglip"])/(1+dw+lw)
        o=raw["ocr"]; geom=raw["geometry"]
        groups=dict(semantic=sem,ocr_identity=o["identity"] if config.ko else 0.,
                    ocr_attributes=o["attribute_agreement"]-o["attribute_conflict"] if config.ko else 0.,
                    geometry=normalized(geom) if config.geometry_enabled else 0.,
                    quality=(int(o["available"] and config.ko>0)+int(geom.get("available",False) and config.geometry_enabled))/2)
        contributions={k:groups[k]*w for k,w in zip(GROUPS,config.weights)}
        ranked.append(dict(**nomination,semantic=semantic,raw=raw,groups=groups,contributions=contributions,
                           score=sum(contributions.values())))
    return sorted(ranked,key=lambda r:(-r["score"],r["id"]))
