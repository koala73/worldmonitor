# Contributing to Iran.skill

Thank you for your interest in contributing. This project benefits most from domain expertise rather than code.

## What We Need Most

### 1. Persian/Arabic/Hebrew Language Sources (Priority: Critical)
The biggest limitation of this skill is its English-source bias. If you can read Persian, Arabic, or Hebrew, your contributions are especially valuable:
- Translations or summaries of Iranian state media analysis
- IRGC Telegram channel monitoring
- Persian-language academic sources on Iran's political culture
- Hebrew-language Israeli security analysis

### 2. Israeli Domestic Politics (Priority: High)
- Netanyahu coalition dynamics updates
- Israeli polling data interpretation
- IDF strategic assessment analysis
- Knesset debate tracking on war/ceasefire

### 3. Quantitative Economic Data (Priority: High)
- Iran fiscal data (budget, oil revenue, IRGC economic activity)
- Sanctions evasion tracking
- Oil tanker movement data analysis
- Rial exchange rate and inflation tracking

### 4. Historical Depth (Priority: Medium)
- Additional Persian dynasty mental models
- Safavid/Qajar primary source translations
- Comparative empire analysis (Ottoman, Mughal parallels)

### 5. Translations (Priority: Medium)
- Full Arabic translation (for regional audiences)
- Persian translation (for Iranian diaspora researchers)
- Turkish translation (for regional context)

## How to Contribute

### For YAML/MD content files:
1. Fork the repository
2. Create a branch: `git checkout -b feature/your-addition`
3. Follow the existing file format (see `decisionmakers/trump.yaml` for YAML template)
4. Include `last_updated` timestamp
5. Include `evidence_quality` rating (★★★ to ☆☆☆)
6. Include `honest_limits` section
7. Submit a pull request with description of sources used

### For framework updates:
- All probability estimates must include source reasoning
- All historical mappings must include `contemporary_mapping` field
- All new constraints must be added to SKILL.md's hard constraint list if applicable

### For watchlist/real-time updates:
- Include source URLs
- Include timestamp
- Flag if based on single source vs. multiple verification

## Quality Standards

- **No single-source claims** for major judgments
- **Bias must be labeled** — every source's lean/funding must be disclosed
- **Honest limits required** — every file must state what it can't do
- **Evidence quality rated** — ★★★ (dual-verified) to ☆☆☆ (speculative)
- **No cultural essentialism** — "Persians are inherently X" is never acceptable

## Code of Conduct

This is a geopolitical analysis project covering an active conflict. Contributors must:
- Maintain analytical neutrality — this is not an advocacy tool for any side
- Respect the 4-angle verification requirement (US / Iran / third-party / historical)
- Not insert propaganda or single-perspective narratives
- Acknowledge uncertainty honestly
- Treat all populations with dignity regardless of government actions
