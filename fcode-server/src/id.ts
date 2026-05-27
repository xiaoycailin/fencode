export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

