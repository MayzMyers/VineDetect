from .config import SOURCES

def build_pool(sources, config):
    nominated={}
    for source,k in zip(SOURCES,(config.ks,config.kd,config.ko,config.kl)):
        for row in sources.get(source,[])[:k]:
            cid=row["id"]
            item=nominated.setdefault(cid,dict(id=cid,sources={},fusion=0.))
            item["sources"][source]=dict(row)
            item["fusion"]+=1/(config.fusion_offset+row["rank"])
    ordered=sorted(nominated.values(),key=lambda r:(-r["fusion"],r["id"]))
    for i,row in enumerate(ordered,1):
        row["fusion_rank"]=i
    selected=ordered[:config.max_pool_size] if config.max_pool_size else ordered
    return selected, ordered
