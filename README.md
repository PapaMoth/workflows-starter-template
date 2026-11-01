# Cloudflare Workflows Starter Template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/workflows-starter-template)

<!-- dash-content-start -->

A real-time, interactive demonstration of [Cloudflare Workflows](https://developers.cloudflare.com/workflows) with live updates via WebSockets and Durable Objects. This template showcases durable multi-step workflows with time-based delays, event-driven pauses, and real-time status visualization.

<!-- dash-content-end -->

![Cloudflare Workflows Starter Template](assets/template-screenshot.png)

## Getting Started

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Visit `http://localhost:5173` to see the interactive demo.

### Deployment

```bash
npm run deploy
```

## Shane AI (outbound calling)

A script-reading outbound calling tool (the "Shane AI" tab), built on
[Bird's Voice API](https://bird.com/docs/guides/voice/create-calls): upload
contacts via CSV or PDF, review and attest consent, then dial one contact
at a time. Each call has Bird read your script via text-to-speech and
offers a keypad opt-out — it is not a live two-way conversational AI.

**Before dialing for real**, set these as Worker secrets (never commit
them — copy `.dev.vars.example` to `.dev.vars` for local dev, or
`wrangler secret put <NAME>` in production):

- `BIRD_API_KEY` — a Bird workspace API key scoped to voice calling + voice management write
- `BIRD_FROM_NUMBER` — a calling number your Bird workspace is permitted to present

Compliance defaults live in `wrangler.jsonc` under `vars`
(`CALL_WINDOW_START`/`CALL_WINDOW_END`, `OPT_OUT_DIGIT`). Only dial
contacts who have actually given consent to be called — the tool gates
every dial on consent, opt-out status, a suppression list, and the
configured calling-hours window, but it can't verify you obtained that
consent in the first place. That's on whoever's using it.

## Learn More

- [Cloudflare Workflows Documentation](https://developers.cloudflare.com/workflows)
- [Durable Objects Documentation](https://developers.cloudflare.com/durable-objects)
- [Workers Documentation](https://developers.cloudflare.com/workers)
