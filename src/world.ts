/**
 * World model: types, init, perceive, decide, apply.
 * Spec §3 (world model), §4a (perceive), §4b (decide), §4c (apply).
 */
import { chat, encodePNG, type CallResult } from "./cerebras.ts";

// ---------- types (spec §3) ----------
export type Vec = { x: number; y: number };
export type TileKind = "grass" | "water" | "rock" | "bush";

export type RelationshipEvent = {
  type: "shared_food" | "competed" | "approached" | "avoided";
  with: string;
  tick: number;
};

export type FoodSource = {
  id: string;
  pos: Vec;
  amount: number;
  maxAmount: number;
  regenRate: number;
};

export type Creature = {
  id: string;
  name: string;
  pos: Vec;
  persona: string;
  color: [number, number, number];
  hunger: number;
  energy: number;
  social: number;
  memory: string[];
  relationships: Record<string, number>;
  relationshipEvents: RelationshipEvent[];
  lastThought?: string;
  alive: boolean;
  starvationTicks: number;
};

export type WorldState = {
  tick: number;
  size: { w: number; h: number };
  terrain: TileKind[][];
  food: FoodSource[];
  creatures: Creature[];
  timeOfDay: number;
};

export type Decision = {
  creatureId: string;
  action: "move_to" | "eat" | "rest" | "approach" | "avoid" | "wander";
  target: string;
  thought: string;
  feelingAbout: Record<string, number>;
  fellback: boolean;
};

// ---------- personas ----------
const PERSONAS: { name: string; persona: string; color: [number, number, number] }[] = [
  { name: "Lumen", persona: "Warm and generous. You share food freely and seek friendship. You believe the group survives together.", color: [255, 200, 100] },
  { name: "Pip", persona: "Selfish and anxious about hunger. You grab food first and hoard. You distrust others near your food.", color: [220, 80, 80] },
  { name: "Thorn", persona: "A loner who prefers solitude. You avoid crowds and find peace in quiet corners.", color: [150, 100, 60] },
  { name: "Fern", persona: "Curious and restless. You love exploring new areas. You wander far and wide, sometimes forgetting to eat.", color: [100, 220, 100] },
  { name: "Moss", persona: "Timid and easily frightened. You flee from conflict and hide near water. You wish you were braver.", color: [80, 160, 80] },
  { name: "Ash", persona: "Calm and steady, the eldest. You rest often, think deeply, and speak little. Others find you wise.", color: [180, 180, 200] },
  { name: "Ripple", persona: "Social and chatty. You crave company above all. You seek out others and feel lonely quickly.", color: [100, 180, 220] },
  { name: "Sage", persona: "Contemplative and patient. You observe before acting. You remember everything and hold grudges.", color: [200, 160, 220] },
  { name: "Breeze", persona: "Gentle and kind. You help others without being asked. You are sad when others are hungry.", color: [180, 220, 200] },
  { name: "Flint", persona: "Competitive and proud. You challenge others for food and territory. You never back down.", color: [240, 160, 60] },
  { name: "Glow", persona: "Optimistic and cheerful. You always see the bright side, even when food is scarce.", color: [255, 240, 120] },
  { name: "Hush", persona: "Quiet and watchful. You rarely speak but notice everything. You avoid loud creatures.", color: [120, 140, 160] },
  { name: "Dash", persona: "Fast and impulsive. You act before thinking and often regret it. You love running.", color: [220, 120, 180] },
  { name: "Vine", persona: "Slow and deliberate. You never rush. You savor every bite and every moment.", color: [100, 140, 60] },
  { name: "Ember", persona: "Passionate and fierce. You feel everything deeply. You are fiercely loyal to friends.", color: [255, 100, 60] },
  { name: "Pebble", persona: "Small but determined. You compensate for your size with cleverness and persistence.", color: [160, 160, 140] },
  { name: "Mist", persona: "Dreamy and absent-minded. You often forget where you were going. You find beauty in everything.", color: [200, 200, 240] },
  { name: "Root", persona: "Grounded and practical. You always plan ahead for food. You distrust wanderers.", color: [140, 100, 50] },
  { name: "Sky", persona: "Free-spirited and open. You befriend everyone you meet. You are sometimes too trusting.", color: [140, 200, 240] },
  { name: "Bramble", persona: "Prickly and defensive. You keep others at a distance until they prove themselves.", color: [100, 80, 60] },
  { name: "Puddle", persona: "Playful and silly. You make light of serious situations. You cheer others up.", color: [120, 200, 180] },
  { name: "Stone", persona: "Stubborn and unmovable. You refuse to leave good spots. You hold your ground.", color: [130, 130, 130] },
  { name: "Wisp", persona: "Ethereal and gentle. You drift through life. You are kind but easily overlooked.", color: [220, 220, 180] },
  { name: "Cinder", persona: "Quietly angry. You resent the hoarders. You want fairness for everyone.", color: [200, 80, 60] },
  { name: "Honey", persona: "Sweet and nurturing. You feed others before yourself. You are the heart of the group.", color: [240, 200, 80] },
];

// ---------- world init ----------
export function initWorld(): WorldState {
  const W = 24, H = 16;
  const terrain: TileKind[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => "grass" as TileKind));

  // Water lake (upper-left area)
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) terrain[y][x] = "water";
  terrain[5][3] = "water"; terrain[4][5] = "water";

  // Rocks scattered
  const rocks: Vec[] = [[8, 3], [9, 3], [15, 10], [16, 10], [20, 5], [21, 5], [12, 12], [13, 12]];
  for (const [x, y] of rocks) terrain[y][x] = "rock";

  // Food sources (bushes)
  const foodPositions: Vec[] = [
    { x: 6, y: 6 }, { x: 18, y: 4 }, { x: 4, y: 10 }, { x: 20, y: 12 },
    { x: 10, y: 8 }, { x: 16, y: 13 }, { x: 2, y: 13 }, { x: 22, y: 8 },
    { x: 11, y: 4 }, { x: 14, y: 7 },
  ];
  const food: FoodSource[] = foodPositions.map((pos, i) => ({
    id: `f${i}`,
    pos,
    amount: 8,
    maxAmount: 8,
    regenRate: 0.15,
  }));

  // SEED THE DRAMA: depleted bush between Pip (hoarder) and Lumen (generous)
  // Place it at center-ish, low amount
  food.push({
    id: "f_contested",
    pos: { x: 12, y: 8 },
    amount: 2,        // nearly empty — scarcity
    maxAmount: 8,
    regenRate: 0.1,   // slow regrow
  });

  // Creatures — 25, scattered, with Pip and Lumen near the contested bush
  const creatures: Creature[] = PERSONAS.map((p, i) => {
    let pos: Vec;
    if (p.name === "Pip") pos = { x: 10, y: 8 };      // left of contested bush
    else if (p.name === "Lumen") pos = { x: 14, y: 8 }; // right of contested bush
    else {
      // scatter the rest, avoiding water/rock
      const angle = (i / PERSONAS.length) * Math.PI * 2;
      const r = 4 + (i % 3) * 2;
      pos = { x: Math.round(12 + r * Math.cos(angle)), y: Math.round(8 + r * Math.sin(angle) * 0.7) };
      pos.x = Math.max(0, Math.min(W - 1, pos.x));
      pos.y = Math.max(0, Math.min(H - 1, pos.y));
      if (terrain[pos.y][pos.x] === "water" || terrain[pos.y][pos.x] === "rock") pos = { x: pos.x + 1, y: pos.y };
    }
    return {
      id: `c${i}`,
      name: p.name,
      pos,
      persona: p.persona,
      color: p.color,
      hunger: 0.3 + Math.random() * 0.2,
      energy: 0.7 + Math.random() * 0.2,
      social: Math.random() * 0.3,
      memory: [],
      relationships: {},
      relationshipEvents: [],
      alive: true,
      starvationTicks: 0,
    };
  });

  return { tick: 0, size: { w: W, h: H }, terrain, food, creatures, timeOfDay: 0.3 };
}

// ---------- needs drift (spec §4) ----------
export function driftNeeds(world: WorldState) {
  for (const c of world.creatures) {
    if (!c.alive) continue;
    c.hunger = Math.min(1, c.hunger + 0.04);
    c.energy = Math.max(0, c.energy - 0.02);
    // social rises when isolated
    const neighbors = world.creatures.filter(o => o.alive && o.id !== c.id && dist(o.pos, c.pos) <= 3);
    if (neighbors.length === 0) c.social = Math.min(1, c.social + 0.05);
    else c.social = Math.max(0, c.social - 0.02 * neighbors.length);
    // starvation check
    if (c.hunger >= 1) c.starvationTicks++;
    else c.starvationTicks = 0;
    if (c.starvationTicks >= 8) {
      c.alive = false;
      c.lastThought = "...";
    }
  }
  world.timeOfDay = (world.timeOfDay + 0.005) % 1;
}

export function regrowFood(world: WorldState) {
  for (const f of world.food) {
    if (f.amount < f.maxAmount) f.amount = Math.min(f.maxAmount, f.amount + f.regenRate);
  }
}

function dist(a: Vec, b: Vec): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function needsWords(c: Creature): string {
  const parts: string[] = [];
  parts.push(c.hunger > 0.7 ? "starving" : c.hunger > 0.4 ? "hungry" : "fed");
  parts.push(c.energy < 0.3 ? "exhausted" : c.energy < 0.6 ? "tired" : "energetic");
  parts.push(c.social > 0.6 ? "lonely" : c.social > 0.3 ? "wanting company" : "content socially");
  return parts.join(", ");
}

// ---------- perceive (spec §4a) ----------
const PERCEPTION_RADIUS = 3;

export function perceive(c: Creature, world: WorldState): { imageB64: string; text: string } {
  const W = world.size.w, H = world.size.h;
  const r = PERCEPTION_RADIUS;
  const N = r * 2 + 1; // 7

  // Build grid: what's in each cell?
  type Cell = { type: string; creature?: Creature; food?: FoodSource };
  const grid: Cell[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ type: "grass" } as Cell)));

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const wx = c.pos.x + dx, wy = c.pos.y + dy;
      const gx = dx + r, gy = dy + r;
      if (wx < 0 || wx >= W || wy < 0 || wy >= H) { grid[gy][gx] = { type: "void" }; continue; }
      grid[gy][gx] = { type: world.terrain[wy][wx] };
      // food
      const f = world.food.find(f => f.pos.x === wx && f.pos.y === wy);
      if (f && f.amount > 0) grid[gy][gx] = { type: "food", food: f };
      // creatures
      const other = world.creatures.find(o => o.alive && o.id !== c.id && o.pos.x === wx && o.pos.y === wy);
      if (other) grid[gy][gx] = { type: "creature", creature: other };
      if (dx === 0 && dy === 0) grid[gy][gx] = { type: "self" };
    }
  }

  // Build iconic image
  const cell = 28;
  const imgW = N * cell, imgH = N * cell;
  const px = Buffer.alloc(imgW * imgH * 3);
  const colors: Record<string, [number, number, number]> = {
    grass: [40, 80, 40], water: [60, 120, 200], rock: [100, 100, 100],
    void: [20, 20, 20], food: [80, 220, 80], self: [40, 80, 40],
  };
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const cell0 = grid[gy][gx];
      let [R, G, B] = colors[cell0.type] ?? colors.grass;
      if (cell0.type === "creature" && cell0.creature) [R, G, B] = cell0.creature.color;
      if (cell0.type === "self") { R = 40; G = 80; B = 40; }
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          if (cell0.type === "self") {
            const edge = dx < 3 || dy < 3 || dx >= cell - 3 || dy >= cell - 3;
            if (edge) { R = 255; G = 255; B = 255; }
          }
          const x = gx * cell + dx, y = gy * cell + dy;
          const o = (y * imgW + x) * 3;
          px[o] = R; px[o + 1] = G; px[o + 2] = B;
        }
      }
    }
  }
  const imageB64 = encodePNG(px, imgW, imgH).toString("base64");

  // Build text minimap + perception text
  const charMap: Record<string, string> = { grass: ".", water: "~", rock: "#", void: " ", food: "F", self: "@", creature: "?" };
  let minimap = "";
  const nearbyCreatures: string[] = [];
  const nearbyFood: string[] = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const cell0 = grid[gy][gx];
      let ch = charMap[cell0.type] ?? ".";
      if (cell0.type === "creature" && cell0.creature) ch = cell0.creature.name[0].toLowerCase();
      minimap += ch;
      if (cell0.type === "creature" && cell0.creature) {
        const o = cell0.creature;
        const d = dist(c.pos, o.pos);
        const aff = c.relationships[o.id] !== undefined ? c.relationships[o.id] : 0;
        nearbyCreatures.push(`${o.name} (id ${o.id}) is ${d.toFixed(0)} tiles away. affinity: ${aff > 0.2 ? "friend" : aff < -0.2 ? "rival" : "neutral"}.`);
      }
      if (cell0.type === "food" && cell0.food) {
        const d = dist(c.pos, cell0.food.pos);
        nearbyFood.push(`${cell0.food.id} at ${d.toFixed(0)} tiles, has ${cell0.food.amount.toFixed(0)}/${cell0.food.maxAmount} food left.`);
      }
    }
    minimap += "\n";
  }

  const recentMemory = c.memory.slice(-4).map(m => `- ${m}`).join("\n");
  const recentEvents = c.relationshipEvents.slice(-3).map(e => `- ${e.type} with ${world.creatures.find(x => x.id === e.with)?.name ?? e.with} at tick ${e.tick}`).join("\n");

  const text = `You are ${c.name} at position (${c.pos.x}, ${c.pos.y}).
Your needs: ${needsWords(c)}.

Nearby creatures:
${nearbyCreatures.length ? nearbyCreatures.join("\n") : "(nobody nearby)"}

Nearby food:
${nearbyFood.length ? nearbyFood.join("\n") : "(no food nearby)"}

Your recent memory:
${recentMemory || "(nothing yet)"}

Recent relationship events:
${recentEvents || "(none yet)"}

Minimap of your surroundings (you are @, F=food, ~=water, #=rock, letters=other creatures):
${minap(minimap)}`;

  return { imageB64, text };
}

function minap(s: string): string { return s.trimEnd(); }

// ---------- decide (spec §4b) ----------
const FEW_SHOT = `
Examples:
perception: you are very hungry. food (berries, id f3) is 2 tiles east. nobody nearby.
{"action":"move_to","target":"f3","thought":"berries, finally."}

perception: Lumen is next to you. you feel lonely. she shared food with you last tick.
{"action":"approach","target":"lumen","thought":"stay near Lumen, she is kind.","feeling_about":{"lumen":0.4}}

perception: nothing notable nearby. you are tired.
{"action":"rest","target":"here","thought":"a moment to breathe."}`;

export async function decide(c: Creature, perception: { imageB64: string; text: string }): Promise<Decision> {
  const system = `You are ${c.name}, a creature in a small world. ${c.persona}
You have needs: hunger, energy, the wish for company. You want to survive and live according to your nature. You can move toward things, eat, rest, approach or avoid other creatures. Be true to your personality.
Respond ONLY as JSON, no prose, no markdown:
{"action":"move_to"|"eat"|"rest"|"approach"|"avoid"|"wander","target":"<creature name, food id, or direction>","thought":"<under 12 words>","feeling_about":{"<creature id>":<-1..1>}}
${FEW_SHOT}`;

  const userContent = [
    { type: "text", text: `${perception.text}\n\n[Image: your surroundings — you are the white-outlined cell at center. Green=food, blue=water, gray=rock, colored squares=other creatures.]\nRespond ONLY as JSON.` },
    { type: "image_url", image_url: { url: `data:image/png;base64,${perception.imageB64}` } },
  ];

  const r: CallResult = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    { maxTokens: 100, temperature: 0.9 },
  );

  if (!r.ok) {
    return { creatureId: c.id, action: "wander", target: "random", thought: "(undecided)", feelingAbout: {}, fellback: true };
  }

  const parsed = parseDecision(r.text, c);
  return { ...parsed, creatureId: c.id, fellback: false };
}

function parseDecision(raw: string, c: Creature): Omit<Decision, "creatureId" | "fellback"> {
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { action: "wander", target: "random", thought: truncate(raw.slice(0, 60)), feelingAbout: {} };
  try {
    const j = JSON.parse(raw.slice(start, end + 1));
    const action = String(j.action ?? "").toLowerCase();
    const valid = ["move_to", "eat", "rest", "approach", "avoid", "wander"].includes(action);
    if (!valid) return { action: "wander", target: "random", thought: "not sure what to do.", feelingAbout: {} };
    const thought = truncate(String(j.thought ?? "..."));
    const feelingAbout: Record<string, number> = {};
    if (j.feeling_about && typeof j.feeling_about === "object") {
      for (const [k, v] of Object.entries(j.feeling_about)) {
        const n = Math.max(-1, Math.min(1, Number(v)));
        if (!isNaN(n)) feelingAbout[k] = n;
      }
    }
    return { action: action as Decision["action"], target: String(j.target ?? ""), thought, feelingAbout };
  } catch {
    return { action: "wander", target: "random", thought: "confused, wandering.", feelingAbout: {} };
  }
}

function truncate(s: string): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= 12) return s.trim();
  return words.slice(0, 12).join(" ") + "...";
}

// ---------- apply decisions (spec §4c) ----------
export function applyDecisions(world: WorldState, decisions: Decision[]) {
  const W = world.size.w, H = world.size.h;
  const foodTargets = new Map<string, string[]>(); // foodId -> creatureIds targeting it

  // First pass: resolve targets and detect competition
  for (const d of decisions) {
    const c = world.creatures.find(c => c.id === d.creatureId);
    if (!c || !c.alive) continue;

    // Resolve target to a food id if applicable
    if (d.action === "move_to" || d.action === "eat") {
      const food = world.food.find(f => f.id === d.target);
      if (food) {
        const list = foodTargets.get(food.id) ?? [];
        list.push(c.id);
        foodTargets.set(food.id, list);
      }
    }
  }

  for (const d of decisions) {
    const c = world.creatures.find(c => c.id === d.creatureId);
    if (!c || !c.alive) continue;

    let moved = false;
    switch (d.action) {
      case "move_to": {
        const target = resolveTarget(d.target, c, world);
        if (target) {
          c.pos = stepToward(c.pos, target, world);
          moved = true;
          c.memory.push(`moved toward ${d.target}`);
        } else {
          c.pos = wander(c.pos, world);
          moved = true;
        }
        break;
      }
      case "eat": {
        const food = world.food.find(f => f.id === d.target && dist(f.pos, c.pos) <= 1.5);
        if (food && food.amount > 0) {
          const eaten = Math.min(3, food.amount);
          food.amount -= eaten;
          c.hunger = Math.max(0, c.hunger - eaten * 0.3);
          c.memory.push(`ate ${eaten} from ${food.id}`);
          // Record shared_food if another creature is nearby
          for (const other of world.creatures) {
            if (other.alive && other.id !== c.id && dist(other.pos, c.pos) <= 2) {
              c.relationshipEvents.push({ type: "shared_food", with: other.id, tick: world.tick });
              if (c.relationshipEvents.length > 6) c.relationshipEvents.shift();
            }
          }
        } else {
          // Move toward the food if not adjacent
          const f = world.food.find(f => f.id === d.target);
          if (f) { c.pos = stepToward(c.pos, f.pos, world); moved = true; }
        }
        break;
      }
      case "rest": {
        c.energy = Math.min(1, c.energy + 0.15);
        c.memory.push("rested");
        break;
      }
      case "approach": {
        const target = world.creatures.find(o => o.name.toLowerCase() === d.target.toLowerCase() || o.id === d.target);
        if (target) {
          c.pos = stepToward(c.pos, target.pos, world);
          moved = true;
          c.relationshipEvents.push({ type: "approached", with: target.id, tick: world.tick });
          if (c.relationshipEvents.length > 6) c.relationshipEvents.shift();
          c.memory.push(`approached ${target.name}`);
        }
        break;
      }
      case "avoid": {
        const target = world.creatures.find(o => o.name.toLowerCase() === d.target.toLowerCase() || o.id === d.target);
        if (target) {
          c.pos = stepAway(c.pos, target.pos, world);
          moved = true;
          c.relationshipEvents.push({ type: "avoided", with: target.id, tick: world.tick });
          if (c.relationshipEvents.length > 6) c.relationshipEvents.shift();
          c.memory.push(`avoided ${target.name}`);
        }
        break;
      }
      case "wander":
      default: {
        c.pos = wander(c.pos, world);
        moved = true;
        break;
      }
    }

    if (moved) c.energy = Math.max(0, c.energy - 0.03);

    // Update relationships from feeling_about
    for (const [otherId, delta] of Object.entries(d.feelingAbout)) {
      const current = c.relationships[otherId] ?? 0;
      c.relationships[otherId] = Math.max(-1, Math.min(1, current + delta * 0.3));
    }

    // Record competition events
    for (const [foodId, creatures] of foodTargets) {
      if (creatures.length > 1 && creatures.includes(c.id)) {
        for (const otherId of creatures) {
          if (otherId !== c.id) {
            c.relationshipEvents.push({ type: "competed", with: otherId, tick: world.tick });
            if (c.relationshipEvents.length > 6) c.relationshipEvents.shift();
          }
        }
      }
    }

    c.lastThought = d.thought;
    if (c.memory.length > 8) c.memory = c.memory.slice(-8);
  }
}

function resolveTarget(target: string, c: Creature, world: WorldState): Vec | null {
  // food id
  const f = world.food.find(f => f.id === target);
  if (f) return f.pos;
  // creature name or id
  const other = world.creatures.find(o => o.name.toLowerCase() === target.toLowerCase() || o.id === target);
  if (other) return other.pos;
  // direction
  const dirs: Record<string, Vec> = {
    n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 },
    ne: { x: 1, y: -1 }, nw: { x: -1, y: -1 }, se: { x: 1, y: 1 }, sw: { x: -1, y: 1 },
    north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 },
  };
  const d = dirs[target.toLowerCase()];
  if (d) return { x: c.pos.x + d.x, y: c.pos.y + d.y };
  return null;
}

function stepToward(from: Vec, to: Vec, world: WorldState): Vec {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const nx = Math.max(0, Math.min(world.size.w - 1, from.x + dx));
  const ny = Math.max(0, Math.min(world.size.h - 1, from.y + dy));
  if (world.terrain[ny][nx] !== "water" && world.terrain[ny][nx] !== "rock") return { x: nx, y: ny };
  // try just x or just y
  if (dx && world.terrain[from.y][nx] !== "water" && world.terrain[from.y][nx] !== "rock") return { x: nx, y: from.y };
  if (dy && world.terrain[ny][from.x] !== "water" && world.terrain[ny][from.x] !== "rock") return { x: from.x, y: ny };
  return from;
}

function stepAway(from: Vec, away: Vec, world: WorldState): Vec {
  const dx = -Math.sign(away.x - from.x);
  const dy = -Math.sign(away.y - from.y);
  const nx = Math.max(0, Math.min(world.size.w - 1, from.x + dx));
  const ny = Math.max(0, Math.min(world.size.h - 1, from.y + dy));
  if (world.terrain[ny][nx] !== "water" && world.terrain[ny][nx] !== "rock") return { x: nx, y: ny };
  return from;
}

function wander(pos: Vec, world: WorldState): Vec {
  const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]];
  const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
  const nx = Math.max(0, Math.min(world.size.w - 1, pos.x + dx));
  const ny = Math.max(0, Math.min(world.size.h - 1, pos.y + dy));
  if (world.terrain[ny][nx] !== "water" && world.terrain[ny][nx] !== "rock") return { x: nx, y: ny };
  return pos;
}
