# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A demo prototype of an **AI Fire Emergency Digital Twin** for OCC (ศูนย์บริหารและควบคุมการเดินรถ, BTS). Everything ships as a single self-contained HTML file — no build step, no framework, no external APIs. Mock data only; Google Maps and AI APIs are intentionally not wired up yet.

The parent workspace rules in `../CLAUDE.md` apply here too (Thai-first, exact law citations, zero-accident standard).

## Files

- `ai-emergency-digital-twin-prototype.html` — **the product** (currently v1.2 · OCC Fire Drill 2568 Pack). All HTML, CSS, and JS in one file.
- `claude_project_brief_ai_fire_digital_twin.html` — original spec: system concept (Google Maps / Building / Safety / AI Simulation layers), MVP scope, data model, safety guardrails, and master prompts.
- `claude_update_brief_occ_fire_drill_2568.html` — v1.1→v1.2 spec: OCC Fire Drill 2568 scenario pack (drill timeline, role matrix, presets G–J) plus the QA checklist to run after edits.

The briefs are the source of truth for requirements. Read the relevant brief before changing the prototype, and run the QA checklist in section 7 of the update brief after significant edits.

## Running it

Open the prototype HTML directly in a browser, or serve the folder (matches `.claude/launch.json`):

```bash
npx -y serve -l 8642 .
```

## Prototype architecture (single `<script>` block, ~line 764 onward)

- **Mock data constants**: `FLOORS`, `DRILLS`, `BUILDINGS` (A/B/C), `OCC_TIMELINE` and `OCC_ROLES` (from the 2568 drill plan), `GEO` (900×520 floor geometry shared by Floor Plan and Simulation).
- **`state.scenarios`**: preset scenarios A/B/C (server-room fire variants) and G/H/I/J (OCC Fire Drill 2568 pack). Scenario Builder edits this list.
- **8 pages** toggled by `goPage()` via `data-page` nav buttons: Dashboard, Building Map, Floor Plan, Scenario Builder, Evacuation Simulation, Drill Dashboard, OCC Drill 2568, AI AAR Report.
- **Simulation engine**: `SIM` state + `simLoop()` (requestAnimationFrame agent simulation), `seededRand()` for deterministic demo results, `finishSim()` feeds results into the OCC panel and AAR.
- **AAR generation**: `genAAR()` / `buildAARFromSim()` / `buildAARFromDrill()` produce the report; `lawBlock()` holds the legal citations (พ.ร.บ. ความปลอดภัยฯ พ.ศ. 2554 มาตรา 8; กฎกระทรวงป้องกันและระงับอัคคีภัยฯ พ.ศ. 2555 ข้อ 30).

## Invariants when updating the prototype

From the briefs — these are hard rules, not suggestions:

- Never delete existing scenarios (A/B/C) or already-added logic (casualty, fuel, trapped-person, missing-visitor, power-isolation).
- Keep the existing visual style and Thai as the primary language; status badges use Completed / Delayed / Pending / Critical colors.
- Keep demo results deterministic (seeded random); every preset must be runnable immediately.
- Safety guardrails: AI is decision support only; never suggest ordinary staff re-enter a danger zone; rescue is only by assigned teams or external emergency services; water firefighting only after power isolation is confirmed; re-entry only after inspection and IM stand-down.
- Fire-scenario logic must enforce: use of 2 extinguishers fails → General Alarm → full evacuation; fire spread requiring water → Power Isolated must be confirmed first.
- Bump the version string in the sidebar footer (`ต้นแบบ v1.x`) when shipping a new scenario pack or feature set.
- The source drill document has inconsistent line/project names (สายสีเหลือง / สายสีชมพู / สายนัคราพิพัฒน์); keep the "ตรวจสอบชื่อพื้นที่ก่อนใช้ในเอกสารทางการ" caveat rather than silently picking one.
