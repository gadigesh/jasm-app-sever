const mongoose = require("mongoose");
const path = require("path");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const {
	AUTO_ROW_ID_COLUMN,
	isAutoRowIdColumn,
	normalizeCellText,
} = require("../constants/copyMatrix");
const {
	buildUpdateImagesAssetIndex,
	resolveAssetUrlByName,
	resolveAssetUrlWithFallback,
} = require("./mindshareAssetLibrary");

function normalizeSearchQuery(value) {
	if (value == null) return "";
	return String(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\r\n\u000b\u000c\u0085\u2028\u2029\t]+/g, " ")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
}

function normalizedColumnKey(value) {
	return normalizeSearchQuery(value).trim().toLowerCase();
}

function isImageTargetColumn(value) {
	const column = normalizeSearchQuery(value).trim();
	const hasImageName =
		/image/i.test(column) && !/^image$/i.test(column);
	const hasSizedBackground =
		/(?:^|[^a-z0-9])bg[12](?:$|[^a-z0-9])/i.test(column) &&
		/\d{2,5}\s*(?:x|×|by|[-_])\s*\d{2,5}/i.test(column);
	return hasImageName || hasSizedBackground;
}

function imageReferenceCandidates(value) {
	const raw = normalizeCellText(value).trim();
	if (!raw) return [];

	const candidates = [raw.replace(/\s*\/\s*/g, "/")];
	try {
		const parsed = new URL(raw);
		if (parsed.pathname) {
			candidates.push(
				decodeURIComponent(parsed.pathname)
					.replace(/^\/+|\/+$/g, "")
					.replace(/\s*\/\s*/g, "/")
			);
		}
	} catch {
		// The reference is normally a filename/path, not a URL.
	}

	// A reference cell can contain labels or more than one image token
	// (for example, "BG1 image1"). Try each BG/image path token as well.
	for (const match of raw.matchAll(
		/(?:bg|image)[a-z0-9._-]*(?:\s*\/\s*[a-z0-9._-]+)*/gi
	)) {
		candidates.push(match[0].replace(/\s*\/\s*/g, "/"));
	}

	return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function assertColumnExists(upload, column) {
	const columns = upload.columns || [];
	if (!column || !columns.includes(column)) {
		const err = new Error("Column not found");
		err.statusCode = 400;
		throw err;
	}
}

async function assertColumnNotSynced(upload, column) {
	if (!upload.copyMatrixId) return;
	const matrix = await CopyMatrix.findById(upload.copyMatrixId)
		.select("columns")
		.lean();
	if ((matrix?.columns || []).includes(column)) {
		const err = new Error(
			`"${column}" cannot be renamed or deleted because it is synced with a copy matrix`
		);
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

async function deleteAssetSourceRow(upload, rowId, userId) {
	const result = await AssetSource.deleteOne({
		_id: rowId,
		uploadId: upload._id,
	});
	if (!result.deletedCount) {
		const err = new Error("Asset source row not found");
		err.statusCode = 404;
		throw err;
	}
	await touchUpload(upload, userId);
	return { deleted: 1 };
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
		const sourceColumn = match[1].trim();
		if (sourceColumn.toUpperCase() === "SN") continue;
		assertColumnExists(upload, sourceColumn);
	}

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) return { updated: 0 };

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row, index) => {
		const value = normalizeCellText(
			customTemplate.replace(
				/\[([^\[\]}]+)(?:\]|\})/g,
				(_match, column) =>
					column.trim().toUpperCase() === "SN"
						? String(index + 1)
						: normalizeCellText(row.rowData?.[column.trim()])
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

async function renameAssetSourceColumn(upload, oldName, newName, userId) {
	await assertColumnNotSynced(upload, oldName);
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
	await assertColumnNotSynced(upload, column);
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

	let sourceIndex = source.cmRowIndex;
	if (sourceIndex == null) {
		const orderedRows = await AssetSource.find({
			uploadId: upload._id,
			isDeleted: false,
		})
			.sort({ primaryKey: 1 })
			.select("_id")
			.lean();
		if (orderedRows.length) {
			await AssetSource.bulkWrite(
				orderedRows.map((existing, index) => ({
					updateOne: {
						filter: { _id: existing._id },
						update: { $set: { cmRowIndex: index + 1 } },
					},
				})),
				{ ordered: false }
			);
		}
		sourceIndex =
			orderedRows.findIndex(
				(row) => String(row._id) === String(source._id)
			) + 1;
	}
	const rowsToShift = await AssetSource.find({
		uploadId: upload._id,
		isDeleted: false,
		cmRowIndex: { $gt: sourceIndex },
	})
		.sort({ cmRowIndex: -1 })
		.select("_id cmRowIndex rowData primaryKey")
		.lean();

	const uniqueColumn = upload.uniqueColumn;
	const hasRowIdColumn = (upload.columns || []).includes(
		AUTO_ROW_ID_COLUMN
	);
	if (rowsToShift.length) {
		await AssetSource.bulkWrite(
			rowsToShift.map((existing) => {
				const nextIndex = (existing.cmRowIndex ?? 0) + 1;
				const setFields = { cmRowIndex: nextIndex };
				if (hasRowIdColumn) {
					setFields.rowData = {
						...(existing.rowData || {}),
						[AUTO_ROW_ID_COLUMN]: String(nextIndex),
					};
					if (isAutoRowIdColumn(uniqueColumn)) {
						setFields.primaryKey = String(nextIndex);
					}
				}
				return {
					updateOne: {
						filter: { _id: existing._id },
						update: { $set: setFields },
					},
				};
			}),
			{ ordered: true }
		);
	}

	const newIndex = sourceIndex + 1;
	const rowData = { ...(source.rowData || {}) };
	if (hasRowIdColumn) {
		rowData[AUTO_ROW_ID_COLUMN] = String(newIndex);
	}

	let primaryKey = `row_${newIndex}`;
	if (uniqueColumn && !isAutoRowIdColumn(uniqueColumn)) {
		const base = normalizeCellText(rowData[uniqueColumn]);
		const existingRows = await AssetSource.find({
			uploadId: upload._id,
			isDeleted: false,
		})
			.select("rowData")
			.lean();
		const existingValues = new Set(
			existingRows
				.map((existing) =>
					normalizeCellText(existing.rowData?.[uniqueColumn])
				)
				.filter(Boolean)
		);
		const baseValue = base || "value";
		primaryKey = `${baseValue}_copy`;
		let suffix = 2;
		while (existingValues.has(primaryKey)) {
			primaryKey = `${baseValue}_copy_${suffix}`;
			suffix += 1;
		}
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

async function updateColumnImages(
	upload,
	targetColumn,
	prefixColumn,
	rowIds,
	userId,
	template,
	folder,
	options = {}
) {
	const dryRun = Boolean(options.dryRun);
	const rowSnapshots = Array.isArray(options.rowSnapshots)
		? options.rowSnapshots
		: null;
	const rowOverrides = Array.isArray(options.rowOverrides)
		? options.rowOverrides
		: null;

	const customTemplate = normalizeSearchQuery(
		template ||
			(prefixColumn ? `[${String(prefixColumn).trim()}]` : "")
	);
	if (!normalizeCellText(customTemplate)) {
		const err = new Error("Add a format");
		err.statusCode = 400;
		throw err;
	}

	for (const match of customTemplate.matchAll(/\[([^\[\]]+)\]/g)) {
		const sourceColumn = match[1].trim();
		if (sourceColumn.toUpperCase() === "SN") continue;
		assertColumnExists(upload, sourceColumn);
	}

	const sourceColumns = new Set(
		[...customTemplate.matchAll(/\[([^\[\]]+)\]/g)].map((match) =>
			normalizedColumnKey(match[1])
		)
	);
	const hasNamedTargetSelection =
		Array.isArray(options.targetColumns) &&
		options.targetColumns.length > 0;
	const requestedTargetColumns =
		hasNamedTargetSelection
			? options.targetColumns
			: [targetColumn];
	const targetColumns = [
		...new Set(
			requestedTargetColumns
				.map((column) => String(column || "").trim())
				.filter(
					(column) =>
						column &&
						!sourceColumns.has(normalizedColumnKey(column)) &&
						(!hasNamedTargetSelection ||
							isImageTargetColumn(column))
				)
		),
	];
	if (targetColumns.length === 0) {
		const err = new Error(
			"Select at least one image or sized BG column to receive the URLs"
		);
		err.statusCode = 400;
		throw err;
	}
	for (const column of targetColumns) {
		assertColumnExists(upload, column);
		assertEditableDataColumn(column);
	}

	let rows;
	if (rowSnapshots?.length) {
		rows = rowSnapshots.map((r, i) => ({
			_id: r._id || r.rowId,
			rowIndex: r.rowIndex ?? i + 1,
			rowData:
				r.rowData && typeof r.rowData === "object" ? r.rowData : {},
		}));
	} else {
		rows = await loadTargetRows(upload._id, rowIds);
	}

	if (rowOverrides?.length) {
		const overridesById = new Map(
			rowOverrides.map((row) => [
				String(row._id || row.rowId),
				row.rowData && typeof row.rowData === "object"
					? row.rowData
					: {},
			])
		);
		for (const row of rows) {
			const override = overridesById.get(String(row._id));
			if (override) {
				row.rowData = { ...(row.rowData || {}), ...override };
			}
		}
	}

	if (!rows.length) {
		return {
			updated: 0,
			matched: 0,
			missing: 0,
			column: targetColumns.length === 1 ? targetColumns[0] : null,
			columns: targetColumns,
			updates: [],
		};
	}

	const uniqueColumn = upload.uniqueColumn;
	const folderPath = String(folder || "").trim();
	const {
		index,
		librarySize,
		folder: resolvedFolder,
		scope,
	} = await buildUpdateImagesAssetIndex(upload.accountId, folderPath);

	let matched = 0;
	let missing = 0;
	const ops = [];
	const updates = [];
	const urlCache = new Map();
	const fallbackUrlCache = new Map();
	const sizePattern =
		/(?:^|[^a-z0-9])(\d{2,5})\s*(?:x|×|by|[-_])\s*(\d{2,5})(?=$|[^0-9])/i;
	const assetNameCandidatesForTarget = (assetName, column) => {
		const sizeMatch = String(column || "").match(sizePattern);
		if (!sizeMatch) return [assetName];

		const width = sizeMatch[1];
		const height = sizeMatch[2];
		const targetName = String(column || "")
			.trim()
			.replace(/\s+/g, "_");
		const targetStem = String(column || "")
			.replace(sizePattern, "")
			.replace(/[_\-\s]+$/g, "")
			.trim();
		const backgroundMatch = String(column || "").match(
			/(?:^|[^a-z0-9])(bg[12])(?=$|[^a-z0-9])/i
		);
		const backgroundStem = backgroundMatch?.[1] || "";
		const targetStems = [
			...new Set([targetStem, backgroundStem].filter(Boolean)),
		];
		const extension = path.extname(assetName);
		const baseName = extension
			? assetName.slice(0, -extension.length)
			: assetName;
		const sourceSizeMatch = baseName.match(sizePattern);
		const dimensions = [
			`${width}x${height}`,
			`${width}_${height}`,
			`${width}-${height}`,
		];
		const sourceCandidates = [];
		const genericCandidates = [];
		const targetCandidates = [];
		const targetUnsizedCandidates = [];

		if (sourceSizeMatch) {
			const sourceSize = `${sourceSizeMatch[1]}x${sourceSizeMatch[2]}`;
			if (sourceSize === `${width}x${height}`) {
				sourceCandidates.push(assetName);
			} else {
				const prefix = sourceSizeMatch[0].match(/^[^0-9]*/)?.[0] || "";
				for (const dimension of dimensions) {
					sourceCandidates.push(
						`${baseName.slice(
							0,
							sourceSizeMatch.index
						)}${prefix}${dimension}${baseName.slice(
							sourceSizeMatch.index + sourceSizeMatch[0].length
						)}${extension}`
					);
				}
			}
		}

		const versionSuffix = baseName.match(/^(.*?)([_-]r\d+)$/i);
		for (const dimension of dimensions) {
			for (const separator of ["_", "-", ""]) {
				genericCandidates.push(
					`${baseName}${separator}${dimension}${extension}`
				);
				if (targetName) {
					const targetNames = [targetName];
					if (backgroundStem) {
						targetNames.push(
							`${backgroundStem}${separator}${dimension}`
						);
					}
					for (const targetPart of targetNames) {
						targetCandidates.push(
							`${baseName}${separator}${targetPart}${extension}`
						);
						targetCandidates.push(
							`${targetPart}${separator}${baseName}${extension}`
						);
					}
				}
				for (const targetPart of targetStems) {
					// Support assets stored under BG folders, as well as
					// filenames that combine the reference image and target
					// column (for example image1_bg2_300x600).
					targetCandidates.push(
						`${targetPart}/${baseName}${separator}${dimension}${extension}`
					);
					targetCandidates.push(
						`${baseName}/${targetPart}${separator}${dimension}${extension}`
					);
					targetCandidates.push(
						`${baseName}${separator}${targetPart}${separator}${dimension}${extension}`
					);
					targetCandidates.push(
						`${targetPart}${separator}${baseName}${separator}${dimension}${extension}`
					);
					if (/^bg[12]$/i.test(targetPart)) {
						// Some libraries encode the BG target in the folder
						// (`bg2/.../image1`) while the sheet column carries the
						// size. Prefer this target-specific path over a generic
						// unsized basename.
						targetUnsizedCandidates.push(
							`${targetPart}/${baseName}${extension}`
						);
						targetUnsizedCandidates.push(
							`${baseName}/${targetPart}${extension}`
						);
					}
				}
				if (versionSuffix) {
					genericCandidates.push(
						`${versionSuffix[1]}${separator}${dimension}${versionSuffix[2]}${extension}`
					);
				}
			}
		}

		const targetIsSizedBackground = /^bg[12]$/i.test(backgroundStem);
		const orderedCandidates =
			targetIsSizedBackground && !String(assetName).includes("/")
				? [
						...targetCandidates,
						...sourceCandidates,
						...genericCandidates,
						...targetUnsizedCandidates,
				  ]
				: [
						...sourceCandidates,
						...genericCandidates,
						...targetCandidates,
						...targetUnsizedCandidates,
				  ];
		return [...new Set(orderedCandidates)];
	};

	for (let indexInSelection = 0; indexInSelection < rows.length; indexInSelection += 1) {
		const row = rows[indexInSelection];
		const assetName = normalizeCellText(
			customTemplate.replace(
				/\[([^\[\]]+)\]/g,
				(_match, column) =>
					column.trim().toUpperCase() === "SN"
						? String(indexInSelection + 1)
						: normalizeCellText(row.rowData?.[column.trim()])
			)
		);
		if (!assetName) {
			missing += targetColumns.length;
			continue;
		}
		const referenceCandidates = imageReferenceCandidates(assetName);

		for (const column of targetColumns) {
			const columnCandidates = imageReferenceCandidates(column);
			const referencePathCandidates = referenceCandidates.filter((candidate) =>
				candidate.includes("/")
			);
			const referenceNameCandidates = referenceCandidates.filter(
				(candidate) => !candidate.includes("/")
			);
			const columnPathCandidates = columnCandidates.filter((candidate) =>
				candidate.includes("/")
			);
			const columnNameCandidates = columnCandidates.filter(
				(candidate) => !candidate.includes("/")
			);
			const candidates = [
				...new Set(
					[
						// A complete frame path is authoritative.
						...referencePathCandidates.flatMap((reference) =>
							assetNameCandidatesForTarget(reference, column)
						),
						// If the reference only contains `image1`, use the
						// target column (`bg1`/`bg2`/`image1`) to select the
						// correct frame before trying a generic basename.
						...referenceCandidates.flatMap((reference) =>
							[
								...columnPathCandidates,
								...columnNameCandidates,
							].flatMap((columnPart) =>
								[
									...assetNameCandidatesForTarget(
										`${reference}/${columnPart}`,
										column
									),
									...assetNameCandidatesForTarget(
										`${columnPart}/${reference}`,
										column
									),
								]
							)
						),
						...referenceNameCandidates.flatMap((reference) =>
							assetNameCandidatesForTarget(reference, column)
						),
					]
				),
			];
			const cacheKey = `${column}\u0000${candidates.join("\u0000")}`;
			let url = urlCache.get(cacheKey);
			if (url === undefined) {
				url = "";
				for (const candidate of candidates) {
					url = resolveAssetUrlByName(index, candidate);
					if (url) break;
				}
				// The recursive index normally resolves every asset. Keep the
				// remote fallback as a compatibility path, but only try the
				// most-specific candidates and cache each request so a large
				// sheet does not issue one network call per cell.
				if (!url) {
					for (const candidate of candidates.slice(0, 4)) {
						let fallbackPromise = fallbackUrlCache.get(candidate);
						if (!fallbackPromise) {
							fallbackPromise = resolveAssetUrlWithFallback(
								upload.accountId,
								index,
								candidate
							);
							fallbackUrlCache.set(candidate, fallbackPromise);
						}
						url = await fallbackPromise;
						if (url) break;
					}
				}
				urlCache.set(cacheKey, url || "");
			}
			if (!url) {
				missing += 1;
				continue;
			}

			matched += 1;
			updates.push({
				rowId: String(row._id),
				column,
				url,
			});
			if (!dryRun) {
				ops.push({
					updateOne: {
						filter: { _id: row._id },
						update: {
							$set: cellSetFields(column, url, uniqueColumn),
						},
					},
				});
			}
		}
	}

	if (!dryRun && ops.length) {
		await AssetSource.bulkWrite(ops);
		await touchUpload(upload, userId);
	}

	return {
		updated: dryRun ? updates.length : ops.length,
		matched,
		missing,
		librarySize,
		folder: resolvedFolder,
		scope,
		column: targetColumns.length === 1 ? targetColumns[0] : null,
		columns: targetColumns,
		updates,
		dryRun,
	};
}

/** Write one CDN URL into targetColumn for the given rows (selection upload). */
async function fillColumnWithCdnUrl(
	upload,
	targetColumn,
	rowIds,
	cdnUrl,
	userId
) {
	assertColumnExists(upload, targetColumn);
	assertEditableDataColumn(targetColumn);

	const url = String(cdnUrl || "").trim();
	if (!url) {
		const err = new Error("Uploaded image CDN URL was not returned");
		err.statusCode = 502;
		throw err;
	}
	if (!Array.isArray(rowIds) || rowIds.length === 0) {
		const err = new Error("Select at least one row");
		err.statusCode = 400;
		throw err;
	}

	const rows = await loadTargetRows(upload._id, rowIds);
	if (!rows.length) {
		const err = new Error("Selected rows were not found");
		err.statusCode = 400;
		throw err;
	}

	const uniqueColumn = upload.uniqueColumn;
	const ops = rows.map((row) => {
		const nextRowData = {
			...(row.rowData && typeof row.rowData === "object"
				? row.rowData
				: {}),
			[targetColumn]: normalizeCellText(url),
		};
		const fields = { rowData: nextRowData };
		if (uniqueColumn && targetColumn === uniqueColumn) {
			fields.primaryKey = normalizeCellText(url);
		}
		return {
			updateOne: {
				filter: { _id: row._id },
				update: { $set: fields },
			},
		};
	});

	await AssetSource.bulkWrite(ops);
	await touchUpload(upload, userId);

	return {
		updated: ops.length,
		column: targetColumn,
		cdnUrl: url,
	};
}

module.exports = {
	fillColumnSequence,
	copyFromOtherColumn,
	deleteAssetSourceRow,
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
	updateColumnImages,
	fillColumnWithCdnUrl,
};
