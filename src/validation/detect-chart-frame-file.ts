import { basename } from "node:path";

import { readDecodedImagePixels } from "./inspect-image.ts";
import {
  CHART_FRAME_DETECTOR_IDENTIFIER,
  CHART_FRAME_DETECTOR_VERSION,
  detectChartFrameFromPixels,
  type ChartFrameDetectionResult,
} from "./detect-chart-frame.ts";

export interface ChartFrameFileResult {
  readonly inputPath: string;
  readonly originalBasename: string;
  readonly detection: ChartFrameDetectionResult;
}

/** Decode and inspect one explicit file without creating output or product state. */
export async function detectChartFrameFile(inputPath: string): Promise<ChartFrameFileResult> {
  try {
    const decoded = await readDecodedImagePixels(inputPath);
    const detection =
      decoded.format === "png"
        ? detectChartFrameFromPixels({
            format: decoded.format,
            width: decoded.width,
            height: decoded.height,
            channelCount: decoded.channelCount,
            data: decoded.data,
          })
        : Object.freeze({
            ok: false as const,
            reason: "unsupported_frame_style" as const,
            detail: `sampled frame detector currently supports decoded PNG input, received ${decoded.format ?? "unknown"}`,
            sourceWidth: decoded.width,
            sourceHeight: decoded.height,
            candidateCount: 0,
            detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
            detectorVersion: CHART_FRAME_DETECTOR_VERSION,
          });
    return Object.freeze({ inputPath, originalBasename: basename(inputPath), detection });
  } catch (error) {
    return Object.freeze({
      inputPath,
      originalBasename: basename(inputPath),
      detection: Object.freeze({
        ok: false as const,
        reason: "unreadable_input" as const,
        detail: error instanceof Error ? error.message : String(error),
        sourceWidth: null,
        sourceHeight: null,
        candidateCount: 0,
        detectorIdentifier: CHART_FRAME_DETECTOR_IDENTIFIER,
        detectorVersion: CHART_FRAME_DETECTOR_VERSION,
      }),
    });
  }
}
