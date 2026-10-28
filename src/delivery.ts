/** Lossless Unicode text parts; labels are included in the configured part limit. */
export function splitReply(text: string, limit: number): string[] {
  const points = Array.from(text || 'DSH 已完成任务，但没有返回文字。');
  if (points.length <= limit) return [points.join('')];
  let total = Math.ceil(points.length / limit);
  let capacity: number;
  while (true) {
    capacity = limit - `[${total}/${total}]\n`.length;
    if (capacity < 1) throw new RangeError('Reply part limit is too small for part labels.');
    const actual = Math.ceil(points.length / capacity);
    if (actual === total) break;
    total = actual;
  }
  return Array.from({ length: total }, (_, index) => `[${index + 1}/${total}]\n${points.slice(index * capacity, (index + 1) * capacity).join('')}`);
}
