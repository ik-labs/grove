# Grove — v1 Spec

**A living pixel-art world where every creature is a Gemma 4 agent.** They get hungry, seek food, befriend, compete, and wander — each decision driven by real language-model reasoning, all of them thinking *at once* because Cerebras runs the whole population in parallel in under a second. You don't read logs; you watch a society survive. It looks like a cozy pixel diorama that's quietly thinking.

**Hackathon:** Cerebras × Google DeepMind Gemma 4 (24h). Target: **Multiverse Agents — Best Multi-Agent + Multimodal Use Case ($2K)**.

**Pitch sentence (lead with this):** A society of 20+ independent LLM agents living, perceiving, and surviving in real time is a slideshow on normal infra and a living world on Cerebras — fast inference is the difference between "one agent at a time" and "a world that breathes."

---

## 0. Revision notes (v1.1 — post-review)

Resolved 9 review issues. Hard constraint: **Cerebras + Gemma 4 only** (hackathon rules). Prize judged on **Multi-Agent + Multimodal** — both legs must carry weight; multimodal is the one at risk, so it gets the most engineering.

| # | Issue | Resolution |
|---|---|---|
| 1 | Multimodal leg is the shakiest (judging criterion) | **Iconic-image vision-in + text minimap.** Send Gemma-4 vision a tiny 7×7 iconic diagram (food=green, creatures=colored-by-persona, water=blue, self=white outline, ~196px) **plus** a one-line text minimap in the same call. Vision models parse simple iconic diagrams reliably (unlike dense pixel art). Honest multimodal on Cerebras+Gemma-4, cheap 2D-canvas render, no Three.js render targets. Test gate at min 30. |
| 2 | "Impossible without Cerebras" overstated | Soften to "the difference between a living world and a slideshow." Harden the *proof* (see #3) instead of asserting it. |
| 3 | Speed demo vs readability in tension | **Dual mode: turbo/observe toggle** (or auto-cycle 8s turbo → 8s observe). Turbo = full speed, meter spikes; observe = ~2s ticks, readable. The *contrast* is the pitch. Promote `tokensPerSec` to a prominent corner pill. |
| 4 | Emergence sold but not engineered | Enrich relationship state with a **typed event log** (`shared_food`/`competed`/`approached`/`avoided`, with id + tick, cap ~6). Feed last 2–3 into prompt so thoughts reference real history. |
| 5 | "Tune scarcity for tension" is magic | **Seed initial conditions:** one depleted bush between two opposing personas (hoarder vs generous) at spawn, low ambient food nearby. Make the climax *probable* in ~40 ticks, not hoped-for. |
| 6 | Gemma JSON reliability | **Few-shot (2–3 worked examples) in system prompt**, strip fences + `JSON.parse` + default `wander` on failure, **log fallback rate** (alarm if >15%), truncate `thought` to 12 words with ellipsis. Use constrained decode if Cerebras exposes it. |
| 7 | Cerebras rate limit not in de-risk | Add a **60s 25-way parallel soak** to the de-risk spike. Verify sustained concurrency + p99 latency + 429 rate. "Increased" ≠ "unlimited." |
| 8 | Concrete gaps (sprites, key, success criterion) | Lock in de-risk phase: pick CC0 pixel sprite pack; tiny Bun backend holds Cerebras key (never in client); falsifiable sim gate = "within 60 ticks, two creatures target same food source and one thought names the other." |
| 9 | Off-screen render crops (25/tick) are a time pit | **Cut** unless #1's vision test passes AND iconic diagram underperforms a real crop (it won't). Default: 50-line 2D canvas, no GPU plumbing. |

**Highest-leverage artifact:** the de-risk spike script — one script resolves #1, #6, #7 and de-risks #9 in the first 30 min. Build it first.

**Rate-limit reality (from the soak, resolved):** The hackathon's elevated capacity is 100 RPM (~1.67 calls/sec sustained, with a ~100-call burst that completes in ~2 seconds). At 25 creatures per tick:
- First ~4 ticks: fast (~4s each, using burst capacity)
- After burst: ~15s per tick (rate-limited, with retry/backoff)
- The retry/backoff client handles 429s gracefully — the world never stalls, just breathes slower.
- **0% JSON fallback rate** on successful calls (75/75 parsed correctly across 3 ticks).
- **~5,600 tok/s** throughput on Cerebras — the speed story holds.
- **Falsifiable gate PASSED on tick 2:** Flint thought "This food is mine. Pip can't have it." while competing with Pip for the same food source. The seeded contested bush worked.

---

## 1. Why this wins — and why it has soul

- **Maximally multi-agent, visibly.** 20–30 independent minds acting at once, not a pipeline. Each is its own agent with memory, personality, and needs.
- **Multimodal, honestly.** Each creature *perceives* an iconic-image diagram of its surroundings (vision drives behavior) plus a one-line text minimap as grounding. Vision in → decision out.
- **Beautiful to watch.** Cozy pixel sprites in a Three.js world with camera drift, soft light, particles. Thought-bubbles surface in each creature's own voice and fade. It reads as a painting that thinks.
- **Soul, not mechanism.** These aren't nodes optimizing a score — they're characters surviving. Scarcity creates real drama: who shares, who hoards, who wanders off alone. The emergent story is unscripted.
- **The difference between a living world and a slideshow.** 25 agents each making a language decision every ~second IS the pitch — Cerebras turns a serial slideshow into a world that breathes. We *prove* it visibly, not just assert it.
- **Inherently shareable** (free People's Choice upside): "I built a tiny world where every creature is an AI that survives, and they formed a society" is a clip that travels.

---

## 2. The rendering decision (resolve this first — it's the time-pit)

**Pixel-art cozy AS sprites in Three.js. Do NOT build 3D meshes.**

- World = a tilemap rendered as textured quads on a (near-)flat plane. Creatures, food, props = **billboarded sprite quads**.
- Textures use **NearestFilter** (no mipmaps) so pixels stay crisp — this is what keeps it "pixel-art" not "blurry 3D."
- Three.js earns its place via **atmosphere, not geometry**: a gently drifting `OrthographicCamera` (or low-FOV perspective for subtle parallax), soft ambient + one warm directional light, particle systems (fireflies, drifting motes, light shafts), and a day/night color grade. That's the warmth that makes it feel alive.
- Sprite animation = swap texture frames on a timer (idle/walk), lerp positions between tiles for smooth movement.

This gets you cozy pixel charm + living richness without the mesh/rig time sink.

---

## 3. World model

```ts
type Vec = { x: number; y: number };           // tile coords

type WorldState = {
  tick: number;
  size: { w: number; h: number };              // tilemap dims, e.g. 24x16
  terrain: TileKind[][];                        // grass | water | rock | bush
  food: FoodSource[];                           // depletes & regrows
  creatures: Creature[];
  timeOfDay: number;                            // 0..1, drives color grade
};

type FoodSource = {
  id: string; pos: Vec;
  amount: number;                               // depletes when eaten
  regenRate: number;                            // slow regrow → scarcity matters
};

type Creature = {
  id: string;
  name: string;
  pos: Vec;
  sprite: string;                               // which pixel critter
  persona: string;                              // 1-2 line personality (drives voice)
  // needs (0..1, drift over time)
  hunger: number;                               // rises each tick; death if maxed too long
  energy: number;                               // falls when moving, restored by rest
  social: number;                               // rises when alone, eased by proximity
  // state
  memory: string[];                             // short rolling log of what it did/saw
  relationships: Record<string, number>;        // id -> affinity (-1..1)
  relationshipEvents: RelationshipEvent[];      // typed log (cap ~6) — feeds the prompt so thoughts reference real history
  lastThought?: string;                         // the floating bubble text
  alive: boolean;
};

type RelationshipEvent = {
  type: "shared_food" | "competed" | "approached" | "avoided";
  with: string;                                 // creature id
  tick: number;
};
```

**Survival rules (the drama engine):**
- `hunger` rises every tick. Eating from a nearby `FoodSource` lowers it and depletes that source.
- Food sources deplete faster than they regrow → **scarcity emerges naturally** → creatures must compete, range further, or cooperate.
- `energy` falls with movement; resting restores it. A starving low-energy creature is in trouble — that's the stakes.
- `social` rises when isolated; being near liked creatures eases it. Drives the social wandering.
- A creature whose hunger stays maxed for N ticks dies (fades out — keep it tasteful, it's cozy not grim). Death is rare and meaningful, not constant.

Tune so the world is mostly cozy with **occasional tension** when food runs low — that rhythm is the story.

**Seed the drama (don't wait for it):** at spawn, place one depleted bush between two opposing personas (hoarder vs generous), with low ambient food nearby. A contest becomes *probable* within ~40 ticks instead of hoped-for. Keep the rest of the map cozy. You're filming a 90s clip — the climax should be engineered to be likely, not left to chance.

---

## 4. The tick loop — where Cerebras is the whole point

```ts
async function tick(world: WorldState, cb: CerebrasClient, bus: EventBus) {
  world.tick++;
  driftNeeds(world);                 // hunger++, energy/social drift (pure, local)
  regrowFood(world);

  const alive = world.creatures.filter(c => c.alive);

  // THE MOMENT: every creature decides AT ONCE, in parallel.
  const decisions = await Promise.all(
    alive.map(c => decide(c, perceive(c, world), cb))   // each = 1 Gemma call
  );

  applyDecisions(world, decisions, bus);   // move, eat, update memory/relationships
  emitWorld(world, bus);                   // stream new state to the renderer
}
```

Loop `tick` on an interval (e.g. every ~1.5–2s) so motion is continuous but the model has time to breathe. **All N creature calls fire in parallel each tick** — at 25 creatures that's 25 concurrent Gemma calls resolving in well under a second on Cerebras. On normal infra this serializes into a slideshow. That contrast IS the submission.

### 4a. `perceive(creature, world)` — builds the agent's local view
Returns what this creature can sense within a radius:
- Nearby creatures (name, distance, current affinity, what they appear to be doing).
- Nearby food (distance, how much is left).
- Its own needs (hunger/energy/social as words: "very hungry", "lonely").
- A few lines of its own recent memory, plus the last 2–3 typed relationship events (so thoughts can reference real history — "I gave berries to Lumen at dawn").
- **Multimodal (primary):** an iconic-image diagram of the 7×7 tiles around it — food=green square, creatures=colored-by-persona square, water=blue, self=white outline, ~196px PNG base64. Render on a small 2D canvas (cheap, no Three.js render targets). Vision models parse simple iconic diagrams reliably (unlike dense pixel art).
- **Text minimap (grounding/backup):** a one-line ASCII/text minimap of the same 7×7 view, sent in the same call. If Gemma-4 vision isn't on the preview or fails the de-risk gate, the text minimap alone still carries the "perceive your world" framing — multimodal-adjacent and honest if stated.

### 4b. `decide(creature, perception, cb)` — one Gemma call
System prompt = the creature's persona + the rules of being alive here. User = the perception. Ask for a structured action + a short spoken thought.

```
SYSTEM:
You are {name}, a creature in a small world. {persona}
You have needs: hunger, energy, the wish for company. You want to survive
and live according to your nature. You can move toward things, eat, rest,
approach or avoid other creatures. Be true to your personality.

USER:
{perception text}
[cropped image of your surroundings attached]

Respond ONLY as JSON, no prose, no markdown:
{
  "action": "move_to" | "eat" | "rest" | "approach" | "avoid" | "wander",
  "target": "<creature id, food id, or direction>",
  "thought": "<your inner voice, under 12 words>",
  "feeling_about": { "<creature id>": <-1..1> }   // optional affinity update
}
```

The `thought` is the soul on screen — it floats above the creature and fades. The `feeling_about` quietly evolves relationships, which is how friendships and rivalries *emerge* without you scripting them.

**Parse defensively** (strip fences, `JSON.parse`, default to `wander` on failure). Gemma is not GPT-class at strict JSON, so harden it:
- Add **2–3 few-shot worked examples** to the system prompt (one `eat`, one `approach` with a `feeling_about` update, one `wander`). Few-shot is the single biggest reliability lever.
- **Truncate `thought` to 12 words** with an ellipsis rather than re-prompting (the constraint will be violated constantly — decide once).
- **Log the fallback rate.** If >15% of ticks fall back to `wander`, the society looks dumb and you'll know why — tighten the prompt or shrink the action set.
- If Cerebras exposes **constrained/grammar decoding** for Gemma, use it. Otherwise few-shot + tolerant parse is your stack.

### 4c. `applyDecisions`
- Resolve movement (lerp toward target tile over the render frames between ticks).
- Resolve eating (deplete food, drop hunger), resting (restore energy), social (proximity eases `social`, update relationships from `feeling_about`).
- **Record typed `RelationshipEvent`s** — when two creatures target the same food (`competed`), one eats while another is nearby (`shared_food`/`approached`), or one moves away (`avoided`). Cap ~6 per creature; this is what makes thoughts reference real history and friendships/rivalries legible.
- Append a terse line to each creature's `memory` (rolling, cap ~8 lines so context stays small/cheap).
- Emit per-creature events for the renderer (new pos, new thought, need bars).

---

## 5. Cerebras client notes

- OpenAI-compatible chat endpoint; model = the Gemma 4 preview id (confirm in console / #gemma-4-hackathon).
- **De-risk in the first 30 min (one script, see §8.1):** (a) confirm chat + JSON output from Bun; (b) send one iconic-image diagram and verify vision parses it; (c) **60s 25-way parallel soak** — fire 25 concurrent calls in a loop, report 429 rate + p99 latency. The granted rate-limit increase is not unlimited; verify your real sustained concurrency before building on it. Don't build past this until it returns.
- If vision is on the preview and passes the gate, send the iconic image per call. If not, the text minimap is already in the prompt — keep moving, don't let it block.
- Fire all per-tick calls in parallel with a concurrency cap (p-limit ~30, **lower it to ~15 if the soak shows 429s**). Retry w/ backoff on 429/5xx; on a creature's terminal failure, that creature just `wander`s this tick (graceful — the world never stalls).
- Keep each creature's context SMALL: persona + capped memory + last 2–3 relationship events + current perception only. This keeps tokens cheap and ticks fast — which lets you run MORE creatures, which is a better demo. Tight context is a feature here.
- **Cerebras key lives server-side only** (tiny Bun backend). Never inline it in the client bundle.
- Meter `totalCalls`, `tokensPerSec` and show it in a **prominent corner pill** (promoted from subtle — it's the throughput proof). Reinforced by the turbo/observe toggle (§9).

---

## 6. Three.js renderer

- **Scene:** orthographic camera looking down at a slight tilt for cozy depth. Tilemap drawn as instanced textured quads (or a single baked texture for terrain + sprite quads on top).
- **Creatures:** billboarded sprite quads, `NearestFilter`, frame-swap animation (idle/walk), position lerped between tick targets so they glide.
- **Thought bubbles:** small CSS/HTML overlays positioned via projecting the creature's 3D pos to screen space (cheap, crisp text) OR sprite-text in-scene. CSS overlay is faster to build and reads better — prefer it.
- **Perception images are NOT rendered here.** The iconic diagrams each creature "sees" are drawn on a small off-screen 2D canvas (§4a), never via Three.js render targets. Keep the GPU clean for the cozy scene only.
- **Atmosphere (this is the budget that buys "alive"):** warm ambient + one soft directional light; a firefly/mote particle system; a day/night color grade lerped from `world.timeOfDay`; gentle idle camera drift. Spend polish time HERE — it's what makes the clip beautiful.
- **Need bars:** tiny, subtle, on hover or always-on small — don't clutter the cozy.
- **Throughput pill:** prominent corner readout of `totalCalls` / `tokensPerSec` (§5) — this is the visible proof, not decoration.
- Performance: at 25 sprites + particles this is trivial for Three.js. Don't pre-optimize.

---

## 7. Transport (backend → renderer)

Same SSE pattern as the event doc, simpler payloads. Per tick, emit one `world_tick` with the deltas (moved creatures, new thoughts, food levels, deaths). Frontend reducer holds `WorldState`, the Three.js layer reads it and animates between ticks. (If you want, run the whole sim **client-side** and call Cerebras directly from a thin backend proxy — fewer moving parts, but keep the key server-side. For 12h, a tiny backend that proxies Cerebras + runs the tick loop + streams SSE is cleanest.)

---

## 8. Build order (12h, build-hard)

1. **(0:00–0:30) De-risk (one spike script):**
   - (a) Hit Gemma 4 on Cerebras from Bun; confirm chat + JSON output.
   - (b) Send one iconic-image diagram; verify vision parses it (gate for the multimodal leg).
   - (c) **60s 25-way parallel soak** — fire 25 concurrent calls in a loop; report 429 rate + p99 latency. Sets your real concurrency cap.
   - (d) Run the few-shot `decide` prompt; report JSON fallback rate (alarm if >15%).
   - **Also lock now:** pick a CC0 pixel sprite pack (or commit to colored squares); confirm the Cerebras key stays in the tiny Bun backend, never the client.
   - Don't build past this until it returns. This single script resolves spec issues #1, #6, #7, #9.
2. **(0:30–2:30) Headless sim:** WorldState, needs drift, food, the tick loop, `perceive`/`decide`/`apply`. Run in terminal, log creature thoughts + actions as text. **Gate (falsifiable, not a vibe): within 60 ticks, two creatures target the same food source and at least one thought names the other.** Prove the society in text before ANY rendering — this is the soul.
3. **(2:30–3:30) SSE bridge:** stream `world_tick` events; verify with curl.
4. **(3:30–7:00) Three.js renderer:** tilemap → sprites → position lerp → thought bubbles + the throughput pill. Get creatures visibly moving and thinking.
5. **(7:00–9:00) Atmosphere pass:** lighting, particles, day/night grade, camera drift, sprite polish. This is where it goes from "tech demo" to "beautiful." Don't skip.
6. **(9:00–10:30) Tune the drama:** set food scarcity / regrow so there's a cozy baseline with occasional tension; **seed the contested-bush initial conditions (§3)** so a tension beat is probable on cue. Pick creature count + tick rate that look alive and stay legible. Pre-write a few vivid personas so the thoughts are charming.
7. **(10:30–12:00) Capture + submit:** record 60–90s (state pitch → world breathing → zoom on two creatures' thoughts → a scarcity moment → society reacting). Submission leads with the pitch sentence + the "every creature is a live Gemma agent, all thinking at once on Cerebras" line.

---

## 9. Demo knobs (so it always looks good)

- **Pre-write 6–8 strong personas** (the loner, the hoarder, the generous one, the curious wanderer, the timid one). Distinct voices make the thoughts charming and the social dynamics legible. This is cheap and high-impact — it's your film-writing skill.
- **Dual mode: turbo/observe toggle (or auto-cycle 8s turbo → 8s observe).** Turbo runs the full population at true Cerebras speed — the throughput pill spikes, the world churns. Observe slows to ~2s ticks so thoughts are readable. The *contrast* is the pitch — judges see "fast" then "readable" rather than a meter they won't read. This replaces the weak "we slowed it for viewing" line with a visible feature.
- Tune scarcity for a **cozy-baseline-with-occasional-tension** rhythm; **seed the contested bush (§3)** so a tension beat is probable within the demo window, not left to chance. Constant crisis = grim; never any = boring. The wave is the story.
- Keep creature count where thoughts stay readable (20–25 is a sweet spot — clearly "many minds," still legible).
- Record at golden-hour color grade — it's the most beautiful frame and the best thumbnail.

---

## 10. Risks & fallbacks

| Risk | Fallback |
|---|---|
| Gemma 4 vision not on preview / fails the iconic-image gate | Text minimap perception (already in the prompt). Keep "creatures perceive their world" framing; it's multimodal-adjacent and honest if stated. Don't ship the off-screen scene-crop plumbing — it's a time pit. |
| Vision works but model ignores the image | A/B test with vs without the image on the soak; if decisions don't change, drop the image to save latency and keep text minimap only. |
| Gemma JSON unreliable (>15% fallback) | Few-shot examples, shrink the action set, truncate thought; if still bad, two-step (free thought → extract action). Log the rate. |
| Cerebras 429s under 25-way load | Drop p-limit to ~15, shrink per-creature context, add backoff. The soak (§8.1c) catches this at min 30, not hour 9. |
| Thoughts feel generic | Stronger personas (§9); feed last 2–3 typed relationship events into the prompt so thoughts reference real history. |
| Pixel-in-Three.js looks blurry | NearestFilter, integer-scaled textures, no mipmaps, snap sprite size to pixel multiples. |
| Society looks random/no patterns | Smaller perception radius + typed relationship events + memory → continuity → legible behavior. Slower tick so causality reads. |
| Tension never happens in the demo window | Seed the contested bush (§3); don't rely on pure emergence for the climax. |
| Ticks too slow / world stalls | Smaller context per creature, parallel fire, p-limit; failing creature just wanders that tick. |
| Too grim (deaths) | Make death rare, slow, gentle (fade + a soft thought). It's cozy survival, not a roguelike. |

---

## 11. Stretch (only if locked + demoed)

- **Player intervention:** drop food, or a "storm," and watch the society react live — turns it interactive and is an incredible clip. High payoff if time allows.
- **Memory across ticks → reputation:** creatures remember who shared vs hoarded, shifting alliances over time. Deepens the emergent story.
- **Ambient generative audio** (you have the ElevenLabs muscle): a soft evolving score keyed to world tension. Pure atmosphere, big for the video.
