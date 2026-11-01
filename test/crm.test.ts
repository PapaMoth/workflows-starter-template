import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CrmData, Company, Deal, Note, Task } from "../src/crm/types";

/**
 * Exercises the CRM REST surface (worker/crm-routes.ts +
 * worker/crm-durable-object.ts) through the worker's fetch handler.
 */
describe("CRM API", () => {
	beforeEach(async () => {
		// Each CrmStoreDO instance is addressed by name ("singleton"); reset
		// it between tests by deleting all rows through the real API so
		// every test starts from a clean slate without reaching into
		// internals.
		const all = (await (
			await SELF.fetch("https://example.com/api/crm/all")
		).json()) as CrmData;
		for (const t of all.tasks) await SELF.fetch(`https://example.com/api/crm/tasks/${t.id}`, { method: "DELETE" });
		for (const n of all.notes) await SELF.fetch(`https://example.com/api/crm/notes/${n.id}`, { method: "DELETE" });
		for (const d of all.deals) await SELF.fetch(`https://example.com/api/crm/deals/${d.id}`, { method: "DELETE" });
		for (const c of all.contacts) await SELF.fetch(`https://example.com/api/crm/contacts/${c.id}`, { method: "DELETE" });
		for (const c of all.companies) await SELF.fetch(`https://example.com/api/crm/companies/${c.id}`, { method: "DELETE" });
	});

	it("rejects an unknown resource", async () => {
		const res = await SELF.fetch("https://example.com/api/crm/bogus");
		expect(res.status).toBe(404);
	});

	it("creates, lists, updates and deletes a company", async () => {
		const create = await SELF.fetch("https://example.com/api/crm/companies", {
			method: "POST",
			body: JSON.stringify({ name: "Acme Corp", domain: "acme.test" }),
		});
		expect(create.status).toBe(201);
		const company = (await create.json()) as Company;
		expect(company.name).toBe("Acme Corp");

		const list = (await (
			await SELF.fetch("https://example.com/api/crm/companies")
		).json()) as Company[];
		expect(list).toHaveLength(1);

		const update = await SELF.fetch(
			`https://example.com/api/crm/companies/${company.id}`,
			{ method: "PUT", body: JSON.stringify({ domain: "acme.co" }) },
		);
		expect(((await update.json()) as Company).domain).toBe("acme.co");

		const del = await SELF.fetch(
			`https://example.com/api/crm/companies/${company.id}`,
			{ method: "DELETE" },
		);
		expect(del.status).toBe(204);

		const afterDelete = (await (
			await SELF.fetch("https://example.com/api/crm/companies")
		).json()) as Company[];
		expect(afterDelete).toHaveLength(0);
	});

	it("404s updating a contact that doesn't exist", async () => {
		const res = await SELF.fetch(
			"https://example.com/api/crm/contacts/does-not-exist",
			{ method: "PUT", body: JSON.stringify({ name: "Nobody" }) },
		);
		expect(res.status).toBe(404);
	});

	it("walks a deal through its pipeline stages", async () => {
		const create = await SELF.fetch("https://example.com/api/crm/deals", {
			method: "POST",
			body: JSON.stringify({ title: "Big Deal", value: 5000 }),
		});
		const deal = (await create.json()) as Deal;
		expect(deal.stage).toBe("lead");

		const advance = await SELF.fetch(
			`https://example.com/api/crm/deals/${deal.id}`,
			{ method: "PUT", body: JSON.stringify({ stage: "won" }) },
		);
		expect(((await advance.json()) as Deal).stage).toBe("won");
	});

	it("toggles a task done and reflects it in /all", async () => {
		const create = await SELF.fetch("https://example.com/api/crm/tasks", {
			method: "POST",
			body: JSON.stringify({ title: "Follow up" }),
		});
		const task = (await create.json()) as Task;
		expect(task.done).toBe(false);

		await SELF.fetch(`https://example.com/api/crm/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ done: true }),
		});

		const all = (await (
			await SELF.fetch("https://example.com/api/crm/all")
		).json()) as CrmData;
		expect(all.tasks.find((t) => t.id === task.id)?.done).toBe(true);
	});

	it("refuses to update a note (notes are immutable)", async () => {
		const create = await SELF.fetch("https://example.com/api/crm/notes", {
			method: "POST",
			body: JSON.stringify({ body: "Called, left voicemail" }),
		});
		const note = (await create.json()) as Note;

		const update = await SELF.fetch(
			`https://example.com/api/crm/notes/${note.id}`,
			{ method: "PUT", body: JSON.stringify({ body: "edited" }) },
		);
		expect(update.status).toBe(405);
	});

	it("rejects invalid JSON bodies", async () => {
		const res = await SELF.fetch("https://example.com/api/crm/companies", {
			method: "POST",
			body: "not json",
		});
		expect(res.status).toBe(500);
	});

	it("getAll aggregates every resource together", async () => {
		await SELF.fetch("https://example.com/api/crm/companies", {
			method: "POST",
			body: JSON.stringify({ name: "Globex" }),
		});
		await SELF.fetch("https://example.com/api/crm/contacts", {
			method: "POST",
			body: JSON.stringify({ name: "Jane Doe" }),
		});

		const all = (await (
			await SELF.fetch("https://example.com/api/crm/all")
		).json()) as CrmData;
		expect(all.companies).toHaveLength(1);
		expect(all.contacts).toHaveLength(1);
		expect(all.deals).toHaveLength(0);
	});

	it("CRM_STORE binding resolves to a single shared instance", async () => {
		const id = env.CRM_STORE.idFromName("singleton");
		const stub = env.CRM_STORE.get(id);
		const data = await stub.getAll();
		expect(data).toHaveProperty("companies");
	});
});
