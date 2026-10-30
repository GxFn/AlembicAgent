import type { RenderAttempt } from '../src/model.js';
export function renderInputFingerprint(
  diagrams: { id: string; digest: string }[],
  version: string,
): string;
export function beginRenderAttempt(
  fingerprint: string,
  previous?: RenderAttempt | null,
  expectedId?: string | null,
): RenderAttempt;
export function finishRenderAttempt(
  previous: RenderAttempt | null,
  id: string,
  receipt: unknown,
  diagrams: { id: string; digest: string }[],
  version: string,
): RenderAttempt;
export function cancelRenderAttempt(previous: RenderAttempt | null, id: string): RenderAttempt;
export function latestRenderErrors(
  attempt: RenderAttempt | null,
  diagrams: { id: string; digest: string }[],
  version: string,
): string[];

export function renderEvidenceErrors(
  attempt: RenderAttempt | null,
  receipt: unknown,
  diagrams: { id: string; digest: string }[],
  version: string,
): string[];
