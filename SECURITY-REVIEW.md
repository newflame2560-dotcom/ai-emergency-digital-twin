# Security Review

Date: 2026-07-26
Scope: tracked application and deployment files at commit `6fe59d8`
Method: manual static review of authentication, authorization, data import/rendering, AI proxying, secrets handling, rate limiting, and deployment configuration. No production configuration or external cloud controls were available for verification.

## Executive summary

The review found **two critical**, **two high**, and **one medium** priority issues. The most urgent risk is cross-site scripting (XSS): both imported/local scenario data and Claude-generated HTML reach `innerHTML` without an allow-list sanitizer. Exploitation can execute JavaScript in an authenticated operator's browser and read the bearer token held in `sessionStorage`, allowing use of protected APIs as that operator until the token expires.

The AI proxy also accepts caller-controlled system prompts and token budgets. A caller with any valid IC or Safety token can bypass the application's safety prompt and amplify API spend independently of the visible UI. These issues should be fixed before treating the prototype as suitable for operational or internet-facing use.

## Prioritized findings

### SR-01 — Critical — Stored XSS through imported and locally persisted application state

**Evidence**

- `ai-emergency-digital-twin-prototype.html:1615-1631` parses an arbitrary selected JSON file, assigns its `scenarios`, `car`, `verify`, and `liveDrill` properties directly to application state, persists them, and immediately renders them. There is no schema, type, length, or character validation.
- `ai-emergency-digital-twin-prototype.html:1450-1461` similarly trusts state restored from `localStorage`.
- `ai-emergency-digital-twin-prototype.html:2310-2328` composes scenario descriptions from state without escaping.
- `ai-emergency-digital-twin-prototype.html:2333-2348` interpolates scenario fields, including `sc.name`, `scDesc(sc)`, and `sc.note`, into `innerHTML`.
- `ai-emergency-digital-twin-prototype.html:2358-2362` inserts simulation event text with `insertAdjacentHTML`; event text includes scenario-controlled fields elsewhere in the simulation.
- `ai-emergency-digital-twin-prototype.html:1472-1525` stores the signed bearer token in `sessionStorage`, which JavaScript executing in the page origin can read.

**Impact**

An attacker can provide a crafted backup JSON file, or use another same-origin script injection path to poison local state. When a privileged IC/Safety user imports or later reloads that state, attacker-controlled markup can execute in the application origin. It can steal the session token, invoke `/api/claude-proxy` or `/api/maps-config`, alter displayed emergency information, and persist across reloads.

**Recommended remediation**

1. Define a strict schema for every imported and restored object. Reject unknown properties, wrong types, unsafe identifiers, oversized arrays/strings, and values outside explicit enums/ranges.
2. Render all data as text with `textContent` and DOM element construction. Where templating is retained, apply the existing `esc()` helper to every data-derived value, including values used in attributes and inline handlers.
3. Do not construct inline `onclick` attributes from state. Bind event listeners and keep identifiers in validated `data-*` attributes.
4. Add a restrictive Content Security Policy (CSP) after removing inline scripts and handlers; do not rely on CSP as the primary XSS fix.
5. Treat existing browser state as potentially tainted after deployment of the fix: version the storage key or validate and discard invalid legacy state.

### SR-02 — Critical — Untrusted AI output is rendered as active HTML

**Evidence**

- `ai-emergency-digital-twin-prototype.html:3158-3163` asks the model for HTML, then interpolates the returned text directly into a report fragment.
- `ai-emergency-digital-twin-prototype.html:3174-3184` appends that fragment and assigns the result to `innerHTML`.
- `api/claude-proxy.js:34-37` accepts both `userPrompt` and `systemPrompt` from the browser, while `api/claude-proxy.js:56-60` forwards them unchanged to Anthropic. The server does not enforce the claimed output tags.

**Impact**

Model output is not a trusted security boundary. Prompt injection in scenario, drill, or CAR data—or unexpected model behavior—can return event handlers, active elements, or other markup that executes in the operator's authenticated origin. Consequences include token theft, protected API calls, falsified emergency reports, and persistent compromise when malicious source data remains stored.

**Recommended remediation**

1. Prefer a structured JSON response whose fields are rendered with `textContent`.
2. If formatted HTML is required, sanitize it with a well-maintained allow-list sanitizer before insertion. Permit only the required elements (`h3`, `ul`, `ol`, `li`) and no attributes, URLs, styles, SVG/MathML, or custom elements.
3. Enforce response structure server-side and reject/sanitize nonconforming output. A prompt instruction is not validation.
4. Apply the CSP hardening described in SR-01 as defense in depth.

### SR-03 — High — AI safety policy and cost controls are caller-controlled

**Evidence**

- `api/claude-proxy.js:34-37` accepts arbitrary `systemPrompt`, `userPrompt`, and `maxTokens`.
- `api/claude-proxy.js:56-60` forwards the caller's system prompt and uses `maxTokens || 1024` without a type, range, or request-size limit.
- `ai-emergency-digital-twin-prototype.html:3132-3135` shows that the safety rules exist only in browser-supplied prompt text; a direct API caller can replace them.
- `api/claude-proxy.js:4-5` restricts access by role, but does not distinguish the approved advisory and AAR operations or enforce operation-specific templates.

**Impact**

Anyone who obtains a valid IC/Safety token can call the endpoint directly with a system prompt that removes the emergency-safety guardrails. They can also submit oversized prompts or token budgets, increasing latency and API cost. This undercuts the application's stated decision-support controls even though authentication succeeds.

**Recommended remediation**

1. Accept an operation identifier and structured input, not raw system prompts. Select immutable, versioned system prompts on the server for each approved operation.
2. Validate request bodies with a strict schema; reject unknown fields.
3. Enforce byte/character limits on every input and clamp `max_tokens` to a small server-owned range appropriate to each operation.
4. Add upstream timeouts, response-size limits, and per-session/user cost accounting. Log the operation, request ID, token usage, and outcome without logging sensitive prompt content.

### SR-04 — High — Rate limiting fails open and AI quota is shared by role

**Evidence**

- `api/_lib/rateLimit.js:21-35` returns `null` when KV is absent or the increment request fails.
- `api/_lib/rateLimit.js:38-46` silently falls back to a per-instance in-memory map on any KV error.
- `api/_lib/rateLimit.js:1-5` acknowledges that the fallback resets on cold start and is not shared across instances or regions.
- `api/claude-proxy.js:27-28` keys the AI limit only by role and hour, so every IC shares one quota and every Safety user shares another.
- `api/login.js:22-23` derives the login key from a client-influenced forwarded header and then relies on the same weak fallback behavior.

**Impact**

During KV misconfiguration or outage, an attacker can distribute requests across cold starts/regions to bypass login and spend controls. Conversely, because AI calls are keyed only by role, one authenticated user can exhaust the quota for all users of that role, causing denial of service during an incident.

**Recommended remediation**

1. Require a durable, atomic rate-limit store in production. Fail closed for AI spend when it is unavailable; use a deliberate, tightly bounded degraded policy for login.
2. Key AI limits by a stable server-issued session/user identifier plus role, and maintain a separate global budget ceiling.
3. Add a random `jti`/session identifier to tokens and rate-limit per `jti`; do not use the bearer token itself as a storage key.
4. Use the hosting platform's trusted client-IP field/normalization rather than accepting an arbitrary forwarding chain at face value.
5. Alert on limiter-store errors and repeated 429s.

### SR-05 — Medium — Missing browser security headers and permissive inline execution

**Evidence**

- `vercel.json:1-5` defines only a rewrite and no response security headers.
- `ai-emergency-digital-twin-prototype.html:250`, `ai-emergency-digital-twin-prototype.html:2341-2343`, and other locations use inline event handlers, making a strong CSP difficult without refactoring.
- `api/maps-config.js:22-28` returns the browser-visible Maps key to every authenticated role; the comments at `api/maps-config.js:3-8` correctly state that external referrer/API/quota restrictions are required, but those controls are outside this repository and therefore unverified.

**Impact**

The application lacks defense-in-depth against script injection, framing, MIME confusion, referrer leakage, and unnecessary browser capabilities. If the Google Maps key is not restricted correctly in Google Cloud, any authenticated user—or an XSS payload—can extract and abuse it from elsewhere.

**Recommended remediation**

1. Configure at least: a nonce/hash-based `Content-Security-Policy`, `frame-ancestors 'none'` (or an explicit approved allow-list), `X-Content-Type-Options: nosniff`, a restrictive `Referrer-Policy`, and a minimal `Permissions-Policy`.
2. Move inline JavaScript and event handlers to a same-origin script and use non-inline listeners so CSP does not require `unsafe-inline`.
3. Restrict the Maps key in Google Cloud by exact production HTTP referrers, required Maps APIs only, and conservative quotas; verify monitoring and billing alerts.
4. Consider narrowing `/api/maps-config` to roles that actually require maps if the product requirements permit it.

## Positive controls observed

- Secrets are read from server-side environment variables rather than embedded in tracked application code (`api/claude-proxy.js:50-53`, `api/maps-config.js:22-25`).
- Session tokens are HMAC-signed and compared with `timingSafeEqual` (`api/_lib/session.js:15-20`, `api/_lib/session.js:38-41`), validate allowed roles, and enforce expiration (`api/_lib/session.js:49-52`).
- Protected API routes perform server-side authentication, and Claude access has a server-side role allow-list (`api/claude-proxy.js:15-25`, `api/maps-config.js:15-20`).
- The AI chat display escapes both user and model text (`ai-emergency-digital-twin-prototype.html:3107-3111`); the unsafe path is specifically the HTML-formatted AAR output.
- `.env` and `.env.local` are ignored (`.gitignore:1-4`), and values in `.env.example` are clearly marked local/test placeholders.

## Verification test plan

### 1. XSS and import validation

1. Create backup files containing payloads in every string field and identifier, including `<img src=x onerror=...>`, `<svg onload=...>`, attribute-breaking quotes, `javascript:` URLs, and oversized values.
2. Confirm import rejects invalid schemas atomically: no partial state update, persistence, or rendering.
3. Seed equivalent payloads directly in legacy `localStorage`; reload and confirm they are discarded or displayed literally.
4. Exercise scenario list, simulation event log, CAR table, verification table, live-drill result, OCC view, export/re-import, and print/report views.
5. Instrument `window.onerror`, network requests, and a sentinel global; confirm no payload executes and no bearer token is exposed.

### 2. AI output handling and safety enforcement

1. Stub the Anthropic response with every disallowed HTML construct, malformed nesting, SVG/MathML, event attributes, styles, URLs, and script tags. Confirm only the exact allowed structure survives, or preferably that all output is rendered as text/structured DOM.
2. Put prompt-injection strings in scenario names, notes, CAR items, and live-drill notes. Confirm the server-owned system policy remains unchanged and unsafe output is rejected.
3. Call `/api/claude-proxy` directly with a replacement `systemPrompt`, unknown fields, negative/fractional/string/very large `maxTokens`, and oversized prompts. Expect `400`/`413`, with no Anthropic request.
4. Verify each supported operation uses its correct immutable server-side prompt and output schema.

### 3. Authentication, authorization, and sessions

1. Test missing, malformed, expired, wrong-signature, wrong-role, and boundary-time tokens against every API route.
2. Confirm only IC/Safety can invoke AI and that Maps access matches the approved role matrix.
3. After adding session identifiers/revocation, verify logout/revocation prevents further API use and that rotated signing secrets invalidate old tokens as intended.
4. Confirm logs contain no passcodes, bearer tokens, API keys, or prompt contents.

### 4. Abuse and resilience controls

1. Run concurrent rate-limit tests across multiple function instances/regions; confirm limits remain atomic and cannot be bypassed by cold starts.
2. Simulate KV timeout, malformed response, and outage. Confirm AI requests fail closed with a controlled `503` and an alert is emitted.
3. Verify per-session limits do not block a second legitimate user of the same role, while the global cost ceiling still caps aggregate spend.
4. Spoof and vary `X-Forwarded-For`; confirm only the platform-trusted client IP determines login throttling.
5. Test upstream timeouts, client disconnects, large Anthropic responses, and non-JSON upstream errors.

### 5. Deployment headers and external key restrictions

1. Inspect production responses for the HTML and all API routes; verify CSP, frame protection, `nosniff`, referrer, permissions, and cache policies.
2. Run the application with CSP reporting enabled and confirm normal behavior produces no violations before enforcing it.
3. Attempt to use the Maps key from an unapproved origin and with an unapproved API; both must fail. Verify quota and billing alerts trigger in a controlled test.
4. Run an automated dependency/secret scan and a dynamic web scan in CI, then manually triage results. Repeat the XSS regression suite on every rendering/import change.

## Remediation order

1. Fix SR-01 and SR-02 together; invalidate or validate existing persisted state.
2. Move AI policy and budgets server-side (SR-03).
3. Make rate limiting durable and correctly scoped (SR-04).
4. Deploy CSP and the remaining browser/cloud hardening (SR-05).
5. Execute the full verification plan before operational use.
