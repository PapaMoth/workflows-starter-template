import {
	buildScreeningSequenceDefinition,
	MAX_FAQ_ENTRIES,
	normalizePhone,
	ScreeningTooComplexError,
} from "./shane-logic";

/**
 * REST routing for /api/shane/screening/* — the inbound call-screening
 * config (greeting, FAQ menu, live-agent number) and the sequence
 * definition it generates.
 *
 * This produces a sequence definition for the operator to paste into
 * Bird's dashboard Sequence editor and bind to their inbound number —
 * Bird's publish/versioning flow for saved sequences isn't a documented
 * REST API, unlike the inline definitions outbound calling uses. There is
 * no "activate" button here because there is nothing to safely automate.
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

export async function handleShaneScreeningRequest(
	request: Request,
	env: Env,
	section: string,
	id: string | undefined,
): Promise<Response> {
	const store = getStore(env);

	try {
		if (section === "config") {
			if (request.method === "GET") return Response.json(await store.getScreeningConfig());
			if (request.method === "PUT") {
				const body = await readJson<{ greeting?: unknown; agentNumber?: unknown }>(request);
				if (typeof body.greeting !== "string" || !body.greeting.trim()) {
					return Response.json({ error: "greeting is required" }, { status: 400 });
				}
				let agentNumber: string | null = null;
				if (body.agentNumber != null) {
					if (typeof body.agentNumber !== "string") {
						return Response.json({ error: "agentNumber must be a string" }, { status: 400 });
					}
					agentNumber = normalizePhone(body.agentNumber);
					if (!agentNumber) {
						return Response.json({ error: "agentNumber doesn't look like a valid phone number" }, { status: 400 });
					}
				}
				return Response.json(await store.setScreeningConfig(body.greeting, agentNumber));
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		if (section === "faqs") {
			if (request.method === "GET" && !id) {
				return Response.json(await store.listScreeningFaqs());
			}
			if (request.method === "POST" && !id) {
				const body = await readJson<{ label?: unknown; answer?: unknown }>(request);
				if (typeof body.label !== "string" || !body.label.trim() || typeof body.answer !== "string" || !body.answer.trim()) {
					return Response.json({ error: "label and answer are required" }, { status: 400 });
				}
				const existing = await store.listScreeningFaqs();
				if (existing.length >= MAX_FAQ_ENTRIES) {
					return Response.json(
						{
							error: `Already at the ${MAX_FAQ_ENTRIES}-entry FAQ limit (digits 1-${MAX_FAQ_ENTRIES}; 0 is reserved for the live agent). Delete one first.`,
						},
						{ status: 422 },
					);
				}
				return Response.json(await store.addScreeningFaq(body.label.trim(), body.answer.trim()), { status: 201 });
			}
			if (request.method === "DELETE" && id) {
				await store.deleteScreeningFaq(id);
				return new Response(null, { status: 204 });
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		if (section === "generate" && request.method === "POST") {
			const config = await store.getScreeningConfig();
			if (!config.agentNumber) {
				return Response.json({ error: "Set a live-agent phone number before generating the sequence" }, { status: 400 });
			}
			const faqs = await store.listScreeningFaqs();
			try {
				const { definition, entryNodeId } = buildScreeningSequenceDefinition(
					config.greeting,
					faqs.map((f) => ({ label: f.label, answer: f.answer })),
					config.agentNumber,
				);
				return Response.json({ definition, entryNodeId });
			} catch (err) {
				if (err instanceof ScreeningTooComplexError) {
					return Response.json({ error: err.message }, { status: 422 });
				}
				throw err;
			}
		}

		return Response.json({ error: "Unknown screening resource" }, { status: 404 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Shane AI screening request failed" },
			{ status: 500 },
		);
	}
}
