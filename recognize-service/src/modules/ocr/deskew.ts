import sharp from "sharp";

export type DeskewEstimate = {
  evaluated: boolean;
  angleDegrees: number | null;
  confidence: number;
  applied: boolean;
  method: "component-baseline-v1";
};

type Component = { left: number; right: number; top: number; bottom: number; area: number };

export async function estimateDeskewAngle(image: Buffer): Promise<DeskewEstimate> {
  const prepared = await sharp(image)
    .resize({ width: 480, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = prepared.info;
  if (width < 40 || height < 20) return unresolved();
  const threshold = darknessThreshold(prepared.data);
  const components = connectedComponents(prepared.data, width, height, threshold)
    .filter((component) => component.area >= 4
      && component.right - component.left + 1 <= width * 0.22
      && component.bottom - component.top + 1 >= 2
      && component.bottom - component.top + 1 <= height * 0.28);
  if (components.length < 5) return unresolved();

  const votes = new Map<number, number>();
  let totalWeight = 0;
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    const left = components[leftIndex];
    const leftHeight = left.bottom - left.top + 1;
    const leftCenterX = (left.left + left.right) / 2;
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const right = components[rightIndex];
      const rightCenterX = (right.left + right.right) / 2;
      const dx = rightCenterX - leftCenterX;
      if (dx < 8 || dx > width * 0.35) continue;
      const rightHeight = right.bottom - right.top + 1;
      const heightRatio = leftHeight / Math.max(1, rightHeight);
      if (heightRatio < 0.45 || heightRatio > 2.2) continue;
      const angle = Math.atan2(right.bottom - left.bottom, dx) * 180 / Math.PI;
      if (Math.abs(angle) > 8.25) continue;
      const weight = Math.sqrt(left.area * right.area) * Math.min(1, dx / 45);
      const bin = Math.round(angle * 2);
      votes.set(bin, (votes.get(bin) ?? 0) + weight);
      totalWeight += weight;
    }
  }
  const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
  const best = ranked[0];
  if (!best || totalWeight <= 0) return unresolved();
  const neighborhoodWeight = [-1, 0, 1].reduce((sum, offset) => sum + (votes.get(best[0] + offset) ?? 0), 0);
  const outsideRunnerUp = ranked.find(([bin]) => Math.abs(bin - best[0]) >= 3)?.[1] ?? 0;
  const concentration = neighborhoodWeight / totalWeight;
  const separation = (best[1] - outsideRunnerUp) / Math.max(best[1], 1e-9);
  const confidence = round01(concentration * 1.8 + Math.max(0, separation) * 0.35);
  const angleDegrees = Math.round((best[0] / 2) * 10) / 10;
  const applied = Math.abs(angleDegrees) >= 0.75 && Math.abs(angleDegrees) <= 7.5 && confidence >= 0.16;
  return { evaluated: true, angleDegrees, confidence, applied, method: "component-baseline-v1" };
}

function connectedComponents(input: Buffer, width: number, height: number, threshold: number) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components: Component[] = [];
  for (let start = 0; start < input.length; start += 1) {
    if (visited[start] || (input[start] ?? 255) > threshold) continue;
    let head = 0; let tail = 1; queue[0] = start; visited[start] = 1;
    let left = start % width; let right = left; let top = Math.floor(start / width); let bottom = top; let area = 0;
    while (head < tail) {
      const index = queue[head++]; const x = index % width; const y = Math.floor(index / width); area += 1;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited[neighbor] || (input[neighbor] ?? 255) > threshold) continue;
        visited[neighbor] = 1; queue[tail++] = neighbor;
      }
    }
    components.push({ left, right, top, bottom, area });
  }
  return components;
}

function darknessThreshold(input: Buffer) {
  let sum = 0; let squareSum = 0;
  for (const value of input) { sum += value; squareSum += value * value; }
  const mean = sum / Math.max(1, input.length);
  const deviation = Math.sqrt(Math.max(0, squareSum / Math.max(1, input.length) - mean * mean));
  return Math.max(55, Math.min(175, mean - deviation * 0.55));
}

function unresolved(): DeskewEstimate {
  return { evaluated: true, angleDegrees: null, confidence: 0, applied: false, method: "component-baseline-v1" };
}

function round01(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}
