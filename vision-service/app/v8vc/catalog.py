"""Build an independently auditable shadow catalog from completed reference records."""
import argparse,json,hashlib,math
from pathlib import Path
from collections import Counter,defaultdict
import numpy as np
from ..v8.checkpoint import read,save,atomic_json,digest
from ..v5.catalog import sha256
from .text import VisibleParser,document,fit_idf,usable_identity,metadata_conflicts,GENERIC_MORE,FIELDS

FACTORS=dict(trusted=1.,suspect_metadata=.75,manual_review=.5,suspect_reference=.25,known_bad_reference=0.)
MANUAL_BAD={277,308,378,587,590,591,592,655}
PAIRS=[(177,598),(396,606),(436,438),(450,454),(515,516),(546,547),(566,567),
       (573,580),(576,577),(593,605),(607,648),(614,617)]
TENTATIVE=[(523,524)]
DISTINCT=[(480,481),(641,642),(672,673)]

def checked(p):
    r=json.loads(p.read_text());assert r["schema"]=="v8-checkpoint/2"
    d=read(p,r["provenance"])
    if d is None:raise ValueError("Corrupt checkpoint "+str(p))
    return d

def reliability(known_bad,conflicts,alternate,usable,duplicate,metadata_seed=False,unresolved=False):
    reasons=[]
    if known_bad:reasons.append("known_reference_defect")
    if any(c["field"]=="producer" for c in conflicts):reasons.append("visible_producer_contradiction")
    if alternate:reasons.append("ocr_matches_other_catalog_identity_substantially_better")
    if conflicts:reasons.append("official_visible_attribute_conflict")
    if metadata_seed:reasons.append("manual_metadata_conflict_to_revisit")
    if not usable:reasons.append("insufficient_reference_identity_text")
    if duplicate:reasons.append("duplicate_or_near_duplicate_review")
    if unresolved:reasons.append("manual_unresolved")
    status=("known_bad_reference" if known_bad else
        "suspect_reference" if any(c["field"]=="producer" for c in conflicts) or alternate else
        "suspect_metadata" if conflicts or metadata_seed else
        "manual_review" if not usable or duplicate or unresolved else "trusted")
    return dict(status=status,factor=FACTORS[status],reasons=reasons,
                meaning="automated_quality_flag_not_manual_certification")

def build(repo):
    out=repo/".generated/v8vc"
    rows=json.loads((repo/".runtime/v5-rc1/catalog.json").read_text())["rows"]
    raw={r["catalog_item_id"]:checked(out/"references"/f'{r["catalog_item_id"]}.json') for r in rows}
    assert len(raw)==2103
    for r in rows:
        x=raw[r["catalog_item_id"]]
        assert (x["catalogItemId"],x["slug"],x["reference_sha256"])==(r["catalog_item_id"],r["official_slug"],r["reference_sha256"])
        for rel,h in x["artifacts"].items():assert sha256(repo/rel)==h,rel
    parser=VisibleParser(rows)
    docs={cid:document(x["ocr"]) for cid,x in raw.items()}
    idf=fit_idf(list(docs.values()))
    atomic_json(out/"reference-idf.json",dict(N=2103,source="reference_OCR_documents_only",idf=idf,
        raw_record_hashes={str(cid):digest(x) for cid,x in raw.items()}))
    derived={cid:parser.extract(x["ocr"]) for cid,x in raw.items()}
    # Compare frozen reference vectors only; no encoder is loaded.
    matrix=np.load(repo/".runtime/v5-rc1/embeddings.npy",mmap_mode="r")
    order=json.loads((repo/".runtime/v5-rc1/rows.json").read_text())
    refs=[raw[r["catalog_item_id"]] for r in order];near=[];duplicate_ids=set()
    for i,a in enumerate(refs):
        candidates=[k for k in range(i+1,len(refs)) if a["reference_sha256"]==refs[k]["reference_sha256"]
                    or (int(a["phash"],16)^int(refs[k]["phash"],16)).bit_count()<=6]
        for k in candidates:
            b=refs[k];same=a["reference_sha256"]==b["reference_sha256"];cos=float(matrix[i]@matrix[k])
            if same or cos>=.98:
                near.append(dict(a=a["catalogItemId"],b=b["catalogItemId"],exact_sha=same,
                    phash_hamming=(int(a["phash"],16)^int(b["phash"],16)).bit_count(),siglip_cosine=cos,
                    interpretation="reference_similarity_only_not_SKU_equivalence"))
                duplicate_ids.update([a["catalogItemId"],b["catalogItemId"]])
    atomic_json(out/"reference-duplicates.json",dict(pairs=near,manual_confirmed_pairs=PAIRS,
               manual_tentative_pairs=TENTATIVE,manual_distinct_pairs=DISTINCT))
    # Identity mismatch diagnostics use only visible tokens, not absent words.
    official={r["catalog_item_id"]:document(dict(texts=[(r.get("winery") or "")+" "+r["title"]],confidences=[1.]))["tokens"] for r in rows}
    inverted=defaultdict(set)
    for cid,doc in official.items():
        for t in doc:
            if t not in GENERIC_MORE:inverted[t].add(cid)
    alt={}
    for cid,doc in docs.items():
        weights={t:idf["tokens"].get(t,1)*c for t,c in doc["tokens"].items() if t not in GENERIC_MORE}
        denom=sum(weights.values());scores=defaultdict(float);matched=defaultdict(set)
        for t,w in weights.items():
            for other in inverted.get(t,[]):
                scores[other]+=w;matched[other].add(t)
        scores={k:v/denom for k,v in scores.items()} if denom else {}
        best=max(scores,key=lambda k:(scores[k],-k)) if scores else cid
        alt[cid]=dict(own_score=scores.get(cid,0),best_id=best,best_score=scores.get(best,0),
            matched_tokens=sorted(matched.get(best,[])),
            substantial=best!=cid and scores.get(best,0)>=.65 and scores.get(best,0)-scores.get(cid,0)>=.30 and len(matched.get(best,[]))>=2)
    overrides=json.loads((repo/"vinedetect_api/data/contest_reference_overrides/lct-rshb-2026-09-15.json").read_text())
    historical={e["catalog_item_id"]:e for e in overrides["entries"] if e["status"]=="replacement_confirmed"}
    pair_ids=set(x for p in PAIRS+TENTATIVE+DISTINCT for x in p)
    shadow=[];conflict_counts=Counter();success=0;usable=0
    for row in rows:
        cid=row["catalog_item_id"];x=raw[cid]
        conflicts=metadata_conflicts(derived[cid],parser.base.expected[cid])
        conflict_counts.update({c["field"] for c in conflicts})
        known=cid in MANUAL_BAD
        seeds=[]
        if known:seeds.append(dict(source="user_manual_review_through676",id=cid))
        if cid in historical:
            h=historical[cid]
            if x["reference_sha256"]==h["expected_current"]["sha256"]:
                known=True;seeds.append(dict(source="canonical_reference_override_ledger",expected_bad_sha=h["expected_current"]["sha256"],
                    reviewed_replacement_sha=h["replacement"]["sha256"],reason=h["reason"],replacement_applied=False))
        identity=usable_identity(docs[cid]);usable+=identity
        success+=any((l.get("confidence") or 0)>=.35 and l["text"].strip() for l in x["ocr"]["lines"])
        quality=reliability(known,conflicts,alt[cid]["substantial"],identity,cid in duplicate_ids|pair_ids,cid==626,cid==424)
        record=dict(catalogItemId=cid,slug=row["official_slug"],official_metadata=row,
            reference_derived_metadata=derived[cid],conflicts=conflicts,
            field_confidence={f:max((v["confidence"] for v in vs),default=None) for f,vs in derived[cid].items()},
            reference_reliability=quality,known_defect_provenance=seeds,
            reference_ocr=x["ocr"],reference_sha256=x["reference_sha256"],
            reference_record=f"references/{cid}.json",reference_record_sha256=digest(x),
            usable_identity=identity,document=docs[cid],alternate_catalog_match=alt[cid],
            frozen_embedding_links=x["embeddings"],descriptor_link=x["descriptors"])
        shadow.append(record)
    prov=dict(raw=digest({cid:digest(x) for cid,x in raw.items()}),parser=sha256(Path(__file__).with_name("text.py")),
              audit_code=sha256(Path(__file__)),plan=sha256(repo/"docs/V8_VC_PHASE1_PLAN.md"))
    save(out/"shadow-catalog.json",shadow,prov)
    summary=dict(total=2103,ocr_success=success,ocr_success_rate=success/2103,usable_identity=usable,
        bottle_detected=sum(bool(x["target"]["selected"]) for x in raw.values()),
        trusted_label=sum(bool(x["label"] and x["label"]["trusted"]) for x in raw.values()),
        field_coverage={f:sum(bool(x["reference_derived_metadata"][f]) for x in shadow) for f in FIELDS},
        conflicts_by_field=dict(conflict_counts),reference_reliability=dict(Counter(x["reference_reliability"]["status"] for x in shadow)),
        identity_name_mismatch_candidates=sum(x["substantial"] for x in alt.values()),
        exact_reference_pairs=sum(x["exact_sha"] for x in near),near_nonexact_pairs=sum(not x["exact_sha"] for x in near),
        likely_wrong_references=[x["catalogItemId"] for x in shadow if x["reference_reliability"]["status"]=="suspect_reference"],
        known_bad_references=[x["catalogItemId"] for x in shadow if x["reference_reliability"]["status"]=="known_bad_reference"])
    atomic_json(out/"catalog-summary.json",summary)
    print(json.dumps(summary))
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--repo",default=".");a=p.parse_args();build(Path(a.repo).resolve())
