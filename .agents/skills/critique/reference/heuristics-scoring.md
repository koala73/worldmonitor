# Heuristics Scoring Guide

Score each of Nielsen's 10 Usability Heuristics on a 0–4 scale. Be honest — a 4 means genuinely excellent, not "good enough."

## Nielsen's 10 Heuristics

### 1. Visibility of System Status

Keep users informed about what's happening through timely, appropriate feedback.

**Check for**:
- Loading indicators during async operations
- Confirmation of user actions (save, submit, delete)
- Progress indicators for multi-step processes
- Current location in navigation (breadcrumbs, active states)
- Form validation feedback (inline, not just on submit)

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | No feedback — user is guessing what happened |
| 1 | Rare feedback — most actions produce no visible response |
| 2 | Partial — some states communicated, major gaps remain |
| 3 | Good — most operations give clear feedback, minor gaps |
| 4 | Excellent — every action confirms, progress is always visible |

### 2. Match Between System and Real World

Speak the user's language. Follow real-world conventions. Information appears in natural, logical order.

**Check for**:
- Familiar terminology (no unexplained jargon)
- Logical information order matching user expectations
- Recognizable icons and metaphors
- Domain-appropriate language for the target audience
- Natural reading flow (left-to-right, top-to-bottom priority)

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Pure tech jargon, alien to users |
| 1 | Mostly confusing — requires domain expertise to navigate |
| 2 | Mixed — some plain language, some jargon leaks through |
| 3 | Mostly natural — occasional term needs context |
| 4 | Speaks the user's language fluently throughout |

### 3. User Control and Freedom

Users need a clear "emergency exit" from unwanted states without extended dialogue.

**Check for**:
- Undo/redo functionality
- Cancel buttons on forms and modals
- Clear navigation back to safety (home, previous)
- Easy way to clear filters, search, selections
- Escape from long or multi-step processes

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Users get trapped — no way out without refreshing |
| 1 | Difficult exits — must find obscure paths to escape |
| 2 | Some exits — main flows have escape, edge cases don't |
| 3 | Good control — users can exit and undo most actions |
| 4 | Full control — undo, cancel, back, and escape everywhere |

### 4. Consistency and Standards

Users shouldn't wonder whether different words, situations, or actions mean the same thing.

**Check for**:
- Consistent terminology throughout the interface
- Same actions produce same results everywhere
- Platform conventions followed (standard UI patterns)
- Visual consistency (colors, typography, spacing, components)
- Consistent interaction patterns (same gesture = same behavior)

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Inconsistent everywhere — feels like different products stitched together |
| 1 | Many inconsistencies — similar things look/behave differently |
| 2 | Partially consistent — main flows match, details diverge |
| 3 | Mostly consistent — occasional deviation, nothing confusing |
| 4 | Fully consistent — cohesive system, predictable behavior |

### 5. Error Prevention

Better than good error messages is a design that prevents problems in the first place.

**Check for**:
- Confirmation before destructive actions (delete, overwrite)
- Constraints preventing invalid input (date pickers, dropdowns)
- Smart defaults that reduce errors
- Clear labels that prevent misunderstanding
- Autosave and draft recovery

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Errors easy to make — no guardrails anywhere |
| 1 | Few safeguards — some inputs validated, most aren't |
| 2 | Partial prevention — common errors caught, edge cases slip |
| 3 | Good prevention — most error paths blocked proactively |
| 4 | Excellent — errors nearly impossible through smart constraints |

### 6. Recognition Rather Than Recall

Minimize memory load. Make objects, actions, and options visible or easily retrievable.

**Check for**:
- Visible options (not buried in hidden menus)
- Contextual help when needed (tooltips, inline hints)
- Recent items and history
- Autocomplete and suggestions
- Labels on icons (not icon-only navigation)

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Heavy memorization — users must remember paths and commands |
| 1 | Mostly recall — many hidden features, few visible cues |
| 2 | Some aids — main actions visible, secondary features hidden |
| 3 | Good recognition — most things discoverable, few memory demands |
| 4 | Everything discoverable — users never need to memorize |

### 7. Flexibility and Efficiency of Use

Accelerators — invisible to novices — speed up expert interaction.

**Check for**:
- Keyboard shortcuts for common actions
- Customizable interface elements
- Recent items and favorites
- Bulk/batch actions
- Power user features that don't complicate the basics

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | One rigid path — no shortcuts or alternatives |
| 1 | Limited flexibility — few alternatives to the main path |
| 2 | Some shortcuts — basic keyboard support, limited bulk actions |
| 3 | Good accelerators — keyboard nav, some customization |
| 4 | Highly flexible — multiple paths, power features, customizable |

### 8. Aesthetic and Minimalist Design

Interfaces should not contain irrelevant or rarely needed information. Every element should serve a purpose.

**Check for**:
- Only necessary information visible at each step
- Clear visual hierarchy directing attention
- Purposeful use of color and emphasis
- No decorative clutter competing for attention
- Focused, uncluttered layouts

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Overwhelming — everything competes for attention equally |
| 1 | Cluttered — too much noise, hard to find what matters |
| 2 | Some clutter — main content clear, periphery noisy |
| 3 | Mostly clean — focused design, minor visual noise |
| 4 | Perfectly minimal — every element earns its pixel |

### 9. Help Users Recognize, Diagnose, and Recover from Errors

Error messages should use plain language, precisely indicate the problem, and constructively suggest a solution.

**Check for**:
- Plain language error messages (no error codes for users)
- Specific problem identification ("Email is missing @" not "Invalid input")
- Actionable recovery suggestions
- Errors displayed near the source of the problem
- Non-blocking error handling (don't wipe the form)

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | Cryptic errors — codes, jargon, or no message at all |
| 1 | Vague errors — "Something went wrong" with no guidance |
| 2 | Clear but unhelpful — names the problem but not the fix |
| 3 | Clear with suggestions — identifies problem and offers next steps |
| 4 | Perfect recovery — pinpoints issue, suggests fix, preserves user work |

### 10. Help and Documentation

Even if the system is usable without docs, help should be easy to find, task-focused, and concise.

**Check for**:
- Searchable help or documentation
- Contextual help (tooltips, inline hints, guided tours)
- Task-focused organization (not feature-organized)
- Concise, scannable content
- Easy access without leaving current context

**Scoring**:
| Score | Criteria |
|-------|----------|
| 0 | No help available anywhere |
| 1 | Help exists but hard to find or irrelevant |
| 2 | Basic help — FAQ or docs exist, not contextual |
| 3 | Good documentation — searchable, mostly task-focused |
| 4 | Excellent contextual help — right info at the right moment |

---

## Score Summary

**Total possible**: 40 points (10 heuristics × 4 max)

| Score Range | Rating | What It Means |
|-------------|--------|---------------|
| 36–40 | Excellent | Minor polish only — ship it |
| 28–35 | Good | Address weak areas, solid foundation |
| 20–27 | Acceptable | Significant improvements needed before users are happy |
| 12–19 | Poor | Major UX overhaul required — core experience broken |
| 0–11 | Critical | Redesign needed — unusable in current state |

---

## Issue Severity (P0–P3)

Tag each individual issue found during scoring with a priority level:

| Priority | Name | Description | Action |
|----------|------|-------------|--------|
| **P0** | Blocking | Prevents task completion entirely | Fix immediately — this is a showstopper |
| **P1** | Major | Causes significant difficulty or confusion | Fix before release |
| **P2** | Minor | Annoyance, but workaround exists | Fix in next pass |
| **P3** | Polish | Nice-to-fix, no real user impact | Fix if time permits |

**Tip**: If you're unsure between two levels, ask: "Would a user contact support about this?" If yes, it's at least P1.
