export function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 0x2e80 ? 0.5 : 0.25;
  }
  return Math.ceil(tokens);
}

export function estimateTokensFast(text: string) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 3.5);
}
