/**
 * Read-only geometric detection of the sampled dark-theme TradingView frame.
 *
 * This module observes one dominant framed rectangle. It does not establish
 * TradingView provenance, semantic chart completeness, or publication policy.
 */

export const CHART_FRAME_DETECTOR_IDENTIFIER =
  "visionx.dark-theme-dominant-frame" as const;
export const CHART_FRAME_DETECTOR_VERSION = "1" as const;
export const CHART_FRAME_COORDINATE_CONVENTION =
  "zero_based_inclusive" as const;

export interface DecodedPixelImage {
  readonly format: string | null;
  readonly width: number;
  readonly height: number;
  readonly channelCount: number;
  readonly data: Uint8Array;
}

export interface RgbObservation {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface SideEvidence {
  readonly matchedPixels: number;
  readonly totalPixels: number;
  readonly ratio: number;
}

export interface SideContinuityEvidence {
  readonly top: SideEvidence;
  readonly right: SideEvidence;
  readonly bottom: SideEvidence;
  readonly left: SideEvidence;
}

export interface CornerCoherenceEvidence {
  readonly topLeft: boolean;
  readonly topRight: boolean;
  readonly bottomRight: boolean;
  readonly bottomLeft: boolean;
  readonly coherentCornerCount: number;
}

export interface BorderEvidence {
  readonly representative: RgbObservation;
  readonly minimum: RgbObservation;
  readonly maximum: RgbObservation;
  readonly neutralPixelRatio: number;
}

export interface ExteriorEvidence {
  readonly representative: RgbObservation;
  readonly minimum: RgbObservation;
  readonly maximum: RgbObservation;
  readonly sampleCount: number;
  readonly contrastFromBorder: number;
  readonly darkerSampleRatio: number;
}

export interface ChartFrameObservation {
  readonly ok: true;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly coordinateConvention: typeof CHART_FRAME_COORDINATE_CONVENTION;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly candidateCount: number;
  readonly detectorIdentifier: typeof CHART_FRAME_DETECTOR_IDENTIFIER;
  readonly detectorVersion: typeof CHART_FRAME_DETECTOR_VERSION;
  readonly sideContinuity: SideContinuityEvidence;
  readonly corners: CornerCoherenceEvidence;
  readonly border: BorderEvidence;
  readonly exterior: ExteriorEvidence;
}

export type ChartFrameFailureReason =
  | "no_frame_candidate"
  | "multiple_comparable_candidates"
  | "incomplete_sides"
  | "incoherent_corners"
  | "touching_image_boundary"
  | "unsupported_frame_style"
  | "invalid_geometry"
  | "unreadable_input";

export interface ChartFrameDetectionFailure {
  readonly ok: false;
  readonly reason: ChartFrameFailureReason;
  readonly detail: string;
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
  readonly candidateCount: number;
  readonly detectorIdentifier: typeof CHART_FRAME_DETECTOR_IDENTIFIER;
  readonly detectorVersion: typeof CHART_FRAME_DETECTOR_VERSION;
}

export type ChartFrameDetectionResult =
  | ChartFrameObservation
  | ChartFrameDetectionFailure;

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface LineRun {
  readonly coordinate: number;
  readonly start: number;
  readonly end: number;
  readonly length: number;
}

interface Candidate {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly area: number;
  readonly sideContinuity: SideContinuityEvidence;
  readonly corners: CornerCoherenceEvidence;
  readonly border: BorderEvidence;
  readonly exterior: ExteriorEvidence | null;
  readonly touchesBoundary: boolean;
  readonly frameStyleSupported: boolean;
}

const MIN_DIMENSION = 12;
const MIN_LINE_FRACTION = 0.35;
const MIN_FRAME_AREA_FRACTION = 0.2;
const REQUIRED_SIDE_CONTINUITY = 0.94;
const REQUIRED_EXTERIOR_DARKER_RATIO = 0.6;
const MIN_EXTERIOR_CONTRAST = 3;
const NEUTRAL_CHANNEL_SPREAD = 10;
const MIN_BORDER_DELTA_FROM_EXTERIOR = 4;
const MAX_BORDER_DELTA_FROM_EXTERIOR = 80;
const COMPARABLE_AREA_RATIO = 0.85;
const LINE_ALIGNMENT_TOLERANCE = 2;
const NEAR_DUPLICATE_MIN_INTERSECTION_OVER_UNION = 0.95;
const DIAGNOSTIC_ALIGNMENT_TOLERANCE = 4;

function freezeRgb(rgb: Rgb): RgbObservation {
  return Object.freeze(rgb);
}

function freezeSide(evidence: SideEvidence): SideEvidence {
  return Object.freeze(evidence);
}

function freezeFailure(
  reason: ChartFrameFailureReason,
  detail: string,
  sourceWidth: number | null,
  sourceHeight: number | null,
  candidateCount = 0,
): ChartFrameDetectionFailure {
  return Object.freeze({
    ok: false,
    reason,
    detail,
    sourceWidth,
    sourceHeight,
    candidateCount,
    detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
    detectorVersion: CHART_FRAME_DETECTOR_VERSION,
  });
}

function isValidInput(image: DecodedPixelImage): boolean {
  return (
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    Number.isInteger(image.channelCount) &&
    image.width >= MIN_DIMENSION &&
    image.height >= MIN_DIMENSION &&
    image.channelCount >= 3 &&
    image.data.byteLength === image.width * image.height * image.channelCount
  );
}

function pixelAt(image: DecodedPixelImage, x: number, y: number): Rgb {
  const index = (y * image.width + x) * image.channelCount;
  return {
    red: image.data[index] ?? 0,
    green: image.data[index + 1] ?? 0,
    blue: image.data[index + 2] ?? 0,
  };
}

function luminance(rgb: Rgb): number {
  return (rgb.red + rgb.green + rgb.blue) / 3;
}

function channelSpread(rgb: Rgb): number {
  return Math.max(rgb.red, rgb.green, rgb.blue) - Math.min(rgb.red, rgb.green, rgb.blue);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function summarizeRgb(values: readonly Rgb[]): {
  readonly representative: Rgb;
  readonly minimum: Rgb;
  readonly maximum: Rgb;
} {
  const reds = values.map((value) => value.red);
  const greens = values.map((value) => value.green);
  const blues = values.map((value) => value.blue);
  return {
    representative: {
      red: median(reds),
      green: median(greens),
      blue: median(blues),
    },
    minimum: {
      red: Math.min(...reds),
      green: Math.min(...greens),
      blue: Math.min(...blues),
    },
    maximum: {
      red: Math.max(...reds),
      green: Math.max(...greens),
      blue: Math.max(...blues),
    },
  };
}

function estimateExterior(image: DecodedPixelImage): Rgb {
  const patch = Math.max(2, Math.min(6, Math.floor(Math.min(image.width, image.height) / 20)));
  const samples: Rgb[] = [];
  const origins: readonly [number, number][] = [
    [0, 0],
    [image.width - patch, 0],
    [0, image.height - patch],
    [image.width - patch, image.height - patch],
  ];
  for (const [originX, originY] of origins) {
    for (let y = originY; y < originY + patch; y += 1) {
      for (let x = originX; x < originX + patch; x += 1) {
        samples.push(pixelAt(image, x, y));
      }
    }
  }
  return summarizeRgb(samples).representative;
}

function isFrameStylePixel(rgb: Rgb, exterior: Rgb): boolean {
  const delta = luminance(rgb) - luminance(exterior);
  return (
    channelSpread(rgb) <= NEUTRAL_CHANNEL_SPREAD &&
    delta >= MIN_BORDER_DELTA_FROM_EXTERIOR &&
    delta <= MAX_BORDER_DELTA_FROM_EXTERIOR
  );
}

function longestRuns(values: readonly boolean[]): readonly { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let index = 0; index <= values.length; index += 1) {
    if (index < values.length && values[index]) {
      if (start === null) start = index;
      continue;
    }
    if (start !== null) {
      runs.push({ start, end: index - 1 });
      start = null;
    }
  }
  return runs;
}

function horizontalRuns(
  image: DecodedPixelImage,
  exterior: Rgb,
): readonly LineRun[] {
  const minimumLength = Math.max(8, Math.floor(image.width * MIN_LINE_FRACTION));
  const runs: LineRun[] = [];
  for (let y = 0; y < image.height; y += 1) {
    const row = Array.from({ length: image.width }, (_, x) =>
      isFrameStylePixel(pixelAt(image, x, y), exterior),
    );
    for (const run of longestRuns(row)) {
      const length = run.end - run.start + 1;
      if (length >= minimumLength) {
        runs.push({ coordinate: y, start: run.start, end: run.end, length });
      }
    }
  }
  return runs;
}

function verticalRuns(
  image: DecodedPixelImage,
  exterior: Rgb,
): readonly LineRun[] {
  const minimumLength = Math.max(8, Math.floor(image.height * MIN_LINE_FRACTION));
  const runs: LineRun[] = [];
  for (let x = 0; x < image.width; x += 1) {
    const column = Array.from({ length: image.height }, (_, y) =>
      isFrameStylePixel(pixelAt(image, x, y), exterior),
    );
    for (const run of longestRuns(column)) {
      const length = run.end - run.start + 1;
      if (length >= minimumLength) {
        runs.push({ coordinate: x, start: run.start, end: run.end, length });
      }
    }
  }
  return runs;
}

function sideEvidence(matches: number, total: number): SideEvidence {
  return freezeSide({ matchedPixels: matches, totalPixels: total, ratio: matches / total });
}

function sideContinuity(
  image: DecodedPixelImage,
  exterior: Rgb,
  left: number,
  top: number,
  right: number,
  bottom: number,
): SideContinuityEvidence {
  let topMatches = 0;
  let bottomMatches = 0;
  for (let x = left; x <= right; x += 1) {
    if (isFrameStylePixel(pixelAt(image, x, top), exterior)) topMatches += 1;
    if (isFrameStylePixel(pixelAt(image, x, bottom), exterior)) bottomMatches += 1;
  }
  let leftMatches = 0;
  let rightMatches = 0;
  for (let y = top; y <= bottom; y += 1) {
    if (isFrameStylePixel(pixelAt(image, left, y), exterior)) leftMatches += 1;
    if (isFrameStylePixel(pixelAt(image, right, y), exterior)) rightMatches += 1;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  return Object.freeze({
    top: sideEvidence(topMatches, width),
    right: sideEvidence(rightMatches, height),
    bottom: sideEvidence(bottomMatches, width),
    left: sideEvidence(leftMatches, height),
  });
}

function nearSidePixel(
  image: DecodedPixelImage,
  exterior: Rgb,
  axis: "horizontal" | "vertical",
  fixed: number,
  target: number,
): boolean {
  for (let offset = -LINE_ALIGNMENT_TOLERANCE; offset <= LINE_ALIGNMENT_TOLERANCE; offset += 1) {
    const x = axis === "horizontal" ? target + offset : fixed;
    const y = axis === "horizontal" ? fixed : target + offset;
    if (x >= 0 && x < image.width && y >= 0 && y < image.height) {
      if (isFrameStylePixel(pixelAt(image, x, y), exterior)) return true;
    }
  }
  return false;
}

function cornerEvidence(
  image: DecodedPixelImage,
  exterior: Rgb,
  left: number,
  top: number,
  right: number,
  bottom: number,
): CornerCoherenceEvidence {
  const topLeft =
    nearSidePixel(image, exterior, "horizontal", top, left) &&
    nearSidePixel(image, exterior, "vertical", left, top);
  const topRight =
    nearSidePixel(image, exterior, "horizontal", top, right) &&
    nearSidePixel(image, exterior, "vertical", right, top);
  const bottomRight =
    nearSidePixel(image, exterior, "horizontal", bottom, right) &&
    nearSidePixel(image, exterior, "vertical", right, bottom);
  const bottomLeft =
    nearSidePixel(image, exterior, "horizontal", bottom, left) &&
    nearSidePixel(image, exterior, "vertical", left, bottom);
  return Object.freeze({
    topLeft,
    topRight,
    bottomRight,
    bottomLeft,
    coherentCornerCount: [topLeft, topRight, bottomRight, bottomLeft].filter(Boolean).length,
  });
}

function borderPixels(
  image: DecodedPixelImage,
  left: number,
  top: number,
  right: number,
  bottom: number,
): readonly Rgb[] {
  const values: Rgb[] = [];
  for (let x = left; x <= right; x += 1) {
    values.push(pixelAt(image, x, top));
    if (bottom !== top) values.push(pixelAt(image, x, bottom));
  }
  for (let y = top + 1; y < bottom; y += 1) {
    values.push(pixelAt(image, left, y));
    if (right !== left) values.push(pixelAt(image, right, y));
  }
  return values;
}

function borderEvidence(values: readonly Rgb[]): BorderEvidence {
  const summary = summarizeRgb(values);
  const neutralCount = values.filter((value) => channelSpread(value) <= NEUTRAL_CHANNEL_SPREAD).length;
  return Object.freeze({
    representative: freezeRgb(summary.representative),
    minimum: freezeRgb(summary.minimum),
    maximum: freezeRgb(summary.maximum),
    neutralPixelRatio: neutralCount / values.length,
  });
}

function exteriorPixels(
  image: DecodedPixelImage,
  left: number,
  top: number,
  right: number,
  bottom: number,
): readonly Rgb[] {
  const values: Rgb[] = [];
  const strip = 3;
  for (let distance = 1; distance <= strip; distance += 1) {
    const yAbove = top - distance;
    const yBelow = bottom + distance;
    if (yAbove >= 0) {
      for (let x = left; x <= right; x += 1) values.push(pixelAt(image, x, yAbove));
    }
    if (yBelow < image.height) {
      for (let x = left; x <= right; x += 1) values.push(pixelAt(image, x, yBelow));
    }
    const xLeft = left - distance;
    const xRight = right + distance;
    if (xLeft >= 0) {
      for (let y = top; y <= bottom; y += 1) values.push(pixelAt(image, xLeft, y));
    }
    if (xRight < image.width) {
      for (let y = top; y <= bottom; y += 1) values.push(pixelAt(image, xRight, y));
    }
  }
  return values;
}

function exteriorEvidence(values: readonly Rgb[], border: BorderEvidence): ExteriorEvidence | null {
  if (values.length === 0) return null;
  const summary = summarizeRgb(values);
  const borderLuma = luminance(border.representative);
  const darker = values.filter((value) => luminance(value) < borderLuma).length;
  return Object.freeze({
    representative: freezeRgb(summary.representative),
    minimum: freezeRgb(summary.minimum),
    maximum: freezeRgb(summary.maximum),
    sampleCount: values.length,
    contrastFromBorder: borderLuma - luminance(summary.representative),
    darkerSampleRatio: darker / values.length,
  });
}

function lineCanMeetHorizontal(
  run: LineRun,
  left: number,
  right: number,
  tolerance: number,
): boolean {
  return run.start <= left + tolerance && run.end >= right - tolerance;
}

function lineCanMeetVertical(
  run: LineRun,
  top: number,
  bottom: number,
  tolerance: number,
): boolean {
  return run.start <= top + tolerance && run.end >= bottom - tolerance;
}

function boundaryRectangleIsCoherent(image: DecodedPixelImage): boolean {
  const left = 0;
  const top = 0;
  const right = image.width - 1;
  const bottom = image.height - 1;
  const edgeValues = borderPixels(image, left, top, right, bottom);
  const edgeSummary = summarizeRgb(edgeValues);
  const representativeLuma = luminance(edgeSummary.representative);

  const matchesRepresentative = (value: Rgb): boolean =>
    channelSpread(value) <= NEUTRAL_CHANNEL_SPREAD &&
    Math.abs(luminance(value) - representativeLuma) <= NEUTRAL_CHANNEL_SPREAD;

  const sideRatio = (values: readonly Rgb[]): number =>
    values.filter(matchesRepresentative).length / values.length;

  const topValues = Array.from({ length: image.width }, (_, x) => pixelAt(image, x, top));
  const bottomValues = Array.from({ length: image.width }, (_, x) => pixelAt(image, x, bottom));
  const leftValues = Array.from({ length: image.height }, (_, y) => pixelAt(image, left, y));
  const rightValues = Array.from({ length: image.height }, (_, y) => pixelAt(image, right, y));

  if (
    sideRatio(topValues) < REQUIRED_SIDE_CONTINUITY ||
    sideRatio(bottomValues) < REQUIRED_SIDE_CONTINUITY ||
    sideRatio(leftValues) < REQUIRED_SIDE_CONTINUITY ||
    sideRatio(rightValues) < REQUIRED_SIDE_CONTINUITY
  ) {
    return false;
  }

  const corners = [
    pixelAt(image, left, top),
    pixelAt(image, right, top),
    pixelAt(image, right, bottom),
    pixelAt(image, left, bottom),
  ];
  if (!corners.every(matchesRepresentative)) return false;

  const inset = Math.max(1, Math.min(3, Math.floor(Math.min(image.width, image.height) / 8)));
  const interiorValues: Rgb[] = [];
  for (let x = inset; x <= right - inset; x += 1) {
    interiorValues.push(pixelAt(image, x, inset));
    interiorValues.push(pixelAt(image, x, bottom - inset));
  }
  for (let y = inset + 1; y < bottom - inset; y += 1) {
    interiorValues.push(pixelAt(image, inset, y));
    interiorValues.push(pixelAt(image, right - inset, y));
  }
  if (interiorValues.length === 0) return false;

  const interiorLuma = luminance(summarizeRgb(interiorValues).representative);
  return representativeLuma - interiorLuma >= MIN_EXTERIOR_CONTRAST;
}

function buildCandidates(
  image: DecodedPixelImage,
  exterior: Rgb,
  horizontals: readonly LineRun[],
  verticals: readonly LineRun[],
  alignmentTolerance = LINE_ALIGNMENT_TOLERANCE,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (let topIndex = 0; topIndex < horizontals.length; topIndex += 1) {
    const topRun = horizontals[topIndex];
    if (topRun === undefined) continue;
    for (let bottomIndex = topIndex + 1; bottomIndex < horizontals.length; bottomIndex += 1) {
      const bottomRun = horizontals[bottomIndex];
      if (bottomRun === undefined || bottomRun.coordinate <= topRun.coordinate) continue;
      for (let leftIndex = 0; leftIndex < verticals.length; leftIndex += 1) {
        const leftRun = verticals[leftIndex];
        if (leftRun === undefined) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < verticals.length; rightIndex += 1) {
          const rightRun = verticals[rightIndex];
          if (rightRun === undefined || rightRun.coordinate <= leftRun.coordinate) continue;
          const left = leftRun.coordinate;
          const right = rightRun.coordinate;
          const top = topRun.coordinate;
          const bottom = bottomRun.coordinate;
          const width = right - left + 1;
          const height = bottom - top + 1;
          const area = width * height;
          if (area < image.width * image.height * MIN_FRAME_AREA_FRACTION) continue;
          if (!lineCanMeetHorizontal(topRun, left, right, alignmentTolerance)) continue;
          if (!lineCanMeetHorizontal(bottomRun, left, right, alignmentTolerance)) continue;
          if (!lineCanMeetVertical(leftRun, top, bottom, alignmentTolerance)) continue;
          if (!lineCanMeetVertical(rightRun, top, bottom, alignmentTolerance)) continue;
          const key = `${left},${top},${right},${bottom}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const continuity = sideContinuity(image, exterior, left, top, right, bottom);
          const corners = cornerEvidence(image, exterior, left, top, right, bottom);
          const border = borderEvidence(borderPixels(image, left, top, right, bottom));
          const exteriorResult = exteriorEvidence(
            exteriorPixels(image, left, top, right, bottom),
            border,
          );
          const frameStyleSupported =
            border.neutralPixelRatio >= REQUIRED_SIDE_CONTINUITY &&
            exteriorResult !== null &&
            exteriorResult.contrastFromBorder >= MIN_EXTERIOR_CONTRAST &&
            exteriorResult.darkerSampleRatio >= REQUIRED_EXTERIOR_DARKER_RATIO;
          candidates.push({
            left,
            top,
            right,
            bottom,
            area,
            sideContinuity: continuity,
            corners,
            border,
            exterior: exteriorResult,
            touchesBoundary:
              left === 0 || top === 0 || right === image.width - 1 || bottom === image.height - 1,
            frameStyleSupported,
          });
        }
      }
    }
  }
  return candidates;
}

function allSidesSupported(candidate: Candidate): boolean {
  return Object.values(candidate.sideContinuity).every(
    (side) => side.ratio >= REQUIRED_SIDE_CONTINUITY,
  );
}

function completedSideCount(candidate: Candidate): number {
  return Object.values(candidate.sideContinuity).filter(
    (side) => side.ratio >= REQUIRED_SIDE_CONTINUITY,
  ).length;
}

function successfulCandidate(candidate: Candidate): boolean {
  return (
    allSidesSupported(candidate) &&
    candidate.corners.coherentCornerCount === 4 &&
    candidate.frameStyleSupported
  );
}

function candidateWidth(candidate: Candidate): number {
  return candidate.right - candidate.left + 1;
}

function candidateHeight(candidate: Candidate): number {
  return candidate.bottom - candidate.top + 1;
}

function candidateIntersectionOverUnion(first: Candidate, second: Candidate): number {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right < left || bottom < top) return 0;

  const intersection = (right - left + 1) * (bottom - top + 1);
  const union = first.area + second.area - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Two supported hypotheses are alternate observations of one physical frame only
 * when every corresponding bound is within the detector's existing alignment
 * tolerance and the rectangles overlap almost completely. The overlap condition
 * prevents materially nested or shifted rectangles from being merged merely
 * because each edge happens to be close.
 */
function candidatesDescribeSamePhysicalFrame(first: Candidate, second: Candidate): boolean {
  return (
    Math.abs(first.left - second.left) <= LINE_ALIGNMENT_TOLERANCE &&
    Math.abs(first.top - second.top) <= LINE_ALIGNMENT_TOLERANCE &&
    Math.abs(first.right - second.right) <= LINE_ALIGNMENT_TOLERANCE &&
    Math.abs(first.bottom - second.bottom) <= LINE_ALIGNMENT_TOLERANCE &&
    candidateIntersectionOverUnion(first, second) >=
      NEAR_DUPLICATE_MIN_INTERSECTION_OVER_UNION
  );
}

function sideContinuityScore(candidate: Candidate): number {
  return (
    candidate.sideContinuity.top.ratio +
    candidate.sideContinuity.right.ratio +
    candidate.sideContinuity.bottom.ratio +
    candidate.sideContinuity.left.ratio
  );
}

/**
 * Representative ordering is deterministic and intentionally geometry-first:
 * 1. greatest enclosed area (therefore preferring the outermost near-duplicate);
 * 2. stronger aggregate side continuity;
 * 3. more coherent corners;
 * 4. stable outer-coordinate ordering as the final tie-breaker.
 */
function compareCandidateRepresentatives(first: Candidate, second: Candidate): number {
  if (first.area !== second.area) return second.area - first.area;

  const continuityDifference = sideContinuityScore(second) - sideContinuityScore(first);
  if (continuityDifference !== 0) return continuityDifference;

  if (first.corners.coherentCornerCount !== second.corners.coherentCornerCount) {
    return second.corners.coherentCornerCount - first.corners.coherentCornerCount;
  }

  if (first.left !== second.left) return first.left - second.left;
  if (first.top !== second.top) return first.top - second.top;
  if (first.right !== second.right) return second.right - first.right;
  if (first.bottom !== second.bottom) return second.bottom - first.bottom;

  const widthDifference = candidateWidth(second) - candidateWidth(first);
  if (widthDifference !== 0) return widthDifference;
  return candidateHeight(second) - candidateHeight(first);
}

/**
 * Canonicalise raw supported line-run combinations into distinct physical-frame
 * candidates. Candidates are considered against the already selected deterministic
 * representative, preventing transitive overlap chains from collapsing rectangles
 * whose own bounds differ by more than the alignment tolerance.
 */
function canonicaliseSupportedCandidates(candidates: readonly Candidate[]): readonly Candidate[] {
  const ordered = [...candidates].sort(compareCandidateRepresentatives);
  const representatives: Candidate[] = [];

  for (const candidate of ordered) {
    const existing = representatives.find((representative) =>
      candidatesDescribeSamePhysicalFrame(candidate, representative),
    );
    if (existing === undefined) representatives.push(candidate);
  }

  return representatives;
}

function freezeObservation(
  image: DecodedPixelImage,
  candidate: Candidate,
  candidateCount: number,
): ChartFrameObservation {
  const exterior = candidate.exterior;
  if (exterior === null) {
    throw new Error("successful candidate must contain exterior evidence");
  }
  return Object.freeze({
    ok: true,
    sourceWidth: image.width,
    sourceHeight: image.height,
    coordinateConvention: CHART_FRAME_COORDINATE_CONVENTION,
    left: candidate.left,
    top: candidate.top,
    right: candidate.right,
    bottom: candidate.bottom,
    frameWidth: candidate.right - candidate.left + 1,
    frameHeight: candidate.bottom - candidate.top + 1,
    candidateCount,
    detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
    detectorVersion: CHART_FRAME_DETECTOR_VERSION,
    sideContinuity: candidate.sideContinuity,
    corners: candidate.corners,
    border: candidate.border,
    exterior,
  });
}

/** Detect one unique dominant framed rectangle from immutable decoded pixels. */
export function detectChartFrameFromPixels(
  image: DecodedPixelImage,
): ChartFrameDetectionResult {
  if (!isValidInput(image)) {
    return freezeFailure(
      "invalid_geometry",
      "decoded pixels do not match a supported positive RGB/RGBA geometry",
      Number.isInteger(image.width) ? image.width : null,
      Number.isInteger(image.height) ? image.height : null,
    );
  }

  const exterior = estimateExterior(image);
  const horizontals = horizontalRuns(image, exterior);
  const verticals = verticalRuns(image, exterior);
  const candidates = buildCandidates(image, exterior, horizontals, verticals);

  if (candidates.length === 0) {
    if (boundaryRectangleIsCoherent(image)) {
      return freezeFailure(
        "touching_image_boundary",
        "a coherent frame-like rectangle coincides with the source-image boundary",
        image.width,
        image.height,
        1,
      );
    }
    const diagnosticCandidates = [
      ...buildCandidates(
        image,
        exterior,
        horizontals,
        verticals,
        DIAGNOSTIC_ALIGNMENT_TOLERANCE,
      ),
    ].sort((a, b) => b.area - a.area);
    const incoherent = diagnosticCandidates.find(
      (candidate) =>
        completedSideCount(candidate) === 4 && candidate.corners.coherentCornerCount < 4,
    );
    if (incoherent !== undefined) {
      return freezeFailure(
        "incoherent_corners",
        `frame-like long sides exist but only ${incoherent.corners.coherentCornerCount} corners meet coherently`,
        image.width,
        image.height,
        diagnosticCandidates.length,
      );
    }
    const hasHorizontalPair = horizontals.some((first, index) =>
      horizontals.slice(index + 1).some((second) => second.coordinate > first.coordinate),
    );
    const hasVerticalPair = verticals.some((first, index) =>
      verticals.slice(index + 1).some((second) => second.coordinate > first.coordinate),
    );
    if (hasHorizontalPair !== hasVerticalPair) {
      return freezeFailure(
        "incomplete_sides",
        "long frame-like lines were found on only one axis",
        image.width,
        image.height,
      );
    }
    return freezeFailure(
      "no_frame_candidate",
      "no dominant framed rectangle was found",
      image.width,
      image.height,
    );
  }

  const complete = candidates.filter(successfulCandidate);
  const distinctComplete = canonicaliseSupportedCandidates(complete);
  if (distinctComplete.length > 0) {
    const best = distinctComplete[0];
    if (best === undefined) {
      return freezeFailure("invalid_geometry", "candidate ordering failed", image.width, image.height);
    }
    const comparable = distinctComplete.filter(
      (candidate) => candidate.area >= best.area * COMPARABLE_AREA_RATIO,
    );
    if (comparable.length > 1) {
      return freezeFailure(
        "multiple_comparable_candidates",
        `${comparable.length} supported rectangles have comparable enclosed area`,
        image.width,
        image.height,
        comparable.length,
      );
    }
    if (best.touchesBoundary) {
      return freezeFailure(
        "touching_image_boundary",
        "the dominant rectangle touches an unsupported source-image boundary",
        image.width,
        image.height,
        distinctComplete.length,
      );
    }
    return freezeObservation(image, best, distinctComplete.length);
  }

  const sorted = [...candidates].sort((a, b) => b.area - a.area);
  const best = sorted[0];
  if (best === undefined) {
    return freezeFailure("no_frame_candidate", "no frame candidate was found", image.width, image.height);
  }
  if (best.touchesBoundary && allSidesSupported(best) && best.corners.coherentCornerCount === 4) {
    return freezeFailure(
      "touching_image_boundary",
      "a coherent rectangle exists only at the source-image boundary",
      image.width,
      image.height,
      candidates.length,
    );
  }
  if (completedSideCount(best) < 4) {
    return freezeFailure(
      "incomplete_sides",
      `best candidate has ${completedSideCount(best)} sufficiently continuous sides`,
      image.width,
      image.height,
      candidates.length,
    );
  }
  if (best.corners.coherentCornerCount < 4) {
    return freezeFailure(
      "incoherent_corners",
      `best candidate has ${best.corners.coherentCornerCount} coherent corners`,
      image.width,
      image.height,
      candidates.length,
    );
  }
  if (!best.frameStyleSupported) {
    return freezeFailure(
      "unsupported_frame_style",
      "rectangle geometry exists but border/exterior evidence is unsupported or ambiguous",
      image.width,
      image.height,
      candidates.length,
    );
  }
  return freezeFailure(
    "no_frame_candidate",
    "no unique supported frame remained after geometric evaluation",
    image.width,
    image.height,
    candidates.length,
  );
}
