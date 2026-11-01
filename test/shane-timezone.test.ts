import { describe, it, expect } from "vitest";
import {
	evaluateDialGate,
	localHourIn,
	normalizeTimeZone,
	parseCsvContacts,
} from "../worker/shane-logic";

// 14:00 UTC on 15 Jan 2026 is 06:00 in Los Angeles (PST) and 09:00 in New York.
const FOURTEEN_UTC = new Date(Date.UTC(2026, 0, 15, 14));

describe("normalizeTimeZone", () => {
	it("keeps a recognized IANA zone name", () => {
		expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
		expect(normalizeTimeZone("  Europe/London  ")).toBe("Europe/London");
	});

	it("rejects unknown, empty and missing zones", () => {
		expect(normalizeTimeZone("Mars/Olympus")).toBeNull();
		expect(normalizeTimeZone("")).toBeNull();
		expect(normalizeTimeZone(null)).toBeNull();
		expect(normalizeTimeZone(undefined)).toBeNull();
	});
});

describe("localHourIn", () => {
	it("returns the hour in the given zone, not UTC", () => {
		expect(localHourIn("America/Los_Angeles", FOURTEEN_UTC)).toBe(6);
		expect(localHourIn("America/New_York", FOURTEEN_UTC)).toBe(9);
	});

	it("returns null when the zone is missing or invalid", () => {
		expect(localHourIn(null, FOURTEEN_UTC)).toBeNull();
		expect(localHourIn("Not/AZone", FOURTEEN_UTC)).toBeNull();
	});
});

describe("evaluateDialGate uses the recipient's local time", () => {
	const base = { consent: true, optedOut: false, phone: "+15551234567" };

	it("blocks a Pacific contact at 06:00 local even though it is 14:00 UTC", () => {
		const result = evaluateDialGate(
			{ ...base, timezone: "America/Los_Angeles" },
			new Set(),
			FOURTEEN_UTC,
			9,
			20,
		);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/calling hours/);
	});

	it("allows an Eastern contact at 09:00 local at the same instant", () => {
		const result = evaluateDialGate(
			{ ...base, timezone: "America/New_York" },
			new Set(),
			FOURTEEN_UTC,
			9,
			20,
		);
		expect(result).toEqual({ allowed: true });
	});

	it("blocks a contact with no time zone on file, since hours can't be checked", () => {
		const result = evaluateDialGate({ ...base, timezone: null }, new Set(), FOURTEEN_UTC, 0, 24);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/time zone/);
	});
});

describe("parseCsvContacts timezone column", () => {
	it("reads a timezone column and drops unknown zones to null", () => {
		const csv = "name,phone,consent,timezone\nJordan,5551234567,yes,America/Chicago\nPriya,5559876543,yes,Mars/Base";
		expect(parseCsvContacts(csv)).toEqual([
			{ name: "Jordan", phone: "+15551234567", consent: true, timezone: "America/Chicago" },
			{ name: "Priya", phone: "+15559876543", consent: true, timezone: null },
		]);
	});
});
