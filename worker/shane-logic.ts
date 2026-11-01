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
	timezone: string | null; // IANA name, e.g. America/New_York
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
	const tzIdx = header.findIndex(function (h) {
		return h === "timezone" || h === "time zone" || h === "tz";
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
				return { name: null, phone: phone, consent: false, timezone: null };
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
				timezone: tzIdx >= 0 ? normalizeTimeZone(cols[tzIdx]) : null,
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
			contacts.push({ name: null, phone: phone, consent: false, timezone: null });
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

/** Returns the IANA zone name if the runtime recognizes it, otherwise null. */
export function normalizeTimeZone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const zone = raw.trim();
	if (!zone) return null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return null;
	}
}

/**
 * Hour (0-23) in the given IANA zone at instant `now`, or null when the zone
 * is missing or unknown. Calling hours are judged in the recipient's local
 * time, so a missing zone means the hour can't be checked and dialing is refused.
 */
export function localHourIn(timeZone: string | null | undefined, now: Date): number | null {
	const zone = normalizeTimeZone(timeZone);
	if (!zone) return null;
	const hour = Number(
		new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(now),
	);
	return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
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
	contact: { consent: boolean; optedOut: boolean; phone: string; timezone?: string | null },
	suppressed: Set<string>,
	now: Date,
	windowStart: number,
	windowEnd: number,
): DialGateResult {
	if (!contact.consent) return { allowed: false, reason: "contact has not given consent to be called" };
	if (contact.optedOut) return { allowed: false, reason: "contact has opted out" };
	if (suppressed.has(contact.phone)) return { allowed: false, reason: "number is on the suppression list" };
	const localHour = localHourIn(contact.timezone, now);
	if (localHour === null) {
		return { allowed: false, reason: "no valid time zone on file, so calling hours can't be checked" };
	}
	if (!isWithinCallingWindow(localHour, windowStart, windowEnd)) {
		return {
			allowed: false,
			reason: `outside calling hours (${windowStart}:00-${windowEnd}:00 in the contact's local time)`,
		};
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

// ---------------------------------------------------------------------------
// SMS campaigns
//
// Unlike Voice (one human-confirmed call at a time), Bird's SMS batch
// endpoint (POST /v1/sms/batches) is itself designed for sending many
// messages in one request, up to 100 per batch. Building a real "send to
// everyone eligible" action here matches that primitive rather than
// fighting it — the safety rail is the eligibility gate (same consent /
// opt-out / suppression / quiet-hours check as calling) plus a server-side
// recount the caller must confirm, not an artificial one-at-a-time limit.
// ---------------------------------------------------------------------------

/** Bird accepts at most this many messages per POST /v1/sms/batches request. */
export const MAX_SMS_BATCH_SIZE = 100;

/** Bird rejects free-text SMS bodies needing more than this many segments. */
export const MAX_SMS_SEGMENTS = 12;

const SMS_GSM7_SINGLE = 160;
const SMS_GSM7_CONCAT = 153;
const SMS_UCS2_SINGLE = 70;
const SMS_UCS2_CONCAT = 67;

/** True when every character fits the GSM-7 default alphabet closely enough to treat as GSM-7 for sizing. */
function isLikelyGsm7(text: string): boolean {
	// eslint-disable-next-line no-control-regex -- deliberately matching the basic Latin/ASCII range GSM-7 covers.
	return /^[\x00-\x7F]*$/.test(text);
}

/**
 * Estimates the SMS segment count for a message body. GSM-7 fits more
 * characters per segment than UCS-2 (needed once any character falls
 * outside the GSM-7 alphabet, e.g. most emoji or non-Latin scripts).
 * This is an estimate for UI display and the pre-send length check, not
 * a byte-exact carrier calculation.
 */
export function estimateSmsSegments(text: string): number {
	if (text.length === 0) return 1;
	const gsm7 = isLikelyGsm7(text);
	const singleCap = gsm7 ? SMS_GSM7_SINGLE : SMS_UCS2_SINGLE;
	const concatCap = gsm7 ? SMS_GSM7_CONCAT : SMS_UCS2_CONCAT;
	if (text.length <= singleCap) return 1;
	return Math.ceil(text.length / concatCap);
}

export class MessageTooLongError extends Error {
	constructor(segments: number) {
		super(
			`Message needs ${segments} SMS segments, which exceeds Bird's ${MAX_SMS_SEGMENTS}-segment cap. Shorten the message.`,
		);
		this.name = "MessageTooLongError";
	}
}

/** Replaces {{name}} with the contact's name, or "there" when none is known. */
export function renderMessage(template: string, contact: { name: string | null }): string {
	return template.replace(/\{\{\s*name\s*\}\}/gi, contact.name || "there");
}

/**
 * Appends a STOP reminder when the message doesn't already mention one.
 * CTIA guidance expects opt-out instructions in marketing SMS; this keeps
 * that from depending on the operator remembering to type it.
 */
export function ensureOptOutLine(text: string): string {
	if (/\bstop\b/i.test(text)) return text;
	const trimmed = text.trim();
	const needsSpace = trimmed.length > 0 && !/[.!?]$/.test(trimmed);
	return trimmed + (needsSpace ? "." : "") + " Reply STOP to opt out.";
}

/** Splits a list into chunks of at most `size`, for Bird's per-batch cap. */
export function chunkIntoBatches<T>(items: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

export interface SmsBatchItem {
	to: string;
	from: string;
	category: "marketing";
	text: string;
}

// ---------------------------------------------------------------------------
// Inbound call screening
//
// Bird's Voice Sequence API only documents voice.say (text + a language
// code — no voice selection, no custom or cloned voice) and voice.gather
// (keypad digits only — no speech recognition). So "answers questions the
// caller asks" here means a keypad-driven FAQ menu, not free-form spoken
// understanding, and the voice is whichever Bird speaks that language in,
// not a chosen or cloned voice. A real conversational, custom-voice
// answering system needs a separate SIP-connected AI voice runtime (see
// Bird's "Connect an AI voice application" guide) — a materially bigger
// integration than this sequence builder.
//
// This also runs as a PUBLISHED sequence bound to an inbound number in
// Bird's dashboard, not an inline per-call definition like outbound
// dialing: Bird's publish/versioning flow for saved sequences isn't a
// documented REST API, so the operator pastes this definition into the
// Bird dashboard's sequence editor and binds their inbound number to it
// there.
// ---------------------------------------------------------------------------

export interface FaqEntry {
	label: string;
	answer: string;
}

/** Greeting may use at most this many chained voice.say nodes (keeps the definition well under Bird's 16-node cap). */
export const MAX_GREETING_CHUNKS = 2;

/** At most this many FAQ menu options — digits 1-5; 0 is reserved for "talk to a live agent". */
export const MAX_FAQ_ENTRIES = 5;

/** A gather may play at most 4 prompts, so the spoken menu can span at most this many. */
export const MAX_MENU_PROMPTS = 4;

export class ScreeningTooComplexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScreeningTooComplexError";
	}
}

function buildMenuAnnouncement(faqs: FaqEntry[]): string {
	const options = faqs.map((faq, i) => `Press ${i + 1} for ${faq.label}.`).join(" ");
	return `${options} Press 0 to speak with a live agent.`;
}

/**
 * Builds a published-sequence definition that greets the caller, offers a
 * keypad menu of FAQ answers plus "talk to a live agent", speaks the
 * selected answer, then offers the live-agent transfer again before
 * ending the call. Forwards to the agent on an explicit "0" at either
 * menu, or when the caller doesn't make a clear choice at all (silence,
 * an unmapped key) — the safer default when intent is unclear.
 */
export function buildScreeningSequenceDefinition(
	greeting: string,
	faqs: FaqEntry[],
	agentNumber: string,
): { definition: SequenceDefinition; entryNodeId: string } {
	if (faqs.length > MAX_FAQ_ENTRIES) {
		throw new ScreeningTooComplexError(
			`${faqs.length} FAQ entries exceeds the ${MAX_FAQ_ENTRIES} this tool allows (digits 1-${MAX_FAQ_ENTRIES}; 0 is reserved for the live agent).`,
		);
	}

	const greetingChunks = chunkScript(greeting, MAX_SAY_BYTES);
	if (greetingChunks.length > MAX_GREETING_CHUNKS) {
		throw new ScreeningTooComplexError(
			`Greeting needs ${greetingChunks.length} say-steps, which exceeds the ${MAX_GREETING_CHUNKS} this tool allows. Shorten it.`,
		);
	}

	faqs.forEach((faq, i) => {
		if (byteLen(faq.answer) > MAX_SAY_BYTES) {
			throw new ScreeningTooComplexError(
				`FAQ #${i + 1} ("${faq.label}")'s answer is too long for one spoken segment (max ~${MAX_SAY_BYTES} bytes). Shorten it.`,
			);
		}
	});

	const menuPromptChunks = chunkScript(buildMenuAnnouncement(faqs), MAX_SAY_BYTES);
	if (menuPromptChunks.length > MAX_MENU_PROMPTS) {
		throw new ScreeningTooComplexError(
			`The menu announcement needs ${menuPromptChunks.length} prompts, which exceeds Bird's ${MAX_MENU_PROMPTS}-prompt gather limit. Use fewer or shorter FAQ labels.`,
		);
	}

	const nodes: SequenceNode[] = [];
	const greetingIds = (greetingChunks.length === 0 ? [""] : greetingChunks).map((_, i) =>
		i === 0 ? "greeting" : "greeting_" + i,
	);
	const effectiveGreetingChunks = greetingChunks.length === 0 ? [""] : greetingChunks;

	nodes.push({
		id: "start",
		type: "trigger.start_call",
		type_version: 1,
		config: { data_schema: { type: "object", properties: {} } },
		input: {},
		connections: { event: { node_id: greetingIds[0], port: "input" } },
	});

	effectiveGreetingChunks.forEach((chunk, i) => {
		const nextId = i + 1 < greetingIds.length ? greetingIds[i + 1] : "main_menu";
		nodes.push({
			id: greetingIds[i],
			type: "voice.say",
			type_version: 1,
			config: {},
			input: { text: chunk, language: "en" },
			connections: { next: { node_id: nextId, port: "input" } },
		});
	});

	const menuConnections: Record<string, { node_id: string; port: string }> = {
		talk_to_agent: { node_id: "agent_dial", port: "input" },
		timeout: { node_id: "agent_dial", port: "input" },
		fallback: { node_id: "agent_dial", port: "input" },
	};
	faqs.forEach((_, i) => {
		menuConnections["faq_" + i] = { node_id: "faq_say_" + i, port: "input" };
	});

	nodes.push({
		id: "main_menu",
		type: "voice.gather",
		type_version: 1,
		config: {},
		input: {
			prompts: menuPromptChunks.map((text) => ({ type: "say", text, language: "en" })),
			max_digits: 1,
			timeout_seconds: 8,
			inter_digit_timeout_seconds: 3,
			finish_on_key: null,
			matches: Object.fromEntries([
				...faqs.map((_, i): [string, string] => ["faq_" + i, String(i + 1)]),
				["talk_to_agent", "0"],
			]),
		},
		connections: menuConnections,
	});

	faqs.forEach((faq, i) => {
		nodes.push({
			id: "faq_say_" + i,
			type: "voice.say",
			type_version: 1,
			config: {},
			input: { text: faq.answer, language: "en" },
			connections: { next: { node_id: "after_faq_gather", port: "input" } },
		});
	});

	nodes.push({
		id: "after_faq_gather",
		type: "voice.gather",
		type_version: 1,
		config: {},
		input: {
			prompts: [{ type: "say", text: "Press 0 to speak with a live agent, or hang up. Thanks for calling.", language: "en" }],
			max_digits: 1,
			timeout_seconds: 6,
			inter_digit_timeout_seconds: 3,
			finish_on_key: null,
			matches: { talk_to_agent: "0" },
		},
		connections: {
			talk_to_agent: { node_id: "agent_dial", port: "input" },
			timeout: { node_id: "exit_done", port: "input" },
			fallback: { node_id: "exit_done", port: "input" },
		},
	});

	nodes.push({
		id: "agent_dial",
		type: "voice.dial",
		type_version: 2,
		config: {},
		input: { type: "pstn", pstn: { dest: agentNumber }, timeout_seconds: 30 },
		connections: {
			success: { node_id: "exit_transferred", port: "input" },
			busy: { node_id: "exit_unavailable", port: "input" },
			no_answer: { node_id: "exit_unavailable", port: "input" },
			failure: { node_id: "exit_unavailable", port: "input" },
		},
	});

	nodes.push({
		id: "exit_transferred",
		type: "logic.exit",
		type_version: 1,
		config: { status: "succeeded", reason: "transferred" },
		input: { output: {} },
		connections: {},
	});
	nodes.push({
		id: "exit_unavailable",
		type: "logic.exit",
		type_version: 1,
		config: { status: "failed", reason: "agent_unavailable" },
		input: { output: {} },
		connections: {},
	});
	nodes.push({
		id: "exit_done",
		type: "logic.exit",
		type_version: 1,
		config: { status: "succeeded", reason: "screened" },
		input: { output: {} },
		connections: {},
	});

	return {
		definition: { schema_version: 1, expression_environment: "bird.cel.v1", nodes },
		entryNodeId: "start",
	};
}

function byteLen(s: string): number {
	return new TextEncoder().encode(s).length;
}

/**
 * Builds the per-recipient SMS payloads for POST /v1/sms/batches: the
 * message template rendered with each contact's name, with a STOP
 * reminder guaranteed present. Throws MessageTooLongError up front if the
 * rendered text would blow Bird's segment cap for any contact that has a
 * name (the longest realistic rendering), so a bad template fails before
 * any network call rather than mid-batch.
 */
export function buildSmsBatchItems(
	contacts: Array<{ phone: string; name: string | null }>,
	template: string,
	fromSender: string,
): SmsBatchItem[] {
	return contacts.map(function (contact) {
		const rendered = ensureOptOutLine(renderMessage(template, contact));
		const segments = estimateSmsSegments(rendered);
		if (segments > MAX_SMS_SEGMENTS) {
			throw new MessageTooLongError(segments);
		}
		return { to: contact.phone, from: fromSender, category: "marketing", text: rendered };
	});
}
