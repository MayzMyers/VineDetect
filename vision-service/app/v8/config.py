from dataclasses import asdict, dataclass, field

SOURCES = ("siglip", "dino", "ocr", "label_siglip")
GROUPS = ("semantic", "ocr_identity", "ocr_attributes", "geometry", "quality")

@dataclass(frozen=True)
class Config:
    ks: int = 20
    kd: int = 10
    ko: int = 5
    kl: int = 0
    max_pool_size: int = 30  # zero means uncapped
    retrieval_depth: int = 30
    reference_cache_size: int = 32
    label_min_score: float = 0.55
    label_min_confidence: float = 0.20
    ocr_min_idf: float = 0.45
    fusion_offset: int = 60
    weights: tuple = (1.0, 0.3, 0.15, 0.3, 0.05)
    dino_weight: float = 0.25
    label_weight: float = 0.15
    geometry_enabled: bool = True

    def __post_init__(self):
        if min(self.ks, self.kd, self.ko, self.kl, self.max_pool_size) < 0:
            raise ValueError("K values must be nonnegative")
        if self.ks < 1 or max(self.ks, self.kd, self.ko, self.kl) > self.retrieval_depth:
            raise ValueError("SigLIP is required; K cannot exceed recorded retrieval depth")
        if self.retrieval_depth > 50 or self.reference_cache_size < 1:
            raise ValueError("Unsupported retrieval depth/cache bound")
        if len(self.weights) != 5 or any(x < 0 for x in self.weights):
            raise ValueError("Expected five nonnegative group weights")

    def json(self):
        return asdict(self)
