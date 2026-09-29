"""Single frozen pre-R90 pool support rule. No prediction/GT input."""
OFFICIAL_FIELDS=('title','official_slug','winery','manufacturer','producer','category','color','style','sweetness','brut','vintage','grapes','region','description')

def support(span,pool_refs,parser):
 """No GT/prediction arguments. Only exact B-pool evidence can support a span."""
 from app.v82.parser import words,ATTRS
 raw=span['raw_text'];ws=[w['value'] for w in words(raw)]
 tok=set(ws);phr={' '.join(pair) for pair in zip(ws,ws[1:])}
 query={'texts':[raw],'confidences':[span['confidence'] or 0.],
        'lines':[{k:span[k] for k in ('text','confidence','polygon','box')}]}
 parsed=parser.extract(query)
 hits=[]
 for cid,ref in sorted(pool_refs.items()):
  official=ref['official_metadata']
  for field in OFFICIAL_FIELDS:
   value=official.get(field)
   if value is None:continue
   ow=[w['value'] for w in words(str(value))]
   overlap=sorted(tok & set(ow));phrase_overlap=sorted(phr & {' '.join(pair) for pair in zip(ow,ow[1:])})
   if overlap or phrase_overlap:
    hits.append(dict(rule='A',candidate_id=cid,source='official_metadata.'+field,
                     exact_tokens=overlap,exact_phrases=phrase_overlap,source_text=value))
  doc=ref['document']
  overlap=sorted(tok & set(doc['tokens']));phrase_overlap=sorted(phr & set(doc['phrases']))
  if overlap or phrase_overlap:
   hits.append(dict(rule='A',candidate_id=cid,source='active_reference.document',
                    reference_sha256=ref['reference_sha256'],exact_tokens=overlap,exact_phrases=phrase_overlap))
  for field in ATTRS:
   for observed in parsed[field]:
    for source,expected in [('official_parser',parser.base.expected[cid]),('active_reference.reference_derived_metadata',ref['reference_derived_metadata'])]:
     for target in expected.get(field,[]):
      if observed['axis']==target['axis'] and observed['normalized_value']==target['normalized_value']:
       hits.append(dict(rule='B',candidate_id=cid,source=source,field=field,axis=observed['axis'],
                        normalized_value=observed['normalized_value'],query_observation=observed,catalog_observation=target))
 return dict(raw_text=raw,normalized_text=' '.join(ws),confidence=span['confidence'],
             catalog_supported=bool(hits),support_candidate_ids=sorted({x['candidate_id'] for x in hits}),
             support_sources=sorted({x['source'] for x in hits}),support_hits=hits,
             parsed_span_attributes={f:parsed[f] for f in ATTRS},
             reason='EXACT_PRE_R90_B_POOL_SUPPORT' if hits else 'NO_EXACT_TOKEN_PHRASE_OR_PARSED_ATTRIBUTE_SUPPORT_IN_PRE_R90_B_POOL')
