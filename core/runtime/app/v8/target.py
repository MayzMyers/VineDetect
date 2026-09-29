"""Bottle-only intention scoring, then proposals detected on that bottle's pixels."""
import math
from ..v5.intent import band_fit, bottle_intent_score, label_geometry_score, nms

class TargetUnavailable(RuntimeError):
    def __init__(self, diagnostics):
        super().__init__("No bottle detection; full-frame identity evidence is forbidden")
        self.diagnostics = diagnostics

def bounds(box, width, height):
    x, y, w, h = box
    x1, y1 = max(0, round(x)), max(0, round(y))
    x2, y2 = min(width, round(x+w)), min(height, round(y+h))
    return [x1, y1, max(0, x2-x1), max(0, y2-y1)]

def crop(image, box):
    x, y, w, h = box
    return image.crop((x, y, x+w, y+h))

def select_bottle(detections, width, height):
    rows = []
    for detection in detections:
        x,y,w,h = detection["boxXywh"]
        if w <= 0 or h <= 0:
            continue
        metrics = bottle_intent_score(detection, width, height)
        clipped = bounds(detection["boxXywh"],width,height)
        visibility = min(1., clipped[2]*clipped[3]/(w*h))
        # Border contact is observable incompleteness, not proof of the wrong target.
        border_count = sum((x <= 1, y <= 1, x+w >= width-1, y+h >= height-1))
        visibility *= 1 - 0.10*border_count
        shape = band_fit(w/h, .07,.14,.72,1.25)
        components = dict(centrality=metrics["centrality"], prominence=metrics["prominence"],
                          visibility=visibility, shape=shape, confidence=detection["modelScore"])
        score = sum(components[k]*v for k,v in
                    dict(centrality=.40,prominence=.25,visibility=.10,shape=.10,confidence=.15).items())
        rows.append(dict(**detection, box=clipped, components=components, score=score))
    viable = [r for r in nms(rows) if r["box"][2] > 0 and r["box"][3] > 0]
    viable.sort(key=lambda r: (-r["score"], tuple(r["box"])))
    selected = viable[0] if viable else None
    suspicious = selected is None or selected["components"]["shape"] < .25 or selected["components"]["visibility"] < .7
    return dict(candidates=rows, selected=selected, selected_box=selected["box"] if selected else None,
                reason="maximum_bottle_intent_score" if selected else "no_bottle_detection",
                manual_audit_required=suspicious)

def select_label(detections, width, height, config):
    rows=[]
    area=max([r["boxXywh"][2]*r["boxXywh"][3] for r in detections] or [1])
    for detection in detections:
        box=bounds(detection["boxXywh"],width,height)
        if min(box[2:]) <= 0:
            continue
        metrics=label_geometry_score(dict(detection,boxXywh=box),[0,0,width,height],area)
        rows.append(dict(box=box, original_box=detection["boxXywh"], confidence=detection["modelScore"],
                         source="grounding_dino_on_selected_target", components=metrics,
                         score=metrics["score"]))
    rows.sort(key=lambda r:(-r["score"],tuple(r["box"])))
    good=[r for r in rows if r["score"]>=config.label_min_score and
          r["confidence"]>=config.label_min_confidence and r["components"]["frontVerticalFit"]>0]
    selected=good[0] if good else None
    return dict(proposals=rows, selected=selected, selected_box=selected["box"] if selected else [0,0,width,height],
                trusted=bool(selected), reason="maximum_target_label_geometry_score" if selected else
                "no_trustworthy_label_use_target_visual_only", coordinate_frame="target_crop")
