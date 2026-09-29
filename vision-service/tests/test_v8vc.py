from app.v8vc.text import VisibleParser,document,fit_idf,similarity,structured,metadata_conflicts
def rows():
    return [dict(catalog_item_id=1,title="White Blend",winery="Domaine Example",grapes="Мускат Белый",category="Белое",official_slug="white-blend"),
            dict(catalog_item_id=2,title="Reserve Range",winery="Different Winery",grapes="Ркацители",category="Белое",official_slug="reserve")]
def ocr(text,conf=.99):return dict(texts=[text],confidences=[conf],lines=[dict(text=text,confidence=conf,polygon=[[0,0],[10,0],[10,10],[0,10]])])
def test_absent_metadata_is_not_injected():
    p=VisibleParser(rows());o=p.extract(ocr("WHITE BLEND"))
    assert not o["grape"] and not o["producer"]
def test_phrase_and_visible_grape():
    p=VisibleParser(rows());o=p.extract(ocr("SEMI-SWEET extra brut RKATSITELI"))
    assert [h["normalized_value"] for h in o["sweetness"]]==["semisweet"]
    assert [h["normalized_value"] for h in o["brut"]]==["extra_brut"]
    assert [h["normalized_value"] for h in o["grape"]]==["rkatsiteli"]
    assert o["grape"][0]["ocr_lines"][0]["polygon"]
def test_low_confidence_and_missing_neutral():
    p=VisibleParser(rows());a=p.extract(ocr("RKATSITELI",.7));b=p.extract(ocr("Мускат Белый"))
    assert not a["grape"] and structured(a,b)["conflict"]==0
def test_reference_corpus_idf_downweights_shared_words():
    docs=[document(ocr("FAMILY UNIQUE")),document(ocr("FAMILY OTHER"))];idf=fit_idf(docs)
    assert idf["tokens"]["family"]<idf["tokens"]["unique"]
    assert similarity(docs[0]["tokens"],docs[0]["tokens"],idf["tokens"])>.999
def test_wrong_official_producer_does_not_override_ocr():
    p=VisibleParser(rows());o=p.extract(ocr("DIFFERENT WINERY"))
    assert o["producer"][0]["normalized_value"]=="different winery"
    assert metadata_conflicts(o,p.base.expected[1])[0]["field"]=="producer"
def test_no_cross_axis_conflict():
    p=VisibleParser(rows());a=p.extract(ocr("WHITE"));b=p.extract(ocr("SPARKLING"))
    assert structured(a,b)["conflict"]==0

def test_reliability_priority_and_nonrepair():
    from app.v8vc.catalog import reliability
    assert reliability(True,[],False,True,False)["status"]=="known_bad_reference"
    assert reliability(False,[],False,False,False)["status"]=="manual_review"
    assert reliability(False,[],False,True,False,metadata_seed=True)["status"]=="suspect_metadata"

def test_uniform_scoring_and_missing_reference_fallback():
    from app.v8vc.experiment import contributions
    base=dict(semantic=.5,geometry=.2,ocr_identity=.3,ocr_attributes=0.,quality=.05)
    f=dict(reliability_factor=1.,token_similarity=0.,phrase_similarity=0.,attribute_match=0.,
           attribute_conflict=0.,official_agreement=0.,reference_identity_available=False,reference_identity=0.)
    assert contributions(base,f,"A_current_V8")==base
    assert sum(contributions(base,f,"C_reference_metadata").values())==sum(base.values())
    f.update(reference_identity_available=True,reference_identity=.8)
    c=contributions(base,f,"C_reference_metadata")
    assert c["official_ocr_removed"]==-.3 and c["reference_identity"]==.48
def test_known_bad_reference_cannot_add_positive_reference_evidence():
    from app.v8vc.experiment import contributions
    f=dict(reliability_factor=0.,token_similarity=1.,phrase_similarity=1.,attribute_match=1.,
           attribute_conflict=0.,official_agreement=0.,reference_identity_available=True,reference_identity=1.)
    c=contributions(dict(semantic=.4),f,"B_add_reference_text")
    assert c["reference_tokens"]==0 and c["reliability_penalty"]==-.1

def test_foundation_year_is_not_vintage():
    p=VisibleParser(rows())
    assert not p.extract(ocr("ESTABLISHED 2001"))["vintage"]
    assert p.extract(ocr("VINTAGE 2021"))["vintage"][0]["normalized_value"]=="2021"

def test_legal_boilerplate_is_not_identity():
    from app.v8vc.text import usable_identity
    assert not usable_identity(document(ocr("WINE RUSSIA CRIMEA CONTAINS SULFITES")))
