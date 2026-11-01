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

## Shane AI (outbound calling + text campaigns)

Outbound outreach tools (the "Shane AI" tab) on top of a shared contact
list: upload contacts via CSV or PDF once, then either call or text them
through [Bird](https://bird.com/docs/guides/voice/create-calls).

- **Calls** read a script aloud via text-to-speech and offer a keypad
  opt-out — not a live two-way conversational AI — placed one contact at
  a time, each a human-confirmed action.
- **Text campaigns** send one message, personalized with `{{name}}`, to
  every eligible contact at once via
  [Bird's SMS batch API](https://bird.com/docs/guides/sms/sending-sms)
  (up to 100 per request, chunked automatically). A "Reply STOP to opt
  out" line is added automatically if the message doesn't already have
  one. Before sending, the UI shows exactly who's eligible and requires
  typing that count to confirm — the server recomputes eligibility at
  send time rather than trusting what the UI showed a moment earlier.

Both channels share the same compliance gate: consent, opt-out status, a
suppression list, and a calling/texting-hours window
(`CALL_WINDOW_START`/`CALL_WINDOW_END` in `wrangler.jsonc`'s `vars`). The
tool can't verify you actually obtained that consent in the first place
— that's on whoever's using it.

**Before sending or dialing for real**, set these as Worker secrets
(never commit them — copy `.dev.vars.example` to `.dev.vars` for local
dev, or `wrangler secret put <NAME>` in production):

- `BIRD_API_KEY` — a Bird workspace API key scoped to voice calling + voice management write + SMS sending
- `BIRD_FROM_NUMBER` — a calling number your Bird workspace is permitted to present
- `SMS_FROM_SENDER` — an SMS sender (number, short code, or alphanumeric ID) your Bird workspace holds

## Learn More

- [Cloudflare Workflows Documentation](https://developers.cloudflare.com/workflows)
- [Durable Objects Documentation](https://developers.cloudflare.com/durable-objects)
- [Workers Documentation](https://developers.cloudflare.com/workers)
