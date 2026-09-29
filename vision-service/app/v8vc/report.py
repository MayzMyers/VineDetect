"""Human-review artifacts for the separate V8-VC Phase1 line."""
import argparse,json,html
from pathlib import Path
from collections import Counter
from .catalog import checked
from ..v8.checkpoint import atomic_json
from ..v8.report import write_csv
from .experiment import SETS,MODELS

def table(headers,rows):
    return "\n".join(["| "+" | ".join(headers)+" |","|"+"|".join("---" for _ in headers)+"|"]+
        ["| "+" | ".join(str(x).replace("\n"," ") for x in row)+" |" for row in rows])+"\n"

def build(repo):
    out=repo/".generated/v8vc";shadow=checked(out/"shadow-catalog.json")
    audit=json.loads((out/"catalog-summary.json").read_text());e=json.loads((out/"experiment-summary.json").read_text())
    byid={r["catalogItemId"]:r for r in shadow}
    queue=[]
    for r in shadow:
        q=r["reference_reliability"];queue.append(dict(catalogItemId=r["catalogItemId"],slug=r["slug"],
            status=q["status"],reasons=q["reasons"],official_title=r["official_metadata"]["title"],
            official_producer=r["official_metadata"].get("winery"),reference_ocr=r["reference_ocr"]["text"],
            field_confidence=r["field_confidence"],conflict_fields=[c["field"] for c in r["conflicts"]],
            best_catalog_identity=r["alternate_catalog_match"]["best_id"],
            best_match_score=r["alternate_catalog_match"]["best_score"],
            own_match_score=r["alternate_catalog_match"]["own_score"],reference_sha256=r["reference_sha256"]))
    priority={s:i for i,s in enumerate(["known_bad_reference","suspect_reference","suspect_metadata","manual_review","trusted"])}
    queue.sort(key=lambda r:(priority[r["status"]],r["catalogItemId"]))
    write_csv(out/"review-queue.csv",queue)
    conflicts=[dict(catalogItemId=r["catalogItemId"],slug=r["slug"],**c) for r in shadow for c in r["conflicts"]]
    atomic_json(out/"metadata-conflicts.json",conflicts)
    metricrows=[]
    for name in ["V7-B"]+MODELS:
        x=e["models"][name];metricrows.append([name,*[f'{x["datasets"][ds]["exact"]}/{x["datasets"][ds]["n"]}' for ds in SETS],
            f'{x["pooled_exact"]}/232',f'{100*x["macro_exact"]:.2f}%',f'{x["fixed_v7"]}/{x["broken_v7"]}',x["sibling_errors"],
            f'{100*x["conditional_accuracy"]:.2f}%'])
    x=e["nested"];metricrows.append(["Nested selection",*[f'{x["datasets"][ds]["exact"]}/{x["datasets"][ds]["n"]}' for ds in SETS],
        f'{x["pooled_exact"]}/232',f'{100*x["macro_exact"]:.2f}%',f'{x["fixed_v7"]}/{x["broken_v7"]}',x["sibling_errors"],
        f'{100*x["conditional_accuracy"]:.2f}%'])
    lines=["# V8-Visual Catalog — Phase1",
        "**Outcome.** "+("At least one fixed offline candidate passed the predeclared development gate; a future full pipeline needs separate authorization." if e["promoted"] else
        "The offline experiment did not pass the predeclared promotion gate. Stop at the shadow catalog and offline artifacts; no full query-image pipeline was run."),
        "Separate branch feat/v8-visual-catalog, based on ff2942c478e489fd2195aea7541c8c4d16eb7ab5. V8/V8.1/V8.2 scorers and evidence remain frozen. All 2103 IDs/slugs are preserved; no organizer catalog, reference, gallery, GT or equivalence repair.",
        "**Reference corpus.** Reference assignments are the current frozen V5/V8 evaluation snapshot (.runtime/v5-rc1), not silently updated repair overrides. Every input reference SHA and linked crop/descriptor artifact was checked. GroundingDINO and existing PaddleOCR processed references sequentially in batches of75 with a6GiB worker limit. SigLIP/DINO vectors link to frozen full-reference rows/matrix hashes; SIFT/RootSIFT likewise link to valid frozen descriptors or newly computed shadow files. Embeddings/descriptors are not representations of the new label crops.",
        table(["Diagnostic","Result"],[
            ["References",audit["total"]],["Bottle detected",audit["bottle_detected"]],["Trusted automated label",audit["trusted_label"]],
            ["OCR success: nonempty line confidence≥.35",f'{audit["ocr_success"]}/2103 ({100*audit["ocr_success_rate"]:.2f}%)'],
            ["Usable identity text: ≥2 nongeneric high-confidence tokens",audit["usable_identity"]],
            ["Exact SHA duplicate reference pairs",audit["exact_reference_pairs"]],
            ["Additional pHash≤6 and SigLIP≥.98 reference pairs",audit["near_nonexact_pairs"]],
            ["OCR matches another catalog identity substantially better",audit["identity_name_mismatch_candidates"]]]),
        "Raw OCR includes every returned line, polygons/boxes and confidences. Derived fields require visible spans at≥.8; contradictions require high-confidence same-axis evidence. Catalog-wide phrase dictionaries identify field roles, but never inject the current row's values into OCR. Producer/product roles remain dictionary-derived and unverified. A visible four-digit year is a vintage candidate, not proof that it is the harvest year. Missing fields remain neutral.",
        table(["Field","Visible coverage","Official/reference conflict rows"],[[f,n,audit["conflicts_by_field"].get(f,0)] for f,n in audit["field_coverage"].items()]),
        "Name mismatches are separately reported through alternate identity matches; absent catalog-name text is not classified as a contradiction. Disjoint grape sets are suspected conflicts, not proof of catalog truth. The manually flagged626 metadata issue remains separately identifiable.",
        table(["Reference reliability","Count"],sorted(audit["reference_reliability"].items())),
        "Known-bad seed IDs: "+", ".join(map(str,audit["known_bad_references"]))+". Historical seeds apply only when the reference SHA matches the documented old bad assignment. No replacement was applied.",
        "Automatically suspected reference IDs: "+(", ".join(map(str,audit["likely_wrong_references"])) or "none")+
        ". These are review suggestions, not confirmed wrong references. All duplicate and near-duplicate pairs are review flags, never entity merges. Trusted means passes these automated checks, not manual certification.",
        "**Offline feature comparison.** Corpus IDF uses all2103 reference OCR documents, never query GT. A is exact V8; B adds reference token/phrase and structured-attribute evidence; C substitutes reference-derived evidence for official OCR contributions where usable reference identity exists. Both use the same weak official agreement and reference-reliability terms. One global formula per fixed alternative; coefficients and gate were declared before scoring.",
        table(["Model","FIELD","UNSEEN","STORE","FRESH","IRE","Exact","Macro","Fix/break vs V7-B","Sibling errors","Correct given GT-in-pool"],metricrows),
        "Sibling errors use the existing incomplete family-only groups as a diagnostic, never as relabelled GT. Potential same-producer mistakes are separately recorded in experiment-summary.json and are not treated as confirmed sibling SKUs.",
        table(["Query/reference coverage","Count"],[[k,v] for k,v in e["coverage"].items()]),
        table(["Model","Changed Top1 vs V8","95% bootstrap macro delta vs V8"],[[m,e["changed_top1"].get(m,0),
            " / ".join(f"{100*v:+.2f}pp" for v in e["bootstrap_macro_delta95"][m])] for m in MODELS]),
        "Bootstrap: 10,000 paired resamples within each dataset, equal dataset weighting, seed8203. Nested LODO selects among the three fixed formulas using inner validation datasets and applies the choice to the outer dataset. Because no coefficients are fitted, inner-fold predictions are the same fixed scores; outer GT never selects its formula.",
        table(["Outer dataset","Selected fixed model"],[[f["heldout"],f["selected"]] for f in e["nested_folds"]]),
        "Nested macro-delta95% interval: "+" / ".join(f"{100*v:+.2f}pp" for v in e["nested_bootstrap_macro_delta95"])+".",
        table(["Candidate","Gate passed","Failed checks"],[[m,g["passed"],", ".join(k for k,v in g["checks"].items() if not v) or "none"] for m,g in e["promotion_gates"].items()]),
        "**Artifacts.** [Shadow catalog](../.generated/v8vc/shadow-catalog.json), [reference audit summary](../.generated/v8vc/catalog-summary.json), [review queue](../.generated/v8vc/review-queue.csv), [reference duplicates](../.generated/v8vc/reference-duplicates.json), [field conflicts](../.generated/v8vc/metadata-conflicts.json), [query coverage](../.generated/v8vc/coverage.csv), [offline results](../.generated/v8vc/experiment-summary.json), [every changed decision and contributions](../.generated/v8vc/changed-decisions.json), [all232 predictions](../.generated/v8vc/predictions.csv), [browsable reference audit](../.generated/v8vc/audit.html). Per-reference checksums/crops/raw OCR are under references/ and crops/; per-query candidate features and all three ordered scores are under features/.",
        "The saved V8 baseline reproduces all232 candidate orders, scores, contributions, pools and margins exactly. Protected-input validation is recorded separately. No new query inference, new-phone/organizer validation, deployment, push, merge or release freeze."
    ]
    (repo/"docs/V8_VC_PHASE1_REPORT.md").write_text("\n\n".join(lines)+"\n")
    cards=[]
    for r in queue:
        cid=r["catalogItemId"];x=byid[cid]
        fieldtext={k:[v["normalized_value"] for v in vs] for k,vs in x["reference_derived_metadata"].items() if vs}
        cards.append('<article data-status="'+r["status"]+'"><h2>'+str(cid)+' — '+html.escape(r["official_title"])+'</h2><b>'+r["status"]+
            '</b><p>'+html.escape(", ".join(r["reasons"]))+'</p><img loading="lazy" src="crops/'+str(cid)+'/label.png" alt="Detected reference label">'+
            '<p><strong>Official:</strong> '+html.escape(str(r["official_producer"]))+'</p><p><strong>OCR:</strong> '+html.escape(r["reference_ocr"])+'</p><pre>'+
            html.escape(json.dumps(fieldtext,ensure_ascii=False,indent=2))+'</pre><a href="references/'+str(cid)+'.json">Raw OCR, boxes and provenance</a></article>')
    (out/"audit.html").write_text('<!doctype html><meta charset="utf-8"><title>V8-VC reference audit</title><style>body{font:15px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:20px}article{border:1px solid #ccc;padding:16px;overflow-wrap:anywhere}img{width:100%;height:240px;object-fit:contain}pre{white-space:pre-wrap}select{margin:16px}</style><h1>V8-VC reference audit — 2103 immutable IDs</h1><p>Automated flags require review. No catalog or reference repairs have been applied.</p><select id="filter"><option value="">All statuses</option>'+''.join('<option>'+x+'</option>' for x in priority)+'</select><main>'+''.join(cards)+'</main><script>document.getElementById("filter").onchange=e=>document.querySelectorAll("article").forEach(a=>a.hidden=!!e.target.value&&a.dataset.status!==e.target.value)</script>')
    print("Report and reference audit written.")
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--repo",default=".");a=p.parse_args();build(Path(a.repo).resolve())
