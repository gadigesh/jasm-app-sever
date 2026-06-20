const AUTO_ROW_ID_COLUMN = "Row ID";

function ensureRowIdColumn(columns = []) {
	const rest = columns.filter((col) => col !== AUTO_ROW_ID_COLUMN);
	return [AUTO_ROW_ID_COLUMN, ...rest];
}

function injectRowIdIntoRowData(rowData, rowIndex) {
	return {
		...rowData,
		[AUTO_ROW_ID_COLUMN]: String(rowIndex),
	};
}

function resolveUniqueColumn(uniqueColumn, columns = []) {
	const trimmed = uniqueColumn?.trim();
	if (trimmed) return trimmed;
	if (columns.includes(AUTO_ROW_ID_COLUMN)) return AUTO_ROW_ID_COLUMN;
	return AUTO_ROW_ID_COLUMN;
}

function isAutoRowIdColumn(column) {
	return column === AUTO_ROW_ID_COLUMN;
}

module.exports = {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	injectRowIdIntoRowData,
	resolveUniqueColumn,
	isAutoRowIdColumn,
};
