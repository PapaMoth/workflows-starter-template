import {
	buildSmsBatchItems,
	chunkIntoBatches,
	ensureOptOutLine,
	estimateSmsSegments,
	evaluateDialGate,
	MAX_SMS_BATCH_SIZE,
	MAX_SMS_SEGMENTS,
	MessageTooLongError,
	renderMessage,
	type DialGateResult,
} from "./shane-logic";
import type { ShaneContact } from "./shane-durable-object";

/**
 * REST routing for /api/shane/text (the campaign message) and
 * /api/shane/campaign/* (preview + send). Unlike calling, Bird's SMS
 * batch endpoint is itself a bulk primitive, so "send to everyone
 * eligible" is a real, intended action here — guarded by recomputing
 * eligibility server-side at send time (never trusting a client-supplied
 * list) and requiring the caller to confirm the exact count first.
 */

function getStore(env: Env) {
	const id = env.SHANE_STORE.idFromName("singleton");
	return env.SHANE_STORE.get(id);
}

async function readJson<T>(request: Request): Promise<T> {
	const text = await request.text();
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error("Invalid JSON body");
	}
}

function outreachWindow(env: Env): { start: number; end: number } {
	const start = Number(env.CALL_WINDOW_START ?? "9");
	const end = Number(env.CALL_WINDOW_END ?? "20");
	return { start: Number.isFinite(start) ? start : 9, end: Number.isFinite(end) ? end : 20 };
}

interface EligibilitySplit {
	eligible: ShaneContact[];
	excluded: Array<{ contact: ShaneContact; reason: string }>;
}

async function splitByEligibility(
	store: ReturnType<typeof getStore>,
	env: Env,
): Promise<EligibilitySplit> {
	const contacts = await store.listContacts();
	const suppressed = new Set(await store.getSuppressedSet());
	const window = outreachWindow(env);
	const now = new Date();

	const eligible: ShaneContact[] = [];
	const excluded: Array<{ contact: ShaneContact; reason: string }> = [];
	contacts.forEach((contact) => {
		const gate: DialGateResult = evaluateDialGate(contact, suppressed, now, window.start, window.end);
		if (gate.allowed) eligible.push(contact);
		else excluded.push({ contact, reason: gate.reason ?? "not eligible" });
	});
	return { eligible, excluded };
}

export async function handleShaneTextRequest(request: Request, env: Env): Promise<Response> {
	const store = getStore(env);

	try {
		if (request.method === "GET") return Response.json(await store.getTextMessage());
		if (request.method === "PUT") {
			const body = await readJson<{ body?: unknown }>(request);
			if (typeof body.body !== "string" || !body.body.trim()) {
				return Response.json({ error: "Message body is required" }, { status: 400 });
			}
			return Response.json(await store.setTextMessage(body.body));
		}
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Shane AI text request failed" },
			{ status: 500 },
		);
	}
}

export async function handleShaneCampaignRequest(
	request: Request,
	env: Env,
	action: string,
): Promise<Response> {
	const store = getStore(env);

	try {
		if (action === "preview" && request.method === "POST") {
			return await handlePreview(store, env);
		}
		if (action === "send" && request.method === "POST") {
			return await handleSend(request, store, env);
		}
		if (action === "sends" && request.method === "GET") {
			return Response.json(await store.listSmsSends());
		}
		return Response.json({ error: "Unknown campaign action" }, { status: 404 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Shane AI campaign request failed" },
			{ status: 500 },
		);
	}
}

async function handlePreview(store: ReturnType<typeof getStore>, env: Env): Promise<Response> {
	const { eligible, excluded } = await splitByEligibility(store, env);
	const message = await store.getTextMessage();

	let maxSegments = 1;
	const samples = eligible.slice(0, 50); // enough to catch a too-long render without scanning thousands
	samples.forEach((contact) => {
		const rendered = ensureOptOutLine(renderMessage(message.body, contact));
		maxSegments = Math.max(maxSegments, estimateSmsSegments(rendered));
	});

	return Response.json({
		eligibleCount: eligible.length,
		excluded: excluded.map((e) => ({ id: e.contact.id, name: e.contact.name, phone: e.contact.phone, reason: e.reason })),
		maxSegments,
		tooLong: maxSegments > MAX_SMS_SEGMENTS,
		batchCount: Math.ceil(eligible.length / MAX_SMS_BATCH_SIZE) || 0,
	});
}

async function handleSend(request: Request, store: ReturnType<typeof getStore>, env: Env): Promise<Response> {
	const body = await readJson<{ confirmCount?: unknown }>(request);
	if (typeof body.confirmCount !== "number") {
		return Response.json({ error: "confirmCount is required" }, { status: 400 });
	}

	const { eligible } = await splitByEligibility(store, env);
	if (eligible.length === 0) {
		return Response.json({ error: "No eligible contacts to send to" }, { status: 400 });
	}
	if (body.confirmCount !== eligible.length) {
		return Response.json(
			{
				error: `Eligible contact count changed (confirmed ${body.confirmCount}, now ${eligible.length}). Re-run preview before sending.`,
			},
			{ status: 409 },
		);
	}

	if (!env.BIRD_API_KEY || !env.SMS_FROM_SENDER) {
		return Response.json(
			{
				error:
					"Bird SMS isn't configured. Set BIRD_API_KEY and SMS_FROM_SENDER as Worker secrets (wrangler secret put) before sending for real.",
			},
			{ status: 501 },
		);
	}

	const message = await store.getTextMessage();
	let items;
	try {
		items = buildSmsBatchItems(eligible, message.body, env.SMS_FROM_SENDER);
	} catch (err) {
		if (err instanceof MessageTooLongError) {
			return Response.json({ error: err.message }, { status: 422 });
		}
		throw err;
	}

	const apiBase = env.BIRD_API_BASE ?? "https://us1.platform.bird.com";
	const contactBatches = chunkIntoBatches(eligible, MAX_SMS_BATCH_SIZE);
	const itemBatches = chunkIntoBatches(items, MAX_SMS_BATCH_SIZE);
	const campaignRunId = crypto.randomUUID();

	let sent = 0;
	let failed = 0;

	for (let i = 0; i < itemBatches.length; i++) {
		const contactsInBatch = contactBatches[i];
		const messagesInBatch = itemBatches[i];

		const response = await fetch(apiBase + "/v1/sms/batches", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + env.BIRD_API_KEY,
				"Content-Type": "application/json",
				"Idempotency-Key": `shane-sms-campaign/${campaignRunId}/batch-${i}`,
			},
			body: JSON.stringify({ messages: messagesInBatch }),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			failed += contactsInBatch.length;
			await store.recordSmsSends(
				contactsInBatch.map((contact) => ({
					contactId: contact.id,
					status: "failed" as const,
					birdMessageId: null,
					segments: null,
					outcome: `bird_api_error: ${response.status} ${errorText.slice(0, 300)}`,
				})),
			);
			continue;
		}

		const data = (await response.json()) as { messages?: Array<{ id?: string }> };
		const acceptedMessages = data.messages ?? [];
		sent += contactsInBatch.length;
		await store.recordSmsSends(
			contactsInBatch.map((contact, idx) => ({
				contactId: contact.id,
				status: "sent" as const,
				birdMessageId: acceptedMessages[idx]?.id ?? null,
				segments: estimateSmsSegments(messagesInBatch[idx].text),
				outcome: null,
			})),
		);
	}

	return Response.json({ sent, failed, batches: itemBatches.length, eligibleCount: eligible.length });
}
