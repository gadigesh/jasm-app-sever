const mongoose = require("mongoose");
const CopyMatrixRow = require("../models/copyMatrixRow");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	isAutoRowIdColumn,
	normalizeCellText,
} = require("../constants/copyMatrix");
const {
	resolveLinkedAssetUpload,
} = require("./copyMatrixToAssetSource");

/**
 * Prepare find/replace query text.
 * Keeps intentional spaces (including leading/trailing in the query).
 * Only normalizes unicode/newlines so they match displayed cell text.
 */
function normalizeSearchQuery(value) {
	if (value == null) return "";
	return String(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\r\n\u000b\u000c\u0085\u2028\u2029\t]+/g, " ")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
}

function assertColumnExists(matrix, column) {
	const columns = matrix.columns || [];
	if (!column || !columns.includes(column)) {
		const err = new Error("Column not found");
		err.statusCode = 400;
		throw err;
	}
}

function assertEditableDataColumn(column) {
	if (isAutoRowIdColumn(column)) {
		const err = new Error(
			`"${AUTO_ROW_ID_COLUMN}" cannot be modified this way`
		);
		err.statusCode = 400;
		throw err;
	}
}

async function assertNotSyncedForStructureChange(matrix) {
	const linked = await resolveLinkedAssetUpload(matrix);
	if (linked) {
		const err = new Error(
			"Rename and delete are only allowed when the copy matrix is not synced with an asset source"
		);
		err.statusCode = 400;
		throw err;
	}
}

function normalizeRowObjectIds(rowIds) {
	if (!Array.isArray(rowIds) || rowIds.length === 0) return null;
	const ids = [];
	for (const raw of rowIds) {
		const str = String(raw || "").trim();
		if (!str || !mongoose.Types.ObjectId.isValid(str)) continue;
		ids.push(new mongoose.Types.ObjectId(str));
	}
	return ids.length ? ids : null;
}

function buildRowFilter(matrixId, rowIds) {
	const filter = { copyMatrixId: matrixId };
	const objectIds = normalizeRowObjectIds(rowIds);
	if (objectIds) {
		filter._id = { $in: objectIds };
	}
	return filter;
}

async function loadTargetRows(matrixId, rowIds) {
	return CopyMatrixRow.find(buildRowFilter(matrixId, rowIds))
		.sort({ rowIndex: 1 })
		.select("_id rowIndex rowData");
}

async function fillColumnSequence(matrix, column, rowIds, userId) {
	assertColumnExists(matrix, column);
	assertEditableDataColumn(column);

	const rows = await loadTargetRows(matrix._id, rowIds);
	if (!rows.length) {
		return { updated: 0 };
	}

	const ops = rows.map((row, index) => ({
		updateOne: {
			filter: { _id: row._id },
			update: {
				$set: { [`rowData.${column}`]: String(index + 1) },
			},
		},
	}));

	await CopyMatrixRow.bulkWrite(ops);
	matrix.updatedBy = userId;
	await matrix.save();
	return { updated: ops.length };
}

async function copyFromOtherColumn(
	matrix,
	targetColumn,
	sourceColumn,
	rowIds,
	userId
) {
	assertColumnExists(matrix, targetColumn);
	assertColumnExists(matrix, sourceColumn);
	assertEditableDataColumn(targetColumn);

	if (targetColumn === sourceColumn) {
		const err = new Error("Source and target columns must be different");
		err.statusCode = 400;
		throw err;
	}

	const rows = await loadTargetRows(matrix._id, rowIds);
	if (!rows.length) {
		return { updated: 0 };
	}

	const ops = rows.map((row) => ({
		updateOne: {
			filter: { _id: row._id },
			update: {
				$set: {
					[`rowData.${targetColumn}`]:
						row.rowData?.[sourceColumn] ?? "",
				},
			},
		},
	}));

	await CopyMatrixRow.bulkWrite(ops);
	matrix.updatedBy = userId;
	await matrix.save();
	return { updated: ops.length };
}

async function fillColumnDate(
	matrix,
	column,
	dateValue,
	rowIds,
	userId
) {
	assertColumnExists(matrix, column);
	assertEditableDataColumn(column);

	const value = String(dateValue || "").trim();
	if (!value) {
		const err = new Error("Date value is required");
		err.statusCode = 400;
		throw err;
	}

	const rows = await loadTargetRows(matrix._id, rowIds);
	if (!rows.length) {
		return { updated: 0 };
	}

	const ops = rows.map((row) => ({
		updateOne: {
			filter: { _id: row._id },
			update: { $set: { [`rowData.${column}`]: value } },
		},
	}));

	await CopyMatrixRow.bulkWrite(ops);
	matrix.updatedBy = userId;
	await matrix.save();
	return { updated: ops.length };
}

async function replaceInColumn(
	matrix,
	column,
	findText,
	replaceText,
	mode,
	rowIds,
	userId
) {
	assertColumnExists(matrix, column);
	assertEditableDataColumn(column);

	// Do NOT trim the find query — spaces are valid search targets.
	// Empty find = match blank cells (shown as "—" in the sheet).
	const find = normalizeSearchQuery(findText);
	const matchEmpty = find.length === 0;

	// Replacement may intentionally include spaces; only normalize unicode/newlines
	const replacement = normalizeSearchQuery(replaceText);
	const isFindOnly = mode === "find";
	const isReplaceSelected = mode === "replace";
	const isReplaceAll = mode === "replaceAll";

	if (!isFindOnly && !isReplaceSelected && !isReplaceAll) {
		const err = new Error("Invalid replace mode");
		err.statusCode = 400;
		throw err;
	}

	if (isReplaceSelected && (!Array.isArray(rowIds) || rowIds.length === 0)) {
		const err = new Error("Select at least one row to replace");
		err.statusCode = 400;
		throw err;
	}

	// Limit to selected rows when rowIds are provided (Replace, or All with a selection).
	// Find / All with no selection scans the whole column.
	const scopeRowIds =
		Array.isArray(rowIds) && rowIds.length > 0 ? rowIds : undefined;
	const rows = await loadTargetRows(matrix._id, scopeRowIds);

	const findLower = find.toLowerCase();
	let matched = 0;
	const matchedRows = [];
	const ops = [];
	const changes = [];

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		// Match against the same normalized text the user sees in the sheet
		const current = normalizeCellText(row.rowData?.[column]);
		const isMatch = matchEmpty
			? current.length === 0
			: current.toLowerCase().includes(findLower);
		if (!isMatch) continue;

		matched += 1;
		matchedRows.push({
			rowId: String(row._id),
			rowIndex: row.rowIndex,
			offset: scopeRowIds ? null : i,
		});

		if (isFindOnly) continue;

		let next;
		if (matchEmpty) {
			// Fill blank cell with replacement (may be empty → no-op)
			next = normalizeCellText(replacement);
		} else {
			const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const replaced = current.replace(
				new RegExp(escaped, "gi"),
				replacement
			);
			// Trim edges on save (sheet rule); keep intentional middle spaces
			next = normalizeCellText(replaced);
		}
		if (next === current) continue;

		ops.push({
			updateOne: {
				filter: { _id: row._id },
				update: { $set: { [`rowData.${column}`]: next } },
			},
		});
		changes.push({
			rowId: String(row._id),
			before: current,
			after: next,
		});
	}

	if (!isFindOnly && ops.length) {
		await CopyMatrixRow.bulkWrite(ops);
		matrix.updatedBy = userId;
		await matrix.save();
	}

	const updated = ops.length;
	return {
		matched,
		updated,
		matchedRows,
		changes,
		column,
		mode: isFindOnly ? "find" : isReplaceSelected ? "replace" : "replaceAll",
		message: isFindOnly
			? matched === 0
				? matchEmpty
					? "No blank cells found"
					: "No matches found"
				: matchEmpty
				? `${matched} blank cell${matched === 1 ? "" : "s"} found`
				: `${matched} matching row${matched === 1 ? "" : "s"} found`
			: matched === 0
			? matchEmpty
				? "No blank cells found"
				: "No matches found"
			: matchEmpty
			? `Filled ${updated} blank cell${updated === 1 ? "" : "s"}`
			: `Replaced ${updated} of ${matched} matched row${
					matched === 1 ? "" : "s"
			  }`,
	};
}

/**
 * Fast bulk apply of known cell values (undo / redo).
 * Uses one bulkWrite — no per-row find/save and no full AS sync.
 */
async function applyColumnCellChanges(matrix, column, cellChanges, userId) {
	assertColumnExists(matrix, column);
	assertEditableDataColumn(column);

	if (!Array.isArray(cellChanges) || cellChanges.length === 0) {
		return { updated: 0, column };
	}

	const ops = [];
	for (const item of cellChanges) {
		const rowId = item?.rowId;
		if (!rowId || !mongoose.Types.ObjectId.isValid(rowId)) continue;
		const next = normalizeCellText(item.value);
		ops.push({
			updateOne: {
				filter: {
					_id: rowId,
					copyMatrixId: matrix._id,
				},
				update: { $set: { [`rowData.${column}`]: next } },
			},
		});
	}

	if (ops.length) {
		await CopyMatrixRow.bulkWrite(ops, { ordered: false });
		matrix.updatedBy = userId;
		await matrix.save();
	}

	return { updated: ops.length, column };
}

async function renameCopyMatrixColumn(matrix, oldName, newName, userId) {
	await assertNotSyncedForStructureChange(matrix);
	assertColumnExists(matrix, oldName);
	assertEditableDataColumn(oldName);

	const trimmed = String(newName || "").trim();
	if (!trimmed) {
		const err = new Error("New column name is required");
		err.statusCode = 400;
		throw err;
	}
	if (isAutoRowIdColumn(trimmed)) {
		const err = new Error(
			`"${AUTO_ROW_ID_COLUMN}" is a reserved column name`
		);
		err.statusCode = 400;
		throw err;
	}

	const columns = matrix.columns || [];
	if (
		columns.some(
			(col) =>
				col !== oldName &&
				col.toLowerCase() === trimmed.toLowerCase()
		)
	) {
		const err = new Error("Same name already exists");
		err.statusCode = 400;
		throw err;
	}

	if (oldName === trimmed) {
		return matrix;
	}

	matrix.columns = ensureRowIdColumn(
		columns.map((col) => (col === oldName ? trimmed : col))
	);

	await CopyMatrixRow.updateMany(
		{ copyMatrixId: matrix._id },
		{
			$rename: {
				[`rowData.${oldName}`]: `rowData.${trimmed}`,
			},
		}
	);

	matrix.updatedBy = userId;
	await matrix.save();
	return matrix;
}

async function deleteCopyMatrixColumn(matrix, column, userId) {
	await assertNotSyncedForStructureChange(matrix);
	assertColumnExists(matrix, column);
	assertEditableDataColumn(column);

	const columns = matrix.columns || [];
	matrix.columns = ensureRowIdColumn(
		columns.filter((col) => col !== column)
	);

	await CopyMatrixRow.updateMany(
		{ copyMatrixId: matrix._id },
		{ $unset: { [`rowData.${column}`]: "" } }
	);

	matrix.updatedBy = userId;
	await matrix.save();
	return matrix;
}

function suggestCloneColumnName(sourceColumn, columns = []) {
	const base = `${sourceColumn} (Copy)`;
	if (!columns.includes(base)) return base;
	let i = 2;
	while (columns.includes(`${sourceColumn} (Copy ${i})`)) {
		i += 1;
	}
	return `${sourceColumn} (Copy ${i})`;
}

module.exports = {
	fillColumnSequence,
	copyFromOtherColumn,
	fillColumnDate,
	replaceInColumn,
	applyColumnCellChanges,
	renameCopyMatrixColumn,
	deleteCopyMatrixColumn,
	suggestCloneColumnName,
	assertNotSyncedForStructureChange,
};
