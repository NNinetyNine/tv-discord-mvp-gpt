import { describe, expect, it } from "vitest";

import {
  detectChartFrameFromPixels,
  type ChartFrameDetectionFailure,
  type ChartFrameObservation,
  type DecodedPixelImage,
} from "./detect-chart-frame.ts";

interface CanvasOptions {
  readonly width?: number;
  readonly height?: number;
  readonly left?: number;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly border?: readonly [number, number, number];
  readonly exterior?: readonly [number, number, number];
  readonly interior?: readonly [number, number, number];
}

function makeCanvas(options: CanvasOptions = {}): DecodedPixelImage {
  const width = options.width ?? 120;
  const height = options.height ?? 90;
  const left = options.left ?? 7;
  const top = options.top ?? 9;
  const right = options.right ?? width - 8;
  const bottom = options.bottom ?? height - 11;
  const border = options.border ?? [45, 45, 45];
  const exterior = options.exterior ?? [31, 31, 31];
  const interior = options.interior ?? [20, 20, 20];
  const data = new Uint8Array(width * height * 4);

  function setPixel(x: number, y: number, rgb: readonly [number, number, number]): void {
    const offset = (y * width + x) * 4;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(x, y, exterior);
    }
  }
  for (let y = top + 1; y < bottom; y += 1) {
    for (let x = left + 1; x < right; x += 1) {
      const variation = (x * 7 + y * 11) % 3;
      setPixel(x, y, [interior[0] + variation, interior[1], interior[2]]);
    }
  }
  for (let x = left; x <= right; x += 1) {
    setPixel(x, top, border);
    setPixel(x, bottom, border);
  }
  for (let y = top; y <= bottom; y += 1) {
    setPixel(left, y, border);
    setPixel(right, y, border);
  }

  return { format: "png", width, height, channelCount: 4, data };
}

function setPixel(
  image: DecodedPixelImage,
  x: number,
  y: number,
  rgb: readonly [number, number, number],
): void {
  const offset = (y * image.width + x) * image.channelCount;
  image.data[offset] = rgb[0];
  image.data[offset + 1] = rgb[1];
  image.data[offset + 2] = rgb[2];
}

function setAlpha(image: DecodedPixelImage, x: number, y: number, alpha: number): void {
  const offset = (y * image.width + x) * image.channelCount;
  image.data[offset + 3] = alpha;
}

function expectSuccess(result: ReturnType<typeof detectChartFrameFromPixels>): ChartFrameObservation {
  expect(result.ok).toBe(true);
  return result as ChartFrameObservation;
}

function expectFailure(
  result: ReturnType<typeof detectChartFrameFromPixels>,
  reason: ChartFrameDetectionFailure["reason"],
): ChartFrameDetectionFailure {
  expect(result).toMatchObject({ ok: false, reason });
  return result as ChartFrameDetectionFailure;
}

describe("detectChartFrameFromPixels", () => {
  it("detects one valid dominant rectangle with inclusive bounds", () => {
    const result = expectSuccess(detectChartFrameFromPixels(makeCanvas()));

    expect(result).toMatchObject({
      coordinateConvention: "zero_based_inclusive",
      left: 7,
      top: 9,
      right: 112,
      bottom: 79,
      frameWidth: 106,
      frameHeight: 71,
      candidateCount: 1,
      detectorIdentifier: "visionx.dark-theme-dominant-frame",
      detectorVersion: "1",
    });
    expect(result.sideContinuity.top.ratio).toBe(1);
    expect(result.sideContinuity.right.ratio).toBe(1);
    expect(result.sideContinuity.bottom.ratio).toBe(1);
    expect(result.sideContinuity.left.ratio).toBe(1);
    expect(result.corners.coherentCornerCount).toBe(4);
  });

  it.each([
    { width: 80, height: 120, left: 5, top: 8, right: 73, bottom: 108 },
    { width: 220, height: 80, left: 9, top: 6, right: 210, bottom: 70 },
  ])("detects valid rectangles across dimensions %#", (options) => {
    const result = expectSuccess(detectChartFrameFromPixels(makeCanvas(options)));

    expect(result.frameWidth).toBe(options.right - options.left + 1);
    expect(result.frameHeight).toBe(options.bottom - options.top + 1);
  });

  it("tolerates mild border-colour variation", () => {
    const image = makeCanvas();
    for (let x = 7; x <= 112; x += 5) setPixel(image, x, 9, [47, 45, 46]);
    for (let y = 9; y <= 79; y += 5) setPixel(image, 112, y, [43, 45, 44]);

    const result = expectSuccess(detectChartFrameFromPixels(image));

    expect(result.border.minimum.red).toBeLessThanOrEqual(43);
    expect(result.border.maximum.red).toBeGreaterThanOrEqual(47);
  });

  it("tolerates corner antialiasing when the sides still meet coherently", () => {
    const image = makeCanvas();
    setPixel(image, 7, 9, [38, 39, 38]);
    setPixel(image, 112, 9, [38, 39, 38]);
    setPixel(image, 112, 79, [38, 39, 38]);
    setPixel(image, 7, 79, [38, 39, 38]);

    const result = expectSuccess(detectChartFrameFromPixels(image));

    expect(result.corners.coherentCornerCount).toBe(4);
  });

  it("canonicalises an adjacent interior top row as the same physical frame", () => {
    const image = makeCanvas();
    for (let x = 7; x <= 112; x += 1) setPixel(image, x, 10, [45, 45, 45]);

    const result = expectSuccess(detectChartFrameFromPixels(image));

    expect([result.left, result.top, result.right, result.bottom]).toEqual([7, 9, 112, 79]);
    expect(result.candidateCount).toBe(1);
  });

  it("selects the same outer representative when the inner bottom hypothesis is discovered first", () => {
    const image = makeCanvas();
    for (let x = 7; x <= 112; x += 1) setPixel(image, x, 78, [45, 45, 45]);

    const first = expectSuccess(detectChartFrameFromPixels(image));
    const second = expectSuccess(detectChartFrameFromPixels(image));

    expect(first).toEqual(second);
    expect([first.left, first.top, first.right, first.bottom]).toEqual([7, 9, 112, 79]);
    expect(first.candidateCount).toBe(1);
  });

  it("reports incomplete sides when one side is missing", () => {
    const image = makeCanvas();
    for (let y = 9; y <= 79; y += 1) setPixel(image, 112, y, [31, 31, 31]);

    expectFailure(detectChartFrameFromPixels(image), "incomplete_sides");
  });

  it("reports incomplete sides when one side is materially broken", () => {
    const image = makeCanvas();
    for (let y = 30; y <= 58; y += 1) setPixel(image, 112, y, [31, 31, 31]);

    expectFailure(detectChartFrameFromPixels(image), "incomplete_sides");
  });

  it("reports incoherent corners when long sides do not meet", () => {
    const image = makeCanvas();
    for (let x = 7; x <= 112; x += 1) {
      setPixel(image, x, 9, [31, 31, 31]);
      setPixel(image, x, 79, [31, 31, 31]);
    }
    for (let x = 10; x <= 109; x += 1) {
      setPixel(image, x, 9, [45, 45, 45]);
      setPixel(image, x, 79, [45, 45, 45]);
    }

    expectFailure(detectChartFrameFromPixels(image), "incoherent_corners");
  });

  it("reports multiple comparable rectangles", () => {
    const image = makeCanvas({ width: 180, height: 120, left: 5, top: 7, right: 83, bottom: 112 });
    for (let y = 7; y <= 112; y += 1) {
      setPixel(image, 96, y, [45, 45, 45]);
      setPixel(image, 174, y, [45, 45, 45]);
    }
    for (let x = 96; x <= 174; x += 1) {
      setPixel(image, x, 7, [45, 45, 45]);
      setPixel(image, x, 112, [45, 45, 45]);
    }

    expectFailure(detectChartFrameFromPixels(image), "multiple_comparable_candidates");
  });

  it("selects one dominant outer frame over a smaller internal rectangle", () => {
    const image = makeCanvas({ width: 180, height: 130, left: 5, top: 7, right: 174, bottom: 120 });
    for (let x = 50; x <= 130; x += 1) {
      setPixel(image, x, 45, [45, 45, 45]);
      setPixel(image, x, 90, [45, 45, 45]);
    }
    for (let y = 45; y <= 90; y += 1) {
      setPixel(image, 50, y, [45, 45, 45]);
      setPixel(image, 130, y, [45, 45, 45]);
    }

    const result = expectSuccess(detectChartFrameFromPixels(image));

    expect([result.left, result.top, result.right, result.bottom]).toEqual([5, 7, 174, 120]);
  });

  it("rejects a candidate touching image boundaries", () => {
    const image = makeCanvas({ left: 0, top: 0, right: 119, bottom: 89 });

    expectFailure(detectChartFrameFromPixels(image), "touching_image_boundary");
  });

  it("rejects an already-cropped-style frame coincident with the source edge", () => {
    const image = makeCanvas({ width: 90, height: 70, left: 0, top: 0, right: 89, bottom: 69 });

    expectFailure(detectChartFrameFromPixels(image), "touching_image_boundary");
  });

  it("rejects a source-boundary frame even when an internal rectangle also qualifies", () => {
    const image = makeCanvas({ width: 140, height: 100, left: 0, top: 0, right: 139, bottom: 99 });
    for (let x = 20; x <= 119; x += 1) {
      setPixel(image, x, 20, [60, 60, 60]);
      setPixel(image, x, 79, [60, 60, 60]);
    }
    for (let y = 20; y <= 79; y += 1) {
      setPixel(image, 20, y, [60, 60, 60]);
      setPixel(image, 119, y, [60, 60, 60]);
    }

    expectFailure(detectChartFrameFromPixels(image), "touching_image_boundary");
  });

  it("reports no candidate for an image with no frame", () => {
    const image = makeCanvas();
    image.data.fill(31);
    for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255;

    expectFailure(detectChartFrameFromPixels(image), "no_frame_candidate");
  });

  it("does not treat fully transparent stored RGB values as frame evidence", () => {
    const image = makeCanvas();
    for (let x = 7; x <= 112; x += 1) {
      setAlpha(image, x, 9, 0);
      setAlpha(image, x, 79, 0);
    }
    for (let y = 9; y <= 79; y += 1) {
      setAlpha(image, 7, y, 0);
      setAlpha(image, 112, y, 0);
    }

    expectFailure(detectChartFrameFromPixels(image), "no_frame_candidate");
  });

  it("fails closed when deterministic candidate enumeration exceeds its budget", () => {
    const width = 50;
    const height = 50;
    const channelCount = 4;
    const data = new Uint8Array(width * height * channelCount);
    const image: DecodedPixelImage = { format: "png", width, height, channelCount, data };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        setPixel(image, x, y, [45, 45, 45]);
        setAlpha(image, x, y, 255);
      }
    }

    const patch = 2;
    for (const [originX, originY] of [
      [0, 0],
      [width - patch, 0],
      [0, height - patch],
      [width - patch, height - patch],
    ] as const) {
      for (let y = originY; y < originY + patch; y += 1) {
        for (let x = originX; x < originX + patch; x += 1) {
          setPixel(image, x, y, [31, 31, 31]);
        }
      }
    }

    const first = expectFailure(
      detectChartFrameFromPixels(image),
      "candidate_search_budget_exceeded",
    );
    const second = expectFailure(
      detectChartFrameFromPixels(image),
      "candidate_search_budget_exceeded",
    );
    expect(first).toEqual(second);
  });

  it("returns a deterministic typed failure for a valid long-perimeter image", () => {
    // The 126,028-pixel source perimeter exceeds common spread-argument limits.
    const width = 16;
    const height = 63_000;
    const channelCount = 4;
    const data = new Uint8Array(width * height * channelCount);
    data.fill(31);
    for (let offset = 3; offset < data.length; offset += channelCount) data[offset] = 255;
    const image: DecodedPixelImage = { format: "png", width, height, channelCount, data };

    for (let x = 0; x < width; x += 1) {
      setPixel(image, x, 0, [45, 45, 45]);
      setPixel(image, x, height - 1, [45, 45, 45]);
    }
    for (let y = 0; y < height; y += 1) {
      setPixel(image, 0, y, [45, 45, 45]);
      setPixel(image, width - 1, y, [45, 45, 45]);
    }

    const before = Buffer.from(image.data);
    const first = expectFailure(detectChartFrameFromPixels(image), "touching_image_boundary");
    const second = expectFailure(detectChartFrameFromPixels(image), "touching_image_boundary");

    expect(first).toEqual(second);
    expect(first).toMatchObject({ sourceWidth: width, sourceHeight: height });
    const after = Buffer.from(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    );
    expect(after.equals(before)).toBe(true);
  });

  it("returns deterministic repeated results", () => {
    const image = makeCanvas();

    expect(detectChartFrameFromPixels(image)).toEqual(detectChartFrameFromPixels(image));
  });

  it("does not mutate input pixels", () => {
    const image = makeCanvas();
    const before = Buffer.from(image.data);

    detectChartFrameFromPixels(image);

    expect(Buffer.from(image.data)).toEqual(before);
  });

  it("rejects invalid decoded geometry", () => {
    const image = makeCanvas();
    const invalid = { ...image, data: image.data.subarray(1) };

    expectFailure(detectChartFrameFromPixels(invalid), "invalid_geometry");
  });

  it("freezes the observation and nested evidence", () => {
    const result = expectSuccess(detectChartFrameFromPixels(makeCanvas()));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sideContinuity)).toBe(true);
    expect(Object.isFrozen(result.sideContinuity.top)).toBe(true);
    expect(Object.isFrozen(result.corners)).toBe(true);
    expect(Object.isFrozen(result.border)).toBe(true);
    expect(Object.isFrozen(result.border.representative)).toBe(true);
    expect(Object.isFrozen(result.exterior)).toBe(true);
  });
});
