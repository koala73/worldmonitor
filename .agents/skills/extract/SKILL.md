---
name: extract
description: Extract and consolidate reusable components, design tokens, and patterns into your design system. Identifies opportunities for systematic reuse and enriches your component library. Use when the user asks to create components, refactor repeated UI patterns, build a design system, or extract tokens.
user-invocable: true
argument-hint: "[target]"
---

Identify reusable patterns, components, and design tokens, then extract and consolidate them into the design system for systematic reuse.

## Discover

Analyze the target area to identify extraction opportunities:

1. **Find the design system**: Locate your design system, component library, or shared UI directory (grep for "design system", "ui", "components", etc.). Understand its structure:
   - Component organization and naming conventions
   - Design token structure (if any)
   - Documentation patterns
   - Import/export conventions
   
   **CRITICAL**: If no design system exists, ask before creating one. Understand the preferred location and structure first.

2. **Identify patterns**: Look for:
   - **Repeated components**: Similar UI patterns used multiple times (buttons, cards, inputs, etc.)
   - **Hard-coded values**: Colors, spacing, typography, shadows that should be tokens
   - **Inconsistent variations**: Multiple implementations of the same concept (3 different button styles)
   - **Reusable patterns**: Layout patterns, composition patterns, interaction patterns worth systematizing

3. **Assess value**: Not everything should be extracted. Consider:
   - Is this used 3+ times, or likely to be reused?
   - Would systematizing this improve consistency?
   - Is this a general pattern or context-specific?
   - What's the maintenance cost vs benefit?

## Plan Extraction

Create a systematic extraction plan:

- **Components to extract**: Which UI elements become reusable components?
- **Tokens to create**: Which hard-coded values become design tokens?
- **Variants to support**: What variations does each component need?
- **Naming conventions**: Component names, token names, prop names that match existing patterns
- **Migration path**: How to refactor existing uses to consume the new shared versions

**IMPORTANT**: Design systems grow incrementally. Extract what's clearly reusable now, not everything that might someday be reusable.

## Extract & Enrich

Build improved, reusable versions:

- **Components**: Create well-designed components with:
  - Clear props API with sensible defaults
  - Proper variants for different use cases
  - Accessibility built in (ARIA, keyboard navigation, focus management)
  - Documentation and usage examples
  
- **Design tokens**: Create tokens with:
  - Clear naming (primitive vs semantic)
  - Proper hierarchy and organization
  - Documentation of when to use each token
  
- **Patterns**: Document patterns with:
  - When to use this pattern
  - Code examples
  - Variations and combinations

**NEVER**:
- Extract one-off, context-specific implementations without generalization
- Create components so generic they're useless
- Extract without considering existing design system conventions
- Skip proper TypeScript types or prop documentation
- Create tokens for every single value (tokens should have semantic meaning)

## Migrate

Replace existing uses with the new shared versions:

- **Find all instances**: Search for the patterns you've extracted
- **Replace systematically**: Update each use to consume the shared version
- **Test thoroughly**: Ensure visual and functional parity
- **Delete dead code**: Remove the old implementations

## Document

Update design system documentation:

- Add new components to the component library
- Document token usage and values
- Add examples and guidelines
- Update any Storybook or component catalog

Remember: A good design system is a living system. Extract patterns as they emerge, enrich them thoughtfully, and maintain them consistently.