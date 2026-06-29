# Grove

> A living 3D world where 25 independent Gemma 4 agents perceive, think, and act — powered by Cerebras inference at ~5,600 tok/s.

Built for the **Cerebras x Google DeepMind Gemma 4 Hackathon** — *Best Multi-Agent + Multimodal Use Case*.

---

## What is this?

Grove is a real-time 3D society simulation. 25 creatures, each with a unique personality, live in a shared world rendered with Three.js. Every few seconds, all 25 agents simultaneously:

1. **Perceive** their surroundings — a rendered PNG image of their 7×7 local view + a structured text minimap (multimodal input)
2. **Decide** what to do — move toward food, eat, rest, approach a friend, avoid a rival, or wander (Gemma 4 31B generates a JSON decision with a natural-language thought)
3. **Act** — the world applies their decisions, updates needs (hunger, energy, social), and records relationship events

Every thought bubble you see floating above a creature is a **real LLM output**, not scripted. When food runs low, the society shows its true character — who shares, who hoards, who wanders off alone.

## Why it's multimodal (not just text with an image attached)

We ran a controlled A/B test (`spike/ab-multimodal.ts`) to verify the image is load-bearing:

| Condition | Input | Result |
|---|---|---|
| **A (multimodal)** | Text minimap + PNG image | Agent decisions and reasoning |
| **B (text-only)** | Text minimap only | Agent decisions and reasoning |

| Metric | Divergence | Meaning |
|---|---|---|
| Action changed | **22%** of trials | The image caused a different decision |
| Thought changed | **67%** of trials | The image shaped reasoning even when actions matched |

**Key finding:** Ripple (a social creature) chose to approach a nearby friend **only when the image was provided**. Without the image, she always chose to eat — the text described both options, but the spatial/visual representation made social proximity more salient. The image is not decorative; it changes behavior.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser (SSE)                  │
│  Three.js 3D renderer: terrain, creatures,       │
│  weather, day/night, thought bubbles, camera     │
└──────────────────────┬──────────────────────────┘
                       │ SSE stream (world state)
┌──────────────────────┴──────────────────────────┐
│              Bun Server (src/server.ts)          │
│  Tick loop → broadcast world state to clients    │
└──────────────────────┬──────────────────────────┘
                       │ 25 parallel decide() calls
┌──────────────────────┴──────────────────────────┐
│            World Engine (src/world.ts)           │
│  perceive() → decide() → applyDecisions()        │
│  Each creature gets: PNG image + text minimap    │
└──────────────────────┬──────────────────────────┘
                       │ Multimodal chat completion
┌──────────────────────┴──────────────────────────┐
│         Cerebras API (src/cerebras.ts)           │
│  gemma-4-31b · ~5,600 tok/s · retry/backoff     │
└─────────────────────────────────────────────────┘
```

### Multimodal perception pipeline

Each tick, for every creature, `perceive()` builds:

- **A 7×7 iconic PNG image** (196×196px) — the creature's local view. Each cell is 28×28 pixels: grass=green, water=blue, rock=gray, food=bright green, self=white-outlined square, other creatures=their persona color
- **A text minimap** — ASCII grid (`@`=self, `F`=food, `~`=water, `#`=rock, letters=other creatures) + structured text listing nearby creatures with distances/affinity, food amounts, recent memory, and relationship events

Both are sent to Gemma 4 in a single multimodal call. The model responds with JSON: `{action, target, thought, feeling_about}`.

## Key results

| Metric | Value | Source |
|---|---|---|
| Agents | 25 parallel | Architecture |
| Throughput | ~5,600 tok/s | Cerebras metrics |
| JSON reliability | 100% (75/75 calls) | De-risk spike |
| Vision changes decisions | 22% of trials | A/B test |
| Vision changes reasoning | 67% of trials | A/B test |
| Falsifiable gate | PASSED on tick 2 | Headless sim |

**Falsifiable gate:** "Within 3 ticks, two creatures target the same food source and one thought names the other." On tick 2, Flint thought *"This food is mine. Pip can't have it."* while competing with Pip for the same bush. The seeded drama (a contested bush between a hoarder and a generous creature) produced legible competition immediately.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) runtime
- A Cerebras API key with access to `gemma-4-31b`

### Setup

```bash
git clone https://github.com/ik-labs/grove.git
cd grove
cp .env.example .env
# Edit .env and add your Cerebras API key
# CEREBRAS_API_KEY=csk-...
```

### Run the visual sim

```bash
bun run server
# Open http://localhost:3000
```

### Run the headless sim (falsifiable gate)

```bash
GROVE_MAX_TICKS=10 bun run src/sim.ts
```

### Run the A/B multimodal test

```bash
bun run spike/ab-multimodal.ts
```

### Run the de-risk spike

```bash
bun run derisk           # quick checks
bun run derisk:soak      # 60s soak test at 25-way concurrency
```

## Project structure

```
├── src/
│   ├── cerebras.ts      # Cerebras client: chat(), encodePNG(), retry/backoff, metrics
│   ├── world.ts         # World model: types, initWorld(), perceive(), decide(), applyDecisions()
│   ├── sim.ts           # Headless tick loop + falsifiable gate
│   └── server.ts        # Bun HTTP server: SSE streaming, static files, tick loop
├── web/
│   └── index.html       # Single-file frontend: Three.js 3D renderer, terrain, creatures, weather, day/night, thought bubbles, camera controls
├── spike/
│   ├── derisk.ts        # De-risk spike: model access, vision, JSON, soak test
│   ├── ab-multimodal.ts # A/B test: does the image change decisions?
│   └── iconic.png       # Sample iconic perception image
├── grove-spec-v1.md     # Full project spec with de-risking notes
└── .env.example         # Environment template (no secrets)
```

## The 25 creatures

Each has a distinct personality that shapes their decisions:

| Name | Personality | Color |
|---|---|---|
| Lumen | Warm, generous, shares food | Amber |
| Pip | Selfish, anxious, hoards | Red |
| Thorn | Loner, seeks solitude | Brown |
| Fern | Curious, restless explorer | Green |
| Moss | Timid, flees conflict | Dark green |
| Ash | Calm, wise elder | Gray |
| Ripple | Social, chatty, craves company | Blue |
| Sage | Contemplative, holds grudges | Purple |
| Breeze | Gentle, helpful | Mint |
| Flint | Competitive, proud | Orange |
| Glow | Optimistic, cheerful | Yellow |
| Hush | Quiet, watchful | Slate |
| Dash | Fast, impulsive | Pink |
| Vine | Slow, deliberate | Olive |
| Ember | Passionate, fiercely loyal | Red-orange |
| Pebble | Small but determined | Stone |
| Mist | Dreamy, absent-minded | Lavender |
| Root | Grounded, practical | Brown |
| Sky | Free-spirited, trusting | Sky blue |
| Bramble | Prickly, defensive | Dark brown |
| Puddle | Playful, silly | Teal |
| Stone | Stubborn, unmovable | Gray |
| Wisp | Ethereal, gentle | Cream |
| Cinder | Quietly angry, wants fairness | Dark red |
| Honey | Sweet, nurturing | Gold |

## Tech stack

- **Runtime:** [Bun](https://bun.sh)
- **LLM:** Gemma 4 31B via Cerebras API
- **Frontend:** Single-file HTML + Three.js 3D renderer (no build step, CDN-loaded)
- **Rendering:** Three.js — 3D terrain with height variations, dynamic lighting with shadows, day/night cycle, weather particles (rain/snow/fireflies), interactive orbit camera, creature animations (bobbing, squish, eye-tracking)
- **Streaming:** Server-Sent Events (SSE)

## Rate limit notes

Cerebras hackathon capacity is ~100 RPM with a ~100-call burst. At 25 creatures per tick:
- First ~4 ticks: ~4s each (burst capacity)
- After burst: ~15s per tick (rate-limited, retry/backoff)
- The client handles 429s gracefully — the world never stalls, just breathes slower

## License

MIT
