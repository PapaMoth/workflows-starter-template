import { useEffect, useMemo, useState } from "react";
import { crmApi } from "./api";
import {
	DEAL_STAGES,
	STAGE_LABELS,
	type Company,
	type Contact,
	type CrmData,
	type Deal,
	type DealStage,
	type Task,
} from "./types";

type Tab = "contacts" | "companies" | "deals" | "tasks";

const TABS: { id: Tab; label: string }[] = [
	{ id: "contacts", label: "Contacts" },
	{ id: "companies", label: "Companies" },
	{ id: "deals", label: "Deals" },
	{ id: "tasks", label: "Tasks" },
];

const inputClass =
	"rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-orange-400/60";
const buttonClass =
	"rounded-md bg-[#F6821F] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#e3760f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const ghostButtonClass =
	"rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors";

export function CrmApp() {
	const [tab, setTab] = useState<Tab>("contacts");
	const [data, setData] = useState<CrmData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const reload = async () => {
		try {
			setError(null);
			const result = await crmApi.getAll();
			setData(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load CRM data");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		reload();
	}, []);

	const companiesById = useMemo(() => {
		const map = new Map<string, Company>();
		data?.companies.forEach((c) => map.set(c.id, c));
		return map;
	}, [data]);

	const contactsById = useMemo(() => {
		const map = new Map<string, Contact>();
		data?.contacts.forEach((c) => map.set(c.id, c));
		return map;
	}, [data]);

	if (loading) {
		return (
			<div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
				Loading CRM…
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden px-6 pb-6 gap-4">
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
				{data && tab === "contacts" && (
					<ContactsTab
						contacts={data.contacts}
						companies={data.companies}
						companiesById={companiesById}
						onChanged={reload}
					/>
				)}
				{data && tab === "companies" && (
					<CompaniesTab companies={data.companies} onChanged={reload} />
				)}
				{data && tab === "deals" && (
					<DealsTab
						deals={data.deals}
						contacts={data.contacts}
						companies={data.companies}
						companiesById={companiesById}
						contactsById={contactsById}
						onChanged={reload}
					/>
				)}
				{data && tab === "tasks" && (
					<TasksTab
						tasks={data.tasks}
						contacts={data.contacts}
						deals={data.deals}
						onChanged={reload}
					/>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function ContactsTab({
	contacts,
	companies,
	companiesById,
	onChanged,
}: {
	contacts: Contact[];
	companies: Company[];
	companiesById: Map<string, Company>;
	onChanged: () => void;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [phone, setPhone] = useState("");
	const [companyId, setCompanyId] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const addContact = async () => {
		if (!name.trim()) return;
		setSubmitting(true);
		try {
			await crmApi.createContact({
				name: name.trim(),
				email: email.trim() || null,
				phone: phone.trim() || null,
				companyId: companyId || null,
			});
			setName("");
			setEmail("");
			setPhone("");
			setCompanyId("");
			onChanged();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="space-y-4">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					addContact();
				}}
				className="flex flex-wrap gap-2 items-end"
			>
				<input
					className={inputClass}
					placeholder="Name"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					className={inputClass}
					placeholder="Email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<input
					className={inputClass}
					placeholder="Phone"
					value={phone}
					onChange={(e) => setPhone(e.target.value)}
				/>
				<select
					className={inputClass}
					value={companyId}
					onChange={(e) => setCompanyId(e.target.value)}
				>
					<option value="">No company</option>
					{companies.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<button type="submit" className={buttonClass} disabled={submitting}>
					Add contact
				</button>
			</form>

			<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-neutral-100 dark:bg-neutral-900 text-left text-neutral-500">
						<tr>
							<th className="px-3 py-2 font-medium">Name</th>
							<th className="px-3 py-2 font-medium">Email</th>
							<th className="px-3 py-2 font-medium">Phone</th>
							<th className="px-3 py-2 font-medium">Company</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
						{contacts.length === 0 && (
							<tr>
								<td
									colSpan={5}
									className="px-3 py-6 text-center text-neutral-400"
								>
									No contacts yet — add your first one above.
								</td>
							</tr>
						)}
						{contacts.map((c) => (
							<tr key={c.id}>
								<td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">
									{c.name}
								</td>
								<td className="px-3 py-2 text-neutral-500">{c.email || "—"}</td>
								<td className="px-3 py-2 text-neutral-500">{c.phone || "—"}</td>
								<td className="px-3 py-2 text-neutral-500">
									{c.companyId ? companiesById.get(c.companyId)?.name ?? "—" : "—"}
								</td>
								<td className="px-3 py-2 text-right">
									<button
										className={ghostButtonClass}
										onClick={async () => {
											await crmApi.deleteContact(c.id);
											onChanged();
										}}
									>
										Delete
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

function CompaniesTab({
	companies,
	onChanged,
}: {
	companies: Company[];
	onChanged: () => void;
}) {
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const addCompany = async () => {
		if (!name.trim()) return;
		setSubmitting(true);
		try {
			await crmApi.createCompany({ name: name.trim(), domain: domain.trim() || null });
			setName("");
			setDomain("");
			onChanged();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="space-y-4">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					addCompany();
				}}
				className="flex flex-wrap gap-2 items-end"
			>
				<input
					className={inputClass}
					placeholder="Company name"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					className={inputClass}
					placeholder="Domain (optional)"
					value={domain}
					onChange={(e) => setDomain(e.target.value)}
				/>
				<button type="submit" className={buttonClass} disabled={submitting}>
					Add company
				</button>
			</form>

			<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-neutral-100 dark:bg-neutral-900 text-left text-neutral-500">
						<tr>
							<th className="px-3 py-2 font-medium">Name</th>
							<th className="px-3 py-2 font-medium">Domain</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
						{companies.length === 0 && (
							<tr>
								<td colSpan={3} className="px-3 py-6 text-center text-neutral-400">
									No companies yet — add your first one above.
								</td>
							</tr>
						)}
						{companies.map((c) => (
							<tr key={c.id}>
								<td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">
									{c.name}
								</td>
								<td className="px-3 py-2 text-neutral-500">{c.domain || "—"}</td>
								<td className="px-3 py-2 text-right">
									<button
										className={ghostButtonClass}
										onClick={async () => {
											await crmApi.deleteCompany(c.id);
											onChanged();
										}}
									>
										Delete
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Deals (kanban by stage)
// ---------------------------------------------------------------------------

function DealsTab({
	deals,
	contacts,
	companies,
	companiesById,
	contactsById,
	onChanged,
}: {
	deals: Deal[];
	contacts: Contact[];
	companies: Company[];
	companiesById: Map<string, Company>;
	contactsById: Map<string, Contact>;
	onChanged: () => void;
}) {
	const [title, setTitle] = useState("");
	const [value, setValue] = useState("");
	const [contactId, setContactId] = useState("");
	const [companyId, setCompanyId] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const addDeal = async () => {
		if (!title.trim()) return;
		setSubmitting(true);
		try {
			await crmApi.createDeal({
				title: title.trim(),
				value: value ? Number(value) : 0,
				contactId: contactId || null,
				companyId: companyId || null,
			});
			setTitle("");
			setValue("");
			setContactId("");
			setCompanyId("");
			onChanged();
		} finally {
			setSubmitting(false);
		}
	};

	const moveStage = async (deal: Deal, direction: 1 | -1) => {
		const idx = DEAL_STAGES.indexOf(deal.stage);
		const nextIdx = idx + direction;
		if (nextIdx < 0 || nextIdx >= DEAL_STAGES.length) return;
		await crmApi.updateDeal(deal.id, { stage: DEAL_STAGES[nextIdx] });
		onChanged();
	};

	const dealsByStage = (stage: DealStage) =>
		deals.filter((d) => d.stage === stage);

	return (
		<div className="space-y-4">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					addDeal();
				}}
				className="flex flex-wrap gap-2 items-end"
			>
				<input
					className={inputClass}
					placeholder="Deal title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<input
					className={`${inputClass} w-28`}
					placeholder="Value"
					type="number"
					min="0"
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<select
					className={inputClass}
					value={contactId}
					onChange={(e) => setContactId(e.target.value)}
				>
					<option value="">No contact</option>
					{contacts.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<select
					className={inputClass}
					value={companyId}
					onChange={(e) => setCompanyId(e.target.value)}
				>
					<option value="">No company</option>
					{companies.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<button type="submit" className={buttonClass} disabled={submitting}>
					Add deal
				</button>
			</form>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
				{DEAL_STAGES.map((stage) => (
					<div
						key={stage}
						className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-2 min-h-[120px]"
					>
						<div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 px-1 pb-2">
							{STAGE_LABELS[stage]} · {dealsByStage(stage).length}
						</div>
						<div className="space-y-2">
							{dealsByStage(stage).map((d) => (
								<div
									key={d.id}
									className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-2 text-sm space-y-1"
								>
									<div className="font-medium text-neutral-900 dark:text-neutral-100">
										{d.title}
									</div>
									<div className="text-xs text-neutral-500">
										${d.value.toLocaleString()}
									</div>
									{d.contactId && (
										<div className="text-xs text-neutral-500">
											{contactsById.get(d.contactId)?.name}
										</div>
									)}
									{d.companyId && (
										<div className="text-xs text-neutral-500">
											{companiesById.get(d.companyId)?.name}
										</div>
									)}
									<div className="flex items-center justify-between pt-1">
										<div className="flex gap-1">
											<button
												className={ghostButtonClass}
												disabled={stage === DEAL_STAGES[0]}
												onClick={() => moveStage(d, -1)}
											>
												←
											</button>
											<button
												className={ghostButtonClass}
												disabled={stage === DEAL_STAGES[DEAL_STAGES.length - 1]}
												onClick={() => moveStage(d, 1)}
											>
												→
											</button>
										</div>
										<button
											className={ghostButtonClass}
											onClick={async () => {
												await crmApi.deleteDeal(d.id);
												onChanged();
											}}
										>
											Delete
										</button>
									</div>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function TasksTab({
	tasks,
	contacts,
	deals,
	onChanged,
}: {
	tasks: Task[];
	contacts: Contact[];
	deals: Deal[];
	onChanged: () => void;
}) {
	const [title, setTitle] = useState("");
	const [dueDate, setDueDate] = useState("");
	const [contactId, setContactId] = useState("");
	const [dealId, setDealId] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const addTask = async () => {
		if (!title.trim()) return;
		setSubmitting(true);
		try {
			await crmApi.createTask({
				title: title.trim(),
				dueAt: dueDate ? new Date(dueDate).getTime() : null,
				contactId: contactId || null,
				dealId: dealId || null,
			});
			setTitle("");
			setDueDate("");
			setContactId("");
			setDealId("");
			onChanged();
		} finally {
			setSubmitting(false);
		}
	};

	const contactsById = new Map(contacts.map((c) => [c.id, c]));
	const dealsById = new Map(deals.map((d) => [d.id, d]));

	return (
		<div className="space-y-4">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					addTask();
				}}
				className="flex flex-wrap gap-2 items-end"
			>
				<input
					className={inputClass}
					placeholder="Task"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<input
					className={inputClass}
					type="date"
					value={dueDate}
					onChange={(e) => setDueDate(e.target.value)}
				/>
				<select
					className={inputClass}
					value={contactId}
					onChange={(e) => setContactId(e.target.value)}
				>
					<option value="">No contact</option>
					{contacts.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<select
					className={inputClass}
					value={dealId}
					onChange={(e) => setDealId(e.target.value)}
				>
					<option value="">No deal</option>
					{deals.map((d) => (
						<option key={d.id} value={d.id}>
							{d.title}
						</option>
					))}
				</select>
				<button type="submit" className={buttonClass} disabled={submitting}>
					Add task
				</button>
			</form>

			<ul className="space-y-1.5">
				{tasks.length === 0 && (
					<li className="px-3 py-6 text-center text-neutral-400 text-sm">
						No tasks yet — add a follow-up above.
					</li>
				)}
				{tasks.map((t) => (
					<li
						key={t.id}
						className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
							t.done
								? "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 opacity-60"
								: "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
						}`}
					>
						<input
							type="checkbox"
							checked={t.done}
							onChange={async () => {
								await crmApi.updateTask(t.id, { done: !t.done });
								onChanged();
							}}
							className="h-4 w-4 accent-[#F6821F]"
						/>
						<span
							className={`flex-1 ${t.done ? "line-through text-neutral-400" : "text-neutral-900 dark:text-neutral-100"}`}
						>
							{t.title}
						</span>
						{t.dueAt && (
							<span className="text-xs text-neutral-500">
								{new Date(t.dueAt).toLocaleDateString()}
							</span>
						)}
						{t.contactId && (
							<span className="text-xs text-neutral-500">
								{contactsById.get(t.contactId)?.name}
							</span>
						)}
						{t.dealId && (
							<span className="text-xs text-neutral-500">
								{dealsById.get(t.dealId)?.title}
							</span>
						)}
						<button
							className={ghostButtonClass}
							onClick={async () => {
								await crmApi.deleteTask(t.id);
								onChanged();
							}}
						>
							Delete
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
