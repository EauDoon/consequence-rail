export const DEMO_CLOCK_EPOCH = "2035-01-01T00:00:00.000Z";
export const SIDECAR_CLOCKS = ["system", "demo"];

export class ManualClock {
  constructor(iso = DEMO_CLOCK_EPOCH) {
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

export class SystemClock {
  now() {
    return new Date().toISOString();
  }
}

export function createSidecarClock(name = "system") {
  return name === "demo" ? new ManualClock() : new SystemClock();
}

export function addMilliseconds(iso, milliseconds) {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString();
}

export function isExpired(iso, now) {
  return new Date(iso).getTime() <= new Date(now).getTime();
}
