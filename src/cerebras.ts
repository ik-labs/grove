/**
 * Cerebras client with retry/backoff + concurrency cap.
 * Key is env-only, sent solely as Bearer header to api.cerebras.ai.
 */
import { deflateSync } from "node:zlib";

const API_BASE = "https://api.cerebras.ai/v1";
const apiKey = process.env.CEREBRAS_API_KEY ?? "";
const model = process.env.GROVE_GEMMA_MODEL ?? "gemma-4-31b";
const MAX_CONCURRENT = Number(process.env.GROVE_MAX_CONCURRENT ?? 3);
const MAX_RETRIES = 5;

if (!apiKey) { console.error("FAIL: CEREBRAS_API_KEY not set."); process.exit(1); }

type Content = Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
type Msg = { role: "system" | "user" | "assistant"; content: string | Content };

export type CallResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  retries: number;
  error?: string;
};

// Simple semaphore for concurrency limiting
class Sem {
  private running = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>(r => this.queue.push(r));
    this.running++;
    try { return await fn(); }
    finally { this.running--; this.queue.shift()?.(); }
  }
}
const sem = new Sem(MAX_CONCURRENT);

// Metrics
export const metrics = { totalCalls: 0, totalTokens: 0, total429: 0, totalRetries: 0, startTime: 0 };
export function tokensPerSec(): number {
  const elapsed = (performance.now() - metrics.startTime) / 1000;
  return elapsed > 0 ? metrics.totalTokens / elapsed : 0;
}

async function rawChat(messages: Msg[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<CallResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.8, max_tokens: opts.maxTokens ?? 120 }),
    });
    const latencyMs = performance.now() - t0;
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, latencyMs, text: body, retries: 0, error: `HTTP ${res.status}` };
    let content = "";
    let usage: CallResult["usage"];
    try { const j = JSON.parse(body); usage = j.usage; content = j.choices?.[0]?.message?.content ?? ""; }
    catch { return { ok: false, status: res.status, latencyMs, text: body, retries: 0, error: "non-JSON body" }; }
    return { ok: true, status: res.status, latencyMs, text: content, usage, retries: 0 };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: performance.now() - t0, text: "", retries: 0, error: String(e) };
  }
}

export async function chat(messages: Msg[], opts?: { maxTokens?: number; temperature?: number }): Promise<CallResult> {
  return sem.run(async () => {
    let result: CallResult;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      result = await rawChat(messages, opts);
      metrics.totalCalls++;
      if (result.usage) metrics.totalTokens += (result.usage.completion_tokens ?? 0) + (result.usage.prompt_tokens ?? 0);
      if (result.ok || result.status !== 429) {
        if (attempt > 0) { result.retries = attempt; metrics.totalRetries += attempt; }
        return result;
      }
      // 429 — backoff and retry
      metrics.total429++;
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(2000 * 2 ** attempt, 30000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    result!.retries = MAX_RETRIES;
    metrics.totalRetries += MAX_RETRIES;
    return result!;
  });
}

// ---------- minimal PNG encoder (from spike) ----------
const CRC: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
export function encodePNG(pixels: Buffer, w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
