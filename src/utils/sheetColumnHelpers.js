function makeUniqueHeader(name, usedNames) {
	let uniqueName = name;
	let suffix = 2;
	while (usedNames.has(uniqueName)) {
		uniqueName = `${name} (${suffix})`;
		suffix += 1;
	}
	usedNames.add(uniqueName);
	return uniqueName;
}

function buildHeadersFromHeaderRow(headerRow = [], maxCols) {
	const usedNames = new Set();
	const headers = [];

	for (let i = 0; i < maxCols; i++) {
		const raw = headerRow[i] != null ? String(headerRow[i]).trim() : "";
		const baseName = raw || `Column ${i + 1}`;
		headers.push(makeUniqueHeader(baseName, usedNames));
	}

	return headers;
}

function rowArrayFromRecord(record) {
	if (Array.isArray(record)) return record;

	return Object.keys(record)
		.filter((key) => /^\d+$/.test(key))
		.sort((a, b) => Number(a) - Number(b))
		.map((key) => (record[key] != null ? String(record[key]) : ""));
}

function rowDataFromArray(rowArr, headers) {
	const rowData = {};
	let hasValue = false;

	for (let i = 0; i < headers.length; i++) {
		const value = rowArr[i] != null ? String(rowArr[i]).trim() : "";
		rowData[headers[i]] = value;
		if (value) hasValue = true;
	}

	return { rowData, hasValue };
}

function resolveHeadersFromGrid(values, { headerRowIndex = 0 } = {}) {
	if (!values?.length) {
		return { headers: [], rows: [] };
	}

	const maxCols = values.reduce(
		(max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
		0
	);

	const headerRow = values[headerRowIndex] || [];
	const headers = buildHeadersFromHeaderRow(headerRow, maxCols);
	const rows = [];

	for (let r = headerRowIndex + 1; r < values.length; r++) {
		const { rowData, hasValue } = rowDataFromArray(values[r] || [], headers);
		if (hasValue) rows.push(rowData);
	}

	return { headers, rows };
}

function getWorksheetMaxColumn(worksheet) {
	let maxCol = 0;

	for (let i = 1; i <= worksheet.rowCount; i++) {
		worksheet.getRow(i).eachCell({ includeEmpty: false }, (_cell, colNumber) => {
			maxCol = Math.max(maxCol, colNumber);
		});
	}

	return maxCol;
}

module.exports = {
	makeUniqueHeader,
	buildHeadersFromHeaderRow,
	rowArrayFromRecord,
	rowDataFromArray,
	resolveHeadersFromGrid,
	getWorksheetMaxColumn,
};
