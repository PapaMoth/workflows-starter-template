/**
 * REST routing for /api/crm/* — translates HTTP verbs/paths into RPC calls
 * on the single global CrmStoreDO instance.
 *
 * Routes:
 *   GET    /api/crm/all
 *   GET    /api/crm/:resource
 *   POST   /api/crm/:resource
 *   PUT    /api/crm/:resource/:id
 *   DELETE /api/crm/:resource/:id
 * where :resource is one of companies | contacts | deals | tasks | notes
 */

type Resource = "companies" | "contacts" | "deals" | "tasks" | "notes";

const RESOURCES: Resource[] = ["companies", "contacts", "deals", "tasks", "notes"];

const SINGULAR: Record<Resource, string> = {
	companies: "Company",
	contacts: "Contact",
	deals: "Deal",
	tasks: "Task",
	notes: "Note",
};

function isResource(value: string): value is Resource {
	return (RESOURCES as string[]).includes(value);
}

function getStore(env: Env) {
	const id = env.CRM_STORE.idFromName("singleton");
	return env.CRM_STORE.get(id);
}

export async function handleCrmRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean); // ["api", "crm", ...]
	const [, , resourceOrAll, maybeId] = parts;
	const store = getStore(env);

	try {
		if (resourceOrAll === "all" && request.method === "GET") {
			const data = await store.getAll();
			return Response.json(data);
		}

		if (!resourceOrAll || !isResource(resourceOrAll)) {
			return Response.json({ error: "Unknown CRM resource" }, { status: 404 });
		}
		const resource = resourceOrAll;
		const singular = SINGULAR[resource];

		if (request.method === "GET" && !maybeId) {
			const list = await (store as unknown as Record<string, () => Promise<unknown>>)[
				`list${capitalize(resource)}`
			]();
			return Response.json(list);
		}

		if (request.method === "POST" && !maybeId) {
			const body = await readJson(request);
			const created = await (
				store as unknown as Record<string, (b: unknown) => Promise<unknown>>
			)[`create${singular}`](body);
			return Response.json(created, { status: 201 });
		}

		if (request.method === "PUT" && maybeId) {
			if (resource === "notes") {
				return Response.json(
					{ error: "Notes are immutable; delete and recreate instead" },
					{ status: 405 },
				);
			}
			const body = await readJson(request);
			const updated = await (
				store as unknown as Record<
					string,
					(id: string, b: unknown) => Promise<unknown>
				>
			)[`update${singular}`](maybeId, body);
			if (updated === null) {
				return Response.json({ error: `${singular} not found` }, { status: 404 });
			}
			return Response.json(updated);
		}

		if (request.method === "DELETE" && maybeId) {
			await (
				store as unknown as Record<string, (id: string) => Promise<void>>
			)[`delete${singular}`](maybeId);
			return new Response(null, { status: 204 });
		}

		return Response.json({ error: "Method not allowed" }, { status: 405 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "CRM request failed" },
			{ status: 500 },
		);
	}
}

async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Invalid JSON body");
	}
}

function capitalize(resource: Resource): string {
	return resource.charAt(0).toUpperCase() + resource.slice(1);
}
