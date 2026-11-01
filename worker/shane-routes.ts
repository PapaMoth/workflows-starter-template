import {
	buildCallSequenceDefinition,
	evaluateDialGate,
	extractPhoneNumbersFromText,
	parseCsvContacts,
	ScriptTooLongError,
} from "./shane-logic";
import { handleShaneCampaignRequest, handleShaneTextRequest } from "./shane-sms-routes";

/**
 * REST routing for /api/shane/* — manages Shane AI's script, contacts,
 * suppression list and call log on the single global ShaneStoreDO, and
 * places a single outbound call through Bird's Voice API when asked.
 *
 * Every dial is one explicit request for one contact. There is
 * deliberately no "call everyone" endpoint: each call is a real,
 * billable, human-confirmed action gated by evaluateDialGate (consent,
 * opt-out, suppression list, calling-hours window).
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

function callingWindow(env: Env): { start: number; end: number } {
	const start = Number(env.CALL_WINDOW_START ?? "9");
	const end = Number(env.CALL_WINDOW_END ?? "20");
	return { start: Number.isFinite(start) ? start : 9, end: Number.isFinite(end) ? end : 20 };
}

export async function handleShaneRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean); // ["api", "shane", ...]
	const section = parts[2];
	const store = getStore(env);

	try {
		if (section === "text") {
			return await handleShaneTextRequest(request, env);
		}

		if (section === "campaign") {
			return await handleShaneCampaignRequest(request, env, parts[3]);
		}

		if (section === "script") {
			if (request.method === "GET") return Response.json(await store.getScript());
			if (request.method === "PUT") {
				const body = await readJson<{ body?: unknown }>(request);
				if (typeof body.body !== "string" || !body.body.trim()) {
					return Response.json({ error: "Script body is required" }, { status: 400 });
				}
				return Response.json(await store.setScript(body.body));
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		if (section === "contacts") {
			const contactId = parts[3];
			if (request.method === "GET" && !contactId) {
				return Response.json(await store.listContacts());
			}
			if (request.method === "POST" && parts[3] === "parse") {
				const parseBody = await readJson<{ text?: unknown; kind?: unknown }>(request);
				if (typeof parseBody.text !== "string") {
					return Response.json({ error: "text is required" }, { status: 400 });
				}
				const parsed =
					parseBody.kind === "pdf"
						? extractPhoneNumbersFromText(parseBody.text)
						: parseCsvContacts(parseBody.text);
				return Response.json({ contacts: parsed });
			}
			if (request.method === "POST" && parts[3] === "import") {
				const importBody = await readJson<{ contacts?: unknown; source?: unknown }>(request);
				if (!Array.isArray(importBody.contacts)) {
					return Response.json({ error: "contacts array is required" }, { status: 400 });
				}
				const source = typeof importBody.source === "string" ? importBody.source : "upload";
				const contacts = importBody.contacts as Array<{
					name?: string | null;
					phone: string;
					consent?: boolean;
				}>;
				const result = await store.importContacts(contacts, source);
				return Response.json(result, { status: 201 });
			}
			if (request.method === "PUT" && contactId) {
				const updateBody = await readJson<{ consent?: unknown; optedOut?: unknown }>(request);
				const updated =
					typeof updateBody.consent === "boolean"
						? await store.setContactConsent(contactId, updateBody.consent)
						: typeof updateBody.optedOut === "boolean"
							? await store.setContactOptedOut(contactId, updateBody.optedOut)
							: null;
				if (!updated) return Response.json({ error: "Contact not found, or no recognized field to update" }, { status: 404 });
				return Response.json(updated);
			}
			if (request.method === "DELETE" && contactId) {
				await store.deleteContact(contactId);
				return new Response(null, { status: 204 });
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		if (section === "suppressions") {
			if (request.method === "GET") return Response.json(await store.listSuppressions());
			if (request.method === "POST") {
				const supBody = await readJson<{ phone?: unknown; reason?: unknown }>(request);
				if (typeof supBody.phone !== "string" || !supBody.phone) {
					return Response.json({ error: "phone is required" }, { status: 400 });
				}
				const reason = typeof supBody.reason === "string" ? supBody.reason : null;
				return Response.json(await store.addSuppression(supBody.phone, reason), { status: 201 });
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		if (section === "calls") {
			if (parts[3] === "dial" && request.method === "POST") {
				return await handleDial(request, env, store);
			}
			if (request.method === "GET" && !parts[3]) {
				return Response.json(await store.listCalls());
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		return Response.json({ error: "Unknown Shane AI resource" }, { status: 404 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Shane AI request failed" },
			{ status: 500 },
		);
	}
}

async function handleDial(
	request: Request,
	env: Env,
	store: ReturnType<typeof getStore>,
): Promise<Response> {
	const body = await readJson<{ contactId?: unknown }>(request);
	if (typeof body.contactId !== "string" || !body.contactId) {
		return Response.json({ error: "contactId is required" }, { status: 400 });
	}

	const contact = await store.getContact(body.contactId);
	if (!contact) return Response.json({ error: "Contact not found" }, { status: 404 });

	const suppressedList = await store.getSuppressedSet();
	const window = callingWindow(env);
	const nowHour = new Date().getUTCHours();
	const gate = evaluateDialGate(contact, new Set(suppressedList), nowHour, window.start, window.end);
	if (!gate.allowed) {
		return Response.json({ error: "Dial blocked: " + gate.reason }, { status: 403 });
	}

	if (!env.BIRD_API_KEY || !env.BIRD_FROM_NUMBER) {
		return Response.json(
			{
				error:
					"Bird Voice isn't configured. Set BIRD_API_KEY and BIRD_FROM_NUMBER as Worker secrets (wrangler secret put) before dialing for real.",
			},
			{ status: 501 },
		);
	}

	const script = await store.getScript();
	const optOutDigit = env.OPT_OUT_DIGIT ?? "9";

	let sequence;
	try {
		sequence = buildCallSequenceDefinition(script.body, optOutDigit);
	} catch (err) {
		if (err instanceof ScriptTooLongError) {
			return Response.json({ error: err.message }, { status: 422 });
		}
		throw err;
	}

	const apiBase = env.BIRD_API_BASE ?? "https://us1.platform.bird.com";
	const idempotencyKey = "shane-dial/" + contact.id + "/" + Date.now();

	const birdResponse = await fetch(apiBase + "/v1/voice/calls", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + env.BIRD_API_KEY,
			"Content-Type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify({
			from: env.BIRD_FROM_NUMBER,
			to: contact.phone,
			sequence: {
				entry_node_id: sequence.entryNodeId,
				trigger_data: contact.name ? { name: contact.name } : {},
				definition: sequence.definition,
			},
		}),
	});

	if (!birdResponse.ok) {
		const errorText = await birdResponse.text().catch(function () {
			return "";
		});
		const call = await store.recordCallStart({ contactId: contact.id, birdCallId: null, birdLegId: null });
		await store.recordCallFailed(call.id, "bird_api_error: " + birdResponse.status + " " + errorText.slice(0, 500));
		return Response.json(
			{ error: "Bird API rejected the call (" + birdResponse.status + ")", detail: errorText.slice(0, 500) },
			{ status: 502 },
		);
	}

	const birdData = (await birdResponse.json()) as { id?: string; initial_leg_id?: string };
	const recorded = await store.recordCallStart({
		contactId: contact.id,
		birdCallId: birdData.id ?? null,
		birdLegId: birdData.initial_leg_id ?? null,
	});
	return Response.json(recorded, { status: 201 });
}
