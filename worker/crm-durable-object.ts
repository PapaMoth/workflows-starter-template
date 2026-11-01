import { DurableObject } from "cloudflare:workers";

export type DealStage = "lead" | "qualified" | "proposal" | "won" | "lost";

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

export const DEAL_STAGES: DealStage[] = [
	"lead",
	"qualified",
	"proposal",
	"won",
	"lost",
];

/**
 * CrmStoreDO - single-instance Durable Object holding all CRM data in its
 * built-in SQLite storage. One global instance backs the whole app; a
 * multi-tenant deployment would shard by workspace id instead.
 */
export class CrmStoreDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS companies (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					domain TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS contacts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT,
					phone TEXT,
					company_id TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS deals (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					value REAL NOT NULL DEFAULT 0,
					stage TEXT NOT NULL DEFAULT 'lead',
					contact_id TEXT,
					company_id TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS tasks (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					due_at INTEGER,
					done INTEGER NOT NULL DEFAULT 0,
					contact_id TEXT,
					deal_id TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS notes (
					id TEXT PRIMARY KEY,
					body TEXT NOT NULL,
					contact_id TEXT,
					company_id TEXT,
					deal_id TEXT,
					created_at INTEGER NOT NULL
				);
			`);
		});
	}

	// ---- Companies ----

	async listCompanies(): Promise<Company[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM companies ORDER BY created_at DESC")
			.toArray();
		return rows.map(rowToCompany);
	}

	async createCompany(input: { name: string; domain?: string | null }): Promise<Company> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO companies (id, name, domain, created_at) VALUES (?, ?, ?, ?)",
			id,
			input.name,
			input.domain ?? null,
			createdAt,
		);
		return { id, name: input.name, domain: input.domain ?? null, createdAt };
	}

	async updateCompany(
		id: string,
		input: { name?: string; domain?: string | null },
	): Promise<Company | null> {
		const existing = this.ctx.storage.sql
			.exec("SELECT * FROM companies WHERE id = ?", id)
			.toArray();
		if (existing.length === 0) return null;
		const current = rowToCompany(existing[0]);
		const next = {
			name: input.name ?? current.name,
			domain: input.domain !== undefined ? input.domain : current.domain,
		};
		this.ctx.storage.sql.exec(
			"UPDATE companies SET name = ?, domain = ? WHERE id = ?",
			next.name,
			next.domain,
			id,
		);
		return { ...current, ...next };
	}

	async deleteCompany(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM companies WHERE id = ?", id);
	}

	// ---- Contacts ----

	async listContacts(): Promise<Contact[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM contacts ORDER BY created_at DESC")
			.toArray();
		return rows.map(rowToContact);
	}

	async createContact(input: {
		name: string;
		email?: string | null;
		phone?: string | null;
		companyId?: string | null;
	}): Promise<Contact> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO contacts (id, name, email, phone, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			input.name,
			input.email ?? null,
			input.phone ?? null,
			input.companyId ?? null,
			createdAt,
		);
		return {
			id,
			name: input.name,
			email: input.email ?? null,
			phone: input.phone ?? null,
			companyId: input.companyId ?? null,
			createdAt,
		};
	}

	async updateContact(
		id: string,
		input: {
			name?: string;
			email?: string | null;
			phone?: string | null;
			companyId?: string | null;
		},
	): Promise<Contact | null> {
		const existing = this.ctx.storage.sql
			.exec("SELECT * FROM contacts WHERE id = ?", id)
			.toArray();
		if (existing.length === 0) return null;
		const current = rowToContact(existing[0]);
		const next = {
			name: input.name ?? current.name,
			email: input.email !== undefined ? input.email : current.email,
			phone: input.phone !== undefined ? input.phone : current.phone,
			companyId:
				input.companyId !== undefined ? input.companyId : current.companyId,
		};
		this.ctx.storage.sql.exec(
			"UPDATE contacts SET name = ?, email = ?, phone = ?, company_id = ? WHERE id = ?",
			next.name,
			next.email,
			next.phone,
			next.companyId,
			id,
		);
		return { ...current, ...next };
	}

	async deleteContact(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM contacts WHERE id = ?", id);
	}

	// ---- Deals ----

	async listDeals(): Promise<Deal[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM deals ORDER BY created_at DESC")
			.toArray();
		return rows.map(rowToDeal);
	}

	async createDeal(input: {
		title: string;
		value?: number;
		stage?: DealStage;
		contactId?: string | null;
		companyId?: string | null;
	}): Promise<Deal> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		const stage = input.stage ?? "lead";
		const value = input.value ?? 0;
		this.ctx.storage.sql.exec(
			"INSERT INTO deals (id, title, value, stage, contact_id, company_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id,
			input.title,
			value,
			stage,
			input.contactId ?? null,
			input.companyId ?? null,
			createdAt,
		);
		return {
			id,
			title: input.title,
			value,
			stage,
			contactId: input.contactId ?? null,
			companyId: input.companyId ?? null,
			createdAt,
		};
	}

	async updateDeal(
		id: string,
		input: {
			title?: string;
			value?: number;
			stage?: DealStage;
			contactId?: string | null;
			companyId?: string | null;
		},
	): Promise<Deal | null> {
		const existing = this.ctx.storage.sql
			.exec("SELECT * FROM deals WHERE id = ?", id)
			.toArray();
		if (existing.length === 0) return null;
		const current = rowToDeal(existing[0]);
		const next = {
			title: input.title ?? current.title,
			value: input.value ?? current.value,
			stage: input.stage ?? current.stage,
			contactId:
				input.contactId !== undefined ? input.contactId : current.contactId,
			companyId:
				input.companyId !== undefined ? input.companyId : current.companyId,
		};
		this.ctx.storage.sql.exec(
			"UPDATE deals SET title = ?, value = ?, stage = ?, contact_id = ?, company_id = ? WHERE id = ?",
			next.title,
			next.value,
			next.stage,
			next.contactId,
			next.companyId,
			id,
		);
		return { ...current, ...next };
	}

	async deleteDeal(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM deals WHERE id = ?", id);
	}

	// ---- Tasks ----

	async listTasks(): Promise<Task[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM tasks ORDER BY (due_at IS NULL), due_at ASC")
			.toArray();
		return rows.map(rowToTask);
	}

	async createTask(input: {
		title: string;
		dueAt?: number | null;
		contactId?: string | null;
		dealId?: string | null;
	}): Promise<Task> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO tasks (id, title, due_at, done, contact_id, deal_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
			id,
			input.title,
			input.dueAt ?? null,
			input.contactId ?? null,
			input.dealId ?? null,
			createdAt,
		);
		return {
			id,
			title: input.title,
			dueAt: input.dueAt ?? null,
			done: false,
			contactId: input.contactId ?? null,
			dealId: input.dealId ?? null,
			createdAt,
		};
	}

	async updateTask(
		id: string,
		input: {
			title?: string;
			dueAt?: number | null;
			done?: boolean;
			contactId?: string | null;
			dealId?: string | null;
		},
	): Promise<Task | null> {
		const existing = this.ctx.storage.sql
			.exec("SELECT * FROM tasks WHERE id = ?", id)
			.toArray();
		if (existing.length === 0) return null;
		const current = rowToTask(existing[0]);
		const next = {
			title: input.title ?? current.title,
			dueAt: input.dueAt !== undefined ? input.dueAt : current.dueAt,
			done: input.done ?? current.done,
			contactId:
				input.contactId !== undefined ? input.contactId : current.contactId,
			dealId: input.dealId !== undefined ? input.dealId : current.dealId,
		};
		this.ctx.storage.sql.exec(
			"UPDATE tasks SET title = ?, due_at = ?, done = ?, contact_id = ?, deal_id = ? WHERE id = ?",
			next.title,
			next.dueAt,
			next.done ? 1 : 0,
			next.contactId,
			next.dealId,
			id,
		);
		return { ...current, ...next };
	}

	async deleteTask(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM tasks WHERE id = ?", id);
	}

	// ---- Notes ----

	async listNotes(): Promise<Note[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM notes ORDER BY created_at DESC")
			.toArray();
		return rows.map(rowToNote);
	}

	async createNote(input: {
		body: string;
		contactId?: string | null;
		companyId?: string | null;
		dealId?: string | null;
	}): Promise<Note> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO notes (id, body, contact_id, company_id, deal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			input.body,
			input.contactId ?? null,
			input.companyId ?? null,
			input.dealId ?? null,
			createdAt,
		);
		return {
			id,
			body: input.body,
			contactId: input.contactId ?? null,
			companyId: input.companyId ?? null,
			dealId: input.dealId ?? null,
			createdAt,
		};
	}

	async deleteNote(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM notes WHERE id = ?", id);
	}

	// ---- Combined fetch for the dashboard's first load ----

	async getAll(): Promise<{
		companies: Company[];
		contacts: Contact[];
		deals: Deal[];
		tasks: Task[];
		notes: Note[];
	}> {
		const [companies, contacts, deals, tasks, notes] = await Promise.all([
			this.listCompanies(),
			this.listContacts(),
			this.listDeals(),
			this.listTasks(),
			this.listNotes(),
		]);
		return { companies, contacts, deals, tasks, notes };
	}
}

// Row shapes come back from storage.sql with snake_case columns and
// SQLite's loose typing (e.g. booleans as 0/1), so map explicitly instead
// of trusting `as`.

function rowToCompany(row: Record<string, unknown>): Company {
	return {
		id: String(row.id),
		name: String(row.name),
		domain: row.domain == null ? null : String(row.domain),
		createdAt: Number(row.created_at),
	};
}

function rowToContact(row: Record<string, unknown>): Contact {
	return {
		id: String(row.id),
		name: String(row.name),
		email: row.email == null ? null : String(row.email),
		phone: row.phone == null ? null : String(row.phone),
		companyId: row.company_id == null ? null : String(row.company_id),
		createdAt: Number(row.created_at),
	};
}

function rowToDeal(row: Record<string, unknown>): Deal {
	return {
		id: String(row.id),
		title: String(row.title),
		value: Number(row.value),
		stage: String(row.stage) as DealStage,
		contactId: row.contact_id == null ? null : String(row.contact_id),
		companyId: row.company_id == null ? null : String(row.company_id),
		createdAt: Number(row.created_at),
	};
}

function rowToTask(row: Record<string, unknown>): Task {
	return {
		id: String(row.id),
		title: String(row.title),
		dueAt: row.due_at == null ? null : Number(row.due_at),
		done: Number(row.done) === 1,
		contactId: row.contact_id == null ? null : String(row.contact_id),
		dealId: row.deal_id == null ? null : String(row.deal_id),
		createdAt: Number(row.created_at),
	};
}

function rowToNote(row: Record<string, unknown>): Note {
	return {
		id: String(row.id),
		body: String(row.body),
		contactId: row.contact_id == null ? null : String(row.contact_id),
		companyId: row.company_id == null ? null : String(row.company_id),
		dealId: row.deal_id == null ? null : String(row.deal_id),
		createdAt: Number(row.created_at),
	};
}
