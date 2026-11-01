/**
 * Client-side Shane AI types. Mirrors worker/shane-durable-object.ts and
 * worker/shane-logic.ts; kept separate because the client bundle can't
 * import from the worker.
 */

export interface ShaneContact {
	id: string;
	name: string | null;
	phone: string;
	consent: boolean;
	optedOut: boolean;
	source: string | null;
	createdAt: number;
}

export interface ParsedContact {
	name: string | null;
	phone: string;
	consent: boolean;
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

// Mirrors worker/shane-logic.ts MAX_SAY_BYTES / MAX_SCRIPT_CHUNKS, for the
// script editor's hint text. Keep in sync if those change.
export const MAX_SAY_BYTES = 130;
export const MAX_SCRIPT_CHUNKS = 10;
