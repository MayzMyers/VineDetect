export type LabelCandidateMergeItem = {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  manualMergeGroupId?: string | null;
};

export type LabelCandidateMergePreview = {
  candidateIds: string[];
  bbox: { x: number; y: number; width: number; height: number };
  mode: "none" | "automatic" | "manual" | "mixed";
};

export function previewLabelCandidateMerges(items: LabelCandidateMergeItem[]): LabelCandidateMergePreview[] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const union = (left: number, right: number) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftItem = items[left]!; const rightItem = items[right]!;
      if ((leftItem.manualMergeGroupId && leftItem.manualMergeGroupId === rightItem.manualMergeGroupId) || fragmentsOverlap(leftItem.bbox, rightItem.bbox)) union(left, right);
    }
  }
  const groups = new Map<number, LabelCandidateMergeItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()].map((members) => {
    const hasManual = members.some((left, index) => members.slice(index + 1).some((right) => Boolean(left.manualMergeGroupId && left.manualMergeGroupId === right.manualMergeGroupId)));
    const hasAutomatic = members.some((left, index) => members.slice(index + 1).some((right) => fragmentsOverlap(left.bbox, right.bbox)));
    const x = Math.min(...members.map((item) => item.bbox.x)); const y = Math.min(...members.map((item) => item.bbox.y));
    const right = Math.max(...members.map((item) => item.bbox.x + item.bbox.width)); const bottom = Math.max(...members.map((item) => item.bbox.y + item.bbox.height));
    return {
      candidateIds: members.map((item) => item.id), bbox: { x, y, width: right - x, height: bottom - y },
      mode: hasManual && hasAutomatic ? "mixed" : hasManual ? "manual" : hasAutomatic ? "automatic" : "none",
    };
  });
}

function fragmentsOverlap(left: LabelCandidateMergeItem["bbox"], right: LabelCandidateMergeItem["bbox"]) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  if (!intersection) return false;
  const containment = intersection / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  return containment < .82;
}
