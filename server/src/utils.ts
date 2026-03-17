export function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function clampBuffer<T>(items: T[], max: number): T[] {
  if (items.length <= max) {
    return items;
  }

  return items.slice(items.length - max);
}
