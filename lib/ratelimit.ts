/**
 * Minimal in-memory sliding-window rate limiter for the expensive Server
 * Actions (each track/re-check burns an outbound page fetch plus Gemini
 * quota; each chat turn burns a grounded Gemini call).
 *
 * Scope honestly stated: state lives in the Node process, so on serverless
 * each warm instance enforces independently and a cold start forgets. That
 * still shuts down the casual abuse this app realistically faces (someone
 * scripting the public form); a durable limiter (Upstash/Redis) is the
 * upgrade path if it ever matters.
 */

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 5_000; // hard memory cap

const hits = new Map<string, number[]>();

/** True = allowed (and the hit is recorded); false = over the limit. */
export function rateLimit(key: string, limitPerMinute: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= limitPerMinute) {
    hits.set(key, recent);
    return false;
  }

  recent.push(now);
  hits.set(key, recent);

  // Cheap sweep: when the map grows past the cap, drop entries whose whole
  // window has expired; if everything is somehow live, drop oldest keys.
  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
    for (const k of hits.keys()) {
      if (hits.size <= MAX_TRACKED_KEYS / 2) break;
      hits.delete(k);
    }
  }

  return true;
}
