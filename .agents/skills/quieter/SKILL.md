---
name: quieter
description: Tones down visually aggressive or overstimulating designs, reducing intensity while preserving quality. Use when the user mentions too bold, too loud, overwhelming, aggressive, garish, or wants a calmer, more refined aesthetic.
user-invocable: true
argument-hint: "[target]"
---

Reduce visual intensity in designs that are too bold, aggressive, or overstimulating, creating a more refined and approachable aesthetic without losing effectiveness.

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first.

---

## Assess Current State

Analyze what makes the design feel too intense:

1. **Identify intensity sources**:
   - **Color saturation**: Overly bright or saturated colors
   - **Contrast extremes**: Too much high-contrast juxtaposition
   - **Visual weight**: Too many bold, heavy elements competing
   - **Animation excess**: Too much motion or overly dramatic effects
   - **Complexity**: Too many visual elements, patterns, or decorations
   - **Scale**: Everything is large and loud with no hierarchy

2. **Understand the context**:
   - What's the purpose? (Marketing vs tool vs reading experience)
   - Who's the audience? (Some contexts need energy)
   - What's working? (Don't throw away good ideas)
   - What's the core message? (Preserve what matters)

If any of these are unclear from the codebase, ask the user directly to clarify what you cannot infer.

**CRITICAL**: "Quieter" doesn't mean boring or generic. It means refined, sophisticated, and easier on the eyes. Think luxury, not laziness.

## Plan Refinement

Create a strategy to reduce intensity while maintaining impact:

- **Color approach**: Desaturate or shift to more sophisticated tones?
- **Hierarchy approach**: Which elements should stay bold (very few), which should recede?
- **Simplification approach**: What can be removed entirely?
- **Sophistication approach**: How can we signal quality through restraint?

**IMPORTANT**: Great quiet design is harder than great bold design. Subtlety requires precision.

## Refine the Design

Systematically reduce intensity across these dimensions:

### Color Refinement
- **Reduce saturation**: Shift from fully saturated to 70-85% saturation
- **Soften palette**: Replace bright colors with muted, sophisticated tones
- **Reduce color variety**: Use fewer colors more thoughtfully
- **Neutral dominance**: Let neutrals do more work, use color as accent (10% rule)
- **Gentler contrasts**: High contrast only where it matters most
- **Tinted grays**: Use warm or cool tinted grays instead of pure gray—adds sophistication without loudness
- **Never gray on color**: If you have gray text on a colored background, use a darker shade of that color or transparency instead

### Visual Weight Reduction
- **Typography**: Reduce font weights (900 → 600, 700 → 500), decrease sizes where appropriate
- **Hierarchy through subtlety**: Use weight, size, and space instead of color and boldness
- **White space**: Increase breathing room, reduce density
- **Borders & lines**: Reduce thickness, decrease opacity, or remove entirely

### Simplification
- **Remove decorative elements**: Gradients, shadows, patterns, textures that don't serve purpose
- **Simplify shapes**: Reduce border radius extremes, simplify custom shapes
- **Reduce layering**: Flatten visual hierarchy where possible
- **Clean up effects**: Reduce or remove blur effects, glows, multiple shadows

### Motion Reduction
- **Reduce animation intensity**: Shorter distances (10-20px instead of 40px), gentler easing
- **Remove decorative animations**: Keep functional motion, remove flourishes
- **Subtle micro-interactions**: Replace dramatic effects with gentle feedback
- **Refined easing**: Use ease-out-quart for smooth, understated motion—never bounce or elastic
- **Remove animations entirely** if they're not serving a clear purpose

### Composition Refinement
- **Reduce scale jumps**: Smaller contrast between sizes creates calmer feeling
- **Align to grid**: Bring rogue elements back into systematic alignment
- **Even out spacing**: Replace extreme spacing variations with consistent rhythm

**NEVER**:
- Make everything the same size/weight (hierarchy still matters)
- Remove all color (quiet ≠ grayscale)
- Eliminate all personality (maintain character through refinement)
- Sacrifice usability for aesthetics (functional elements still need clear affordances)
- Make everything small and light (some anchors needed)

## Verify Quality

Ensure refinement maintains quality:

- **Still functional**: Can users still accomplish tasks easily?
- **Still distinctive**: Does it have character, or is it generic now?
- **Better reading**: Is text easier to read for extended periods?
- **Sophistication**: Does it feel more refined and premium?

Remember: Quiet design is confident design. It doesn't need to shout. Less is more, but less is also harder. Refine with precision and maintain intentionality.