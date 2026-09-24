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

function normalizedColumnName(column) {
	return String(column || "").trim();
}

function columnKey(column) {
	return normalizedColumnName(column).replace(/\s+/g, " ").toLowerCase();
}

function findColumnStructureChanges(existingColumns, sourceColumns) {
	const existing = userColumns(existingColumns)
		.map(normalizedColumnName)
		.filter(Boolean);
	const source = userColumns(sourceColumns)
		.map(normalizedColumnName)
		.filter(Boolean);
	const existingKeys = new Set(existing.map(columnKey));
	const sourceKeys = new Set(source.map(columnKey));

	const deleted = [];
	const edited = [];
	const consumedNew = new Set();

	existing.forEach((name, index) => {
		if (sourceKeys.has(columnKey(name))) return;

		const replacement = source[index];
		const replacementKey = replacement ? columnKey(replacement) : "";
		const replacementIsNew =
			replacement &&
			!existingKeys.has(replacementKey) &&
			!consumedNew.has(replacementKey);

		if (replacementIsNew) {
			edited.push({ column: name, updatedName: replacement });
			consumedNew.add(replacementKey);
			return;
		}

		deleted.push(name);
	});

	return {
		deleted,
		edited: edited.filter(
			(item) => columnKey(item.column) !== columnKey(item.updatedName)
		),
	};
}

function mergeColumns(existingColumns, sourceColumns) {
	const seen = new Set();
	const next = [];

	for (const column of [
		...userColumns(existingColumns),
		...userColumns(sourceColumns),
	]) {
		const name = normalizedColumnName(column);
		const key = columnKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		next.push(name);
	}

	return ensureRowIdColumn(next);
}

async function dedupeStoredColumns(matrix) {
	const uniqueColumns = mergeColumns(matrix.columns, []);
	if (uniqueColumns.length === ensureRowIdColumn(matrix.columns || []).length) {
		return;
	}
	matrix.columns = uniqueColumns;
	await matrix.save();
}

function columnChangeLabel(item) {
	if (item?.updatedName && item.updatedName !== item.column) {
		return `${item.column} → ${item.updatedName}`;
	}
	return item?.column || "";
}

function assertSourceColumnsAllowed(existingColumns, sourceColumns) {
	const { deleted, edited } = findColumnStructureChanges(
		existingColumns,
		sourceColumns
	);
	if (!deleted.length && !edited.length) return { deleted, edited };

	const parts = [];
	if (deleted.length) {
		parts.push(`Deleted columns: ${deleted.join(", ")}`);
	}
	if (edited.length) {
		parts.push(
			`Edited columns: ${edited.map(columnChangeLabel).filter(Boolean).join(", ")}`
		);
	}

	const err = new Error(parts.join(". "));
	err.statusCode = 400;
	err.deletedColumns = deleted;
	err.editedColumns = edited;
	throw err;
}

function cellText(rowData, column) {
	return normalizeCellText(rowData?.[column]);
}

function rowsEqual(current, source, columns) {
	if (!current || !source) return false;
	return columns.every(
		(column) =>
			cellText(current.rowData, column) === cellText(source, column)
	);
}

function listCellChanges(current, source, columns) {
	const changes = [];
	for (const column of columns) {
		const previousValue = current?.rowData?.[column] ?? "";
		const updatedValue = source?.[column] ?? "";
		if (cellText(current?.rowData, column) === cellText(source, column)) {
			continue;
		}
		changes.push({ column, previousValue, updatedValue });
	}
	return changes;
}

function findEqualAhead(rows, start, matcher) {
	const end = Math.min(rows.length, start + 250);
	for (let index = start; index < end; index++) {
		if (matcher(rows[index])) return index;
	}
	return -1;
}

function pushAddedChanges(changes, source, columns, rowIndex) {
	const filled = columns.filter((column) => cellText(source, column));
	for (const column of filled) {
		changes.push({
			rowIndex,
			rowId: null,
			column,
			previousValue: "",
			updatedValue: source[column] ?? "",
			status: "Added",
		});
	}
}

function alignCopyMatrixRows(currentRows, sourceRows, columns) {
	const cols = userColumns(columns);
	const pairs = [];
	let currentIndex = 0;
	let sourceIndex = 0;
	const addedBase = Math.max(currentRows.length, sourceRows.length) + 1;
	let addedCount = 0;

	while (currentIndex < currentRows.length || sourceIndex < sourceRows.length) {
		const current = currentRows[currentIndex];
		const source = sourceRows[sourceIndex];

		if (current && source && rowsEqual(current, source, cols)) {
			pairs.push({
				kind: "same",
				rowIndex: current.rowIndex || currentIndex + 1,
				current,
				source,
			});
			currentIndex += 1;
			sourceIndex += 1;
			continue;
		}

		if (current && source) {
			const cellChanges = listCellChanges(current, source, cols);
			const matchedColumns = cols.length - cellChanges.length;
			if (cellChanges.length > 0 && matchedColumns >= cellChanges.length) {
				pairs.push({
					kind: "modified",
					rowIndex: current.rowIndex || currentIndex + 1,
					current,
					source,
				});
				currentIndex += 1;
				sourceIndex += 1;
				continue;
			}

			const sourceAhead = findEqualAhead(sourceRows, sourceIndex + 1, (row) =>
				rowsEqual(current, row, cols)
			);
			const currentAhead = findEqualAhead(
				currentRows,
				currentIndex + 1,
				(row) => rowsEqual(row, source, cols)
			);
			const addedGap = sourceAhead === -1 ? Infinity : sourceAhead - sourceIndex;
			const removedGap =
				currentAhead === -1 ? Infinity : currentAhead - currentIndex;

			if (sourceAhead !== -1 && addedGap <= removedGap) {
				for (let index = sourceIndex; index < sourceAhead; index++) {
					addedCount += 1;
					pairs.push({
						kind: "added",
						rowIndex: addedBase + addedCount,
						current: null,
						source: sourceRows[index],
					});
				}
				sourceIndex = sourceAhead;
				continue;
			}

			if (currentAhead !== -1) {
				for (let index = currentIndex; index < currentAhead; index++) {
					const removed = currentRows[index];
					pairs.push({
						kind: "removed",
						rowIndex: removed.rowIndex || index + 1,
						current: removed,
						source: null,
					});
				}
				currentIndex = currentAhead;
				continue;
			}

			pairs.push({
				kind: "modified",
				rowIndex: current.rowIndex || currentIndex + 1,
				current,
				source,
			});
			currentIndex += 1;
			sourceIndex += 1;
			continue;
		}

		if (source) {
			addedCount += 1;
			pairs.push({
				kind: "added",
				rowIndex: addedBase + addedCount,
				current: null,
				source,
			});
			sourceIndex += 1;
			continue;
		}

		pairs.push({
			kind: "removed",
			rowIndex: current.rowIndex || currentIndex + 1,
			current,
			source: null,
		});
		currentIndex += 1;
	}

	return pairs;
}

function diffCopyMatrixRows(currentRows, sourceRows, columns) {
	const cols = userColumns(columns);
	const changes = [];

	for (const pair of alignCopyMatrixRows(currentRows, sourceRows, columns)) {
		const rowId = pair.current?._id ? String(pair.current._id) : null;
		if (pair.kind === "added") {
			pushAddedChanges(changes, pair.source, cols, pair.rowIndex);
			continue;
		}
		if (pair.kind === "removed") {
			changes.push({
				rowIndex: pair.rowIndex,
				rowId,
				column: "Entire row",
				previousValue: "Row data",
				updatedValue: "Row deleted",
				status: "Removed",
			});
			continue;
		}
		if (pair.kind !== "modified") continue;
		for (const change of listCellChanges(pair.current, pair.source, cols)) {
			changes.push({
				rowIndex: pair.rowIndex,
				rowId,
				column: change.column,
				previousValue: change.previousValue,
				updatedValue: change.updatedValue,
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

function buildUnsyncedRows(pairs, columns) {
	const seenColumns = new Set();
	const cols = userColumns(columns).filter((column) => {
		if (!column || column === AUTO_ROW_ID_COLUMN) return false;
		const key = columnKey(column);
		if (!key || seenColumns.has(key)) return false;
		seenColumns.add(key);
		return true;
	});

	return pairs
		.filter((pair) => pair.kind !== "same")
		.map((pair) => {
			const status =
				pair.kind === "added"
					? "Added"
					: pair.kind === "removed"
						? "Removed"
						: "Modified";
			const rowData =
				status === "Removed"
					? pair.current?.rowData || {}
					: pair.source || {};
			const changed = new Map(
				status === "Modified"
					? listCellChanges(pair.current, pair.source, cols).map(
							(change) => [change.column, change]
						)
					: []
			);
			const fields = cols.map((column) => {
				const change = changed.get(column);
				return {
					column,
					value: change
						? change.updatedValue
						: rowData?.[column] ?? "",
					previousValue: change?.previousValue ?? "",
					changed: Boolean(change),
					status: change ? "Modified" : "",
				};
			});
			return {
				rowIndex: pair.rowIndex,
				rowId: pair.current?._id ? String(pair.current._id) : null,
				status,
				fields,
			};
		})
		.filter((row) => {
			if (row.status !== "Added") return row.fields.length > 0;
			return row.fields.some((field) => normalizeCellText(field.value));
		})
		.sort((left, right) => left.rowIndex - right.rowIndex);
}

async function loadCurrentRows(copyMatrixId) {
	return CopyMatrixRow.find({ copyMatrixId })
		.sort({ rowIndex: 1 })
		.select("_id rowIndex rowData")
		.lean();
}

async function previewCopyMatrixRefresh(matrix) {
	const source = await parseCopyMatrixSource(matrix);
	await dedupeStoredColumns(matrix);
	assertSourceColumnsAllowed(matrix.columns, source.columns);
	const currentRows = await loadCurrentRows(matrix._id);
	const columns = mergeColumns(matrix.columns, source.columns);
	const pairs = alignCopyMatrixRows(
		currentRows,
		source.rows || [],
		columns
	);
	const changes = diffCopyMatrixRows(
		currentRows,
		source.rows || [],
		columns
	);
	const summary = summarizeChanges(changes);
	const userFacingColumns = omitRowIdColumn(columns);
	const unsyncedRows = buildUnsyncedRows(pairs, userFacingColumns);

	return {
		hasChanges: changes.length > 0,
		name: matrix.name,
		fileName: source.sheetTitle || matrix.fileName || "",
		inputType: matrix.inputType,
		columns: userFacingColumns,
		sourceRowCount: (source.rows || []).length,
		currentRowCount: currentRows.length,
		maxRowIndex: currentRows.reduce(
			(max, row) => Math.max(max, Number(row.rowIndex) || 0),
			0
		),
		summary,
		changes,
		highlights: highlightsFromChanges(changes),
		unsyncedRows,
	};
}

async function applyCopyMatrixRefresh(matrix) {
	const source = await parseCopyMatrixSource(matrix);
	await dedupeStoredColumns(matrix);
	assertSourceColumnsAllowed(matrix.columns, source.columns);
	const currentRows = await loadCurrentRows(matrix._id);
	const columns = mergeColumns(matrix.columns, source.columns);
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

async function decideCopyMatrixRefresh(matrix, { action, rowIndexes } = {}) {
	const decision = action === "reject" ? "reject" : "approve";
	const indexes = new Set(
		(Array.isArray(rowIndexes) ? rowIndexes : [])
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value) && value > 0)
	);
	if (!indexes.size) {
		const err = new Error("Select at least one row");
		err.statusCode = 400;
		throw err;
	}

	if (decision === "reject") {
		return { staged: true, rejected: true, hasChanges: false };
	}

	const source = await parseCopyMatrixSource(matrix);
	await dedupeStoredColumns(matrix);
	assertSourceColumnsAllowed(matrix.columns, source.columns);
	const currentRows = await loadCurrentRows(matrix._id);
	const sourceRows = source.rows || [];
	const columns = mergeColumns(matrix.columns, source.columns);
	const pairs = alignCopyMatrixRows(currentRows, sourceRows, columns);
	const cols = userColumns(columns);
	const pendingEdits = {};
	const appendedRows = [];
	const removedRowIds = [];
	const cells = [];
	const highlightRowIndexes = [];
	let nextIndex = currentRows.reduce(
		(max, row) => Math.max(max, Number(row.rowIndex) || 0),
		0
	);

	for (const pair of pairs) {
		if (!indexes.has(Number(pair.rowIndex)) || pair.kind === "same") {
			continue;
		}
		if (pair.kind === "removed") {
			if (pair.current?._id) removedRowIds.push(String(pair.current._id));
			continue;
		}
		if (pair.kind === "added" && pair.source) {
			nextIndex += 1;
			const rowData = {};
			const filled = [];
			for (const column of cols) {
				rowData[column] = pair.source[column] ?? "";
				if (cellText(pair.source, column)) filled.push(column);
			}
			appendedRows.push({ rowIndex: nextIndex, rowData });
			highlightRowIndexes.push(nextIndex);
			for (const column of filled.length ? filled : cols) {
				if (!column || column === AUTO_ROW_ID_COLUMN) continue;
				cells.push({ rowIndex: nextIndex, column });
			}
			continue;
		}
		if (pair.kind !== "modified" || !pair.current?._id || !pair.source) {
			continue;
		}
		const changes = listCellChanges(pair.current, pair.source, cols);
		if (!changes.length) continue;
		const rowIndex = Number(pair.rowIndex);
		const patch = {};
		for (const change of changes) {
			patch[change.column] = change.updatedValue ?? "";
			cells.push({ rowIndex, column: change.column });
		}
		pendingEdits[String(pair.current._id)] = patch;
		highlightRowIndexes.push(rowIndex);
	}

	return {
		staged: true,
		hasChanges: false,
		pendingEdits,
		appendedRows,
		removedRowIds,
		columns: userColumns(columns),
		approvedHighlights: {
			cells,
			rowIndexes: highlightRowIndexes,
		},
	};
}

module.exports = {
	previewCopyMatrixRefresh,
	applyCopyMatrixRefresh,
	decideCopyMatrixRefresh,
	assertSourceColumnsAllowed,
	AUTO_ROW_ID_COLUMN,
};
