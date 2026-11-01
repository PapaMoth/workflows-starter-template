import { DurableObject } from "cloudflare:workers";

export interface ShaneContact {
	id: string;
	name: string | null;
	phone: string;
	consent: boolean;
	optedOut: boolean;
	source: string | null;
	createdAt: number;
}

export type CallStatus = "dialing" | "completed" | "failed";

export interface ShaneCall {
	id: string;
	contactId: string;
	status: CallStatus;
	birdCallId: string | null;
	birdLegId: string | null;
	outcome: string | null;
	startedAt: number;
	endedAt: number | null;
}

export interface Suppression {
	phone: string;
	reason: string | null;
	createdAt: number;
}

export type SmsStatus = "sent" | "failed";

export interface ShaneSmsSend {
	id: string;
	contactId: string;
	status: SmsStatus;
	birdMessageId: string | null;
	segments: number | null;
	outcome: string | null;
	createdAt: number;
}

export interface ScreeningFaq {
	id: string;
	label: string;
	answer: string;
	createdAt: number;
}

export interface ScreeningConfig {
	greeting: string;
	agentNumber: string | null;
	updatedAt: number;
}

const DEFAULT_SCRIPT =
	"Hi, this is Shane calling on behalf of our team. I'm following up about your recent interest — do you have a quick minute?";

const DEFAULT_TEXT_MESSAGE =
	"Hi {{name}}, this is Shane following up about your recent interest. Reply STOP to opt out.";

const DEFAULT_GREETING = "Thanks for calling. Let's get you to the right place.";

/**
 * ShaneStoreDO - single-instance Durable Object holding Shane AI's state:
 * the current calling script, the imported contact list, the
 * suppression/opt-out list, and the call log. One global instance, like
 * CrmStoreDO; a multi-tenant deployment would shard by workspace id.
 */
export class ShaneStoreDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS script (
					id TEXT PRIMARY KEY DEFAULT 'current',
					body TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS contacts (
					id TEXT PRIMARY KEY,
					name TEXT,
					phone TEXT NOT NULL UNIQUE,
					consent INTEGER NOT NULL DEFAULT 0,
					opted_out INTEGER NOT NULL DEFAULT 0,
					source TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS suppressions (
					phone TEXT PRIMARY KEY,
					reason TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS calls (
					id TEXT PRIMARY KEY,
					contact_id TEXT NOT NULL,
					status TEXT NOT NULL,
					bird_call_id TEXT,
					bird_leg_id TEXT,
					outcome TEXT,
					started_at INTEGER NOT NULL,
					ended_at INTEGER
				);
				CREATE TABLE IF NOT EXISTS text_message (
					id TEXT PRIMARY KEY DEFAULT 'current',
					body TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS sms_sends (
					id TEXT PRIMARY KEY,
					contact_id TEXT NOT NULL,
					status TEXT NOT NULL,
					bird_message_id TEXT,
					segments INTEGER,
					outcome TEXT,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS screening_config (
					id TEXT PRIMARY KEY DEFAULT 'current',
					greeting TEXT NOT NULL,
					agent_number TEXT,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS screening_faqs (
					id TEXT PRIMARY KEY,
					label TEXT NOT NULL,
					answer TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
			`);

			const existing = this.ctx.storage.sql.exec("SELECT id FROM script WHERE id = 'current'").toArray();
			if (existing.length === 0) {
				this.ctx.storage.sql.exec(
					"INSERT INTO script (id, body, updated_at) VALUES ('current', ?, ?)",
					DEFAULT_SCRIPT,
					Date.now(),
				);
			}

			const existingText = this.ctx.storage.sql.exec("SELECT id FROM text_message WHERE id = 'current'").toArray();
			if (existingText.length === 0) {
				this.ctx.storage.sql.exec(
					"INSERT INTO text_message (id, body, updated_at) VALUES ('current', ?, ?)",
					DEFAULT_TEXT_MESSAGE,
					Date.now(),
				);
			}

			const existingScreening = this.ctx.storage.sql
				.exec("SELECT id FROM screening_config WHERE id = 'current'")
				.toArray();
			if (existingScreening.length === 0) {
				this.ctx.storage.sql.exec(
					"INSERT INTO screening_config (id, greeting, agent_number, updated_at) VALUES ('current', ?, NULL, ?)",
					DEFAULT_GREETING,
					Date.now(),
				);
			}
		});
	}

	// ---- Script ----

	async getScript(): Promise<{ body: string; updatedAt: number }> {
		const row = this.ctx.storage.sql.exec("SELECT * FROM script WHERE id = 'current'").toArray()[0];
		return { body: String(row.body), updatedAt: Number(row.updated_at) };
	}

	async setScript(body: string): Promise<{ body: string; updatedAt: number }> {
		const updatedAt = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE script SET body = ?, updated_at = ? WHERE id = 'current'",
			body,
			updatedAt,
		);
		return { body, updatedAt };
	}

	// ---- Contacts ----

	async listContacts(): Promise<ShaneContact[]> {
		return this.ctx.storage.sql
			.exec("SELECT * FROM contacts ORDER BY created_at DESC")
			.toArray()
			.map(rowToContact);
	}

	/** Imports contacts, skipping any phone already on file (unique). Returns counts, not rows. */
	async importContacts(
		contacts: Array<{ name?: string | null; phone: string; consent?: boolean }>,
		source: string,
	): Promise<{ imported: number; skipped: number }> {
		let imported = 0;
		let skipped = 0;
		for (const c of contacts) {
			const existing = this.ctx.storage.sql.exec("SELECT phone FROM contacts WHERE phone = ?", c.phone).toArray();
			if (existing.length > 0) {
				skipped++;
				continue;
			}
			this.ctx.storage.sql.exec(
				"INSERT INTO contacts (id, name, phone, consent, opted_out, source, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
				crypto.randomUUID(),
				c.name ?? null,
				c.phone,
				c.consent ? 1 : 0,
				source,
				Date.now(),
			);
			imported++;
		}
		return { imported, skipped };
	}

	async setContactConsent(id: string, consent: boolean): Promise<ShaneContact | null> {
		const existing = this.ctx.storage.sql.exec("SELECT * FROM contacts WHERE id = ?", id).toArray();
		if (existing.length === 0) return null;
		this.ctx.storage.sql.exec("UPDATE contacts SET consent = ? WHERE id = ?", consent ? 1 : 0, id);
		return { ...rowToContact(existing[0]), consent };
	}

	async setContactOptedOut(id: string, optedOut: boolean): Promise<ShaneContact | null> {
		const existing = this.ctx.storage.sql.exec("SELECT * FROM contacts WHERE id = ?", id).toArray();
		if (existing.length === 0) return null;
		this.ctx.storage.sql.exec("UPDATE contacts SET opted_out = ? WHERE id = ?", optedOut ? 1 : 0, id);
		return { ...rowToContact(existing[0]), optedOut };
	}

	async getContact(id: string): Promise<ShaneContact | null> {
		const rows = this.ctx.storage.sql.exec("SELECT * FROM contacts WHERE id = ?", id).toArray();
		return rows.length ? rowToContact(rows[0]) : null;
	}

	async deleteContact(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM contacts WHERE id = ?", id);
	}

	// ---- Suppressions ----

	async listSuppressions(): Promise<Suppression[]> {
		return this.ctx.storage.sql
			.exec("SELECT * FROM suppressions ORDER BY created_at DESC")
			.toArray()
			.map(function (r) {
				return { phone: String(r.phone), reason: r.reason == null ? null : String(r.reason), createdAt: Number(r.created_at) };
			});
	}

	async addSuppression(phone: string, reason: string | null): Promise<Suppression> {
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO suppressions (phone, reason, created_at) VALUES (?, ?, ?)",
			phone,
			reason,
			createdAt,
		);
		return { phone, reason, createdAt };
	}

	async removeSuppression(phone: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM suppressions WHERE phone = ?", phone);
	}

	// ---- Calls ----

	async listCalls(): Promise<ShaneCall[]> {
		return this.ctx.storage.sql
			.exec("SELECT * FROM calls ORDER BY started_at DESC")
			.toArray()
			.map(rowToCall);
	}

	async recordCallStart(input: {
		contactId: string;
		birdCallId: string | null;
		birdLegId: string | null;
	}): Promise<ShaneCall> {
		const id = crypto.randomUUID();
		const startedAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO calls (id, contact_id, status, bird_call_id, bird_leg_id, outcome, started_at, ended_at) VALUES (?, ?, 'dialing', ?, ?, NULL, ?, NULL)",
			id,
			input.contactId,
			input.birdCallId,
			input.birdLegId,
			startedAt,
		);
		return {
			id,
			contactId: input.contactId,
			status: "dialing",
			birdCallId: input.birdCallId,
			birdLegId: input.birdLegId,
			outcome: null,
			startedAt,
			endedAt: null,
		};
	}

	async recordCallFailed(id: string, outcome: string): Promise<void> {
		this.ctx.storage.sql.exec(
			"UPDATE calls SET status = 'failed', outcome = ?, ended_at = ? WHERE id = ?",
			outcome,
			Date.now(),
			id,
		);
	}

	async getSuppressedSet(): Promise<string[]> {
		return this.ctx.storage.sql
			.exec("SELECT phone FROM suppressions")
			.toArray()
			.map(function (r) {
				return String(r.phone);
			});
	}

	// ---- Text message (SMS campaign body) ----

	async getTextMessage(): Promise<{ body: string; updatedAt: number }> {
		const row = this.ctx.storage.sql.exec("SELECT * FROM text_message WHERE id = 'current'").toArray()[0];
		return { body: String(row.body), updatedAt: Number(row.updated_at) };
	}

	async setTextMessage(body: string): Promise<{ body: string; updatedAt: number }> {
		const updatedAt = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE text_message SET body = ?, updated_at = ? WHERE id = 'current'",
			body,
			updatedAt,
		);
		return { body, updatedAt };
	}

	// ---- SMS send log ----

	async listSmsSends(): Promise<ShaneSmsSend[]> {
		return this.ctx.storage.sql
			.exec("SELECT * FROM sms_sends ORDER BY created_at DESC")
			.toArray()
			.map(rowToSmsSend);
	}

	async recordSmsSends(
		entries: Array<{
			contactId: string;
			status: SmsStatus;
			birdMessageId: string | null;
			segments: number | null;
			outcome: string | null;
		}>,
	): Promise<ShaneSmsSend[]> {
		const createdAt = Date.now();
		const results: ShaneSmsSend[] = [];
		for (const entry of entries) {
			const id = crypto.randomUUID();
			this.ctx.storage.sql.exec(
				"INSERT INTO sms_sends (id, contact_id, status, bird_message_id, segments, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				id,
				entry.contactId,
				entry.status,
				entry.birdMessageId,
				entry.segments,
				entry.outcome,
				createdAt,
			);
			results.push({ id, createdAt, ...entry });
		}
		return results;
	}

	// ---- Call screening (inbound) ----

	async getScreeningConfig(): Promise<ScreeningConfig> {
		const row = this.ctx.storage.sql.exec("SELECT * FROM screening_config WHERE id = 'current'").toArray()[0];
		return {
			greeting: String(row.greeting),
			agentNumber: row.agent_number == null ? null : String(row.agent_number),
			updatedAt: Number(row.updated_at),
		};
	}

	async setScreeningConfig(greeting: string, agentNumber: string | null): Promise<ScreeningConfig> {
		const updatedAt = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE screening_config SET greeting = ?, agent_number = ?, updated_at = ? WHERE id = 'current'",
			greeting,
			agentNumber,
			updatedAt,
		);
		return { greeting, agentNumber, updatedAt };
	}

	async listScreeningFaqs(): Promise<ScreeningFaq[]> {
		return this.ctx.storage.sql
			.exec("SELECT * FROM screening_faqs ORDER BY created_at ASC")
			.toArray()
			.map(rowToScreeningFaq);
	}

	async addScreeningFaq(label: string, answer: string): Promise<ScreeningFaq> {
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO screening_faqs (id, label, answer, created_at) VALUES (?, ?, ?, ?)",
			id,
			label,
			answer,
			createdAt,
		);
		return { id, label, answer, createdAt };
	}

	async deleteScreeningFaq(id: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM screening_faqs WHERE id = ?", id);
	}
}

function rowToScreeningFaq(row: Record<string, unknown>): ScreeningFaq {
	return {
		id: String(row.id),
		label: String(row.label),
		answer: String(row.answer),
		createdAt: Number(row.created_at),
	};
}

function rowToContact(row: Record<string, unknown>): ShaneContact {
	return {
		id: String(row.id),
		name: row.name == null ? null : String(row.name),
		phone: String(row.phone),
		consent: Number(row.consent) === 1,
		optedOut: Number(row.opted_out) === 1,
		source: row.source == null ? null : String(row.source),
		createdAt: Number(row.created_at),
	};
}

function rowToSmsSend(row: Record<string, unknown>): ShaneSmsSend {
	return {
		id: String(row.id),
		contactId: String(row.contact_id),
		status: String(row.status) as SmsStatus,
		birdMessageId: row.bird_message_id == null ? null : String(row.bird_message_id),
		segments: row.segments == null ? null : Number(row.segments),
		outcome: row.outcome == null ? null : String(row.outcome),
		createdAt: Number(row.created_at),
	};
}

function rowToCall(row: Record<string, unknown>): ShaneCall {
	return {
		id: String(row.id),
		contactId: String(row.contact_id),
		status: String(row.status) as CallStatus,
		birdCallId: row.bird_call_id == null ? null : String(row.bird_call_id),
		birdLegId: row.bird_leg_id == null ? null : String(row.bird_leg_id),
		outcome: row.outcome == null ? null : String(row.outcome),
		startedAt: Number(row.started_at),
		endedAt: row.ended_at == null ? null : Number(row.ended_at),
	};
}
