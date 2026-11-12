/** A header and the value to read out of each row. */
export type CsvColumn<T> = [
	header: string,
	value: (row: T) => string | number | boolean | null | undefined,
];

function cell(value: string | number | boolean | null | undefined): string {
	if (value === null || value === undefined) {
		return "";
	}
	let text = String(value);
	// A spreadsheet runs a text cell that starts with one of these as a formula: an error message
	// or a model name the gateway logged could call out or run anything. A leading quote keeps it
	// text. Numbers stay numbers (a negative count is not a formula).
	if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text)) {
		text = `'${text}`;
	}
	// A model id with a comma, or an error message with a quote, must not shift every later column.
	return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv<T>(rows: readonly T[], columns: CsvColumn<T>[]): string {
	const lines = [columns.map(([header]) => cell(header)).join(",")];
	for (const row of rows) {
		lines.push(columns.map(([, value]) => cell(value(row))).join(","));
	}
	return lines.join("\r\n");
}

/**
 * Hands the operator the rows they are looking at.
 *
 * Deliberately the current page rather than the whole table: exporting everything would be a second,
 * unbounded query against the gateway disguised as a button. What is on screen is what is filtered,
 * ordered and understood — and it is what gets pasted into the spreadsheet that answers the question.
 */
export function downloadCsv<T>(
	filename: string,
	rows: readonly T[],
	columns: CsvColumn<T>[],
): void {
	if (typeof document === "undefined") {
		return;
	}
	const blob = new Blob([toCsv(rows, columns)], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}
