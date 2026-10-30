export function validateRenderReceipt(
  receipt: unknown,
  diagrams: { id: string; digest: string }[],
  version: string,
): string[];
export function renderInputKey(diagrams: { id: string; digest: string }[], version: string): string;
