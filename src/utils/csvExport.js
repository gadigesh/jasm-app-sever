function escapeCsv(value) {
	const str = value == null ? "" : String(value);
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function buildCsv(columns, rows) {
	const header = columns.map(escapeCsv).join(",");
	const body = rows.map((row) =>
		columns.map((col) => escapeCsv(row[col])).join(",")
	);
	return [header, ...body].join("\n");
}

function sendCsv(res, filename, csv) {
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.setHeader(
		"Content-Disposition",
		`attachment; filename="${filename.replace(/"/g, "")}.csv"`
	);
	res.status(200).send(csv);
}

module.exports = { buildCsv, sendCsv };
