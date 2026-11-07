// Tiny TTL cache with stale-serve — the reliability backbone of the API layer.
// On success we refresh the entry; on failure we keep serving the last good
// value for up to `staleTtl` so a flaky upstream never blanks the page.

export type Entry<T> = { at: number; value: T };

export class TtlCache<T> {
  private entry: Entry<T> | null = null;
  private inflight: Promise<T> | null = null;

  constructor(
    private readonly ttl: number,
    private readonly staleTtl: number,
    private readonly loader: () => Promise<T>,
  ) {}

  private fresh(): Entry<T> | null {
    if (this.entry && Date.now() - this.entry.at < this.ttl) return this.entry;
    return null;
  }

  private stale(): Entry<T> | null {
    if (this.entry && Date.now() - this.entry.at < this.staleTtl) return this.entry;
    return null;
  }

  async get(): Promise<{ value: T; stale: boolean }> {
    const fresh = this.fresh();
    if (fresh) return { value: fresh.value, stale: false };

    if (!this.inflight) {
      this.inflight = this.loader()
        .then((value) => {
          this.entry = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }

    try {
      const value = await this.inflight;
      return { value, stale: false };
    } catch (error) {
      const stale = this.stale();
      if (stale) return { value: stale.value, stale: true };
      throw error;
    }
  }
}

export class FeedError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "FeedError";
  }
}

export function friendlyError(error: unknown, fallback: string): Error {
  if (error instanceof FeedError && error.status === 429) {
    return new Error("The price feed is busy. Give it a few seconds and try again.");
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error("The price feed took too long to answer.");
  }
  return new Error(fallback);
}

// JSON fetch with timeout + retry of transient failures (timeout / 429 / 5xx).
export async function fetchJson(url: string, timeoutMs = 15_000, retries = 1): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!response.ok) throw new FeedError(response.status, `Feed responded ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable =
        (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) ||
        (error instanceof FeedError && (error.status === 429 || error.status >= 500));
      if (!retryable || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
