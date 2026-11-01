import type {
	CampaignPreview,
	CampaignSendResult,
	GeneratedSequence,
	ParsedContact,
	ScreeningConfig,
	ScreeningFaq,
	ShaneCall,
	ShaneContact,
	ShaneSmsSend,
	Suppression,
} from "./types";

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

	getTextMessage: () => request<{ body: string; updatedAt: number }>("/text"),
	setTextMessage: (body: string) =>
		request<{ body: string; updatedAt: number }>("/text", { method: "PUT", body: JSON.stringify({ body }) }),

	previewCampaign: () => request<CampaignPreview>("/campaign/preview", { method: "POST" }),
	sendCampaign: (confirmCount: number) =>
		request<CampaignSendResult>("/campaign/send", { method: "POST", body: JSON.stringify({ confirmCount }) }),
	listSmsSends: () => request<ShaneSmsSend[]>("/campaign/sends"),

	getScreeningConfig: () => request<ScreeningConfig>("/screening/config"),
	setScreeningConfig: (greeting: string, agentNumber: string | null) =>
		request<ScreeningConfig>("/screening/config", {
			method: "PUT",
			body: JSON.stringify({ greeting, agentNumber }),
		}),
	listScreeningFaqs: () => request<ScreeningFaq[]>("/screening/faqs"),
	addScreeningFaq: (label: string, answer: string) =>
		request<ScreeningFaq>("/screening/faqs", { method: "POST", body: JSON.stringify({ label, answer }) }),
	deleteScreeningFaq: (id: string) => request<void>(`/screening/faqs/${id}`, { method: "DELETE" }),
	generateScreeningSequence: () => request<GeneratedSequence>("/screening/generate", { method: "POST" }),
};
