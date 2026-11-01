import type { ParsedContact, ShaneCall, ShaneContact, Suppression } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api/shane${path}`, {
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
		...init,
	});
	const payload = await res.json().catch(() => ({ error: res.statusText }));
	if (!res.ok) {
		throw new Error(payload.error ?? `Request failed (${res.status})`);
	}
	return payload as T;
}

export const shaneApi = {
	getScript: () => request<{ body: string; updatedAt: number }>("/script"),
	setScript: (body: string) =>
		request<{ body: string; updatedAt: number }>("/script", {
			method: "PUT",
			body: JSON.stringify({ body }),
		}),

	parseUpload: (text: string, kind: "csv" | "pdf") =>
		request<{ contacts: ParsedContact[] }>("/contacts/parse", {
			method: "POST",
			body: JSON.stringify({ text, kind }),
		}),

	listContacts: () => request<ShaneContact[]>("/contacts"),
	importContacts: (contacts: ParsedContact[], source: string) =>
		request<{ imported: number; skipped: number }>("/contacts/import", {
			method: "POST",
			body: JSON.stringify({ contacts, source }),
		}),
	setContactConsent: (id: string, consent: boolean) =>
		request<ShaneContact>(`/contacts/${id}`, { method: "PUT", body: JSON.stringify({ consent }) }),
	setContactOptedOut: (id: string, optedOut: boolean) =>
		request<ShaneContact>(`/contacts/${id}`, { method: "PUT", body: JSON.stringify({ optedOut }) }),
	deleteContact: (id: string) => request<void>(`/contacts/${id}`, { method: "DELETE" }),

	listSuppressions: () => request<Suppression[]>("/suppressions"),
	addSuppression: (phone: string, reason: string | null) =>
		request<Suppression>("/suppressions", { method: "POST", body: JSON.stringify({ phone, reason }) }),

	listCalls: () => request<ShaneCall[]>("/calls"),
	dial: (contactId: string) =>
		request<ShaneCall>("/calls/dial", { method: "POST", body: JSON.stringify({ contactId }) }),
};
