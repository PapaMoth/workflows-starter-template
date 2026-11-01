/**
 * Client-side CRM types. Mirrors worker/crm-durable-object.ts; kept
 * separate because the client bundle can't import from the worker.
 */

export type DealStage = "lead" | "qualified" | "proposal" | "won" | "lost";

export const DEAL_STAGES: DealStage[] = [
	"lead",
	"qualified",
	"proposal",
	"won",
	"lost",
];

export const STAGE_LABELS: Record<DealStage, string> = {
	lead: "Lead",
	qualified: "Qualified",
	proposal: "Proposal",
	won: "Won",
	lost: "Lost",
};

export interface Company {
	id: string;
	name: string;
	domain: string | null;
	createdAt: number;
}

export interface Contact {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	companyId: string | null;
	createdAt: number;
}

export interface Deal {
	id: string;
	title: string;
	value: number;
	stage: DealStage;
	contactId: string | null;
	companyId: string | null;
	createdAt: number;
}

export interface Task {
	id: string;
	title: string;
	dueAt: number | null;
	done: boolean;
	contactId: string | null;
	dealId: string | null;
	createdAt: number;
}

export interface Note {
	id: string;
	body: string;
	contactId: string | null;
	companyId: string | null;
	dealId: string | null;
	createdAt: number;
}

export interface CrmData {
	companies: Company[];
	contacts: Contact[];
	deals: Deal[];
	tasks: Task[];
	notes: Note[];
}
