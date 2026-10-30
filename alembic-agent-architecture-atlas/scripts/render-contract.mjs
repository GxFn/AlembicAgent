export function validateRenderReceipt(receipt, expected, version) {
  const errors = [];
  if (
    !receipt ||
    receipt.renderer !== 'mermaid' ||
    receipt.rendererVersion !== version ||
    !Array.isArray(receipt.results) ||
    receipt.results.some((r) => !r || typeof r !== 'object') ||
    !Number.isFinite(Date.parse(receipt.checkedAt))
  ) {
    return ['invalid render receipt or version'];
  }
  if (!expected.length) {
    errors.push('empty render coverage');
  }
  for (const diagram of expected) {
    const matches = receipt.results.filter((r) => r.id === diagram.id);
    if (
      matches.length !== 1 ||
      matches[0].digest !== diagram.digest ||
      matches[0].status !== 'pass' ||
      !Number.isFinite(matches[0].width) ||
      !Number.isFinite(matches[0].height) ||
      matches[0].width <= 0 ||
      matches[0].height <= 0
    ) {
      errors.push(`re-render required: ${diagram.id}`);
    }
  }
  if (receipt.results.length !== expected.length) {
    errors.push('render coverage differs');
  }
  return errors;
}

export function renderInputKey(diagrams, version) {
  return JSON.stringify({
    rendererVersion: version,
    diagrams: diagrams
      .map(({ id, digest }) => ({ id, digest }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en')),
  });
}
