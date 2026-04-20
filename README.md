# Inclusive Design Analyzer — Figma Plugin

An AI-powered accessibility audit plugin that analyzes selected Figma frames using 6 parallel Claude agents. Instead of manual checklists, it reads real design data — contrast ratios, touch target sizes, layer names — and returns prioritized WCAG recommendations in seconds.

---

## What It Does

Select any frame in Figma and the plugin extracts:

- **Text layers** — font size, color, background, pre-calculated contrast ratio
- **Interactive components** — exact pixel dimensions, touch target pass/fail
- **Icon-only elements** — flags missing text alternatives
- **Color palette** — full list of colors in use

Six AI agents then analyze this data in parallel:

| Agent | Analyzes |
|---|---|
| 👁 Vision | Contrast ratios, text size, color-only information |
| 🧠 Cognitive | Complexity, memory load, language, number of steps |
| ✋ Motor | Touch targets, keyboard accessibility, interaction precision |
| 👂 Hearing | Audio dependencies, caption gaps, sound-only alerts |
| 📊 ROI | Market unreached, legal exposure, business case |
| ◈ Synthesis | Combines all findings into a prioritized remediation plan |

Results reference your **exact layer names** — not generic advice.

---

## Installation

1. Download or clone this repo
2. Open Figma desktop app
3. Go to **Plugins → Development → Import plugin from manifest**
4. Select `manifest.json` from this folder

---

## Usage

1. Open the plugin in any Figma file
2. Click **⚙** and enter your [Anthropic API key](https://console.anthropic.com/) — saved locally to your device
3. Select a frame or component in Figma
4. Click **Analyze Selected Frame**
5. Review results in ~15–30 seconds

---

## Requirements

- Figma desktop app (not browser)
- Anthropic API key (`sk-ant-...`)
- The selected frame should have at least some text or interactive elements

---

## Tech Stack

- **Figma Plugin API v1** — reads node tree, stores API key in `clientStorage`
- **Claude Haiku 4.5** — 5 specialist agents (vision, cognitive, motor, hearing, ROI)
- **Claude Sonnet 4.6** — synthesis agent (combines findings, prioritizes recommendations)
- **Prompt caching** — system prompts cached across agents for efficiency
- No build step, no dependencies, no backend

---

## Methodology

Based on the [Cambridge Inclusive Design Toolkit](https://www.inclusivedesigntoolkit.com/) exclusion calculator methodology. Exclusion percentages are estimates grounded in UK Disability Follow-up Survey data and WHO global disability prevalence figures (15–16%).

WCAG compliance assessments reference [WCAG 2.1 AA](https://www.w3.org/WAI/WCAG21/quickref/) criteria.

---

## License

MIT
