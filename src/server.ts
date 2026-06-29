/**
 * Grove SSE server — runs the tick loop, streams world state to the frontend.
 * Cerebras key stays server-side. SSE payload contains no secrets.
 * Per Corridor: path sanitization on static files, no key in SSE payload.
 */
import { chat, metrics, tokensPerSec } from "./cerebras.ts";
import {
  initWorld, driftNeeds, regrowFood, perceive, decide, applyDecisions,
  type WorldState,
} from "./world.ts";
import { resolve, join, relative, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_TICKS = Number(process.env.GROVE_MAX_TICKS ?? 999);
const TICK_DELAY_MS = Number(process.env.GROVE_TICK_DELAY ?? 500);

let world = initWorld();
const clients = new Set<ReadableStreamDefaultController>();
let tickRunning = false;

// Serialize world for SSE (no secrets, no persona text, no memory — just render data)
function serializeInit() {
  return {
    type: "init",
    size: world.size,
    terrain: world.terrain,
    timeOfDay: world.timeOfDay,
  };
}

function serializeTick(elapsed: number, foodTargets: Map<string, string[]>) {
  return {
    type: "tick",
    tick: world.tick,
    elapsed,
    timeOfDay: world.timeOfDay,
    creatures: world.creatures.map(c => ({
      id: c.id, name: c.name, pos: c.pos,
      color: c.color, hunger: c.hunger, energy: c.energy, social: c.social,
      lastThought: c.lastThought, alive: c.alive,
    })),
    food: world.food.map(f => ({
      id: f.id, pos: f.pos, amount: f.amount, maxAmount: f.maxAmount,
    })),
    contests: [...foodTargets.entries()].filter(([_, cs]) => cs.length > 1).map(([foodId, cs]) => ({ foodId, creatures: cs })),
    metrics: {
      totalCalls: metrics.totalCalls,
      tokensPerSec: Math.round(tokensPerSec()),
      total429: metrics.total429,
      totalRetries: metrics.totalRetries,
    },
  };
}

function broadcast(data: object) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.enqueue(msg); } catch { clients.delete(c); }
  }
}

// Start the world on demand (triggered by the "enter the world" button).
// Guarded so concurrent viewers can't double-start. If a previous run already
// advanced, spin up a fresh world and re-broadcast init so terrain resets.
function startTickLoop(): boolean {
  if (tickRunning) return false;
  if (world.tick > 0) {
    world = initWorld();
    broadcast(serializeInit());
  }
  tickRunning = true;
  tickLoop().finally(() => { tickRunning = false; });
  return true;
}

async function tickLoop() {
  metrics.startTime = performance.now();
  for (let i = 0; i < MAX_TICKS; i++) {
    world.tick++;
    const t0 = performance.now();
    driftNeeds(world);
    regrowFood(world);

    const alive = world.creatures.filter(c => c.alive);
    const perceptions = alive.map(c => ({ c, p: perceive(c, world) }));
    const decisions = await Promise.all(perceptions.map(({ c, p }) => decide(c, p)));

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
    broadcast(serializeTick(elapsed, foodTargets));

    const aliveCount = world.creatures.filter(c => c.alive).length;
    console.log(`tick ${world.tick}: ${aliveCount} alive, ${elapsed.toFixed(0)}ms, ${metrics.totalCalls} calls, ${metrics.total429} 429s`);

    if (aliveCount < 5) { console.log("Too few alive, stopping."); break; }
    if (TICK_DELAY_MS > 0) await new Promise(r => setTimeout(r, TICK_DELAY_MS));
  }
  broadcast({ type: "end", tick: world.tick });
}

// Path sanitization (Corridor): ensure file requests stay within web/
function safeServeFile(pathname: string): Response {
  const WEB_DIR = resolve(import.meta.dir, "..", "web");
  const requested = resolve(WEB_DIR, pathname === "/" ? "index.html" : pathname);
  const rel = relative(WEB_DIR, requested);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(requested);
  if (!file.exists()) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
  });
}

function sseResponse(): Response {
  let ctrl: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      clients.add(controller);
      controller.enqueue(`data: ${JSON.stringify(serializeInit())}\n\n`);
    },
    cancel() { if (ctrl) clients.delete(ctrl); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max — SSE connections must stay alive
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/events") return sseResponse();
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/start" && req.method === "POST") {
      const started = startTickLoop();
      return Response.json({ started, running: tickRunning, tick: world.tick });
    }
    return safeServeFile(url.pathname);
  },
});

console.log(`Grove server: http://localhost:${PORT}`);
console.log(`SSE: http://localhost:${PORT}/events`);
console.log(`Idle — waiting for /start (${MAX_TICKS === 999 ? "unlimited" : MAX_TICKS + " ticks"} when triggered)...`);
