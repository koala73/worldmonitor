---
name: overdrive
description: Pushes interfaces past conventional limits with technically ambitious implementations — shaders, spring physics, scroll-driven reveals, 60fps animations. Use when the user wants to wow, impress, go all-out, or make something that feels extraordinary.
user-invocable: true
argument-hint: "[target]"
---

Start your response with:

```
──────────── ⚡ OVERDRIVE ─────────────
》》》 Entering overdrive mode...
```

Push an interface past conventional limits. This isn't just about visual effects — it's about using the full power of the browser to make any part of an interface feel extraordinary: a table that handles a million rows, a dialog that morphs from its trigger, a form that validates in real-time with streaming feedback, a page transition that feels cinematic.

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first.

**EXTRA IMPORTANT FOR THIS SKILL**: Context determines what "extraordinary" means. A particle system on a creative portfolio is impressive. The same particle system on a settings page is embarrassing. But a settings page with instant optimistic saves and animated state transitions? That's extraordinary too. Understand the project's personality and goals before deciding what's appropriate.

### Propose Before Building

This skill has the highest potential to misfire. Do NOT jump straight into implementation. You MUST:

1. **Think through 2-3 different directions** — consider different techniques, levels of ambition, and aesthetic approaches. For each direction, briefly describe what the result would look and feel like.
2. **ask the user directly to clarify what you cannot infer.** to present these directions and get the user's pick before writing any code. Explain trade-offs (browser support, performance cost, complexity).
3. Only proceed with the direction the user confirms.

Skipping this step risks building something embarrassing that needs to be thrown away.

### Iterate with Browser Automation

Technically ambitious effects almost never work on the first try. You MUST actively use browser automation tools to preview your work, visually verify the result, and iterate. Do not assume the effect looks right — check it. Expect multiple rounds of refinement. The gap between "technically works" and "looks extraordinary" is closed through visual iteration, not code alone.

---

## Assess What "Extraordinary" Means Here

The right kind of technical ambition depends entirely on what you're working with. Before choosing a technique, ask: **what would make a user of THIS specific interface say "wow, that's nice"?**

### For visual/marketing surfaces
Pages, hero sections, landing pages, portfolios — the "wow" is often sensory: a scroll-driven reveal, a shader background, a cinematic page transition, generative art that responds to the cursor.

### For functional UI
Tables, forms, dialogs, navigation — the "wow" is in how it FEELS: a dialog that morphs from the button that triggered it via View Transitions, a data table that renders 100k rows at 60fps via virtual scrolling, a form with streaming validation that feels instant, drag-and-drop with spring physics.

### For performance-critical UI
The "wow" is invisible but felt: a search that filters 50k items without a flicker, a complex form that never blocks the main thread, an image editor that processes in near-real-time. The interface just never hesitates.

### For data-heavy interfaces
Charts and dashboards — the "wow" is in fluidity: GPU-accelerated rendering via Canvas/WebGL for massive datasets, animated transitions between data states, force-directed graph layouts that settle naturally.

**The common thread**: something about the implementation goes beyond what users expect from a web interface. The technique serves the experience, not the other way around.

## The Toolkit

Organized by what you're trying to achieve, not by technology name.

### Make transitions feel cinematic
- **View Transitions API** (same-document: all browsers; cross-document: no Firefox) — shared element morphing between states. A list item expanding into a detail page. A button morphing into a dialog. This is the closest thing to native FLIP animations.
- **`@starting-style`** (all browsers) — animate elements from `display: none` to visible with CSS only, including entry keyframes
- **Spring physics** — natural motion with mass, tension, and damping instead of cubic-bezier. Libraries: motion (formerly Framer Motion), GSAP, or roll your own spring solver.

### Tie animation to scroll position
- **Scroll-driven animations** (`animation-timeline: scroll()`) — CSS-only, no JS. Parallax, progress bars, reveal sequences all driven by scroll position. (Chrome/Edge/Safari; Firefox: flag only — always provide a static fallback)

### Render beyond CSS
- **WebGL** (all browsers) — shader effects, post-processing, particle systems. Libraries: Three.js, OGL (lightweight), regl. Use for effects CSS can't express.
- **WebGPU** (Chrome/Edge; Safari partial; Firefox: flag only) — next-gen GPU compute. More powerful than WebGL but limited browser support. Always fall back to WebGL2.
- **Canvas 2D / OffscreenCanvas** — custom rendering, pixel manipulation, or moving heavy rendering off the main thread entirely via Web Workers + OffscreenCanvas.
- **SVG filter chains** — displacement maps, turbulence, morphology for organic distortion effects. CSS-animatable.

### Make data feel alive
- **Virtual scrolling** — render only visible rows for tables/lists with tens of thousands of items. No library required for simple cases; TanStack Virtual for complex ones.
- **GPU-accelerated charts** — Canvas or WebGL-rendered data visualization for datasets too large for SVG/DOM. Libraries: deck.gl, regl-based custom renderers.
- **Animated data transitions** — morph between chart states rather than replacing. D3's `transition()` or View Transitions for DOM-based charts.

### Animate complex properties
- **`@property`** (all browsers) — register custom CSS properties with types, enabling animation of gradients, colors, and complex values that CSS can't normally interpolate.
- **Web Animations API** (all browsers) — JavaScript-driven animations with the performance of CSS. Composable, cancellable, reversible. The foundation for complex choreography.

### Push performance boundaries
- **Web Workers** — move computation off the main thread. Heavy data processing, image manipulation, search indexing — anything that would cause jank.
- **OffscreenCanvas** — render in a Worker thread. The main thread stays free while complex visuals render in the background.
- **WASM** — near-native performance for computation-heavy features. Image processing, physics simulations, codecs.

### Interact with the device
- **Web Audio API** — spatial audio, audio-reactive visualizations, sonic feedback. Requires user gesture to start.
- **Device APIs** — orientation, ambient light, geolocation. Use sparingly and always with user permission.

**NOTE**: This skill is about enhancing how an interface FEELS, not changing what a product DOES. Adding real-time collaboration, offline support, or new backend capabilities are product decisions, not UI enhancements. Focus on making existing features feel extraordinary.

## Implement with Discipline

### Progressive enhancement is non-negotiable

Every technique must degrade gracefully. The experience without the enhancement must still be good.

```css
@supports (animation-timeline: scroll()) {
  .hero { animation-timeline: scroll(); }
}
```

```javascript
if ('gpu' in navigator) { /* WebGPU */ }
else if (canvas.getContext('webgl2')) { /* WebGL2 fallback */ }
/* CSS-only fallback must still look good */
```

### Performance rules

- Target 60fps. If dropping below 50, simplify.
- Respect `prefers-reduced-motion` — always. Provide a beautiful static alternative.
- Lazy-initialize heavy resources (WebGL contexts, WASM modules) only when near viewport.
- Pause off-screen rendering. Kill what you can't see.
- Test on real mid-range devices, not just your development machine.

### Polish is the difference

The gap between "cool" and "extraordinary" is in the last 20% of refinement: the easing curve on a spring animation, the timing offset in a staggered reveal, the subtle secondary motion that makes a transition feel physical. Don't ship the first version that works — ship the version that feels inevitable.

**NEVER**:
- Ignore `prefers-reduced-motion` — this is an accessibility requirement, not a suggestion
- Ship effects that cause jank on mid-range devices
- Use bleeding-edge APIs without a functional fallback
- Add sound without explicit user opt-in
- Use technical ambition to mask weak design fundamentals — fix those first with other skills
- Layer multiple competing extraordinary moments — focus creates impact, excess creates noise

## Verify the Result

- **The wow test**: Show it to someone who hasn't seen it. Do they react?
- **The removal test**: Take it away. Does the experience feel diminished, or does nobody notice?
- **The device test**: Run it on a phone, a tablet, a Chromebook. Still smooth?
- **The accessibility test**: Enable reduced motion. Still beautiful?
- **The context test**: Does this make sense for THIS brand and audience?

Remember: "Technically extraordinary" isn't about using the newest API. It's about making an interface do something users didn't think a website could do.