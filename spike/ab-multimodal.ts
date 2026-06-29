/**
 * A/B test: does the image in Gemma 4's multimodal call actually influence decisions?
 *
 * For each of 3 creatures, we run the SAME perception text through:
 *   A = multimodal (text + image)  — the current production call
 *   B = text-only (no image)       — control
 *
 * 3 trials each, temperature 0.3. If the image matters, A and B should diverge
 * meaningfully on action, target, or thought content.
 *
 * Result: a table + divergence summary we can cite in the hackathon submission.
 */
import { chat } from "../src/cerebras.ts";
import { initWorld, perceive, type Creature, type WorldState } from "../src/world.ts";

const world = initWorld();

// Pick 3 creatures with interesting surroundings
const targets = ["c0", "c6", "c9"]; // Lumen (near contested bush), Ripple (social), Flint (competitive)
const creatures = targets.map(id => world.creatures.find(c => c.id === id)!).filter(Boolean);

const TEMP = 0.3;
const TRIALS = 3;

const FEW_SHOT = `
Examples:
perception: you are very hungry. food (berries, id f3) is 2 tiles east. nobody nearby.
{"action":"move_to","target":"f3","thought":"berries, finally."}

perception: Lumen is next to you. you feel lonely. she shared food with you last tick.
{"action":"approach","target":"lumen","thought":"stay near Lumen, she is kind.","feeling_about":{"lumen":0.4}}

perception: nothing notable nearby. you are tired.
{"action":"rest","target":"here","thought":"a moment to breathe."}`;

function buildSystem(c: Creature): string {
  return `You are ${c.name}, a creature in a small world. ${c.persona}
You have needs: hunger, energy, the wish for company. You want to survive and live according to your nature. You can move toward things, eat, rest, approach or avoid other creatures. Be true to your personality.
Respond ONLY as JSON, no prose, no markdown:
{"action":"move_to"|"eat"|"rest"|"approach"|"avoid"|"wander","target":"<creature name, food id, or direction>","thought":"<under 12 words>","feeling_about":{"<creature id>":<-1..1>}}
${FEW_SHOT}`;
}

function parseDecision(raw: string) {
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "?", target: "?", thought: raw.slice(0, 40) };
  try {
    const j = JSON.parse(raw.slice(start, end + 1));
    return { action: j.action ?? "?", target: j.target ?? "?", thought: (j.thought ?? "...").slice(0, 60) };
  } catch {
    return { action: "?", target: "?", thought: "parse error" };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  A/B TEST: Does the image influence Gemma 4 decisions?  ║");
console.log("║  A = text + image (multimodal)  B = text only (control) ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`Model: gemma-4-31b | Temperature: ${TEMP} | Trials per condition: ${TRIALS}`);
console.log();

const results: { creature: string; trial: number; condition: string; action: string; target: string; thought: string }[] = [];

for (const c of creatures) {
  const perception = perceive(c, world);
  const system = buildSystem(c);

  console.log(`--- ${c.name} (id ${c.id}) at (${c.pos.x},${c.pos.y}) ---`);
  console.log(`Nearby: ${perception.text.split("\n").find(l => l.includes("Nearby creatures")) ?? "(none)"}`);
  console.log(`Food: ${perception.text.split("\n").find(l => l.includes("Nearby food")) ?? "(none)"}`);
  console.log();

  for (let trial = 1; trial <= TRIALS; trial++) {
    // Condition A: multimodal (text + image)
    const userContentA = [
      { type: "text", text: `${perception.text}\n\n[Image: your surroundings — you are the white-outlined cell at center. Green=food, blue=water, gray=rock, colored squares=other creatures.]\nRespond ONLY as JSON.` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${perception.imageB64}` } },
    ];
    const rA = await chat(
      [{ role: "system", content: system }, { role: "user", content: userContentA }],
      { maxTokens: 100, temperature: TEMP },
    );
    const dA = rA.ok ? parseDecision(rA.text) : { action: "error", target: "error", thought: rA.error ?? "failed" };

    // Condition B: text-only (no image)
    const userContentB = [
      { type: "text", text: `${perception.text}\n\nRespond ONLY as JSON.` },
    ];
    const rB = await chat(
      [{ role: "system", content: system }, { role: "user", content: userContentB }],
      { maxTokens: 100, temperature: TEMP },
    );
    const dB = rB.ok ? parseDecision(rB.text) : { action: "error", target: "error", thought: rB.error ?? "failed" };

    console.log(`  Trial ${trial}:`);
    console.log(`    A (image):  action=${dA.action.padEnd(8)} target=${truncate(dA.target, 12).padEnd(12)} thought="${dA.thought}"`);
    console.log(`    B (text):   action=${dB.action.padEnd(8)} target=${truncate(dB.target, 12).padEnd(12)} thought="${dB.thought}"`);
    const diverged = dA.action !== dB.action || dA.target !== dB.target;
    console.log(`    ${diverged ? ">>> DIVERGED" : "(same)"}`);
    console.log();

    results.push({ creature: c.name, trial, condition: "A", ...dA });
    results.push({ creature: c.name, trial, condition: "B", ...dB });
  }
}

// ---- Summary ----
console.log("═══════════════════════════════════════════════════════");
console.log("SUMMARY");
console.log("═══════════════════════════════════════════════════════");

let actionDiverge = 0, targetDiverge = 0, thoughtDiverge = 0, total = 0;
for (const c of creatures) {
  for (let t = 1; t <= TRIALS; t++) {
    const a = results.find(r => r.creature === c.name && r.trial === t && r.condition === "A")!;
    const b = results.find(r => r.creature === c.name && r.trial === t && r.condition === "B")!;
    total++;
    if (a.action !== b.action) actionDiverge++;
    if (a.target !== b.target) targetDiverge++;
    if (a.thought !== b.thought) thoughtDiverge++;
  }
}

console.log(`Total trials: ${total} (${creatures.length} creatures x ${TRIALS} trials)`);
console.log(`Action diverged:  ${actionDiverge}/${total} (${(actionDiverge / total * 100).toFixed(0)}%)`);
console.log(`Target diverged:  ${targetDiverge}/${total} (${(targetDiverge / total * 100).toFixed(0)}%)`);
console.log(`Thought diverged: ${thoughtDiverge}/${total} (${(thoughtDiverge / total * 100).toFixed(0)}%)`);
console.log();

if (actionDiverge > 0 || targetDiverge > 0) {
  console.log("VERDICT: The image IS load-bearing — it changes agent decisions.");
  console.log("Claim for submission: 'Vision input measurably alters Gemma 4's decisions in X% of trials.'");
} else if (thoughtDiverge > 0) {
  console.log("VERDICT: Image doesn't change actions but changes reasoning/thought content.");
  console.log("Claim: 'Vision input shapes how agents reason about their environment, even when actions converge.'");
} else {
  console.log("VERDICT: No divergence detected — the text minimap may be sufficient.");
  console.log("WARNING: This weakens the multimodal claim. Consider richer images or removing text redundancy.");
}
