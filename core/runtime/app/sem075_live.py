"""Isolated frozen SEM=.75 wrapper. No production routing; model imports are lazy."""
from __future__ import annotations
import math

ORDER = ("geometry", "ocr_attributes", "ocr_identity", "quality", "semantic",
         "reference_tokens", "reference_phrases", "reference_attribute_match",
         "reference_attribute_conflict", "weak_official_agreement", "reliability_penalty")
LAMBDA = 0.75

def historical(base, feature):
    """Preserve Gate-0 order and source-associated arithmetic, including signed zero."""
    if set(base) != set(ORDER[:5]):
        raise ValueError("Historical base contribution keys differ")
    values = {name: base[name] for name in ORDER[:5]}
    r = feature["reliability_factor"]
    values.update(
        reference_tokens=r*.4*feature["token_similarity"],
        reference_phrases=r*.2*feature["phrase_similarity"],
        reference_attribute_match=r*.2*feature["attribute_match"],
        reference_attribute_conflict=-r*.2*feature["attribute_conflict"],
        weak_official_agreement=.05*feature["official_agreement"],
        reliability_penalty=-.1*(1-r))
    return values

def score(contributions):
    if set(contributions) != set(ORDER):
        raise ValueError("Historical contribution keys differ")
    values = {name: contributions[name] for name in ORDER}
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
               and math.isfinite(v) for v in values.values()):
        raise ValueError("Nonfinite or nonnumeric contribution")
    values["semantic"] = LAMBDA * values["semantic"]
    return values, sum(values.values())

def ordered(candidates):
    result = []
    for cid, contributions in candidates:
        values, total = score(contributions)
        result.append(dict(id=cid, historical_contributions=contributions,
                           contributions=values, score=total))
    if len({x["id"] for x in result}) != len(result) or not result:
        raise ValueError("Duplicate IDs or empty pool")
    result.sort(key=lambda x: (-x["score"], x["id"]))
    for rank, row in enumerate(result, 1):
        row["rank"] = rank
    return result

class LiveSEM:
    """Existing V8 image path, existing V8-VC evidence functions, frozen SEM scorer."""
    def __init__(self, repo):
        import json
        from .v8.backend import Backend
        from .v8.pipeline import Pipeline
        from .v8.config import Config
        from .v8vc.catalog import checked
        from .v8vc.text import VisibleParser
        self.pipeline = Pipeline(Backend(), Config(**json.loads(
            (repo/".generated/v8/selected-config.json").read_text())))
        shadow = checked(repo/".generated/v8vc/shadow-catalog.json")
        self.references = {r["catalogItemId"]: r for r in shadow}
        self.idf = json.loads((repo/".generated/v8vc/reference-idf.json").read_text())["idf"]
        self.parser = VisibleParser([r["official_metadata"] for r in shadow])

    def reference_evidence(self, ocr, pool):
        from .v8vc.text import document, similarity, structured
        query = document(ocr)
        qfields = self.parser.extract(ocr)
        # Existing V8-VC observation provenance token is retained verbatim.
        # In this wrapper the OCR itself is freshly inferred and separately persisted.
        qfields = {f: [dict(x, source="saved_query_label_ocr") for x in vs]
                   for f, vs in qfields.items()}
        features = {}
        for cid in pool:
            ref = self.references[cid]
            token = similarity(query["tokens"], ref["document"]["tokens"], self.idf["tokens"])
            phrase = similarity(query["phrases"], ref["document"]["phrases"], self.idf["phrases"])
            attrs = structured(qfields, ref["reference_derived_metadata"])
            official = document(dict(texts=[str(ref["official_metadata"].get("winery") or "")+
                                            " "+ref["official_metadata"]["title"]], confidences=[1.]))
            weak = similarity(query["tokens"], official["tokens"], self.idf["tokens"])
            features[cid] = dict(
                token_similarity=token, phrase_similarity=phrase,
                reference_identity=(2*token+phrase)/3,
                reference_identity_available=ref["usable_identity"],
                attribute_match=attrs["match"], attribute_conflict=attrs["conflict"],
                attribute_provenance=attrs["details"], official_agreement=weak,
                official_agreement_source=["winery", "title"],
                reliability=ref["reference_reliability"]["status"],
                reliability_factor=ref["reference_reliability"]["factor"],
                shared_tokens=sorted(set(query["tokens"]) & set(ref["document"]["tokens"])),
                shared_phrases=sorted(set(query["phrases"]) & set(ref["document"]["phrases"])))
        return dict(query_document=query, query_attributes=qfields, features=features)

    def analyze(self, raw):
        trace = self.pipeline.analyze(raw, explore=False)
        # Match saved V8 report annotations; these fields do not enter scoring.
        config = self.pipeline.config
        limits = dict(zip(("siglip", "dino", "ocr", "label_siglip"),
                          (config.ks, config.kd, config.ko, config.kl)))
        for nomination in trace["nominations"]:
            nomination["slug"] = self.pipeline.backend.catalog.by_id[nomination["id"]]["official_slug"]
        for candidate in trace["ordered"]:
            for source, feature in candidate["semantic"].items():
                feature["outside_source_k"] = feature["rank"] is None or feature["rank"] > limits[source]
        reference = self.reference_evidence(trace["ocr"], trace["pool_ids"])
        ranks = ordered((c["id"], historical(c["contributions"], reference["features"][c["id"]]))
                        for c in trace["ordered"])
        for row in ranks:
            row["slug"] = self.pipeline.backend.catalog.by_id[row["id"]]["official_slug"]
        return dict(trace=trace, reference_evidence=reference, ordered=ranks,
                    top1=ranks[0]["id"], slug=ranks[0]["slug"],
                    margin=ranks[0]["score"]-ranks[1]["score"] if len(ranks)>1 else None)

