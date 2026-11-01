import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Exercises the Shane AI REST surface (worker/shane-routes.ts +
 * worker/shane-durable-object.ts) through the worker's fetch handler.
 * No real Bird credentials are configured in this test env, so dialing
 * exercises the compliance gate and the "not configured" path, never a
 * real network call.
 */
describe("Shane AI API", () => {
	beforeAll(() => {
		// Force the calling-hours window wide open so these tests don't
		// flake depending on the wall-clock UTC hour they happen to run at.
		// wrangler.jsonc types these vars as their literal default values, so
		// widen to string for this test-only override.
		const mutableEnv = env as unknown as { CALL_WINDOW_START: string; CALL_WINDOW_END: string };
		mutableEnv.CALL_WINDOW_START = "0";
		mutableEnv.CALL_WINDOW_END = "24";
	});

	beforeEach(async () => {
		const contacts = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string }>;
		for (const c of contacts) {
			await SELF.fetch(`https://example.com/api/shane/contacts/${c.id}`, { method: "DELETE" });
		}
	});

	it("gets and updates the script", async () => {
		const current = (await (
			await SELF.fetch("https://example.com/api/shane/script")
		).json()) as { body: string };
		expect(current.body.length).toBeGreaterThan(0);

		const put = await SELF.fetch("https://example.com/api/shane/script", {
			method: "PUT",
			body: JSON.stringify({ body: "Hi, this is a test script." }),
		});
		expect(put.status).toBe(200);
		const updated = (await put.json()) as { body: string };
		expect(updated.body).toBe("Hi, this is a test script.");
	});

	it("rejects an empty script body", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/script", {
			method: "PUT",
			body: JSON.stringify({ body: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("parses CSV text into previewable contacts without persisting them", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/contacts/parse", {
			method: "POST",
			body: JSON.stringify({ kind: "csv", text: "name,phone,consent\nJordan Keane,5551234567,yes" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contacts: Array<{ name: string; phone: string; consent: boolean }> };
		expect(body.contacts).toEqual([{ name: "Jordan Keane", phone: "+15551234567", consent: true }]);

		const list = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as unknown[];
		expect(list).toHaveLength(0);
	});

	it("parses PDF-extracted text into contacts needing an explicit consent attestation", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/contacts/parse", {
			method: "POST",
			body: JSON.stringify({ kind: "pdf", text: "Call list: Jordan 555-123-4567, Priya 555-987-6543" }),
		});
		const body = (await res.json()) as { contacts: Array<{ consent: boolean }> };
		expect(body.contacts).toHaveLength(2);
		expect(body.contacts.every((c) => c.consent === false)).toBe(true);
	});

	it("imports contacts and skips duplicate phone numbers", async () => {
		const first = await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({
				contacts: [{ name: "Jordan Keane", phone: "+15551234567", consent: true }],
				source: "csv",
			}),
		});
		expect(first.status).toBe(201);
		expect(await first.json()).toEqual({ imported: 1, skipped: 0 });

		const second = await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({
				contacts: [{ name: "Jordan Keane", phone: "+15551234567", consent: true }],
				source: "csv",
			}),
		});
		expect(await second.json()).toEqual({ imported: 0, skipped: 1 });

		const list = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as unknown[];
		expect(list).toHaveLength(1);
	});

	it("toggles a contact's consent", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ phone: "+15557654321" }], source: "csv" }),
		});
		const [contact] = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string; consent: boolean }>;
		expect(contact.consent).toBe(false);

		const res = await SELF.fetch(`https://example.com/api/shane/contacts/${contact.id}`, {
			method: "PUT",
			body: JSON.stringify({ consent: true }),
		});
		expect((await res.json() as { consent: boolean }).consent).toBe(true);
	});

	it("blocks dialing a contact that hasn't consented", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ phone: "+15550001111", consent: false }], source: "csv" }),
		});
		const [contact] = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string }>;

		const res = await SELF.fetch("https://example.com/api/shane/calls/dial", {
			method: "POST",
			body: JSON.stringify({ contactId: contact.id }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/consent/);
	});

	it("reports Bird as unconfigured when a consented contact is dialed outside of test secrets", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ phone: "+15552223333", consent: true }], source: "csv" }),
		});
		const [contact] = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string }>;

		const res = await SELF.fetch("https://example.com/api/shane/calls/dial", {
			method: "POST",
			body: JSON.stringify({ contactId: contact.id }),
		});
		// This test env has no BIRD_API_KEY/BIRD_FROM_NUMBER secrets, so the
		// gate passes and the route reports the real reason it can't dial.
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not configured|BIRD_API_KEY/);
	});

	it("404s dialing an unknown contact", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/calls/dial", {
			method: "POST",
			body: JSON.stringify({ contactId: "does-not-exist" }),
		});
		expect(res.status).toBe(404);
	});

	it("adds a suppression and then blocks dialing that number", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ phone: "+15554445555", consent: true }], source: "csv" }),
		});
		const [contact] = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string; phone: string }>;

		await SELF.fetch("https://example.com/api/shane/suppressions", {
			method: "POST",
			body: JSON.stringify({ phone: contact.phone, reason: "requested removal" }),
		});

		const res = await SELF.fetch("https://example.com/api/shane/calls/dial", {
			method: "POST",
			body: JSON.stringify({ contactId: contact.id }),
		});
		expect(res.status).toBe(403);
		expect((await res.json() as { error: string }).error).toMatch(/suppression/);
	});

	it("rejects invalid JSON bodies", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/script", {
			method: "PUT",
			body: "not json",
		});
		expect(res.status).toBe(500);
	});
});

/**
 * Exercises the SMS campaign surface (worker/shane-sms-routes.ts).
 * Unlike calling, Bird's SMS batch endpoint is itself a bulk primitive —
 * so these tests cover the real "send to everyone eligible" path, not a
 * one-at-a-time flow, while still proving eligibility is recomputed
 * server-side rather than trusted from the client.
 */
describe("Shane AI SMS campaigns", () => {
	beforeAll(() => {
		const mutableEnv = env as unknown as { CALL_WINDOW_START: string; CALL_WINDOW_END: string };
		mutableEnv.CALL_WINDOW_START = "0";
		mutableEnv.CALL_WINDOW_END = "24";
	});

	beforeEach(async () => {
		const contacts = (await (
			await SELF.fetch("https://example.com/api/shane/contacts")
		).json()) as Array<{ id: string }>;
		for (const c of contacts) {
			await SELF.fetch(`https://example.com/api/shane/contacts/${c.id}`, { method: "DELETE" });
		}
	});

	it("gets and updates the campaign text message", async () => {
		const current = (await (
			await SELF.fetch("https://example.com/api/shane/text")
		).json()) as { body: string };
		expect(current.body.length).toBeGreaterThan(0);

		const put = await SELF.fetch("https://example.com/api/shane/text", {
			method: "PUT",
			body: JSON.stringify({ body: "Hi {{name}}, test message." }),
		});
		expect(put.status).toBe(200);
		expect((await put.json()) as { body: string }).toMatchObject({ body: "Hi {{name}}, test message." });
	});

	it("rejects an empty message body", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/text", {
			method: "PUT",
			body: JSON.stringify({ body: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("previews a campaign, separating eligible from excluded contacts", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({
				contacts: [
					{ name: "Consented", phone: "+15551110001", consent: true },
					{ name: "NoConsent", phone: "+15551110002", consent: false },
				],
				source: "test",
			}),
		});

		const res = await SELF.fetch("https://example.com/api/shane/campaign/preview", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			eligibleCount: number;
			excluded: Array<{ name: string; reason: string }>;
			batchCount: number;
		};
		expect(body.eligibleCount).toBe(1);
		expect(body.excluded).toHaveLength(1);
		expect(body.excluded[0].name).toBe("NoConsent");
		expect(body.excluded[0].reason).toMatch(/consent/);
		expect(body.batchCount).toBe(1);
	});

	it("blocks sending when Bird SMS isn't configured, after confirming eligibility matched", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ name: "Jordan", phone: "+15552220001", consent: true }], source: "test" }),
		});

		const res = await SELF.fetch("https://example.com/api/shane/campaign/send", {
			method: "POST",
			body: JSON.stringify({ confirmCount: 1 }),
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not configured|BIRD_API_KEY|SMS_FROM_SENDER/);
	});

	it("rejects sending when the confirmed count no longer matches eligible contacts", async () => {
		await SELF.fetch("https://example.com/api/shane/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts: [{ name: "Jordan", phone: "+15552220002", consent: true }], source: "test" }),
		});

		const res = await SELF.fetch("https://example.com/api/shane/campaign/send", {
			method: "POST",
			body: JSON.stringify({ confirmCount: 999 }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/changed/);
	});

	it("rejects sending when there are no eligible contacts at all", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/campaign/send", {
			method: "POST",
			body: JSON.stringify({ confirmCount: 0 }),
		});
		expect(res.status).toBe(400);
	});

	it("lists sms sends (empty before anything is sent)", async () => {
		const res = await SELF.fetch("https://example.com/api/shane/campaign/sends");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});
