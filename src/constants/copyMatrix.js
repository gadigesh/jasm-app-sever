const AUTO_ROW_ID_COLUMN = "Row ID";

function ensureRowIdColumn(columns = []) {
	const rest = columns.filter((col) => col !== AUTO_ROW_ID_COLUMN);
	return [AUTO_ROW_ID_COLUMN, ...rest];
}

function omitRowIdColumn(columns = []) {
	return columns.filter((col) => col !== AUTO_ROW_ID_COLUMN);
}

function injectRowIdIntoRowData(rowData, rowIndex) {
	return {
		...rowData,
		[AUTO_ROW_ID_COLUMN]: String(rowIndex),
	};
}

/**
 * Normalize cell strings for CM + AS sheets. Line breaks inside a cell are
 * kept as "\n"; flattening them is an explicit column action.
 */
function normalizeCellText(value) {
	if (value == null) return "";
	return String(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u000b\u000c\u0085\u2028\u2029]/g, "\n")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
		// Leading/trailing only — keep intentional spaces in the middle
		.trim();
}

function normalizeRowDataValues(rowData = {}) {
	const next = {};
	for (const [key, value] of Object.entries(rowData)) {
		next[key] =
			typeof value === "string" || value == null
				? normalizeCellText(value)
				: value;
	}
	return next;
}

function resolveUniqueColumn() {
	return AUTO_ROW_ID_COLUMN;
}

function isAutoRowIdColumn(column) {
	return column === AUTO_ROW_ID_COLUMN;
}

module.exports = {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	omitRowIdColumn,
	injectRowIdIntoRowData,
	normalizeCellText,
	normalizeRowDataValues,
	resolveUniqueColumn,
	isAutoRowIdColumn,
};
