/**
 * Headless sim — tick loop, console logging, falsifiable gate (spec §8.2).
 * Prove the society emerges in text before any rendering.
 */
import { chat, metrics, tokensPerSec } from "./cerebras.ts";
import {
  initWorld, driftNeeds, regrowFood, perceive, decide, applyDecisions,
  type WorldState, type Decision,
} from "./world.ts";

const MAX_TICKS = Number(process.env.GROVE_MAX_TICKS ?? 40);
const TICK_DELAY_MS = Number(process.env.GROVE_TICK_DELAY ?? 0); // 0 = fire as fast as rate limit allows

// Track the falsifiable gate: did two creatures target the same food, and did one thought name the other?
let gateMet = false;
const gateLog: string[] = [];

async function tick(world: WorldState): Promise<{ elapsed: number; foodTargets: Map<string, string[]> }> {
  world.tick++;
  const t0 = performance.now();

  driftNeeds(world);
  regrowFood(world);

  const alive = world.creatures.filter(c => c.alive);

  // Fire all decide() calls in parallel — client handles concurrency cap + retry
  const perceptions = alive.map(c => ({ c, p: perceive(c, world) }));
  const decisions = await Promise.all(
    perceptions.map(({ c, p }) => decide(c, p)),
  );

  // Check for competition BEFORE applying (for the gate)
  const foodTargets = new Map<string, string[]>();
  for (const d of decisions) {
    if (d.action === "move_to" || d.action === "eat") {
      const list = foodTargets.get(d.target) ?? [];
      list.push(d.creatureId);
      foodTargets.set(d.target, list);
    }
  }

  applyDecisions(world, decisions);

  const elapsed = performance.now() - t0;
  return { elapsed, foodTargets };
}

function logTick(world: WorldState, elapsed: number, foodTargets: Map<string, string[]>) {
  const alive = world.creatures.filter(c => c.alive);
  const dead = world.creatures.filter(c => !c.alive);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`TICK ${world.tick} | ${alive.length} alive${dead.length ? `, ${dead.length} dead` : ""} | ${elapsed.toFixed(0)}ms | ${tokensPerSec().toFixed(0)} tok/s | calls=${metrics.totalCalls} 429s=${metrics.total429}`);
  console.log(`${"=".repeat(70)}`);

  for (const c of alive) {
    const icon = c.hunger > 0.7 ? "!" : c.hunger > 0.4 ? "~" : " ";
    const thought = c.lastThought ?? "...";
    console.log(`  ${icon} ${c.name.padEnd(8)} (${c.pos.x},${c.pos.y}) h=${c.hunger.toFixed(1)} e=${c.energy.toFixed(1)} s=${c.social.toFixed(1)}  "${thought}"`);
  }

  // Highlight competition
  for (const [foodId, creatures] of foodTargets) {
    if (creatures.length > 1) {
      const names = creatures.map(id => world.creatures.find(c => c.id === id)?.name ?? id).join(" vs ");
      console.log(`  >> CONTEST: ${names} both targeting ${foodId}`);
      // Check gate: did any thought name the other?
      for (const id1 of creatures) {
        const c1 = world.creatures.find(c => c.id === id1);
        if (!c1?.lastThought) continue;
        for (const id2 of creatures) {
          if (id1 === id2) continue;
          const c2 = world.creatures.find(c => c.id === id2);
          if (c2 && c1.lastThought.toLowerCase().includes(c2.name.toLowerCase())) {
            gateMet = true;
            gateLog.push(`  TICK ${world.tick}: ${c1.name} thought "${c1.lastThought}" while competing with ${c2.name} for ${foodId}`);
          }
        }
      }
    }
  }
}

function logFood(world: WorldState) {
  const foodLine = world.food.map(f => `${f.id}:${f.amount.toFixed(0)}`).join(" ");
  console.log(`  food: ${foodLine}`);
}

function logRelationships(world: WorldState) {
  for (const c of world.creatures) {
    if (!c.alive) continue;
    const friends = Object.entries(c.relationships).filter(([_, v]) => v > 0.2);
    const rivals = Object.entries(c.relationships).filter(([_, v]) => v < -0.2);
    if (friends.length || rivals.length) {
      const parts: string[] = [];
      for (const [id, v] of friends) {
        const name = world.creatures.find(x => x.id === id)?.name ?? id;
        parts.push(`${name}:+${v.toFixed(1)}`);
      }
      for (const [id, v] of rivals) {
        const name = world.creatures.find(x => x.id === id)?.name ?? id;
        parts.push(`${name}:${v.toFixed(1)}`);
      }
      console.log(`  ${c.name}: relationships [${parts.join(", ")}]`);
    }
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  GROVE — headless sim (spec §8.2)        ║");
  console.log("║  25 Gemma-4 agents on Cerebras           ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`max ticks: ${MAX_TICKS} | concurrency: ${process.env.GROVE_MAX_CONCURRENT ?? 3} | model: ${process.env.GROVE_GEMMA_MODEL ?? "gemma-4-31b"}`);

  metrics.startTime = performance.now();
  const world = initWorld();

  console.log(`\nWorld: ${world.size.w}x${world.size.h}, ${world.creatures.length} creatures, ${world.food.length} food sources`);
  console.log(`Contested bush (f_contested) at (12,8) with ${world.food.find(f => f.id === "f_contested")?.amount} food — between Pip (hoarder) and Lumen (generous)`);

  for (let i = 0; i < MAX_TICKS; i++) {
    const { elapsed, foodTargets } = await tick(world);
    logTick(world, elapsed, foodTargets);
    logFood(world);

    // Log relationships every 5 ticks
    if (world.tick % 5 === 0) logRelationships(world);

    // Check gate
    if (gateMet) {
      console.log(`\n*** FALSIFIABLE GATE MET at tick ${world.tick} ***`);
      for (const line of gateLog) console.log(line);
      console.log("  -> Society is producing legible competition. Safe to proceed to rendering.");
      // Keep running a few more ticks to show the pattern
    }

    if (TICK_DELAY_MS > 0) await new Promise(r => setTimeout(r, TICK_DELAY_MS));

    // Stop if too many deaths
    const aliveCount = world.creatures.filter(c => c.alive).length;
    if (aliveCount < 10) {
      console.log(`\nOnly ${aliveCount} creatures alive — stopping.`);
      break;
    }
  }

  // Final gate report
  console.log("\n" + "═".repeat(50));
  console.log("FALSIFIABLE GATE REPORT");
  console.log("═".repeat(50));
  console.log(`Gate: "within ${MAX_TICKS} ticks, two creatures target same food and one thought names the other"`);
  console.log(`Result: ${gateMet ? "PASS ✅" : "FAIL ❌"}`);
  if (gateLog.length) {
    for (const line of gateLog) console.log(line);
  } else {
    console.log("  No named competition detected. Check thoughts for indirect references.");
    // Show some thoughts as evidence of society
    console.log("\n  Sample thoughts from last tick:");
    for (const c of world.creatures.filter(c => c.alive).slice(0, 10)) {
      console.log(`    ${c.name}: "${c.lastThought ?? "..."}"`);
    }
  }

  console.log(`\nMetrics: ${metrics.totalCalls} calls, ${metrics.total429} 429s, ${metrics.totalRetries} retries, ${tokensPerSec().toFixed(0)} tok/s`);
  console.log(`Verdict: ${gateMet ? "GREEN — build the renderer (spec §8.4)" : "YELLOW — society runs but needs tuning (personas, scarcity, tick rate)"}`);
}

main();
