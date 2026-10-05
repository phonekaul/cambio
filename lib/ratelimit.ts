// Best-effort, in-memory abuse guard. On serverless this resets per instance, which is fine
// for a take-home link: it stops a runaway loop or a casual scraper, not a determined attacker.
const perIp = new Map<string, number[]>();
let dayKey = "";
let dayCount = 0;

const PER_HOUR = Number(process.env.AI_RATE_PER_HOUR ?? 400);
const DAILY_CAP = Number(process.env.AI_DAILY_CAP ?? 5000);

export function checkRate(ip: string): string | null {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  if (dayCount >= DAILY_CAP) return "The opponent has hit today's budget. Try again tomorrow.";

  const recent = (perIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_HOUR) return "Slow down a little: too many requests from your address this hour.";
  recent.push(now);
  perIp.set(ip, recent);
  dayCount++;
  return null;
}
