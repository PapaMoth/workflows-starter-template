import type { CrmData } from "./types";

async function request<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(`/api/crm${path}`, {
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
		...init,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `Request failed (${res.status})`);
	}
	if (res.status === 204) return undefined as T;
	return res.json();
}

export const crmApi = {
	getAll: () => request<CrmData>("/all"),

	createCompany: (input: { name: string; domain?: string | null }) =>
		request("/companies", { method: "POST", body: JSON.stringify(input) }),
	updateCompany: (id: string, input: Record<string, unknown>) =>
		request(`/companies/${id}`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	deleteCompany: (id: string) =>
		request(`/companies/${id}`, { method: "DELETE" }),

	createContact: (input: {
		name: string;
		email?: string | null;
		phone?: string | null;
		companyId?: string | null;
	}) => request("/contacts", { method: "POST", body: JSON.stringify(input) }),
	updateContact: (id: string, input: Record<string, unknown>) =>
		request(`/contacts/${id}`, {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	deleteContact: (id: string) =>
		request(`/contacts/${id}`, { method: "DELETE" }),

	createDeal: (input: {
		title: string;
		value?: number;
		stage?: string;
		contactId?: string | null;
		companyId?: string | null;
	}) => request("/deals", { method: "POST", body: JSON.stringify(input) }),
	updateDeal: (id: string, input: Record<string, unknown>) =>
		request(`/deals/${id}`, { method: "PUT", body: JSON.stringify(input) }),
	deleteDeal: (id: string) => request(`/deals/${id}`, { method: "DELETE" }),

	createTask: (input: {
		title: string;
		dueAt?: number | null;
		contactId?: string | null;
		dealId?: string | null;
	}) => request("/tasks", { method: "POST", body: JSON.stringify(input) }),
	updateTask: (id: string, input: Record<string, unknown>) =>
		request(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(input) }),
	deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),

	createNote: (input: {
		body: string;
		contactId?: string | null;
		companyId?: string | null;
		dealId?: string | null;
	}) => request("/notes", { method: "POST", body: JSON.stringify(input) }),
	deleteNote: (id: string) => request(`/notes/${id}`, { method: "DELETE" }),
};
