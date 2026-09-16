const CopyMatrixRow = require("../models/copyMatrixRow");
const {
	AUTO_ROW_ID_COLUMN,
	normalizeCellText,
	omitRowIdColumn,
	ensureRowIdColumn,
} = require("../constants/copyMatrix");
const {
	parseCopyMatrixSource,
	saveRows,
} = require("./copyMatrixProcessors");

function userColumns(columns = []) {
	return omitRowIdColumn(columns);
}

function cellText(rowData, column) {
	return normalizeCellText(rowData?.[column]);
}

function diffCopyMatrixRows(currentRows, sourceRows, columns) {
	const cols = userColumns(columns);
	const changes = [];
	const max = Math.max(currentRows.length, sourceRows.length);

	for (let i = 0; i < max; i++) {
		const current = currentRows[i];
		const source = sourceRows[i];
		const rowIndex = current?.rowIndex || i + 1;
		const rowId = current?._id ? String(current._id) : null;

		if (!current && source) {
			const filled = cols.filter((column) => cellText(source, column));
			if (filled.length === 0) {
				changes.push({
					rowIndex,
					rowId,
					column: "Entire row",
					previousValue: "",
					updatedValue: "New row",
					status: "Added",
				});
				continue;
			}
			for (const column of filled) {
				changes.push({
					rowIndex,
					rowId,
					column,
					previousValue: "",
					updatedValue: source[column] ?? "",
					status: "Added",
				});
			}
			continue;
		}

		if (current && !source) {
			changes.push({
				rowIndex,
				rowId,
				column: "Entire row",
				previousValue: "Row data",
				updatedValue: "Row deleted",
				status: "Removed",
			});
			continue;
		}

		for (const column of cols) {
			const previousValue = current.rowData?.[column] ?? "";
			const updatedValue = source[column] ?? "";
			if (cellText(current.rowData, column) === cellText(source, column)) {
				continue;
			}
			changes.push({
				rowIndex,
				rowId,
				column,
				previousValue,
				updatedValue,
				status: "Modified",
			});
		}
	}

	return changes;
}

function summarizeChanges(changes) {
	return {
		added: changes.filter((item) => item.status === "Added").length,
		modified: changes.filter((item) => item.status === "Modified").length,
		removed: changes.filter((item) => item.status === "Removed").length,
	};
}

function highlightsFromChanges(changes) {
	const cells = [];
	const rowIndexes = new Set();

	for (const change of changes) {
		if (change.status === "Removed") continue;
		rowIndexes.add(change.rowIndex);
		if (change.column && change.column !== "Entire row") {
			cells.push({
				rowIndex: change.rowIndex,
				column: change.column,
			});
		}
	}

	return {
		cells,
		rowIndexes: [...rowIndexes],
	};
}

async function loadCurrentRows(copyMatrixId) {
	return CopyMatrixRow.find({ copyMatrixId })
		.sort({ rowIndex: 1 })
		.select("_id rowIndex rowData")
		.lean();
}

async function previewCopyMatrixRefresh(matrix) {
	const source = await parseCopyMatrixSource(matrix);
	const currentRows = await loadCurrentRows(matrix._id);
	const columns = ensureRowIdColumn([
		...(matrix.columns || []),
		...(source.columns || []),
	]);
	const changes = diffCopyMatrixRows(
		currentRows,
		source.rows || [],
		columns
	);
	const summary = summarizeChanges(changes);

	return {
		hasChanges: changes.length > 0,
		name: matrix.name,
		fileName: source.sheetTitle || matrix.fileName || "",
		inputType: matrix.inputType,
		columns: omitRowIdColumn(columns),
		sourceRowCount: (source.rows || []).length,
		currentRowCount: currentRows.length,
		summary,
		changes,
		highlights: highlightsFromChanges(changes),
	};
}

async function applyCopyMatrixRefresh(matrix) {
	const source = await parseCopyMatrixSource(matrix);
	const currentRows = await loadCurrentRows(matrix._id);
	const columns = ensureRowIdColumn([
		...(matrix.columns || []),
		...(source.columns || []),
	]);
	const changes = diffCopyMatrixRows(
		currentRows,
		source.rows || [],
		columns
	);

	const inserted = await saveRows(matrix._id, source.rows || []);
	matrix.columns = ensureRowIdColumn(source.columns || []);
	matrix.processedRows = inserted;
	if (matrix.inputType === "gsheet" && source.sheetTitle) {
		matrix.sheetGid = source.sheetGid;
		matrix.fileName = source.sheetTitle;
	}
	matrix.message = `Refreshed ${inserted} rows from source`;
	await matrix.save();

	return {
		hasChanges: changes.length > 0,
		processedRows: inserted,
		columns: matrix.columns,
		summary: summarizeChanges(changes),
		highlights: highlightsFromChanges(changes),
	};
}

module.exports = {
	previewCopyMatrixRefresh,
	applyCopyMatrixRefresh,
	AUTO_ROW_ID_COLUMN,
};
