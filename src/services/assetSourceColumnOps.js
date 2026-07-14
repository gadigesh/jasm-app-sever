const mongoose = require("mongoose");
const AssetSource = require("../models/assetSource");
const {
	AUTO_ROW_ID_COLUMN,
	isAutoRowIdColumn,
	normalizeCellText,
} = require("../constants/copyMatrix");

function normalizeSearchQuery(value) {
	if (value == null) return "";
	return String(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\r\n\u000b\u000c\u0085\u2028\u2029\t]+/g, " ")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
}

function assertColumnExists(upload, column) {
	const columns = upload.columns || [];
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

function buildRowFilter(uploadId, rowIds) {
	const filter = { uploadId, isDeleted: { $ne: true } };
	const objectIds = normalizeRowObjectIds(rowIds);
	if (objectIds) {
		filter._id = { $in: objectIds };
	}
	return filter;
}

async function loadTargetRows(uploadId, rowIds) {
	return AssetSource.find(buildRowFilter(uploadId, rowIds))
		.sort({ cmRowIndex: 1, primaryKey: 1 })
		.select("_id cmRowIndex primaryKey rowData");
}

function cellSetFields(column, value, uniqueColumn) {
	const next = normalizeCellText(value);
	const fields = { [`rowData.${column}`]: next };
	if (uniqueColumn && column === uniqueColumn) {
		fields.primaryKey = next;
	}
	return fields;
}

async function touchUpload(upload, userId) {
	upload.uploadedBy = userId;
	await upload.save();
}

async function fillColumnSequence(upload, column, rowIds, userId) {
	assertColumnExists(upload, column);
	assertEditableDataColumn(column);

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) return { updated: 0 };

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row, index) => ({
		updateOne: {
			filter: { _id: row._id },
			update: {
				$set: cellSetFields(column, String(index + 1), uniqueColumn),
			},
		},
	}));

	await AssetSource.bulkWrite(ops);
	await touchUpload(upload, userId);
	return { updated: ops.length };
}

async function copyFromOtherColumn(
	upload,
	targetColumn,
	sourceColumn,
	template,
	splitBy,
	rowIds,
	userId
) {
	assertColumnExists(upload, targetColumn);
	assertColumnExists(upload, sourceColumn);
	assertEditableDataColumn(targetColumn);

	if (targetColumn === sourceColumn) {
		const err = new Error("Source and target columns must be different");
		err.statusCode = 400;
		throw err;
	}

	const wordPositions = new Map([
		["First word", 0],
		["Second word", 1],
		["Third word", 2],
		["Fourth word", 3],
		["Fifth word", 4],
	]);
	const separator = String(splitBy ?? "");
	const format =
		separator === "" ? "" : normalizeSearchQuery(template);
	const isValidSeparator =
		separator === "" ||
		separator === " " ||
		(separator.length <= 20 &&
			/^[^\p{L}\p{N}\s]+$/u.test(separator));
	if (!isValidSeparator) {
		const err = new Error("Invalid split option");
		err.statusCode = 400;
		throw err;
	}
	for (const match of format.matchAll(/\[([^\[\]]+)\]/g)) {
		if (!wordPositions.has(match[1])) {
			const err = new Error(`Invalid extract token: [${match[1]}]`);
			err.statusCode = 400;
			throw err;
		}
	}

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) return { updated: 0 };

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row) => {
		const sourceValue = row.rowData?.[sourceColumn] ?? "";
		const normalizedSource = normalizeCellText(sourceValue);
		const words = (
			separator === " "
				? normalizedSource.split(/\s+/)
				: normalizedSource.split(separator)
		)
			.map((word) => word.trim())
			.filter(Boolean);
		const value = format
			? normalizeCellText(
					format.replace(
						/\[([^\[\]]+)\]/g,
						(_match, token) => words[wordPositions.get(token)] ?? ""
					)
			  )
			: sourceValue;
		return {
			updateOne: {
				filter: { _id: row._id },
				update: {
					$set: cellSetFields(targetColumn, value, uniqueColumn),
				},
			},
		};
	});

	await AssetSource.bulkWrite(ops);
	await touchUpload(upload, userId);
	return { updated: ops.length };
}

async function generateColumnText(
	upload,
	targetColumn,
	template,
	rowIds,
	userId
) {
	assertColumnExists(upload, targetColumn);
	assertEditableDataColumn(targetColumn);

	const customTemplate = normalizeSearchQuery(template);
	const hasCustomTemplate = normalizeCellText(customTemplate).length > 0;
	if (!hasCustomTemplate) {
		const err = new Error("Add a format");
		err.statusCode = 400;
		throw err;
	}
	for (const match of customTemplate.matchAll(/\[([^\[\]]+)\]/g)) {
		const sourceColumn = match[1];
		assertColumnExists(upload, sourceColumn);
		if (sourceColumn === targetColumn) {
			const err = new Error("Target column cannot be used as a source");
			err.statusCode = 400;
			throw err;
		}
	}

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) return { updated: 0 };

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row) => {
		const value = normalizeCellText(
			customTemplate.replace(
				/\[([^\[\]]+)\]/g,
				(_match, column) =>
					normalizeCellText(row.rowData?.[column])
			)
		);
		return {
			updateOne: {
				filter: { _id: row._id },
				update: {
					$set: cellSetFields(targetColumn, value, uniqueColumn),
				},
			},
		};
	});

	await AssetSource.bulkWrite(ops);
	await touchUpload(upload, userId);
	return { updated: ops.length, column: targetColumn };
}

async function fillColumnDate(upload, column, dateValue, rowIds, userId) {
	assertColumnExists(upload, column);
	assertEditableDataColumn(column);

	const value = String(dateValue || "").trim();
	if (!value) {
		const err = new Error("Date value is required");
		err.statusCode = 400;
		throw err;
	}

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) return { updated: 0 };

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row) => ({
		updateOne: {
			filter: { _id: row._id },
			update: { $set: cellSetFields(column, value, uniqueColumn) },
		},
	}));

	await AssetSource.bulkWrite(ops);
	await touchUpload(upload, userId);
	return { updated: ops.length };
}

async function replaceInColumn(
	upload,
	column,
	findText,
	replaceText,
	mode,
	rowIds,
	userId
) {
	assertColumnExists(upload, column);
	assertEditableDataColumn(column);

	const find = normalizeSearchQuery(findText);
	const matchEmpty = find.length === 0;
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

	const scopeRowIds =
		Array.isArray(rowIds) && rowIds.length > 0 ? rowIds : undefined;
	const rows = await loadTargetRows(upload._id, scopeRowIds);
	const uniqueColumn = upload.uniqueColumn;
	const findLower = find.toLowerCase();

	let matched = 0;
	const matchedRows = [];
	const ops = [];
	const changes = [];

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const current = normalizeCellText(row.rowData?.[column]);
		const isMatch = matchEmpty
			? current.length === 0
			: current.toLowerCase().includes(findLower);
		if (!isMatch) continue;

		matched += 1;
		matchedRows.push({
			rowId: String(row._id),
			rowIndex: row.cmRowIndex ?? i + 1,
			offset: scopeRowIds ? null : i,
		});

		if (isFindOnly) continue;

		let next;
		if (matchEmpty) {
			next = normalizeCellText(replacement);
		} else {
			const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			next = normalizeCellText(
				current.replace(new RegExp(escaped, "gi"), replacement)
			);
		}
		if (next === current) continue;

		ops.push({
			updateOne: {
				filter: { _id: row._id },
				update: { $set: cellSetFields(column, next, uniqueColumn) },
			},
		});
		changes.push({
			rowId: String(row._id),
			before: current,
			after: next,
		});
	}

	if (!isFindOnly && ops.length) {
		await AssetSource.bulkWrite(ops);
		await touchUpload(upload, userId);
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

async function applyColumnCellChanges(upload, column, cellChanges, userId) {
	assertColumnExists(upload, column);
	assertEditableDataColumn(column);

	if (!Array.isArray(cellChanges) || cellChanges.length === 0) {
		return { updated: 0, column };
	}

	const uniqueColumn = upload.uniqueColumn;
	const ops = [];
	for (const item of cellChanges) {
		const rowId = item?.rowId;
		if (!rowId || !mongoose.Types.ObjectId.isValid(rowId)) continue;
		ops.push({
			updateOne: {
				filter: { _id: rowId, uploadId: upload._id },
				update: {
					$set: cellSetFields(column, item.value, uniqueColumn),
				},
			},
		});
	}

	if (ops.length) {
		await AssetSource.bulkWrite(ops, { ordered: false });
		await touchUpload(upload, userId);
	}

	return { updated: ops.length, column };
}

function assertDraftColumnStructure(upload) {
	if (upload.status !== "draft") {
		const err = new Error(
			"Columns cannot be renamed or deleted after the asset source is finalized"
		);
		err.statusCode = 400;
		throw err;
	}
}

async function renameAssetSourceColumn(upload, oldName, newName, userId) {
	assertDraftColumnStructure(upload);
	assertColumnExists(upload, oldName);
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

	const columns = upload.columns || [];
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

	if (oldName === trimmed) return upload;

	upload.columns = columns.map((col) => (col === oldName ? trimmed : col));
	if (upload.uniqueColumn === oldName) {
		upload.uniqueColumn = trimmed;
	}

	await AssetSource.updateMany(
		{ uploadId: upload._id },
		{
			$rename: {
				[`rowData.${oldName}`]: `rowData.${trimmed}`,
			},
		}
	);

	await touchUpload(upload, userId);
	return upload;
}

async function deleteAssetSourceColumn(upload, column, userId) {
	assertDraftColumnStructure(upload);
	assertColumnExists(upload, column);
	assertEditableDataColumn(column);

	if (upload.uniqueColumn === column) {
		const err = new Error(
			"Cannot delete the unique column. Change the unique column first."
		);
		err.statusCode = 400;
		throw err;
	}

	upload.columns = (upload.columns || []).filter((col) => col !== column);

	await AssetSource.updateMany(
		{ uploadId: upload._id },
		{ $unset: { [`rowData.${column}`]: "" } }
	);

	await touchUpload(upload, userId);
	return upload;
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

async function cloneAssetSourceColumn(
	upload,
	sourceColumn,
	newColumnName,
	userId
) {
	assertColumnExists(upload, sourceColumn);
	const trimmed = String(newColumnName || "").trim();
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

	const columns = upload.columns || [];
	if (columns.includes(trimmed)) {
		const err = new Error("A column with this name already exists");
		err.statusCode = 400;
		throw err;
	}

	const sourceIndex = columns.indexOf(sourceColumn);
	const nextColumns = [...columns];
	nextColumns.splice(sourceIndex + 1, 0, trimmed);
	upload.columns = nextColumns;

	const rows = await loadTargetRows(upload._id);
	if (rows.length) {
		const ops = rows.map((row) => ({
			updateOne: {
				filter: { _id: row._id },
				update: {
					$set: {
						[`rowData.${trimmed}`]:
							row.rowData?.[sourceColumn] ?? "",
					},
				},
			},
		}));
		await AssetSource.bulkWrite(ops);
	}

	await touchUpload(upload, userId);
	return { upload, newColumnName: trimmed };
}

async function reorderAssetSourceColumns(upload, orderedColumns, userId) {
	if (!Array.isArray(orderedColumns) || orderedColumns.length === 0) {
		const err = new Error("Column order is required");
		err.statusCode = 400;
		throw err;
	}

	const current = upload.columns || [];
	const currentSet = new Set(current);
	const nextUser = orderedColumns.filter((col) => !isAutoRowIdColumn(col));
	const currentUser = current.filter((col) => !isAutoRowIdColumn(col));

	if (nextUser.length !== currentUser.length) {
		const err = new Error("Column list does not match existing columns");
		err.statusCode = 400;
		throw err;
	}
	for (const col of nextUser) {
		if (!currentSet.has(col)) {
			const err = new Error(`Unknown column: ${col}`);
			err.statusCode = 400;
			throw err;
		}
	}

	const hasRowId = current.includes(AUTO_ROW_ID_COLUMN);
	upload.columns = hasRowId ? [AUTO_ROW_ID_COLUMN, ...nextUser] : nextUser;
	await touchUpload(upload, userId);
	return upload;
}

async function addAssetSourceRow(upload, userId, overrides = {}) {
	const columns = upload.columns || [];
	const maxRow = await AssetSource.findOne({ uploadId: upload._id })
		.sort({ cmRowIndex: -1 })
		.select("cmRowIndex")
		.lean();
	const newIndex = (maxRow?.cmRowIndex ?? upload.processedRows ?? 0) + 1;

	const rowData = {};
	for (const col of columns) {
		rowData[col] = overrides[col] ?? "";
	}
	if (columns.includes(AUTO_ROW_ID_COLUMN)) {
		rowData[AUTO_ROW_ID_COLUMN] = String(newIndex);
	}

	const uniqueColumn = upload.uniqueColumn;
	let primaryKey = String(newIndex);
	if (uniqueColumn && !isAutoRowIdColumn(uniqueColumn)) {
		primaryKey =
			normalizeCellText(rowData[uniqueColumn]) || `row_${newIndex}`;
	}

	const row = await AssetSource.create({
		uploadId: upload._id,
		primaryKey,
		rowData,
		fileHash: upload.fileHash,
		isDeleted: false,
		importStatus: upload.status === "draft" ? "DRAFT" : "ACTIVE",
		cmRowIndex: newIndex,
	});

	upload.processedRows = (upload.processedRows || 0) + 1;
	await touchUpload(upload, userId);
	return { row, upload };
}

async function addAssetSourceColumn(upload, columnName, userId) {
	const trimmed = String(columnName || "").trim();
	if (!trimmed) {
		const err = new Error("Column name is required");
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

	const columns = upload.columns || [];
	if (columns.includes(trimmed)) {
		const err = new Error("A column with this name already exists");
		err.statusCode = 400;
		throw err;
	}

	upload.columns = [...columns, trimmed];
	await AssetSource.updateMany(
		{ uploadId: upload._id },
		{ $set: { [`rowData.${trimmed}`]: "" } }
	);
	await touchUpload(upload, userId);
	return upload;
}

async function cloneAssetSourceRow(upload, sourceRowId, userId) {
	const source = await AssetSource.findById(sourceRowId);
	if (!source || String(source.uploadId) !== String(upload._id)) {
		const err = new Error("Source row not found");
		err.statusCode = 404;
		throw err;
	}

	const maxRow = await AssetSource.findOne({ uploadId: upload._id })
		.sort({ cmRowIndex: -1 })
		.select("cmRowIndex")
		.lean();
	const newIndex = (maxRow?.cmRowIndex ?? 0) + 1;
	const rowData = { ...(source.rowData || {}) };
	if ((upload.columns || []).includes(AUTO_ROW_ID_COLUMN)) {
		rowData[AUTO_ROW_ID_COLUMN] = String(newIndex);
	}

	const uniqueColumn = upload.uniqueColumn;
	let primaryKey = `row_${newIndex}`;
	if (uniqueColumn && !isAutoRowIdColumn(uniqueColumn)) {
		const base = normalizeCellText(rowData[uniqueColumn]);
		primaryKey = base ? `${base}_copy_${newIndex}` : `row_${newIndex}`;
		rowData[uniqueColumn] = primaryKey;
	} else {
		primaryKey = String(newIndex);
	}

	const row = await AssetSource.create({
		uploadId: upload._id,
		primaryKey,
		rowData,
		fileHash: upload.fileHash,
		isDeleted: false,
		importStatus: upload.status === "draft" ? "DRAFT" : "ACTIVE",
		cmRowIndex: newIndex,
	});

	upload.processedRows = (upload.processedRows || 0) + 1;
	await touchUpload(upload, userId);
	return { row, upload };
}

module.exports = {
	fillColumnSequence,
	copyFromOtherColumn,
	generateColumnText,
	fillColumnDate,
	replaceInColumn,
	applyColumnCellChanges,
	renameAssetSourceColumn,
	deleteAssetSourceColumn,
	cloneAssetSourceColumn,
	suggestCloneColumnName,
	reorderAssetSourceColumns,
	addAssetSourceRow,
	addAssetSourceColumn,
	cloneAssetSourceRow,
};
