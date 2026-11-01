import { useEffect, useMemo, useState } from "react";
import { shaneApi } from "./api";
import {
	MAX_FAQ_ENTRIES,
	MAX_SAY_BYTES,
	MAX_SCRIPT_CHUNKS,
	MAX_SMS_SEGMENTS,
	type CampaignPreview,
	type ParsedContact,
	type ScreeningFaq,
	type ShaneCall,
	type ShaneContact,
	type ShaneSmsSend,
	type Suppression,
} from "./types";

type Tab = "script" | "text" | "screening" | "contacts" | "calls";

const TABS: { id: Tab; label: string }[] = [
	{ id: "script", label: "Outbound calls" },
	{ id: "text", label: "Text campaigns" },
	{ id: "screening", label: "Inbound screening" },
	{ id: "contacts", label: "Contacts" },
	{ id: "calls", label: "Call log" },
];

const inputClass =
	"rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-orange-400/60";
const buttonClass =
	"rounded-md bg-[#F6821F] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#e3760f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const ghostButtonClass =
	"rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

function approxByteLen(s: string): number {
	return new TextEncoder().encode(s).length;
}

export function ShaneApp() {
	const [tab, setTab] = useState<Tab>("script");
	const [error, setError] = useState<string | null>(null);

	return (
		<div className="flex-1 flex flex-col overflow-hidden px-6 pb-6 gap-4">
			<div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs px-3 py-2">
				<span>
					Outbound calls read your script aloud and offer a keypad opt-out, placed one contact at a time. Text
					campaigns send via Bird's SMS batch API to every consented, non-suppressed contact at once. Inbound
					screening answers incoming calls with a keypad FAQ menu and transfers to a live agent — not free-form
					speech understanding or a custom/cloned voice, which would need a separate AI voice runtime. Only reach
					out to contacts who have actually consented to being contacted.
				</span>
			</div>

			<nav className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
				{TABS.map((t) => (
					<button
						key={t.id}
						onClick={() => setTab(t.id)}
						className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
							tab === t.id
								? "border-[#F6821F] text-neutral-900 dark:text-neutral-100"
								: "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300"
						}`}
					>
						{t.label}
					</button>
				))}
			</nav>

			{error && (
				<div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-sm px-3 py-2">
					{error}
				</div>
			)}

			<div className="flex-1 overflow-y-auto">
				{tab === "script" && <ScriptTab onError={setError} />}
				{tab === "text" && <TextCampaignTab onError={setError} />}
				{tab === "screening" && <ScreeningTab onError={setError} />}
				{tab === "contacts" && <ContactsTab onError={setError} />}
				{tab === "calls" && <CallsTab onError={setError} />}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

function ScriptTab({ onError }: { onError: (e: string | null) => void }) {
	const [body, setBody] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		shaneApi
			.getScript()
			.then((s) => {
				setBody(s.body);
				setLoaded(true);
			})
			.catch((e) => onError(e.message));
	}, [onError]);

	const estimatedChunks = Math.max(1, Math.ceil(approxByteLen(body) / MAX_SAY_BYTES));
	const tooLong = estimatedChunks > MAX_SCRIPT_CHUNKS;

	const save = async () => {
		setSaving(true);
		onError(null);
		try {
			const result = await shaneApi.setScript(body);
			setSavedAt(result.updatedAt);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to save script");
		} finally {
			setSaving(false);
		}
	};

	if (!loaded) return <div className="text-sm text-neutral-500">Loading script…</div>;

	return (
		<div className="space-y-3 max-w-2xl">
			<div>
				<h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Calling script</h2>
				<p className="text-xs text-neutral-500 mt-1">
					Read aloud to each contact via text-to-speech. Write it the way you'd actually say it over the phone.
				</p>
			</div>
			<textarea
				className={`${inputClass} w-full`}
				style={{ minHeight: 160 }}
				value={body}
				onChange={(e) => setBody(e.target.value)}
			/>
			<div className="flex items-center justify-between text-xs text-neutral-500">
				<span className={tooLong ? "text-red-600 dark:text-red-400 font-medium" : ""}>
					~{estimatedChunks} TTS segment{estimatedChunks === 1 ? "" : "s"} (max {MAX_SCRIPT_CHUNKS})
					{tooLong ? " — shorten the script before dialing" : ""}
				</span>
				{savedAt && <span>Saved {new Date(savedAt).toLocaleTimeString()}</span>}
			</div>
			<button className={buttonClass} onClick={save} disabled={saving || !body.trim()}>
				Save script
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Text campaign (message editor + eligibility preview + mass send)
// ---------------------------------------------------------------------------

function TextCampaignTab({ onError }: { onError: (e: string | null) => void }) {
	const [body, setBody] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [preview, setPreview] = useState<CampaignPreview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const [sending, setSending] = useState(false);
	const [result, setResult] = useState<{ sent: number; failed: number } | null>(null);
	const [recentSends, setRecentSends] = useState<ShaneSmsSend[]>([]);

	useEffect(() => {
		shaneApi
			.getTextMessage()
			.then((m) => {
				setBody(m.body);
				setLoaded(true);
			})
			.catch((e) => onError(e.message));
	}, [onError]);

	const estimatedSegments = Math.max(1, Math.ceil(approxByteLen(body) / 150));
	const tooLong = estimatedSegments > MAX_SMS_SEGMENTS;

	const save = async () => {
		setSaving(true);
		onError(null);
		setPreview(null);
		try {
			const saved = await shaneApi.setTextMessage(body);
			setSavedAt(saved.updatedAt);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to save message");
		} finally {
			setSaving(false);
		}
	};

	const runPreview = async () => {
		setPreviewing(true);
		onError(null);
		setResult(null);
		setConfirmText("");
		try {
			setPreview(await shaneApi.previewCampaign());
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to preview campaign");
		} finally {
			setPreviewing(false);
		}
	};

	const send = async () => {
		if (!preview) return;
		setSending(true);
		onError(null);
		try {
			const sendResult = await shaneApi.sendCampaign(preview.eligibleCount);
			setResult({ sent: sendResult.sent, failed: sendResult.failed });
			setPreview(null);
			setConfirmText("");
			setRecentSends((await shaneApi.listSmsSends()).slice(0, 10));
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to send campaign");
		} finally {
			setSending(false);
		}
	};

	if (!loaded) return <div className="text-sm text-neutral-500">Loading message…</div>;

	const confirmMatches = preview !== null && confirmText.trim() === String(preview.eligibleCount);

	return (
		<div className="space-y-4 max-w-2xl">
			<div>
				<h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Campaign text message</h2>
				<p className="text-xs text-neutral-500 mt-1">
					Sent via Bird's SMS batch API to every consented, non-suppressed contact in your calling-hours window.
					Use <code>{"{{name}}"}</code> to personalize. A "Reply STOP to opt out" line is added automatically if
					you don't include one.
				</p>
			</div>
			<textarea
				className={`${inputClass} w-full`}
				style={{ minHeight: 120 }}
				value={body}
				onChange={(e) => {
					setBody(e.target.value);
					setPreview(null);
				}}
			/>
			<div className="flex items-center justify-between text-xs text-neutral-500">
				<span className={tooLong ? "text-red-600 dark:text-red-400 font-medium" : ""}>
					~{estimatedSegments} SMS segment{estimatedSegments === 1 ? "" : "s"} (max {MAX_SMS_SEGMENTS})
					{tooLong ? " — shorten the message before sending" : ""}
				</span>
				{savedAt && <span>Saved {new Date(savedAt).toLocaleTimeString()}</span>}
			</div>
			<button className={buttonClass} onClick={save} disabled={saving || !body.trim()}>
				Save message
			</button>

			<div className="border-t border-neutral-200 dark:border-neutral-800 pt-4 space-y-3">
				<button className={ghostButtonClass} onClick={runPreview} disabled={previewing}>
					{previewing ? "Checking…" : "Preview who this will reach"}
				</button>

				{preview && (
					<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
						<p className="text-sm text-neutral-900 dark:text-neutral-100">
							<strong>{preview.eligibleCount}</strong> contact{preview.eligibleCount === 1 ? "" : "s"} will receive
							this text, in {preview.batchCount} batch{preview.batchCount === 1 ? "" : "es"}.
							{preview.excluded.length > 0 && (
								<> {preview.excluded.length} excluded (no consent, opted out, suppressed, or outside hours).</>
							)}
						</p>
						{preview.tooLong && (
							<p className="text-sm text-red-600 dark:text-red-400">
								This message renders to more than {MAX_SMS_SEGMENTS} segments for some contacts — shorten it
								before sending.
							</p>
						)}
						{preview.excluded.length > 0 && (
							<details className="text-xs text-neutral-500">
								<summary className="cursor-pointer">Show excluded contacts</summary>
								<ul className="mt-2 space-y-1">
									{preview.excluded.map((e) => (
										<li key={e.id}>
											{e.name || e.phone} — {e.reason}
										</li>
									))}
								</ul>
							</details>
						)}
						{preview.eligibleCount > 0 && !preview.tooLong && (
							<div className="space-y-2">
								<label className="block text-xs text-neutral-600 dark:text-neutral-400">
									Type <strong>{preview.eligibleCount}</strong> to confirm you want to text that many people
									right now:
									<input
										className={`${inputClass} mt-1 w-32`}
										value={confirmText}
										onChange={(e) => setConfirmText(e.target.value)}
										inputMode="numeric"
									/>
								</label>
								<button className={buttonClass} disabled={!confirmMatches || sending} onClick={send}>
									{sending ? "Sending…" : `Send to ${preview.eligibleCount} contact${preview.eligibleCount === 1 ? "" : "s"}`}
								</button>
							</div>
						)}
					</div>
				)}

				{result && (
					<div className="rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 text-green-700 dark:text-green-300 text-sm px-3 py-2">
						Sent {result.sent}, failed {result.failed}.
					</div>
				)}

				{recentSends.length > 0 && (
					<ul className="text-xs text-neutral-500 space-y-0.5">
						{recentSends.map((s) => (
							<li key={s.id}>
								{new Date(s.createdAt).toLocaleTimeString()} — {s.status}
								{s.outcome ? `: ${s.outcome}` : ""}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Inbound call screening (greeting + FAQ menu + live-agent transfer)
// ---------------------------------------------------------------------------

function ScreeningTab({ onError }: { onError: (e: string | null) => void }) {
	const [greeting, setGreeting] = useState("");
	const [agentNumber, setAgentNumber] = useState("");
	const [faqs, setFaqs] = useState<ScreeningFaq[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const [newAnswer, setNewAnswer] = useState("");
	const [generated, setGenerated] = useState<string | null>(null);
	const [generating, setGenerating] = useState(false);
	const [copied, setCopied] = useState(false);

	const reload = async () => {
		try {
			const [config, faqList] = await Promise.all([shaneApi.getScreeningConfig(), shaneApi.listScreeningFaqs()]);
			setGreeting(config.greeting);
			setAgentNumber(config.agentNumber ?? "");
			setFaqs(faqList);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to load screening config");
		} finally {
			setLoaded(true);
		}
	};

	useEffect(() => {
		reload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const saveConfig = async () => {
		setSaving(true);
		onError(null);
		setGenerated(null);
		try {
			await shaneApi.setScreeningConfig(greeting, agentNumber.trim() || null);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	};

	const addFaq = async () => {
		if (!newLabel.trim() || !newAnswer.trim()) return;
		onError(null);
		try {
			await shaneApi.addScreeningFaq(newLabel.trim(), newAnswer.trim());
			setNewLabel("");
			setNewAnswer("");
			await reload();
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to add FAQ");
		}
	};

	const generate = async () => {
		setGenerating(true);
		onError(null);
		setGenerated(null);
		try {
			const result = await shaneApi.generateScreeningSequence();
			setGenerated(JSON.stringify(result.definition, null, 2));
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to generate sequence");
		} finally {
			setGenerating(false);
		}
	};

	const copyGenerated = async () => {
		if (!generated) return;
		try {
			await navigator.clipboard.writeText(generated);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable; the textarea below is still selectable
		}
	};

	if (!loaded) return <div className="text-sm text-neutral-500">Loading screening config…</div>;

	const greetingChunks = Math.max(1, Math.ceil(approxByteLen(greeting) / MAX_SAY_BYTES));
	const greetingTooLong = greetingChunks > 2;

	return (
		<div className="space-y-5 max-w-2xl">
			<div className="rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-600 dark:text-neutral-400 px-3 py-2">
				This generates a Bird Voice sequence definition — paste it into Bird's dashboard Sequence editor, publish
				it, and bind your inbound phone number to it there. Bird's sequence publishing isn't something this tool
				can safely automate.
			</div>

			<div>
				<h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Greeting</h2>
				<textarea
					className={`${inputClass} w-full mt-2`}
					style={{ minHeight: 80 }}
					value={greeting}
					onChange={(e) => setGreeting(e.target.value)}
				/>
				<p className={`text-xs mt-1 ${greetingTooLong ? "text-red-600 dark:text-red-400 font-medium" : "text-neutral-500"}`}>
					~{greetingChunks} spoken segment{greetingChunks === 1 ? "" : "s"} (max 2)
				</p>
			</div>

			<div>
				<h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Live agent number</h2>
				<input
					className={`${inputClass} w-full mt-2`}
					placeholder="+15557654321"
					value={agentNumber}
					onChange={(e) => setAgentNumber(e.target.value)}
				/>
				<p className="text-xs text-neutral-500 mt-1">
					Where calls transfer when a caller asks for a person, or doesn't make a clear menu choice.
				</p>
			</div>

			<button className={buttonClass} onClick={saveConfig} disabled={saving || !greeting.trim()}>
				Save
			</button>

			<div className="border-t border-neutral-200 dark:border-neutral-800 pt-4">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
					FAQ menu ({faqs.length}/{MAX_FAQ_ENTRIES})
				</h2>
				<p className="text-xs text-neutral-500 mb-3">
					Each becomes "press {"N"}" in the menu. Keep answers to one short sentence — they're spoken as a single
					segment, with no follow-up questions since there's no speech recognition here.
				</p>
				<ul className="space-y-1.5 mb-3">
					{faqs.map((f, i) => (
						<li
							key={f.id}
							className="flex items-start gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm"
						>
							<span className="font-mono text-neutral-400">{i + 1}</span>
							<div className="flex-1">
								<div className="font-medium text-neutral-900 dark:text-neutral-100">{f.label}</div>
								<div className="text-xs text-neutral-500">{f.answer}</div>
							</div>
							<button
								className={ghostButtonClass}
								onClick={() => shaneApi.deleteScreeningFaq(f.id).then(reload)}
							>
								Delete
							</button>
						</li>
					))}
				</ul>
				{faqs.length < MAX_FAQ_ENTRIES && (
					<div className="flex flex-wrap gap-2 items-end">
						<input
							className={inputClass}
							placeholder="Label (e.g. store hours)"
							value={newLabel}
							onChange={(e) => setNewLabel(e.target.value)}
						/>
						<input
							className={`${inputClass} flex-1 min-w-[200px]`}
							placeholder="Answer, one short sentence"
							value={newAnswer}
							onChange={(e) => setNewAnswer(e.target.value)}
						/>
						<button className={ghostButtonClass} onClick={addFaq}>
							Add
						</button>
					</div>
				)}
			</div>

			<div className="border-t border-neutral-200 dark:border-neutral-800 pt-4 space-y-2">
				<button className={buttonClass} onClick={generate} disabled={generating || !agentNumber.trim()}>
					{generating ? "Generating…" : "Generate sequence for Bird"}
				</button>
				{generated && (
					<div className="space-y-2">
						<textarea
							readOnly
							className={`${inputClass} w-full font-mono text-xs`}
							style={{ minHeight: 200 }}
							value={generated}
						/>
						<button className={ghostButtonClass} onClick={copyGenerated}>
							{copied ? "Copied" : "Copy JSON"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Contacts (upload + consent review + dial)
// ---------------------------------------------------------------------------

function ContactsTab({ onError }: { onError: (e: string | null) => void }) {
	const [contacts, setContacts] = useState<ShaneContact[]>([]);
	const [suppressions, setSuppressions] = useState<Suppression[]>([]);
	const [loading, setLoading] = useState(true);
	const [parsed, setParsed] = useState<ParsedContact[] | null>(null);
	const [parsedSource, setParsedSource] = useState("");
	const [attested, setAttested] = useState(false);
	const [importing, setImporting] = useState(false);
	const [dialingId, setDialingId] = useState<string | null>(null);

	const suppressedSet = useMemo(() => new Set(suppressions.map((s) => s.phone)), [suppressions]);

	const reload = async () => {
		try {
			const [c, s] = await Promise.all([shaneApi.listContacts(), shaneApi.listSuppressions()]);
			setContacts(c);
			setSuppressions(s);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to load contacts");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		reload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleFile = async (file: File) => {
		onError(null);
		setAttested(false);
		try {
			const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
			const text = isPdf ? await (await import("./pdfText")).extractPdfText(file) : await file.text();
			const { contacts: rows } = await shaneApi.parseUpload(text, isPdf ? "pdf" : "csv");
			if (rows.length === 0) {
				onError("No phone numbers were found in that file.");
				return;
			}
			setParsed(rows);
			setParsedSource(file.name);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to read that file");
		}
	};

	const toggleParsedConsent = (index: number) => {
		if (!parsed) return;
		setParsed(parsed.map((c, i) => (i === index ? { ...c, consent: !c.consent } : c)));
	};

	const confirmImport = async () => {
		if (!parsed) return;
		setImporting(true);
		onError(null);
		try {
			const result = await shaneApi.importContacts(parsed, parsedSource);
			setParsed(null);
			setAttested(false);
			await reload();
			onError(
				result.skipped > 0
					? `Imported ${result.imported}, skipped ${result.skipped} already-known number(s).`
					: null,
			);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Import failed");
		} finally {
			setImporting(false);
		}
	};

	const dial = async (contact: ShaneContact) => {
		setDialingId(contact.id);
		onError(null);
		try {
			await shaneApi.dial(contact.id);
			await reload();
		} catch (e) {
			onError(e instanceof Error ? e.message : "Dial failed");
		} finally {
			setDialingId(null);
		}
	};

	if (loading) return <div className="text-sm text-neutral-500">Loading contacts…</div>;

	return (
		<div className="space-y-5">
			<div className="panel rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
					Upload contacts (CSV or PDF)
				</h2>
				<p className="text-xs text-neutral-500 mb-3">
					CSV: a header row with a <code>phone</code> column, optionally <code>name</code> and{" "}
					<code>consent</code>. PDF: any text containing phone numbers — every match starts <em>unconsented</em>{" "}
					until you check it below, since a PDF has no reliable consent field.
				</p>
				<input
					type="file"
					accept=".csv,text/csv,.pdf,application/pdf"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) handleFile(file);
						e.target.value = "";
					}}
					className="text-sm"
				/>
			</div>

			{parsed && (
				<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
					<h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
						Review before import — {parsed.length} number{parsed.length === 1 ? "" : "s"} from {parsedSource}
					</h3>
					<div className="max-h-64 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800">
						<table className="w-full text-sm">
							<thead className="bg-neutral-100 dark:bg-neutral-900 text-left text-neutral-500 sticky top-0">
								<tr>
									<th className="px-3 py-1.5 font-medium">Name</th>
									<th className="px-3 py-1.5 font-medium">Phone</th>
									<th className="px-3 py-1.5 font-medium">Consented?</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
								{parsed.map((c, i) => (
									<tr key={c.phone}>
										<td className="px-3 py-1.5">{c.name || "—"}</td>
										<td className="px-3 py-1.5">{c.phone}</td>
										<td className="px-3 py-1.5">
											<input type="checkbox" checked={c.consent} onChange={() => toggleParsedConsent(i)} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<label className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-400">
						<input
							type="checkbox"
							className="mt-0.5"
							checked={attested}
							onChange={(e) => setAttested(e.target.checked)}
						/>
						<span>
							I confirm that every number I've checked "consented" above has actually agreed to be contacted by
							phone, and I'm responsible for that being true.
						</span>
					</label>
					<div className="flex gap-2">
						<button className={buttonClass} disabled={!attested || importing} onClick={confirmImport}>
							Import {parsed.filter((c) => c.consent).length} consented contact
							{parsed.filter((c) => c.consent).length === 1 ? "" : "s"}
						</button>
						<button className={ghostButtonClass} onClick={() => setParsed(null)}>
							Cancel
						</button>
					</div>
				</div>
			)}

			<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-neutral-100 dark:bg-neutral-900 text-left text-neutral-500">
						<tr>
							<th className="px-3 py-2 font-medium">Name</th>
							<th className="px-3 py-2 font-medium">Phone</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
						{contacts.length === 0 && (
							<tr>
								<td colSpan={4} className="px-3 py-6 text-center text-neutral-400">
									No contacts yet — upload a CSV or PDF above.
								</td>
							</tr>
						)}
						{contacts.map((c) => {
							const suppressed = suppressedSet.has(c.phone);
							const dialable = c.consent && !c.optedOut && !suppressed;
							return (
								<tr key={c.id}>
									<td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">{c.name || "—"}</td>
									<td className="px-3 py-2 text-neutral-500">{c.phone}</td>
									<td className="px-3 py-2">
										{c.optedOut ? (
											<span className="text-amber-600 dark:text-amber-400">Opted out</span>
										) : suppressed ? (
											<span className="text-amber-600 dark:text-amber-400">Suppressed</span>
										) : c.consent ? (
											<span className="text-green-600 dark:text-green-400">Consented</span>
										) : (
											<span className="text-neutral-400">No consent</span>
										)}
									</td>
									<td className="px-3 py-2 text-right space-x-1">
										{!c.consent && !c.optedOut && (
											<button
												className={ghostButtonClass}
												onClick={() => shaneApi.setContactConsent(c.id, true).then(reload)}
											>
												Mark consented
											</button>
										)}
										<button
											className={ghostButtonClass}
											disabled={!dialable || dialingId === c.id}
											onClick={() => dial(c)}
										>
											{dialingId === c.id ? "Dialing…" : "Dial"}
										</button>
										<button
											className={ghostButtonClass}
											onClick={() => shaneApi.deleteContact(c.id).then(reload)}
										>
											Delete
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function CallsTab({ onError }: { onError: (e: string | null) => void }) {
	const [calls, setCalls] = useState<ShaneCall[]>([]);
	const [contacts, setContacts] = useState<ShaneContact[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		Promise.all([shaneApi.listCalls(), shaneApi.listContacts()])
			.then(([c, people]) => {
				setCalls(c);
				setContacts(people);
			})
			.catch((e) => onError(e instanceof Error ? e.message : "Failed to load calls"))
			.finally(() => setLoading(false));
	}, [onError]);

	const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

	if (loading) return <div className="text-sm text-neutral-500">Loading calls…</div>;

	return (
		<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
			<table className="w-full text-sm">
				<thead className="bg-neutral-100 dark:bg-neutral-900 text-left text-neutral-500">
					<tr>
						<th className="px-3 py-2 font-medium">Contact</th>
						<th className="px-3 py-2 font-medium">Status</th>
						<th className="px-3 py-2 font-medium">Outcome</th>
						<th className="px-3 py-2 font-medium">Started</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
					{calls.length === 0 && (
						<tr>
							<td colSpan={4} className="px-3 py-6 text-center text-neutral-400">
								No calls placed yet.
							</td>
						</tr>
					)}
					{calls.map((call) => {
						const contact = contactsById.get(call.contactId);
						return (
							<tr key={call.id}>
								<td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">
									{contact?.name || contact?.phone || call.contactId}
								</td>
								<td className="px-3 py-2">
									<span
										className={
											call.status === "failed"
												? "text-red-600 dark:text-red-400"
												: call.status === "completed"
													? "text-green-600 dark:text-green-400"
													: "text-neutral-500"
										}
									>
										{call.status}
									</span>
								</td>
								<td className="px-3 py-2 text-neutral-500">{call.outcome || "—"}</td>
								<td className="px-3 py-2 text-neutral-500">{new Date(call.startedAt).toLocaleString()}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
