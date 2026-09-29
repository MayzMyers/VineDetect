from app.v5.intent import nms, select_intent


def bottle(box, score=0.8):
    return {"boxXywh": box, "modelScore": score}


def test_central_prominent_bottle_wins_over_edge_bottle():
    left = bottle([0, 100, 120, 800], 0.95)
    center = bottle([350, 50, 300, 900], 0.65)
    labels = [bottle([370, 500, 240, 220]), bottle([10, 500, 100, 150])]
    result = select_intent([left, center], labels, labels[1], 1000, 1000)
    assert result["primaryBottle"]["boxXywh"] == center["boxXywh"]
    assert result["selected"]["boxXywh"] == labels[0]["boxXywh"]
    assert result["action"] == "intent-override"


def test_valid_original_label_is_retained():
    b = bottle([350, 50, 300, 900])
    label = bottle([370, 500, 240, 220])
    assert select_intent([b], [label], label, 1000, 1000)["action"] == "keep-original"


def test_nms_and_no_bottle_fallback():
    b = bottle([350, 50, 300, 900])
    assert len(nms([b, dict(b, modelScore=0.7)])) == 1
    result = select_intent([], [], b, 1000, 1000)
    assert result["primaryBottle"] is None
    assert result["selected"] is b
