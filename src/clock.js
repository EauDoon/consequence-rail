export class ManualClock {
  constructor(iso = "2035-01-01T00:00:00.000Z") {
    this.current = new Date(iso);
  }

  now() {
    return this.current.toISOString();
  }

  advance(milliseconds) {
    this.current = new Date(this.current.getTime() + milliseconds);
    return this.now();
  }
}

export function addMilliseconds(iso, milliseconds) {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString();
}

export function isExpired(iso, now) {
  return new Date(iso).getTime() <= new Date(now).getTime();
}
