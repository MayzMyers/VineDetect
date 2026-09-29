import type { RegionGeometry } from "./annotationGraphContract.js";
import { rectangleGeometry } from "./quadGeometry.js";

export type LabelCandidateMergeInput = {
  candidateId: string;
  geometry: RegionGeometry;
  mergeGroupId?: string | null;
};

export type LabelCandidateMergeGroup = {
  candidateIds: string[];
  geometry: RegionGeometry;
  mode: "none" | "automatic" | "manual" | "mixed";
};

/**
 * Builds one canonical Label result per connected candidate group.
 * Partially overlapping fragments merge automatically; containment represents
 * competing ROI hypotheses and stays separate. An explicit mergeGroupId may
 * still join any candidates after human/LLM review.
 */
export function planLabelCandidateMerges(inputs: LabelCandidateMergeInput[]): LabelCandidateMergeGroup[] {
  const parent = inputs.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const union = (left: number, right: number) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let left = 0; left < inputs.length; left += 1) {
    for (let right = left + 1; right < inputs.length; right += 1) {
      const leftInput = inputs[left]!; const rightInput = inputs[right]!;
      const manuallyGrouped = Boolean(leftInput.mergeGroupId && leftInput.mergeGroupId === rightInput.mergeGroupId);
      if (manuallyGrouped || bboxFragmentsOverlap(leftInput.geometry.bbox, rightInput.geometry.bbox)) union(left, right);
    }
  }

  const grouped = new Map<number, LabelCandidateMergeInput[]>();
  inputs.forEach((input, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), input]);
  });

  return [...grouped.values()].map((members) => {
    const hasManual = members.some((left, index) => members.slice(index + 1)
      .some((right) => Boolean(left.mergeGroupId && left.mergeGroupId === right.mergeGroupId)));
    const hasAutomatic = members.some((left, index) => members.slice(index + 1)
      .some((right) => bboxFragmentsOverlap(left.geometry.bbox, right.geometry.bbox)));
    return {
      candidateIds: members.map((member) => member.candidateId),
      geometry: members.length === 1 ? members[0]!.geometry : rectangleGeometry(unionBboxes(members.map((member) => member.geometry.bbox))),
      mode: hasManual && hasAutomatic ? "mixed" : hasManual ? "manual" : hasAutomatic ? "automatic" : "none",
    };
  });
}

function bboxFragmentsOverlap(left: RegionGeometry["bbox"], right: RegionGeometry["bbox"]) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  if (!intersection) return false;
  const containment = intersection / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  return containment < .82;
}

function unionBboxes(values: RegionGeometry["bbox"][]) {
  const x = Math.min(...values.map((value) => value.x));
  const y = Math.min(...values.map((value) => value.y));
  const right = Math.max(...values.map((value) => value.x + value.width));
  const bottom = Math.max(...values.map((value) => value.y + value.height));
  return { x, y, width: right - x, height: bottom - y };
}
