import { describe, it, expect } from "vitest";
import {
	normalizePhone,
	parseCsvContacts,
	extractPhoneNumbersFromText,
	isWithinCallingWindow,
	filterDialable,
	evaluateDialGate,
	chunkScript,
	buildCallSequenceDefinition,
	ScriptTooLongError,
	MAX_SAY_BYTES,
	MAX_SCRIPT_CHUNKS,
	estimateSmsSegments,
	renderMessage,
	ensureOptOutLine,
	chunkIntoBatches,
	buildSmsBatchItems,
	MessageTooLongError,
	MAX_SMS_BATCH_SIZE,
	buildScreeningSequenceDefinition,
	ScreeningTooComplexError,
	MAX_FAQ_ENTRIES,
	MAX_GREETING_CHUNKS,
	type FaqEntry,
} from "../worker/shane-logic";

describe("normalizePhone", () => {
	it("adds +1 to a bare 10-digit US number", () => {
		expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
	});

	it("accepts an 11-digit number already starting with 1", () => {
		expect(normalizePhone("15551234567")).toBe("+15551234567");
	});

	it("keeps an already-E.164 international number", () => {
		expect(normalizePhone("+442071838750")).toBe("+442071838750");
	});

	it("rejects numbers that are too short or malformed", () => {
		expect(normalizePhone("12345")).toBeNull();
		expect(normalizePhone("not a number")).toBeNull();
		expect(normalizePhone(null)).toBeNull();
		expect(normalizePhone(undefined)).toBeNull();
	});
});

describe("parseCsvContacts", () => {
	it("parses name, phone and consent columns", () => {
		const csv = "name,phone,consent\nJordan Keane,555-123-4567,yes\nPriya Nandan,5551119999,no";
		expect(parseCsvContacts(csv)).toEqual([
			{ name: "Jordan Keane", phone: "+15551234567", consent: true, timezone: null },
			{ name: "Priya Nandan", phone: "+15551119999", consent: false, timezone: null },
		]);
	});

	it("drops rows with no resolvable phone number", () => {
		const csv = "name,phone,consent\nNo Phone,,yes\nGood,5551234567,yes";
		expect(parseCsvContacts(csv)).toEqual([{ name: "Good", phone: "+15551234567", consent: true, timezone: null }]);
	});

	it("treats a headerless file as one bare phone number per line", () => {
		const csv = "5551234567\n5559876543";
		expect(parseCsvContacts(csv)).toEqual([
			{ name: null, phone: "+15551234567", consent: false, timezone: null },
			{ name: null, phone: "+15559876543", consent: false, timezone: null },
		]);
	});

	it("returns an empty array for empty input", () => {
		expect(parseCsvContacts("")).toEqual([]);
	});
});

describe("extractPhoneNumbersFromText", () => {
	it("finds phone-shaped numbers in free text and dedupes them", () => {
		const text = "Call Jordan at (555) 123-4567 or back line 555-123-4567. Also Priya 555 987 6543.";
		const contacts = extractPhoneNumbersFromText(text);
		expect(contacts).toEqual([
			{ name: null, phone: "+15551234567", consent: false, timezone: null },
			{ name: null, phone: "+15559876543", consent: false, timezone: null },
		]);
	});

	it("returns an empty array when no phone numbers appear", () => {
		expect(extractPhoneNumbersFromText("No numbers here at all.")).toEqual([]);
	});
});

describe("isWithinCallingWindow", () => {
	it("is true inside the window and false outside it", () => {
		expect(isWithinCallingWindow(10, 9, 20)).toBe(true);
		expect(isWithinCallingWindow(9, 9, 20)).toBe(true);
		expect(isWithinCallingWindow(20, 9, 20)).toBe(false);
		expect(isWithinCallingWindow(7, 9, 20)).toBe(false);
	});
});

describe("filterDialable", () => {
	const contacts = [
		{ phone: "+1", consent: true, optedOut: false },
		{ phone: "+2", consent: false, optedOut: false },
		{ phone: "+3", consent: true, optedOut: true },
		{ phone: "+4", consent: true, optedOut: false },
	];

	it("keeps only consented, non-opted-out, non-suppressed contacts", () => {
		const result = filterDialable(contacts, new Set(["+4"]));
		expect(result).toEqual([{ phone: "+1", consent: true, optedOut: false }]);
	});

	it("returns an empty array when nothing qualifies", () => {
		expect(filterDialable(contacts, new Set(["+1", "+4"]))).toEqual([]);
	});
});

describe("evaluateDialGate", () => {
	const base = { consent: true, optedOut: false, phone: "+15551234567", timezone: "UTC" };
	const at = (hourUtc: number) => new Date(Date.UTC(2026, 0, 15, hourUtc));

	it("allows a consented, non-suppressed contact inside the calling window", () => {
		expect(evaluateDialGate(base, new Set(), at(14), 9, 20)).toEqual({ allowed: true });
	});

	it("blocks a contact that hasn't consented", () => {
		const result = evaluateDialGate({ ...base, consent: false }, new Set(), at(14), 9, 20);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/consent/);
	});

	it("blocks a contact that opted out", () => {
		const result = evaluateDialGate({ ...base, optedOut: true }, new Set(), at(14), 9, 20);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/opted out/);
	});

	it("blocks a number on the suppression list", () => {
		const result = evaluateDialGate(base, new Set([base.phone]), at(14), 9, 20);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/suppression/);
	});

	it("blocks dialing outside the calling-hours window", () => {
		const result = evaluateDialGate(base, new Set(), at(6), 9, 20);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/calling hours/);
	});
});

describe("chunkScript", () => {
	it("keeps a short script as a single chunk", () => {
		expect(chunkScript("Hi there, quick call about your account.", 130)).toEqual([
			"Hi there, quick call about your account.",
		]);
	});

	it("splits a long script into multiple chunks without exceeding the byte limit", () => {
		const script = Array(10).fill("word").join(" ").repeat(5);
		const chunks = chunkScript(script, 20);
		expect(chunks.length).toBeGreaterThan(1);
		chunks.forEach((c) => {
			expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(20);
		});
		expect(chunks.join(" ")).toBe(script);
	});

	it("returns an empty array for blank input", () => {
		expect(chunkScript("   ", 130)).toEqual([]);
	});
});

describe("buildCallSequenceDefinition", () => {
	it("builds a greeting, say chunks, opt-out gather and two exits for a short script", () => {
		const { definition, entryNodeId } = buildCallSequenceDefinition(
			"Hi, this is a quick call about your account renewal.",
			"9",
		);
		expect(entryNodeId).toBe("start");
		const ids = definition.nodes.map((n) => n.id);
		expect(ids).toEqual(["start", "greeting", "optout_gather", "exit_opt_out", "exit_done"]);

		const gather = definition.nodes.find((n) => n.id === "optout_gather")!;
		expect(gather.input.matches).toEqual({ opt_out: "9" });
		expect(gather.connections.opt_out.node_id).toBe("exit_opt_out");
		expect(gather.connections.timeout.node_id).toBe("exit_done");
		expect(gather.connections.fallback.node_id).toBe("exit_done");
	});

	it("chains multiple say nodes for a longer script, each within the byte limit", () => {
		const longScript = Array(60).fill("word").join(" ");
		const { definition } = buildCallSequenceDefinition(longScript, "9");
		const sayNodes = definition.nodes.filter((n) => n.type === "voice.say");
		expect(sayNodes.length).toBeGreaterThan(1);
		sayNodes.slice(1).forEach((n) => {
			const text = n.input.text as string;
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_SAY_BYTES);
		});
		// each say chains to the next, and the last one chains into the gather
		for (let i = 0; i < sayNodes.length - 1; i++) {
			expect(sayNodes[i].connections.next.node_id).toBe(sayNodes[i + 1].id);
		}
		expect(sayNodes[sayNodes.length - 1].connections.next.node_id).toBe("optout_gather");
	});

	it("throws ScriptTooLongError when the script needs more chunks than the node budget allows", () => {
		const chunks = chunkScript(Array(400).fill("word").join(" "), MAX_SAY_BYTES);
		expect(chunks.length).toBeGreaterThan(MAX_SCRIPT_CHUNKS);
		const hugeScript = Array(400).fill("word").join(" ");
		expect(() => buildCallSequenceDefinition(hugeScript, "9")).toThrow(ScriptTooLongError);
	});

	it("templates the first line with the recipient's name via trigger.data", () => {
		const { definition } = buildCallSequenceDefinition("Following up on your order.", "9");
		const greeting = definition.nodes.find((n) => n.id === "greeting")!;
		expect(greeting.input.text).toMatchObject({
			$template: expect.arrayContaining([expect.objectContaining({ $expr: expect.stringContaining("trigger.data.name") })]),
		});
	});

	it("keeps the total node count within Bird's 16-node inline-run limit", () => {
		const script = Array(9 * 15).fill("word").join(" "); // forces close to MAX_SCRIPT_CHUNKS chunks
		const { definition } = buildCallSequenceDefinition(script, "9");
		expect(definition.nodes.length).toBeLessThanOrEqual(16);
	});
});

describe("estimateSmsSegments", () => {
	it("counts a short plain-ASCII message as one segment", () => {
		expect(estimateSmsSegments("Hi there, quick update for you.")).toBe(1);
	});

	it("counts exactly at the single-segment boundary as one segment", () => {
		expect(estimateSmsSegments("a".repeat(160))).toBe(1);
	});

	it("splits a long plain-ASCII message into multiple concatenated segments", () => {
		expect(estimateSmsSegments("a".repeat(161))).toBe(2);
		expect(estimateSmsSegments("a".repeat(153 * 2 + 1))).toBe(3);
	});

	it("uses the tighter UCS-2 caps once any character falls outside GSM-7", () => {
		expect(estimateSmsSegments("a".repeat(70))).toBe(1);
		expect(estimateSmsSegments("é" + "a".repeat(70))).toBe(2);
	});

	it("treats an empty message as one segment", () => {
		expect(estimateSmsSegments("")).toBe(1);
	});
});

describe("renderMessage", () => {
	it("substitutes {{name}} with the contact's name", () => {
		expect(renderMessage("Hi {{name}}, following up!", { name: "Priya" })).toBe("Hi Priya, following up!");
	});

	it("falls back to 'there' when the contact has no name", () => {
		expect(renderMessage("Hi {{name}}!", { name: null })).toBe("Hi there!");
	});

	it("is case-insensitive and tolerates internal spacing", () => {
		expect(renderMessage("Hey {{ Name }}", { name: "Jordan" })).toBe("Hey Jordan");
	});

	it("leaves a template with no placeholder unchanged", () => {
		expect(renderMessage("Hello there", { name: "Jordan" })).toBe("Hello there");
	});
});

describe("ensureOptOutLine", () => {
	it("appends a STOP reminder when the message doesn't mention one", () => {
		expect(ensureOptOutLine("Thanks for your interest")).toBe("Thanks for your interest. Reply STOP to opt out.");
	});

	it("doesn't duplicate an existing STOP mention", () => {
		expect(ensureOptOutLine("Reply STOP anytime to unsubscribe.")).toBe("Reply STOP anytime to unsubscribe.");
	});

	it("doesn't add a redundant period after existing punctuation", () => {
		expect(ensureOptOutLine("Thanks!")).toBe("Thanks! Reply STOP to opt out.");
	});
});

describe("chunkIntoBatches", () => {
	it("splits items into batches no larger than the given size", () => {
		const items = Array.from({ length: 250 }, (_, i) => i);
		const batches = chunkIntoBatches(items, MAX_SMS_BATCH_SIZE);
		expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
		expect(batches.flat()).toEqual(items);
	});

	it("returns a single batch when everything fits", () => {
		expect(chunkIntoBatches([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
	});

	it("returns no batches for an empty list", () => {
		expect(chunkIntoBatches([], 100)).toEqual([]);
	});
});

describe("buildSmsBatchItems", () => {
	it("builds one batch item per contact, templated and with an opt-out line", () => {
		const items = buildSmsBatchItems(
			[{ phone: "+15551234567", name: "Jordan" }],
			"Hi {{name}}, we have an update for you.",
			"+15557654321",
		);
		expect(items).toEqual([
			{
				to: "+15551234567",
				from: "+15557654321",
				category: "marketing",
				text: "Hi Jordan, we have an update for you. Reply STOP to opt out.",
			},
		]);
	});

	it("renders a different message per contact from the same template", () => {
		const items = buildSmsBatchItems(
			[
				{ phone: "+1", name: "Alex" },
				{ phone: "+2", name: null },
			],
			"Hi {{name}}!",
			"+1555000",
		);
		expect(items[0].text).toContain("Alex");
		expect(items[1].text).toContain("there");
	});

	it("throws MessageTooLongError before returning anything if the template is too long", () => {
		const hugeTemplate = "a".repeat(2000);
		expect(() => buildSmsBatchItems([{ phone: "+1", name: null }], hugeTemplate, "+1555000")).toThrow(
			MessageTooLongError,
		);
	});
});

describe("buildScreeningSequenceDefinition", () => {
	const faqs: FaqEntry[] = [
		{ label: "store hours", answer: "We're open Monday through Friday, nine to six." },
		{ label: "pricing", answer: "Plans start at twenty nine dollars a month." },
	];

	it("builds a greeting, a menu gather, one say per FAQ, and an agent transfer", () => {
		const { definition, entryNodeId } = buildScreeningSequenceDefinition(
			"Thanks for calling, how can we help?",
			faqs,
			"+15557654321",
		);
		expect(entryNodeId).toBe("start");
		const ids = definition.nodes.map((n) => n.id);
		expect(ids).toEqual([
			"start",
			"greeting",
			"main_menu",
			"faq_say_0",
			"faq_say_1",
			"after_faq_gather",
			"agent_dial",
			"exit_transferred",
			"exit_unavailable",
			"exit_done",
		]);
	});

	it("maps FAQ digits 1..N and reserves 0 for the live agent", () => {
		const { definition } = buildScreeningSequenceDefinition("Hi there.", faqs, "+15557654321");
		const menu = definition.nodes.find((n) => n.id === "main_menu")!;
		expect(menu.input.matches).toEqual({ faq_0: "1", faq_1: "2", talk_to_agent: "0" });
		expect(menu.connections.faq_0.node_id).toBe("faq_say_0");
		expect(menu.connections.talk_to_agent.node_id).toBe("agent_dial");
	});

	it("routes an unclear choice (timeout/fallback) to the live agent rather than hanging up", () => {
		const { definition } = buildScreeningSequenceDefinition("Hi there.", faqs, "+15557654321");
		const menu = definition.nodes.find((n) => n.id === "main_menu")!;
		expect(menu.connections.timeout.node_id).toBe("agent_dial");
		expect(menu.connections.fallback.node_id).toBe("agent_dial");
	});

	it("ends the call politely when the caller doesn't ask for an agent after hearing an answer", () => {
		const { definition } = buildScreeningSequenceDefinition("Hi there.", faqs, "+15557654321");
		const afterFaq = definition.nodes.find((n) => n.id === "after_faq_gather")!;
		expect(afterFaq.connections.timeout.node_id).toBe("exit_done");
		expect(afterFaq.connections.talk_to_agent.node_id).toBe("agent_dial");
	});

	it("dials the configured agent number and routes dial outcomes to the right exits", () => {
		const { definition } = buildScreeningSequenceDefinition("Hi there.", faqs, "+15557654321");
		const dial = definition.nodes.find((n) => n.id === "agent_dial")!;
		expect(dial.input).toMatchObject({ type: "pstn", pstn: { dest: "+15557654321" } });
		expect(dial.connections.success.node_id).toBe("exit_transferred");
		expect(dial.connections.busy.node_id).toBe("exit_unavailable");
		expect(dial.connections.no_answer.node_id).toBe("exit_unavailable");
	});

	it("throws ScreeningTooComplexError with more FAQ entries than digits 1-5 allow", () => {
		const tooMany: FaqEntry[] = Array.from({ length: MAX_FAQ_ENTRIES + 1 }, (_, i) => ({
			label: "topic " + i,
			answer: "answer " + i,
		}));
		expect(() => buildScreeningSequenceDefinition("Hi.", tooMany, "+1")).toThrow(ScreeningTooComplexError);
	});

	it("throws ScreeningTooComplexError when an FAQ answer is too long for one spoken segment", () => {
		const longAnswer: FaqEntry[] = [{ label: "x", answer: "a".repeat(200) }];
		expect(() => buildScreeningSequenceDefinition("Hi.", longAnswer, "+1")).toThrow(ScreeningTooComplexError);
	});

	it("throws ScreeningTooComplexError when the greeting needs more chunks than allowed", () => {
		const hugeGreeting = Array(200).fill("word").join(" ");
		expect(() => buildScreeningSequenceDefinition(hugeGreeting, faqs, "+1")).toThrow(ScreeningTooComplexError);
	});

	it("throws ScreeningTooComplexError when the menu announcement needs more than 4 prompts", () => {
		const verboseFaqs: FaqEntry[] = Array.from({ length: MAX_FAQ_ENTRIES }, (_, i) => ({
			label: "a very long and verbose topic label number " + i + " that takes up a lot of space when spoken aloud",
			answer: "short",
		}));
		expect(() => buildScreeningSequenceDefinition("Hi.", verboseFaqs, "+1")).toThrow(ScreeningTooComplexError);
	});

	it("keeps the total node count well within Bird's 16-node inline-run limit", () => {
		const { definition } = buildScreeningSequenceDefinition("Thanks for calling.", faqs, "+15557654321");
		expect(definition.nodes.length).toBeLessThanOrEqual(16);
	});

	it("respects MAX_GREETING_CHUNKS for a greeting right at the boundary", () => {
		// Two short sentences chunk to exactly MAX_GREETING_CHUNKS under MAX_SAY_BYTES.
		const greeting = "a".repeat(MAX_GREETING_CHUNKS * 120);
		expect(() => buildScreeningSequenceDefinition(greeting, [], "+1")).not.toThrow();
	});
});
