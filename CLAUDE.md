# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

An **AI Fire Emergency Digital Twin** for OCC (ศูนย์บริหารและควบคุมการเดินรถ, BTS), currently **v1.8 · Vector Digital Twin — Backend proxy + Login ตามบทบาท**. The frontend is still a single self-contained HTML file with no build step and no framework, but as of v1.8 it is backed by real Vercel serverless functions: role-based login, a Claude API proxy, and a Google Maps key proxy. It is a drill/training tool — the login screen and footer both say so — not a live life-safety system, and it must never be presented as one.

The parent workspace rules in `../CLAUDE.md` apply here too (Thai-first, exact law citations, zero-accident standard).

## Files

- `ai-emergency-digital-twin-prototype.html` — **the product** (v1.8). All HTML, CSS, and JS for the app in one file (~3000+ lines). Talks to the backend under `api/`.
- `api/` — Vercel serverless functions (backend). See **API directory** below.
- `vercel.json` — routes `/` to the prototype HTML; `api/*.js` files are picked up automatically by Vercel's zero-config Node.js function convention (no explicit function config or `package.json` needed — the code uses only Node built-ins and the global `fetch`).
- `.env.example` — documents every required environment variable (placeholders only, safe to read). See **Authentication & session flow** and **Deployment model**.
- `claude_project_brief_ai_fire_digital_twin.html` — original spec: system concept (Google Maps / Building / Safety / AI Simulation layers), MVP scope, data model, safety guardrails, and master prompts.
- `claude_update_brief_occ_fire_drill_2568.html` — v1.1→v1.2 spec: OCC Fire Drill 2568 scenario pack (drill timeline, role matrix, presets G–J) plus a QA checklist.
- `ai-emergency-digital-twin-vector-floorplan.html` — a standalone vector floor-plan exploration. It is **not** linked from or loaded by the main prototype and has no `api/` calls — treat it as a separate design reference, not part of the shipped app, unless a future brief says otherwise.

There is no brief in this repo covering the v1.3→v1.8 jump (login, RBAC, Claude proxy, Maps proxy). Code comments reference "the plan" for the RBAC matrix and Google Cloud key setup, but no such document exists in the repo — treat the code and this file as the source of truth for that range of changes, and don't assume a missing brief exists elsewhere.

## Running it

The app has two layers now — a static frontend and Vercel serverless functions — so how you run it depends on what you need to test:

```bash
# Static-only: layout, pages, simulation, scenario builder. Login/AI/Maps will NOT work
# (no /api/* routes are served) — attemptLogin(), sendAIChat(), and fetchMapsKey() will all fail.
npx -y serve -l 8642 .

# Full stack, including login, Claude proxy, and Maps proxy — requires the Vercel CLI
# and a .env.local populated from .env.example.
vercel dev
```

When testing anything under Login, AI Advisory chat, AI AAR insight, or Building Map's live Google Map, use `vercel dev`, not plain `serve` — otherwise every `/api/*` fetch will 404 and you'll misdiagnose a frontend bug that is actually just a missing backend.

## Prototype architecture (single `<script>` block, ~line 764 onward)

- **Mock data constants**: `FLOORS`, `DRILLS`, `BUILDINGS` (A/B/C), `OCC_TIMELINE` and `OCC_ROLES` (from the 2568 drill plan), `GEO` (900×520 floor geometry shared by Floor Plan and Simulation).
- **`state.scenarios`**: preset scenarios A/B/C (server-room fire variants) and G/H/I/J (OCC Fire Drill 2568 pack). Scenario Builder edits this list.
- **8 pages** toggled by `goPage()` via `data-page` nav buttons: Dashboard, Building Map, Floor Plan, Scenario Builder, Evacuation Simulation, Drill Dashboard, OCC Drill 2568, AI AAR Report.
- **Simulation engine**: `SIM` state + `simLoop()` (requestAnimationFrame agent simulation), `seededRand()` for deterministic demo results, `finishSim()` feeds results into the OCC panel and AAR. This stays fully client-side and deterministic — it does not call the backend.
- **AAR generation**: `genAAR()` / `buildAARFromSim()` / `buildAARFromDrill()` produce the template-based report; `lawBlock()` holds the legal citations (พ.ร.บ. ความปลอดภัยฯ พ.ศ. 2554 มาตรา 8; กฎกระทรวงป้องกันและระงับอัคคีภัยฯ พ.ศ. 2555 ข้อ 30). `buildAIInsight()` additively appends a **real** Claude API analysis on top of the template report, only when the logged-in role is `ic` or `safety`.
- **Auth/session layer** (`~line 1467` onward): `attemptLogin()`, `setSession()` / `restoreSessionFromStorage()`, `RBAC` map, `canUse()`, `onAuthStateChanged()`. See **Authentication & session flow**.
- **Google Maps integration** (`~line 1679` onward): `fetchMapsKey()` fetches the Maps JS API key from the backend post-login and injects `<script src="https://maps.googleapis.com/maps/api/js?key=...">`; falls back to the mock `#bm-mock` building map on `gm_authFailure` or fetch failure.
- **AI Advisory chat and AI AAR insight** (`~line 3074` onward): `callClaudeAPI()` is the single client-side entry point to the backend proxy; `sendAIChat()` and `buildAIInsight()` are its two callers.

## API directory (`api/`)

Vercel serverless functions, CommonJS, no npm dependencies (Node built-ins + global `fetch` only):

- **`api/login.js`** — `POST /api/login`. Body `{role, passcode}`. Checks the passcode against `process.env.ROLE_PASSCODE_<ROLE>`, rate-limits by IP (5/min), and on success issues a signed session token via `issueToken()`. Returns a generic 401 on any failure (wrong role, wrong passcode, unknown role) — deliberately does not reveal which part was wrong.
- **`api/claude-proxy.js`** — `POST /api/claude-proxy`. Requires `Authorization: Bearer <token>`; only `ic` and `safety` roles are allowed (`AI_ALLOWED_ROLES`). Rate-limited to 20 calls/role/hour. Forwards `{userPrompt, systemPrompt, maxTokens}` to `https://api.anthropic.com/v1/messages` using server-side `ANTHROPIC_API_KEY`, model `claude-sonnet-5`, with `thinking: {type: 'disabled'}` (adaptive thinking would otherwise eat the small `max_tokens` budgets used here). Logs role + prompt length only, never prompt text (drill content privacy).
- **`api/maps-config.js`** — `GET /api/maps-config`. Requires a valid session (any role). Returns `process.env.GOOGLE_MAPS_API_KEY` in the JSON body. The login gate is *not* real key protection — a Maps JS API key is inherently visible in the browser Network tab/DOM once loaded, by design of that API. The actual protection is the HTTP-referrer + API + quota restriction that must be set on the key in Google Cloud Console; the code comment flags this explicitly.
- **`api/_lib/session.js`** — HMAC-SHA256 signed, stateless session tokens (`payload.signature`, base64url). `issueToken(role)` / `verifyToken(token)` / `getBearerToken(req)`. TTL 8 hours (`SESSION_TTL_SECONDS`). Signing key is `SESSION_SIGNING_SECRET`. `VALID_ROLES = ['ic','safety','floor_warden','security','observer']`.
- **`api/_lib/rateLimit.js`** — `checkRateLimit(key, limit, windowSeconds)`. Uses Vercel KV via the Upstash REST protocol (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) when provisioned, so counts are shared across function instances/regions. Falls back to an in-memory `Map` per function instance when KV isn't configured — see **Known operational limitations**.

## Authentication & session flow

1. User picks a role on the login gate (`ic`, `safety`, `floor_warden`, `security`, `observer`) and enters that role's shared passcode.
2. Frontend `attemptLogin()` → `POST /api/login`. Backend checks the passcode against the matching `ROLE_PASSCODE_*` env var and issues a signed token (`role`, `iat`, `exp`) if it matches.
3. Frontend stores `{token, role, exp}` in `sessionStorage` only (never `localStorage`, never included in `exportState()`/JSON export) — it clears on tab close and is deliberately excluded from the app's own state export/import feature.
4. Every subsequent privileged call (`/api/claude-proxy`, `/api/maps-config`) sends `Authorization: Bearer <token>`; the backend re-verifies the HMAC signature and expiry on every request. There is no server-side session store — a token is valid until it expires or the signing secret changes. There is no logout-everywhere or token revocation mechanism.
5. Authorization is **per-role, not per-user** — everyone with a given role's passcode shares one capability set. There is no concept of an individual user identity anywhere in this system.
6. Client-side `RBAC` map in the HTML (`scenarioWrite`, `simRun`, `liveDrill`, `carWrite`, `verifyWrite`, `mapEdit`, `ai`, `exportImport`) drives which buttons are enabled — this is **UX convenience only**. The real enforcement is server-side: `claude-proxy.js` hardcodes its own `AI_ALLOWED_ROLES` allow-list, and `maps-config.js` requires any valid session. Do not treat the client `RBAC` object as a security boundary when reasoning about what's actually protected.

## Deployment model

- Target platform: Vercel. `vercel.json` only defines a rewrite of `/` → the prototype HTML; the `api/*.js` files deploy as serverless functions automatically under Vercel's zero-config convention (no `functions` block, no `package.json`, no build step).
- Required environment variables (see `.env.example`, values there are placeholders): `ROLE_PASSCODE_IC`, `ROLE_PASSCODE_SAFETY`, `ROLE_PASSCODE_FLOOR_WARDEN`, `ROLE_PASSCODE_SECURITY`, `ROLE_PASSCODE_OBSERVER`, `SESSION_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_API_KEY`.
- Optional: `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel KV / Upstash REST) — recommended for real rate limiting in production; without them, rate limiting is best-effort only (see below).
- The Google Maps key additionally needs HTTP-referrer + API + quota restrictions configured directly in Google Cloud Console — that restriction is not something the code enforces, and must be set up by whoever provisions the key.
- Local full-stack dev needs the Vercel CLI (`npm i -g vercel`) and `vercel dev` reading from `.env.local` (copy `.env.example` and fill in real/test values — `.env` and `.env.local` are gitignored). Plain `npx serve` only serves the static HTML and will not exercise login, AI, or Maps.

## Known operational limitations

- **Rate limiting is soft without KV provisioned.** `rateLimit.js` falls back to a per-function-instance in-memory `Map`, which resets on cold start and is not shared across regions or concurrent instances. It blunts casual abuse only — it is not a hard guarantee. Provision Vercel KV for anything closer to real enforcement.
- **No session revocation.** Tokens are stateless HMAC-signed JSON, valid for 8 hours from issuance. There is no way to force-logout a role or invalidate a single leaked token short of rotating `SESSION_SIGNING_SECRET` (which invalidates *every* active session, all roles, at once).
- **Passcodes are shared secrets per role, not per person.** Anyone who has a role's passcode has that role's full capability set; there's no per-user audit trail beyond `{role, ip}` in the login log.
- **The Google Maps key is visible in the browser once fetched**, by the nature of the Maps JS API. Login gating only stops a logged-out visitor from getting the key at all — real protection is the referrer/API/quota restriction on the key itself (see **Deployment model**).
- **AI features are gated to `ic` and `safety` roles only**, both client-side (disabled inputs/chip states) and server-side (`AI_ALLOWED_ROLES` in `claude-proxy.js`, 20 calls/role/hour). Other roles will see the chat input disabled and get a 403 if they hit the endpoint directly.
- **`ANTHROPIC_API_KEY` / `GOOGLE_MAPS_API_KEY` / `SESSION_SIGNING_SECRET` missing in production** causes clear, typed 500s from the relevant endpoint (not silent failures) — but `issueToken()` in `session.js` throws synchronously if `SESSION_SIGNING_SECRET` is unset, and `login.js` does not wrap that call in try/catch, so a missing signing secret will surface as an unhandled function error rather than the endpoint's own JSON error shape. Confirm the secret is set before assuming login is broken for another reason.
- **This is a drill/training tool, not a live incident system.** The login gate and sidebar footer both say so in Thai. Never let a feature change imply otherwise (e.g. don't wire this into anything that could be mistaken for live BTS operational fire response).

## Invariants when updating the prototype

From the briefs — these are hard rules, not suggestions:

- Never delete existing scenarios (A/B/C) or already-added logic (casualty, fuel, trapped-person, missing-visitor, power-isolation).
- Keep the existing visual style and Thai as the primary language; status badges use Completed / Delayed / Pending / Critical colors.
- Keep demo results deterministic (seeded random); every preset must be runnable immediately, without login, for anything that doesn't touch AI or the live Maps embed.
- Safety guardrails: AI is decision support only; never suggest ordinary staff re-enter a danger zone; rescue is only by assigned teams or external emergency services; water firefighting only after power isolation is confirmed; re-entry only after inspection and IM stand-down. These guardrails are also baked into the Claude system prompts in `sendAIChat()` and `buildAIInsight()` (`ai-emergency-digital-twin-prototype.html` ~line 3125 and ~3160) — if you change those prompts, keep the guardrail language intact.
- Fire-scenario logic must enforce: use of 2 extinguishers fails → General Alarm → full evacuation; fire spread requiring water → Power Isolated must be confirmed first.
- Bump the version string in the sidebar footer (`ต้นแบบ v1.x`) **and** the sidebar brand `<small>` tag (`OCC YL · Vector Digital Twin v1.x`) when shipping a new scenario pack or feature set — both currently read v1.8 and must move together.
- The source drill document has inconsistent line/project names (สายสีเหลือง / สายสีชมพู / สายนัคราพิพัฒน์); keep the "ตรวจสอบชื่อพื้นที่ก่อนใช้ในเอกสารทางการ" caveat rather than silently picking one.
- Never commit real values for anything in `.env.example` — it must stay placeholders only. Real secrets belong in Vercel's environment variable settings or a gitignored `.env.local`, never in a tracked file.
- When adding a new privileged capability (new API route, new AI feature, new write action), gate it in **both** places: the client `RBAC` map (for UX) and server-side in the relevant `api/*.js` handler (for actual enforcement). The client map alone is not security.
