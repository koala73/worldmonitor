# Cognitive Load Assessment

Cognitive load is the total mental effort required to use an interface. Overloaded users make mistakes, get frustrated, and leave. This reference helps identify and fix cognitive overload.

---

## Three Types of Cognitive Load

### Intrinsic Load — The Task Itself
Complexity inherent to what the user is trying to do. You can't eliminate this, but you can structure it.

**Manage it by**:
- Breaking complex tasks into discrete steps
- Providing scaffolding (templates, defaults, examples)
- Progressive disclosure — show what's needed now, hide the rest
- Grouping related decisions together

### Extraneous Load — Bad Design
Mental effort caused by poor design choices. **Eliminate this ruthlessly** — it's pure waste.

**Common sources**:
- Confusing navigation that requires mental mapping
- Unclear labels that force users to guess meaning
- Visual clutter competing for attention
- Inconsistent patterns that prevent learning
- Unnecessary steps between user intent and result

### Germane Load — Learning Effort
Mental effort spent building understanding. This is *good* cognitive load — it leads to mastery.

**Support it by**:
- Progressive disclosure that reveals complexity gradually
- Consistent patterns that reward learning
- Feedback that confirms correct understanding
- Onboarding that teaches through action, not walls of text

---

## Cognitive Load Checklist

Evaluate the interface against these 8 items:

- [ ] **Single focus**: Can the user complete their primary task without distraction from competing elements?
- [ ] **Chunking**: Is information presented in digestible groups (≤4 items per group)?
- [ ] **Grouping**: Are related items visually grouped together (proximity, borders, shared background)?
- [ ] **Visual hierarchy**: Is it immediately clear what's most important on the screen?
- [ ] **One thing at a time**: Can the user focus on a single decision before moving to the next?
- [ ] **Minimal choices**: Are decisions simplified (≤4 visible options at any decision point)?
- [ ] **Working memory**: Does the user need to remember information from a previous screen to act on the current one?
- [ ] **Progressive disclosure**: Is complexity revealed only when the user needs it?

**Scoring**: Count the failed items. 0–1 failures = low cognitive load (good). 2–3 = moderate (address soon). 4+ = high cognitive load (critical fix needed).

---

## The Working Memory Rule

**Humans can hold ≤4 items in working memory at once** (Miller's Law revised by Cowan, 2001).

At any decision point, count the number of distinct options, actions, or pieces of information a user must simultaneously consider:
- **≤4 items**: Within working memory limits — manageable
- **5–7 items**: Pushing the boundary — consider grouping or progressive disclosure
- **8+ items**: Overloaded — users will skip, misclick, or abandon

**Practical applications**:
- Navigation menus: ≤5 top-level items (group the rest under clear categories)
- Form sections: ≤4 fields visible per group before a visual break
- Action buttons: 1 primary, 1–2 secondary, group the rest in a menu
- Dashboard widgets: ≤4 key metrics visible without scrolling
- Pricing tiers: ≤3 options (more causes analysis paralysis)

---

## Common Cognitive Load Violations

### 1. The Wall of Options
**Problem**: Presenting 10+ choices at once with no hierarchy.
**Fix**: Group into categories, highlight recommended, use progressive disclosure.

### 2. The Memory Bridge
**Problem**: User must remember info from step 1 to complete step 3.
**Fix**: Keep relevant context visible, or repeat it where it's needed.

### 3. The Hidden Navigation
**Problem**: User must build a mental map of where things are.
**Fix**: Always show current location (breadcrumbs, active states, progress indicators).

### 4. The Jargon Barrier
**Problem**: Technical or domain language forces translation effort.
**Fix**: Use plain language. If domain terms are unavoidable, define them inline.

### 5. The Visual Noise Floor
**Problem**: Every element has the same visual weight — nothing stands out.
**Fix**: Establish clear hierarchy: one primary element, 2–3 secondary, everything else muted.

### 6. The Inconsistent Pattern
**Problem**: Similar actions work differently in different places.
**Fix**: Standardize interaction patterns. Same type of action = same type of UI.

### 7. The Multi-Task Demand
**Problem**: Interface requires processing multiple simultaneous inputs (reading + deciding + navigating).
**Fix**: Sequence the steps. Let the user do one thing at a time.

### 8. The Context Switch
**Problem**: User must jump between screens/tabs/modals to gather info for a single decision.
**Fix**: Co-locate the information needed for each decision. Reduce back-and-forth.
