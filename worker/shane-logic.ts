/**
 * Pure logic for Shane AI, the outbound-calling tool: phone/contact
 * parsing, compliance gating, and building the Bird Voice sequence that
 * reads the script aloud. Kept free of I/O so it's directly unit-testable.
 *
 * Shane AI reads a script to the recipient via text-to-speech and offers
 * a keypad opt-out. It is NOT a live two-way conversational AI — Bird's
 * Voice sequence API (as documented) is a structured call flow (speak /
 * gather digits / branch), not a real-time dialogue engine. Describing it
 * as more than script playback plus opt-out would be inaccurate.
 */

export interface RawContactRow {
	name?: string | null;
	phone?: string | null;
	consent?: string | boolean | null;
}

export interface Contact {
	name: string | null;
	phone: string; // E.164
	consent: boolean;
}

/**
 * Longest a single voice.say node's text may be. Bird's node reference caps
 * rendered speech text at 160 bytes; this tool chunks at 130 to leave
 * headroom for the "Hi {name}. " greeting prefix templated onto the first
 * chunk, whose rendered length isn't known until call time.
 */
export const MAX_SAY_BYTES = 130;

/** Entry + say chunks + gather + 2 exits must stay within Bird's 16-node inline-run limit. */
export const MAX_SCRIPT_CHUNKS = 10;

/**
 * Normalizes a phone number to E.164. Assumes US/Canada (+1) for a bare
 * 10-digit number, since that's the common case for an unprefixed CSV
 * column; returns null for anything that doesn't resolve to a plausible
 * number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let digits = raw.replace(/[^\d+]/g, "");
	if (digits.startsWith("+")) {
		const rest = digits.slice(1);
		if (rest.length < 8 || rest.length > 15 || !/^\d+$/.test(rest)) return null;
		return "+" + rest;
	}
	digits = digits.replace(/\D/g, "");
	if (digits.length === 10) return "+1" + digits;
	if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
	return null;
}

function parseConsent(value: string | boolean | null | undefined): boolean {
	if (typeof value === "boolean") return value;
	if (!value) return false;
	return /^(yes|y|true|1|opted[\s_-]?in)$/i.test(value.trim());
}

/**
 * Parses CSV text into contacts. Expects a header row containing at least
 * a phone-like column (phone/number/mobile) and tolerates optional
 * name/consent columns. Rows with no resolvable phone number are dropped.
 */
export function parseCsvContacts(text: string): Contact[] {
	const lines = text
		.split(/\r?\n/)
		.map(function (l) {
			return l.trim();
		})
		.filter(Boolean);
	if (lines.length === 0) return [];

	const header = lines[0].split(",").map(function (h) {
		return h.trim().toLowerCase();
	});
	const nameIdx = header.findIndex(function (h) {
		return h === "name" || h === "full name" || h === "contact";
	});
	const phoneIdx = header.findIndex(function (h) {
		return h === "phone" || h === "number" || h === "mobile" || h === "phone number";
	});
	const consentIdx = header.findIndex(function (h) {
		return h === "consent" || h === "opted_in" || h === "opt_in" || h === "opted in";
	});

	// No recognizable header: treat the whole file as one bare phone number per line.
	if (phoneIdx === -1) {
		return lines
			.map(function (line) {
				return normalizePhone(line.split(",")[0]);
			})
			.filter(function (p): p is string {
				return !!p;
			})
			.map(function (phone) {
				return { name: null, phone: phone, consent: false };
			});
	}

	return lines
		.slice(1)
		.map(function (line) {
			const cols = line.split(",").map(function (c) {
				return c.trim();
			});
			const phone = normalizePhone(cols[phoneIdx]);
			if (!phone) return null;
			return {
				name: nameIdx >= 0 ? cols[nameIdx] || null : null,
				phone: phone,
				consent: consentIdx >= 0 ? parseConsent(cols[consentIdx]) : false,
			};
		})
		.filter(function (c): c is Contact {
			return c !== null;
		});
}

/**
 * Scans free text (e.g. extracted from a PDF) for phone-number-shaped
 * substrings. Has no way to learn consent from unstructured text, so
 * every match comes back with consent: false — the UI must have the
 * importer explicitly attest consent for this batch before any dial.
 */
export function extractPhoneNumbersFromText(text: string): Contact[] {
	const matches = text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || [];
	const seen = new Set<string>();
	const contacts: Contact[] = [];
	matches.forEach(function (m) {
		const phone = normalizePhone(m);
		if (phone && !seen.has(phone)) {
			seen.add(phone);
			contacts.push({ name: null, phone: phone, consent: false });
		}
	});
	return contacts;
}

/** True when `hour` (0-23, recipient's local time) falls inside [startHour, endHour). */
export function isWithinCallingWindow(
	hour: number,
	startHour: number,
	endHour: number,
): boolean {
	return hour >= startHour && hour < endHour;
}

/**
 * Keeps only contacts that are actually dialable: explicit consent, not
 * opted out, and not on the suppression list. This is the compliance
 * gate — nothing downstream should dial a contact that didn't pass it.
 */
export function filterDialable(
	contacts: Array<{ phone: string; consent: boolean; optedOut: boolean }>,
	suppressed: Set<string>,
): typeof contacts {
	return contacts.filter(function (c) {
		return c.consent && !c.optedOut && !suppressed.has(c.phone);
	});
}

export interface DialGateResult {
	allowed: boolean;
	reason?: string;
}

/**
 * The single compliance decision behind "may we dial this contact right
 * now": consent, opt-out, suppression list, and calling-hours window, all
 * in one place so nothing can place a call by skipping a check.
 */
export function evaluateDialGate(
	contact: { consent: boolean; optedOut: boolean; phone: string },
	suppressed: Set<string>,
	nowHour: number,
	windowStart: number,
	windowEnd: number,
): DialGateResult {
	if (!contact.consent) return { allowed: false, reason: "contact has not given consent to be called" };
	if (contact.optedOut) return { allowed: false, reason: "contact has opted out" };
	if (suppressed.has(contact.phone)) return { allowed: false, reason: "number is on the suppression list" };
	if (!isWithinCallingWindow(nowHour, windowStart, windowEnd)) {
		return { allowed: false, reason: `outside the configured calling window (${windowStart}:00-${windowEnd}:00)` };
	}
	return { allowed: true };
}

/** Splits a script into TTS-sized chunks without breaking mid-word, respecting UTF-8 byte length. */
export function chunkScript(script: string, maxBytes: number): string[] {
	const words = script.trim().split(/\s+/).filter(Boolean);
	const chunks: string[] = [];
	let current = "";
	const byteLen = function (s: string): number {
		return new TextEncoder().encode(s).length;
	};
	words.forEach(function (word) {
		const candidate = current ? current + " " + word : word;
		if (byteLen(candidate) > maxBytes && current) {
			chunks.push(current);
			current = word;
		} else {
			current = candidate;
		}
	});
	if (current) chunks.push(current);
	return chunks;
}

export interface SequenceNode {
	id: string;
	type: string;
	type_version: number;
	config: Record<string, unknown>;
	input: Record<string, unknown>;
	connections: Record<string, { node_id: string; port: string }>;
}

export interface SequenceDefinition {
	schema_version: 1;
	expression_environment: "bird.cel.v1";
	nodes: SequenceNode[];
}

export class ScriptTooLongError extends Error {
	constructor(chunkCount: number) {
		super(
			`Script needs ${chunkCount} say-steps, which exceeds the ${MAX_SCRIPT_CHUNKS} this tool allows to stay under Bird's 16-node inline-run limit. Shorten the script.`,
		);
		this.name = "ScriptTooLongError";
	}
}

/**
 * Builds an inline Bird Voice sequence definition that greets the
 * recipient by name (if known), reads the script via chained voice.say
 * nodes, then gathers a keypad opt-out before ending the call.
 */
export function buildCallSequenceDefinition(
	script: string,
	optOutDigit: string,
): { definition: SequenceDefinition; entryNodeId: string } {
	let chunks = chunkScript(script, MAX_SAY_BYTES);
	if (chunks.length === 0) chunks = [""];
	if (chunks.length > MAX_SCRIPT_CHUNKS) {
		throw new ScriptTooLongError(chunks.length);
	}

	const nodes: SequenceNode[] = [];
	const sayIds = chunks.map(function (_, i) {
		return i === 0 ? "greeting" : "say_" + i;
	});
	nodes.push({
		id: "start",
		type: "trigger.start_call",
		type_version: 1,
		config: {
			data_schema: { type: "object", properties: { name: { type: "string" } } },
		},
		input: {},
		connections: { event: { node_id: sayIds[0], port: "input" } },
	});

	chunks.forEach(function (chunk, i) {
		const text =
			i === 0
				? { $template: ["Hi ", { $expr: "has(trigger.data.name) ? trigger.data.name : 'there'" }, ". " + chunk] }
				: chunk;
		const nextId = i + 1 < sayIds.length ? sayIds[i + 1] : "optout_gather";
		nodes.push({
			id: sayIds[i],
			type: "voice.say",
			type_version: 1,
			config: {},
			input: { text: text, language: "en" },
			connections: { next: { node_id: nextId, port: "input" } },
		});
	});

	nodes.push({
		id: "optout_gather",
		type: "voice.gather",
		type_version: 1,
		config: {},
		input: {
			prompts: [
				{
					type: "say",
					text: `Press ${optOutDigit} at any time to be removed from our calling list. Otherwise, thanks for your time.`,
					language: "en",
				},
			],
			max_digits: 1,
			timeout_seconds: 6,
			inter_digit_timeout_seconds: 3,
			finish_on_key: null,
			matches: { opt_out: optOutDigit },
		},
		connections: {
			opt_out: { node_id: "exit_opt_out", port: "input" },
			timeout: { node_id: "exit_done", port: "input" },
			fallback: { node_id: "exit_done", port: "input" },
		},
	});

	nodes.push({
		id: "exit_opt_out",
		type: "logic.exit",
		type_version: 1,
		config: { status: "succeeded", reason: "opted_out" },
		input: { output: {} },
		connections: {},
	});
	nodes.push({
		id: "exit_done",
		type: "logic.exit",
		type_version: 1,
		config: { status: "succeeded", reason: "script_completed" },
		input: { output: {} },
		connections: {},
	});

	return {
		definition: { schema_version: 1, expression_environment: "bird.cel.v1", nodes: nodes },
		entryNodeId: "start",
	};
}
