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

## Shane AI (outbound calls, text campaigns, inbound screening)

One tool (the "Shane AI" tab), three channels on top of a shared contact
list: upload contacts via CSV or PDF once, then reach them by call or
text, or let Shane screen the calls that come in — all through
[Bird](https://bird.com/docs/guides/voice/create-calls).

- **Outbound calls** read a script aloud via text-to-speech and offer a
  keypad opt-out — not a live two-way conversational AI — placed one
  contact at a time, each a human-confirmed action.
- **Text campaigns** send one message, personalized with `{{name}}`, to
  every eligible contact at once via
  [Bird's SMS batch API](https://bird.com/docs/guides/sms/sending-sms)
  (up to 100 per request, chunked automatically). A "Reply STOP to opt
  out" line is added automatically if the message doesn't already have
  one. Before sending, the UI shows exactly who's eligible and requires
  typing that count to confirm — the server recomputes eligibility at
  send time rather than trusting what the UI showed a moment earlier.
- **Inbound screening** generates a Bird Voice sequence that greets an
  incoming caller, offers a keypad menu of up to 5 FAQ answers, and
  transfers to a live agent on request (or on an unclear choice — the
  safer default). This is a keypad menu, not free-form speech
  understanding, and it speaks in whichever Bird voice that language
  uses — Bird's documented Voice API has no voice-selection or
  voice-cloning option. A real conversational, custom-voice answering
  system needs a separate SIP-connected AI voice runtime (see Bird's
  [Connect an AI voice application](https://bird.com/docs/ai/voice-conversations)
  guide) — a materially bigger integration than this generates. Bird's
  sequence publishing isn't a documented REST API, so the generated
  definition is pasted into Bird's dashboard Sequence editor and bound to
  the inbound number there, rather than activated from this tool.

Outbound calls and texts share one compliance gate: consent, opt-out
status, a suppression list, and a calling/texting-hours window
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
