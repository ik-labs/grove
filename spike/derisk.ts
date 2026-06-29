/**
 * Grove — de-risk spike (spec §8.1).
 * Resolves issues #1 (vision gate), #6 (JSON fallback rate), #7 (parallel soak), #9 (no render-target plumbing).
 * Run: bun run spike/derisk.ts   (or: bun run derisk)
 *
 * Reads CEREBRAS_API_KEY + GROVE_GEMMA_MODEL from env. Key is only ever sent
 * as a Bearer header to api.cerebras.ai — never logged, never written to disk.
 */
import { deflateSync } from "node:zlib";

const API_BASE = "https://api.cerebras.ai/v1";
const apiKey = process.env.CEREBRAS_API_KEY ?? "";
let model = process.env.GROVE_GEMMA_MODEL ?? "";
const SOAK_SECONDS = Number(process.env.GROVE_SOAK_SECONDS ?? 60);
const SOAK_CONCURRENCY = Number(process.env.GROVE_SOAK_CONCURRENCY ?? 25);
const FALLBACK_TRIALS = Number(process.env.GROVE_FALLBACK_TRIALS ?? 20);

type Msg =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> };

type CallResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
};

async function chat(messages: Msg[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<CallResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens ?? 256 }),
    });
    const latencyMs = performance.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, latencyMs, text, error: `HTTP ${res.status}` };
    let usage: CallResult["usage"];
    let content = "";
    try {
      const j = JSON.parse(text);
      usage = j.usage;
      content = j.choices?.[0]?.message?.content ?? "";
    } catch {
      return { ok: false, status: res.status, latencyMs, text, error: "non-JSON body" };
    }
    return { ok: true, status: res.status, latencyMs, text: content, usage };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: performance.now() - t0, text: "", error: String(e) };
  }
}

// ---------- minimal PNG encoder (no deps) ----------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(pixels: Uint8Array, width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

type RGB = [number, number, number];
// 7x7 iconic perception grid. cell (r,c). self at center (3,3).
// food=green, water=blue, creatures=colored, self=white outline on grass.
function buildIconicImage(): { pngB64: string; legend: string; grid: string[][] } {
  const N = 7, cell = 28;
  const grass: RGB = [40, 80, 40];
  const food: RGB = [80, 220, 80];
  const water: RGB = [60, 120, 200];
  const creatures: Record<string, RGB> = {
    lumen: [220, 120, 60],
    pip: [120, 120, 220],
  };
  const grid: { type: string; color: RGB }[][] = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => ({ type: "grass", color: grass })),
  );
  const place = (r: number, c: number, type: string, color: RGB) => (grid[r][c] = { type, color });
  place(2, 1, "water", water);
  place(2, 2, "water", water);
  place(5, 5, "food", food); // SE of self
  place(1, 4, "lumen", creatures.lumen);
  place(5, 1, "pip", creatures.pip);
  grid[3][3] = { type: "self", color: grass };

  const W = N * cell, H = N * cell;
  const px = Buffer.alloc(W * H * 3);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const [R, G, B] = grid[r][c].color;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          let rr = R, gg = G, bb = B;
          if (grid[r][c].type === "self") {
            const edge = dx < 3 || dy < 3 || dx >= cell - 3 || dy >= cell - 3;
            if (edge) { rr = 255; gg = 255; bb = 255; }
          }
          const x = c * cell + dx, y = r * cell + dy;
          const o = (y * W + x) * 3;
          px[o] = rr; px[o + 1] = gg; px[o + 2] = bb;
        }
      }
    }
  }
  const pngB64 = encodePNG(px, W, H).toString("base64");
  const legend = "green=square food, blue=water, orange/purple=other creatures, white outline=self (you), dark green=grass.";
  const ascii = grid.map((row) => row.map((c) => ({ food: "F", water: "~", self: "@", lumen: "L", pip: "P", grass: "." })[c.type] ?? ".").join("")).join("\n");
  return { pngB64, legend, grid: ascii.split("\n").map((l) => l.split("")) };
}

// ---------- phases ----------
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function stripFences(s: string): string {
  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}
function parseDecision(s: string): { valid: boolean; action?: string; thought?: string } {
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return { valid: false };
  try {
    const j = JSON.parse(s.slice(start, end + 1));
    const action = String(j.action ?? "").toLowerCase();
    const valid = ["move_to", "eat", "rest", "approach", "avoid", "wander"].includes(action);
    return { valid, action: valid ? action : undefined, thought: j.thought };
  } catch {
    return { valid: false };
  }
}

const DECIDE_SYSTEM = `You are a creature in a small world. You have needs: hunger, energy, the wish for company. You want to survive and live according to your nature. You can move toward things, eat, rest, approach or avoid other creatures.
Respond ONLY as JSON, no prose, no markdown:
{"action":"move_to"|"eat"|"rest"|"approach"|"avoid"|"wander","target":"<id or direction>","thought":"<under 12 words>","feeling_about":{"<id>":<-1..1>}}

Examples:
perception: you are very hungry. food (berries, id f3) is 2 tiles east. nobody nearby.
{"action":"move_to","target":"f3","thought":"berries, finally."}

perception: Lumen is next to you. you feel lonely. she shared food with you last tick.
{"action":"approach","target":"lumen","thought":"stay near Lumen, she is kind.","feeling_about":{"lumen":0.4}}

perception: nothing notable nearby. you are tired.
{"action":"rest","target":"here","thought":"a moment to breathe."}`;

// Hard-targeted Gemma probe. The hackathon Q&A is explicit:
//   "Model ID: gemma-4-31b" and "uses the standard Cerebras Inference API and
//   your existing Cerebras API key. There is no separate preview endpoint."
// Gemma 4 may NOT appear in /v1/models even when callable (private preview is
// often gated at the call layer, not the catalog). So the real test is a direct
// chat call to gemma-4-31b, not the models list.
async function phaseProbeGemma(): Promise<"ok" | "model-missing" | "auth-fail" | "network"> {
  console.log("\n[0/4] Gemma 4 probe (gemma-4-31b)");
  if (!model) model = "gemma-4-31b";
  // 0a. list visible models for diagnostics
  try {
    const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 401 || res.status === 403) {
      console.log(`  AUTH FAIL: /v1/models -> HTTP ${res.status}. Key may be invalid or revoked.`);
      return "auth-fail";
    }
    if (res.ok) {
      const j = await res.json() as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map((m) => m.id);
      console.log(`  /v1/models visible: ${ids.join(", ") || "(none)"}`);
      const listed = ids.includes("gemma-4-31b");
      console.log(`  gemma-4-31b in catalog: ${listed ? "YES" : "NO (private preview often not listed — direct call is the real test)"}`);
    } else {
      console.log(`  /v1/models -> HTTP ${res.status} (continuing to direct call)`);
    }
  } catch (e) {
    console.log(`  /v1/models network error: ${e}`);
  }
  // 0b. direct chat call — the authoritative test
  const r = await chat(
    [
      { role: "system", content: "Respond with the single word: ok" },
      { role: "user", content: "ping" },
    ],
    { maxTokens: 16, temperature: 0 },
  );
  if (r.ok) {
    console.log(`  PASS: gemma-4-31b callable. latency=${r.latencyMs.toFixed(0)}ms reply="${r.text.trim().slice(0, 40)}"`);
    return "ok";
  }
  if (r.status === 401 || r.status === 403) {
    console.log(`  AUTH FAIL: direct call -> HTTP ${r.status}. Key invalid or lacks preview grant.`);
    console.log(`  body: ${r.text.slice(0, 300)}`);
    return "auth-fail";
  }
  if (r.status === 404) {
    console.log(`  MODEL MISSING: direct call -> HTTP 404. gemma-4-31b is not provisioned on this account.`);
    console.log(`  body: ${r.text.slice(0, 300)}`);
    console.log(`  --> ACTION: post in #gemma-4-hackathon on Discord:`);
    console.log(`      "Submitted the capacity form before the deadline, but /v1/models shows only`);
    console.log(`       [${(["zai-glm-4.7","gpt-oss-120b"]).join(", ")}] and direct calls to gemma-4-31b 404.`);
    console.log(`       Can my Org ID provisioning be confirmed or restored for submission?"`);
    console.log(`  --> Also double-check: the Org ID you submitted matches the account this key belongs to.`);
    return "model-missing";
  }
  if (r.status === 429) {
    console.log(`  RATE LIMITED: direct call -> HTTP 429. Account works but you're throttled. Wait and retry.`);
    console.log(`  body: ${r.text.slice(0, 300)}`);
    return "ok"; // 429 means the model IS reachable; treat as provisioned
  }
  if (r.status === 0) {
    console.log(`  NETWORK ERROR: ${r.error}`);
    return "network";
  }
  console.log(`  UNEXPECTED: HTTP ${r.status} ${r.error}`);
  console.log(`  body: ${r.text.slice(0, 300)}`);
  return "model-missing";
}

async function phase1ChatJson(): Promise<boolean> {
  console.log("\n[1/4] chat + JSON sanity");
  const r = await chat(
    [
      { role: "system", content: "Respond ONLY as compact JSON, no prose." },
      { role: "user", content: 'Return {"ok":true,"n":7}' },
    ],
    { maxTokens: 64, temperature: 0 },
  );
  if (!r.ok) { console.log(`  FAIL: ${r.error} status=${r.status} body=${r.text.slice(0, 200)}`); return false; }
  try {
    const j = JSON.parse(stripFences(r.text));
    const pass = j.ok === true && typeof j.n === "number";
    console.log(`  ${pass ? "PASS" : "FAIL"}: parsed=${pass} latency=${r.latencyMs.toFixed(0)}ms raw=${r.text.slice(0, 80)}`);
    return pass;
  } catch {
    console.log(`  FAIL: non-JSON response. latency=${r.latencyMs.toFixed(0)}ms raw=${r.text.slice(0, 120)}`);
    return false;
  }
}

async function phase2Vision(): Promise<boolean> {
  console.log("\n[2/4] vision gate (iconic image)");
  const { pngB64, legend, grid } = buildIconicImage();
  console.log("  grid:\n" + grid.map((r) => "    " + r.join(" ")).join("\n"));
  console.log(`  legend: ${legend}`);
  const r = await chat(
    [
      { role: "user", content: [
        { type: "text", text: `You are the creature marked with a white outline at the center of this grid. ${legend} Look at the image. In which compass direction (N/NE/E/SE/S/SW/W/NW) is the nearest food (green square) relative to you? Answer with just the direction, then a one-line reason.` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngB64}` } },
      ] } as Msg,
    ],
    { maxTokens: 80, temperature: 0 },
  );
  if (!r.ok) {
    const unsupported = r.status === 400 && /image|vision|multimodal/i.test(r.text);
    console.log(`  ${unsupported ? "VISION NOT SUPPORTED" : "FAIL"}: status=${r.status} error=${r.error} body=${r.text.slice(0, 200)}`);
    console.log(unsupported ? "  -> fallback to text minimap (spec §4a). Multimodal leg via vision-in is out; reframe as vision-out if needed." : "");
    return false;
  }
  const ans = r.text.trim();
  const hasSE = /\bSE\b|south.?east/i.test(ans);
  console.log(`  ${hasSE ? "PASS" : "REVIEW"}: latency=${r.latencyMs.toFixed(0)}ms`);
  console.log(`  answer: ${ans.slice(0, 160)}`);
  if (!hasSE) console.log("  -> model returned an answer but not 'SE' (food is at SE). Check the raw answer — vision may be working but spatially weak. Run the A/B in §10 before relying on it.");
  return hasSE;
}

async function phase3Soak(): Promise<boolean> {
  console.log(`\n[3/4] parallel soak (${SOAK_SECONDS}s @ ${SOAK_CONCURRENCY}-way concurrency, NO retries)`);
  const deadline = performance.now() + SOAK_SECONDS * 1000;
  const latencies: number[] = [];
  let calls = 0, ok = 0, r429 = 0, errs = 0, tokens = 0;
  const batchMsg: Msg[] = [
    { role: "system", content: "Respond ONLY as JSON." },
    { role: "user", content: 'Return {"alive":true}' },
  ];
  while (performance.now() < deadline) {
    const batch = Array.from({ length: SOAK_CONCURRENCY }, () => chat(batchMsg, { maxTokens: 32, temperature: 0 }));
    const results = await Promise.all(batch);
    for (const r of results) {
      calls++;
      if (r.ok) { ok++; latencies.push(r.latencyMs); tokens += r.usage?.completion_tokens ?? 0; }
      else if (r.status === 429) r429++;
      else errs++;
    }
    const elapsed = ((performance.now() - (deadline - SOAK_SECONDS * 1000)) / 1000).toFixed(0);
    process.stdout.write(`\r  t=${elapsed}s calls=${calls} ok=${ok} 429=${r429} err=${errs}   `);
  }
  console.log("");
  const p50 = pct(latencies, 50), p99 = pct(latencies, 99);
  const dur = SOAK_SECONDS;
  const tps = tokens / dur;
  const successRate = calls ? (ok / calls) * 100 : 0;
  const rate429 = calls ? (r429 / calls) * 100 : 0;
  console.log(`  calls=${calls} ok=${ok} (${successRate.toFixed(1)}%) 429=${r429} (${rate429.toFixed(1)}%) other_errs=${errs}`);
  console.log(`  latency p50=${p50.toFixed(0)}ms p99=${p99.toFixed(0)}ms | ~${tps.toFixed(0)} completion tok/s`);
  const safe = rate429 < 5 && successRate > 90;
  const verdict = safe
    ? `SAFE at concurrency ${SOAK_CONCURRENCY}`
    : `THROTTLED — drop p-limit to ~15, add backoff (spec §5)`;
  console.log(`  verdict: ${verdict}`);
  return safe;
}

async function phase4Fallback(): Promise<boolean> {
  console.log(`\n[4/4] JSON fallback rate (few-shot decide prompt, ${FALLBACK_TRIALS} trials)`);
  const perceptions = [
    "you are very hungry. food (berries, id f3) is 2 tiles east. nobody nearby.",
    "Lumen is next to you. you feel lonely. she shared food with you last tick.",
    "nothing notable nearby. you are tired.",
    "Pip is near the only food. you are both hungry. the bush is nearly empty.",
    "you are alone on a rock. wind. a faint green dot to the north — maybe food.",
  ];
  let valid = 0, fallback = 0;
  const thoughts: string[] = [];
  for (let i = 0; i < FALLBACK_TRIALS; i++) {
    const p = perceptions[i % perceptions.length];
    const r = await chat(
      [
        { role: "system", content: DECIDE_SYSTEM },
        { role: "user", content: `perception: ${p}\nRespond ONLY as JSON.` },
      ],
      { maxTokens: 80, temperature: 0.8 },
    );
    if (!r.ok) { fallback++; console.log(`  trial ${i + 1}: HTTP ${r.status} ${r.error}`); continue; }
    const d = parseDecision(r.text);
    if (d.valid) { valid++; if (d.thought) thoughts.push(d.thought); }
    else { fallback++; console.log(`  trial ${i + 1}: parse fail. raw=${r.text.slice(0, 100)}`); }
  }
  const rate = (fallback / FALLBACK_TRIALS) * 100;
  const pass = rate < 15;
  console.log(`  valid=${valid} fallback=${fallback} -> fallback rate=${rate.toFixed(1)}%`);
  console.log(`  ${pass ? "PASS" : "FAIL"} (threshold 15%)`);
  if (thoughts.length) console.log(`  sample thoughts: ${thoughts.slice(0, 4).map((t) => `"${t}"`).join("  ")}`);
  if (!pass) console.log("  -> tighten prompt / shrink action set / two-step (spec §10). Few-shot is already in; consider constrained decode if Cerebras exposes it.");
  return pass;
}

// ---------- main ----------
async function main() {
  if (process.argv[2] === "--png") {
    const { pngB64, grid } = buildIconicImage();
    const out = `${import.meta.dir}/iconic.png`;
    await Bun.write(out, Buffer.from(pngB64, "base64"));
    console.log(`wrote ${out} (${(pngB64.length * 0.75 / 1024).toFixed(1)} KB)`);
    console.log("grid:\n" + grid.map((r) => "  " + r.join(" ")).join("\n"));
    return;
  }
  if (!apiKey) {
    console.error("FAIL: CEREBRAS_API_KEY not set. Copy .env.example -> .env and fill it.");
    process.exit(1);
  }
  console.log("=== Grove de-risk spike ===");
  console.log(`soak: ${SOAK_SECONDS}s @ ${SOAK_CONCURRENCY}-way | fallback trials: ${FALLBACK_TRIALS}`);
  const probe = await phaseProbeGemma();
  if (probe === "auth-fail") {
    console.log("\nRED: auth failed — key is invalid or lacks the Gemma 4 preview grant. Get a valid key before continuing.");
    process.exit(1);
  }
  if (probe === "model-missing") {
    console.log("\nRED: gemma-4-31b is not reachable on this account. See the ACTION text above and message #gemma-4-hackathon.");
    console.log("    (Hackathon rules require Gemma 4 — do NOT proceed with a substitute model for the submission.)");
    process.exit(1);
  }
  if (probe === "network") {
    console.log("\nRED: network error reaching Cerebras. Check connectivity / VPN and retry.");
    process.exit(1);
  }
  console.log(`model: ${model}`);
  const r1 = await phase1ChatJson();
  const r2 = await phase2Vision();
  const r3 = await phase3Soak();
  const r4 = await phase4Fallback();
  console.log("\n=== SUMMARY ===");
  console.log(`  [0] gemma-4-31b probe .. PASS`);
  console.log(`  [1] chat+JSON ......... ${r1 ? "PASS" : "FAIL"}`);
  console.log(`  [2] vision gate ....... ${r2 ? "PASS" : "REVIEW/FALLBACK"}`);
  console.log(`  [3] parallel soak ..... ${r3 ? "PASS" : "THROTTLED"}`);
  console.log(`  [4] JSON fallback ..... ${r4 ? "PASS" : "FAIL"}`);
  const blockers = [r1, r3, r4].filter((x) => !x).length;
  console.log(blockers === 0 && r2
    ? "\nGREEN: build the headless sim (spec §8.2). Vision is live."
    : blockers === 0 && !r2
      ? "\nYELLOW: build the headless sim with TEXT MINIMAP perception (spec §4a fallback). Vision-in is out; consider vision-out for the multimodal leg."
      : "\nRED: fix blockers above before building further.");
}
main();
