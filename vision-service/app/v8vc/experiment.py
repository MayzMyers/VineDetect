"""Fixed global offline scorers over saved query OCR/pools. No image model imports."""
import argparse,json,hashlib
from pathlib import Path
from collections import Counter
import numpy as np
from ..v8.checkpoint import save,atomic_json,digest
from ..v8.config import Config
from ..v8.report import predict,write_csv
from ..v5.catalog import sha256
from .catalog import checked
from .text import document,similarity,structured,VisibleParser,usable_identity,GENERIC_MORE

SETS=["FIELD51","UNSEEN32","STORE13","FRESH8","IRECOMMEND128"]
MODELS=["A_current_V8","B_add_reference_text","C_reference_metadata"]

def contributions(base,feature,mode):
    values=dict(base)
    if mode=="A_current_V8":return values
    r=feature["reliability_factor"]
    if mode=="B_add_reference_text":
        values.update(reference_tokens=r*.4*feature["token_similarity"],
                      reference_phrases=r*.2*feature["phrase_similarity"],
                      reference_attribute_match=r*.2*feature["attribute_match"],
                      reference_attribute_conflict=-r*.2*feature["attribute_conflict"])
    elif mode=="C_reference_metadata":
        available=feature["reference_identity_available"]
        values["official_ocr_removed"]=-sum(base.get(k,0) for k in ["ocr_identity","ocr_attributes"]) if available else 0.
        values.update(reference_identity=r*.6*feature["reference_identity"] if available else 0.,
                      reference_attribute_match=r*.2*feature["attribute_match"] if available else 0.,
                      reference_attribute_conflict=-r*.2*feature["attribute_conflict"] if available else 0.)
    else:raise ValueError(mode)
    values["weak_official_agreement"]=.05*feature["official_agreement"]
    values["reliability_penalty"]=-.1*(1-r)
    return values

def run(repo):
    out=repo/".generated/v8vc"
    inventory=json.loads((out/"protected-inputs.json").read_text())
    assert all(sha256(repo/p)==h for p,h in inventory.items()),"Protected input changed"
    shadow=checked(out/"shadow-catalog.json");catalog={r["catalogItemId"]:r for r in shadow}
    idf=json.loads((out/"reference-idf.json").read_text())["idf"]
    rows=json.loads((repo/".generated/v7/image-manifest.json").read_text())
    assert len(rows)==232
    originals=[r["official_metadata"] for r in shadow];parser=VisibleParser(originals)
    config=Config(**json.loads((repo/".generated/v8/selected-config.json").read_text()))
    assert (config.ks,config.kd,config.ko,config.kl,config.max_pool_size)==(20,20,3,15,0)
    families=[set(r["catalogItemIds"]) for r in json.loads((repo/".generated/irecommend531/gt-audit/equivalence_groups.json").read_text())]
    predictions={name:[] for name in MODELS};v7=[];inpool=[];gt=[];audits=[];coverage=[];features_out=[];parity=[]
    for row in rows:
        key=hashlib.sha256(row["key"].encode()).hexdigest()
        t=checked(repo/".generated/v8/explore"/(key+".json"))["trace"]
        saved=checked(repo/".generated/v8/variants"/(key+"-V8-final.json"))
        reproduced=predict(t,config)
        assert [(c["id"],c["score"],c["contributions"]) for c in reproduced["ordered"]]==[(c["id"],c["score"],c["contributions"]) for c in saved["ordered"]]
        assert reproduced["pool_ids"]==saved["pool_ids"]
        assert reproduced["top1"]==saved["top1"] and reproduced["margin"]==saved["margin"]
        gt.append(row["expected"]);inpool.append(row["expected"] in saved["pool_ids"])
        old=json.loads((repo/".generated/v7/images"/(key+"-V7-B.json")).read_text())
        assert old["key"]==row["key"] and old["imageSha256"]==row["sha256"]
        v7.append(old["result"]["catalogItemId"])
        query=document(t["ocr"]);qfields=parser.extract(t["ocr"])
        qfields={f:[dict(x,source="saved_query_label_ocr") for x in vs] for f,vs in qfields.items()}
        features={};orders={}
        for cand in saved["ordered"]:
            cid=cand["id"];ref=catalog[cid]
            token=similarity(query["tokens"],ref["document"]["tokens"],idf["tokens"])
            phrase=similarity(query["phrases"],ref["document"]["phrases"],idf["phrases"])
            attrs=structured(qfields,ref["reference_derived_metadata"])
            official=document(dict(texts=[str(ref["official_metadata"].get("winery") or "")+" "+ref["official_metadata"]["title"]],confidences=[1.]))
            weak=similarity(query["tokens"],official["tokens"],idf["tokens"])
            features[cid]=dict(token_similarity=token,phrase_similarity=phrase,
                reference_identity=(2*token+phrase)/3,reference_identity_available=ref["usable_identity"],
                attribute_match=attrs["match"],attribute_conflict=attrs["conflict"],attribute_provenance=attrs["details"],
                official_agreement=weak,official_agreement_source=["winery","title"],
                reliability=ref["reference_reliability"]["status"],reliability_factor=ref["reference_reliability"]["factor"],
                shared_tokens=sorted(set(query["tokens"])&set(ref["document"]["tokens"])),
                shared_phrases=sorted(set(query["phrases"])&set(ref["document"]["phrases"])))
        for mode in MODELS:
            order=[]
            for cand in saved["ordered"]:
                cid=cand["id"];c=contributions(cand["contributions"],features[cid],mode)
                # Preserve exact baseline float computation/tie order for parity.
                score=cand["score"] if mode==MODELS[0] else sum(c.values())
                order.append(dict(id=cid,score=score,contributions=c))
            order.sort(key=lambda x:(-x["score"],x["id"]))
            assert set(x["id"] for x in order)==set(saved["pool_ids"])
            predictions[mode].append(order[0]["id"]);orders[mode]=order
            if order[0]["id"]!=saved["top1"]:
                ids={saved["top1"],order[0]["id"],row["expected"]}
                audits.append(dict(key=row["key"],dataset=row["dataset"],model=mode,gt=row["expected"],
                    old_top1=saved["top1"],new_top1=order[0]["id"],v7=v7[-1],
                    candidates=[dict(candidateId=cid,features=features[cid],
                      baseline=next(c for c in saved["ordered"] if c["id"]==cid),
                      new=next(c for c in order if c["id"]==cid)) for cid in sorted(ids) if cid in features]))
        assert predictions[MODELS[0]][-1]==saved["top1"]
        parity.append(dict(key=row["key"],pool_unchanged=True,full_V8_order_score_parity=True))
        coverage.append(dict(key=row["key"],dataset=row["dataset"],query_usable_identity=usable_identity(query),
           query_ocr_nonempty=bool(t["ocr"]["text"]),pool_size=len(features),
           reference_identity_candidates=sum(f["reference_identity_available"] for f in features.values()),
           token_overlap_candidates=sum(f["token_similarity"]>0 for f in features.values()),
           phrase_overlap_candidates=sum(f["phrase_similarity"]>0 for f in features.values()),
           structured_overlap_candidates=sum(f["attribute_match"]>0 for f in features.values()),
           gt_in_pool=inpool[-1],gt_token_overlap=features.get(row["expected"],{}).get("token_similarity",0)>0))
        payload=dict(key=row["key"],expected=row["expected"],pool_ids=saved["pool_ids"],features=features,orders=orders,
                     saved_query_ocr=t["ocr"],query_attributes=qfields)
        save(out/"features"/(key+".json"),payload,dict(trace=digest(t),shadow=digest(shadow),
             scorer=sha256(Path(__file__)),text=sha256(Path(__file__).with_name("text.py")),
             plan=sha256(repo/"docs/V8_VC_PHASE1_PLAN.md")))
    gt=np.array(gt);v7=np.array(v7);inpool=np.array(inpool);predictions={k:np.array(v) for k,v in predictions.items()}
    masks={ds:np.array([r["dataset"]==ds for r in rows]) for ds in SETS}
    def metrics(p,datasets=SETS):
        stats={}
        for ds in datasets:
            ix=masks[ds];truth=gt[ix];new=p[ix];old=v7[ix];exact=new==truth
            stats[ds]=dict(n=int(ix.sum()),exact=int(exact.sum()),accuracy=float(exact.mean()),
               fixed_v7=int(((new==truth)&(old!=truth)).sum()),broken_v7=int(((new!=truth)&(old==truth)).sum()),
               sibling_errors=sum(int(a!=b and any(a in group and b in group for group in families)) for a,b in zip(new,truth)),
               potential_same_producer_errors=sum(int(a!=b and catalog[int(a)]["official_metadata"].get("winery")==catalog[int(b)]["official_metadata"].get("winery")) for a,b in zip(new,truth)),
               gt_in_pool=int(inpool[ix].sum()),conditional_accuracy=float((exact&inpool[ix]).sum()/inpool[ix].sum()))
        return dict(datasets=stats,pooled_exact=sum(s["exact"] for s in stats.values()),
            macro_exact=float(np.mean([s["accuracy"] for s in stats.values()])),
            fixed_v7=sum(s["fixed_v7"] for s in stats.values()),broken_v7=sum(s["broken_v7"] for s in stats.values()),
            sibling_errors=sum(s["sibling_errors"] for s in stats.values()),
            potential_same_producer_errors=sum(s["potential_same_producer_errors"] for s in stats.values()),
            conditional_accuracy=sum(s["conditional_accuracy"]*s["gt_in_pool"] for s in stats.values())/sum(s["gt_in_pool"] for s in stats.values()))
    allstats={name:metrics(p) for name,p in predictions.items()}
    allstats["V7-B"]=metrics(v7)
    def choose(training):
        stats={m:metrics(p,training) for m,p in predictions.items()}
        feasible=[m for m,s in stats.items() if all(s["datasets"][ds]["exact"]>=stats[MODELS[0]]["datasets"][ds]["exact"] for ds in ["FIELD51","STORE13"] if ds in training)]
        return min(feasible,key=lambda m:(-stats[m]["macro_exact"],stats[m]["sibling_errors"],-stats[m]["pooled_exact"],MODELS.index(m)))
    nested=np.zeros(len(gt),int);folds=[]
    # No fitted query-dependent parameters. Inner heldout predictions are fixed scores;
    # only model choice uses the four training datasets, never the outer dataset.
    for outer in SETS:
        training=[d for d in SETS if d!=outer]
        selected=choose(training);nested[masks[outer]]=predictions[selected][masks[outer]]
        folds.append(dict(heldout=outer,selected=selected,inner_validation_datasets=training,
                         heldout_metrics=metrics(predictions[selected],[outer])))
    nestedstats=metrics(nested);best=choose(SETS)
    def bootstrap(p,baseline):
        rng=np.random.default_rng(8203);parts=[]
        for ds in SETS:
            ix=np.flatnonzero(masks[ds]);delta=(p[ix]==gt[ix]).astype(float)-(baseline[ix]==gt[ix]).astype(float)
            parts.append(delta[rng.integers(0,len(ix),size=(10000,len(ix)))].mean(axis=1))
        return [float(x) for x in np.quantile(np.mean(parts,axis=0),[.025,.975])]
    intervals={m:bootstrap(p,predictions[MODELS[0]]) for m,p in predictions.items()}
    nested_interval=bootstrap(nested,predictions[MODELS[0]])
    gates={}
    for mode in MODELS[1:]:
        a=allstats[mode];base=allstats[MODELS[0]]
        checks=dict(macro_gain_2pp=a["macro_exact"]>=base["macro_exact"]+.02,
           field_store_no_loss=all(a["datasets"][ds]["exact"]>=base["datasets"][ds]["exact"] for ds in ["FIELD51","STORE13"]),
           field_store_within_one_of_v7=all(a["datasets"][ds]["exact"]>=allstats["V7-B"]["datasets"][ds]["exact"]-1 for ds in ["FIELD51","STORE13"]),
           nested_macro_improves=nestedstats["macro_exact"]>base["macro_exact"],
           pooled_no_loss=a["pooled_exact"]>=base["pooled_exact"],
           bootstrap_lower_not_materially_negative=intervals[mode][0]>=-.005 and nested_interval[0]>=-.005)
        gates[mode]=dict(checks=checks,passed=all(checks.values()))
    summary=dict(models=allstats,nested=nestedstats,nested_folds=folds,selected=best,
       bootstrap_macro_delta95=intervals,nested_bootstrap_macro_delta95=nested_interval,promotion_gates=gates,
       promoted=any(g["passed"] for g in gates.values()),query_inference_performed=False,
       coverage=dict(images=232,query_ocr_nonempty=sum(r["query_ocr_nonempty"] for r in coverage),
          query_usable_identity=sum(r["query_usable_identity"] for r in coverage),
          images_any_token_overlap=sum(r["token_overlap_candidates"]>0 for r in coverage),
          images_any_phrase_overlap=sum(r["phrase_overlap_candidates"]>0 for r in coverage),
          images_any_structured_overlap=sum(r["structured_overlap_candidates"]>0 for r in coverage),
          gt_in_pool=sum(r["gt_in_pool"] for r in coverage),gt_token_overlap=sum(r["gt_token_overlap"] for r in coverage),
          candidate_pairs=sum(r["pool_size"] for r in coverage),
          usable_reference_pairs=sum(r["reference_identity_candidates"] for r in coverage),
          token_overlap_pairs=sum(r["token_overlap_candidates"] for r in coverage)),
       changed_top1=dict(Counter(r["model"] for r in audits)),
       limitations=["Family-only sibling groups are incomplete and never change GT.",
         "Potential same-producer errors are a broad diagnostic, not established sibling SKUs.",
         "Known reference reliability is seeded from manual audits; gate is development sensitivity, not unseen validation.",
         "Identity field roles use a catalog-wide dictionary; raw reference text remains independent of official row assertions."])
    atomic_json(out/"experiment-summary.json",summary);atomic_json(out/"changed-decisions.json",audits)
    atomic_json(out/"parity.json",parity);write_csv(out/"coverage.csv",coverage)
    write_csv(out/"predictions.csv",[dict(key=r["key"],dataset=r["dataset"],gt=int(gt[i]),v7=int(v7[i]),
            **{m:int(p[i]) for m,p in predictions.items()},nested=int(nested[i])) for i,r in enumerate(rows)])
    atomic_json(out/"protected-inputs-validation.json",dict(files=len(inventory),unchanged=all(sha256(repo/p)==h for p,h in inventory.items())))
    assert all(sha256(repo/p)==h for p,h in inventory.items())
    print(json.dumps(summary))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--repo",default=".");a=p.parse_args();run(Path(a.repo).resolve())
