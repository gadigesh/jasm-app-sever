const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	omitRowIdColumn,
	injectRowIdIntoRowData,
	resolveUniqueColumn,
	isAutoRowIdColumn,
	normalizeCellText,
} = require("../constants/copyMatrix");

const BATCH_SIZE = 500;

function normalizeKeyValue(value) {
	return String(value ?? "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function buildPrimaryKey(rowData, keyColumn, rowIndex) {
	if (isAutoRowIdColumn(keyColumn)) {
		return String(rowIndex);
	}
	const key = normalizeKeyValue(rowData[keyColumn]);
	return key || `row_${rowIndex}`;
}

async function isColumnUnique(copyMatrixId, keyColumn) {
	const result = await analyzeColumnUniqueness(copyMatrixId, keyColumn);
	return result.unique;
}

/**
 * Analyze whether a column is unique across all copy-matrix rows.
 * Returns duplicate groups with row indexes / ids for UI highlighting.
 */
async function analyzeColumnUniqueness(
	copyMatrixId,
	keyColumn,
	rowUpdates = []
) {
	if (isAutoRowIdColumn(keyColumn)) {
		return {
			unique: true,
			column: keyColumn,
			duplicates: [],
			emptyRowIndexes: [],
			emptyRowIds: [],
			message: null,
		};
	}

	const cmRows = await CopyMatrixRow.find({ copyMatrixId })
		.select("_id rowData rowIndex")
		.sort({ rowIndex: 1 })
		.lean();
	const updatesById = new Map(
		(Array.isArray(rowUpdates) ? rowUpdates : [])
			.filter((item) => item?._id && item?.rowData)
			.map((item) => [String(item._id), item.rowData])
	);

	const byValue = new Map();
	const emptyRows = [];

	for (const row of cmRows) {
		const rowData = {
			...(row.rowData || {}),
			...(updatesById.get(String(row._id)) || {}),
		};
		const key = normalizeKeyValue(rowData[keyColumn]);
		if (!key) {
			emptyRows.push({
				rowId: String(row._id),
				rowIndex: row.rowIndex,
			});
			continue;
		}
		if (!byValue.has(key)) {
			byValue.set(key, []);
		}
		byValue.get(key).push({
			rowId: String(row._id),
			rowIndex: row.rowIndex,
		});
	}

	const duplicates = [];
	for (const [value, rows] of byValue.entries()) {
		if (rows.length > 1) {
			duplicates.push({
				value,
				count: rows.length,
				rowIndexes: rows.map((r) => r.rowIndex),
				rowIds: rows.map((r) => r.rowId),
			});
		}
	}

	const emptyRowIndexes = emptyRows.map((r) => r.rowIndex);
	const emptyRowIds = emptyRows.map((r) => r.rowId);

	// A unique column must contain one distinct, non-empty value per row.
	const unique = duplicates.length === 0 && emptyRows.length === 0;

	let message = null;
	if (duplicates.length > 0) {
		const samples = duplicates
			.slice(0, 3)
			.map(
				(d) =>
					`"${d.value}" (rows ${d.rowIndexes.join(", ")})`
			)
			.join("; ");
		message = `Duplicate values in "${keyColumn}": ${samples}${
			duplicates.length > 3
				? ` and ${duplicates.length - 3} more`
				: ""
		}`;
		if (emptyRows.length > 0) {
			message += `. Also ${emptyRows.length} empty cell${
				emptyRows.length === 1 ? "" : "s"
			}`;
		}
	} else if (emptyRows.length > 0) {
		message = `${emptyRows.length} empty cell${
			emptyRows.length === 1 ? "" : "s"
		} in "${keyColumn}". Fill every value before saving`;
	}

	return {
		unique,
		column: keyColumn,
		duplicates,
		emptyRowIndexes,
		emptyRowIds,
		message: unique ? null : message,
		emptyWarning: unique && emptyRows.length > 0 ? message : null,
	};
}

async function resolveUniqueColumnWithFallback() {
	return {
		keyColumn: AUTO_ROW_ID_COLUMN,
		requestedColumn: AUTO_ROW_ID_COLUMN,
		notice: null,
	};
}

async function insertRowsFromCopyMatrix(
	upload,
	matrix,
	keyColumn,
	importStatus = "DRAFT"
) {
	const fileHash =
		upload.fileHash ||
		matrix.fileHash ||
		`cm_${matrix._id}_${Date.now()}`;

	const cmRows = await CopyMatrixRow.find({ copyMatrixId: matrix._id }).sort({
		rowIndex: 1,
	});

	let inserted = 0;

	for (let i = 0; i < cmRows.length; i += BATCH_SIZE) {
		const chunk = cmRows.slice(i, i + BATCH_SIZE).map((row, offset) => {
			const rowData = row.rowData || {};
			const primaryKey = buildPrimaryKey(
				rowData,
				keyColumn,
				row.rowIndex || i + offset + 1
			);

			return {
				uploadId: upload._id,
				primaryKey,
				rowData,
				fileHash,
				isDeleted: false,
				importStatus,
				cmRowIndex: row.rowIndex,
				cmSourceData: snapshotCmSourceData(
					rowData,
					omitRowIdColumn(matrix.columns || [])
				),
			};
		});

		if (chunk.length) {
			const result = await AssetSource.insertMany(chunk, {
				ordered: false,
			});
			inserted += result.length;
		}
	}

	return inserted;
}

async function clearCopyMatrixAssetUploadLink(matrixId, assetUploadId = null) {
	const filter = { _id: matrixId };
	if (assetUploadId) {
		filter.assetUploadId = assetUploadId;
	}
	await CopyMatrix.updateOne(filter, { $unset: { assetUploadId: "" } });
}

async function createAssetSourceFromCopyMatrix(
	matrix,
	userId,
	uniqueColumn,
	assetName = null
) {
	const { keyColumn, notice } = await resolveUniqueColumnWithFallback();

	// Persist the chosen unique column on the copy matrix as well
	matrix.uniqueColumn = keyColumn;

	const resolvedAssetName =
		assetName === ""
			? "New asset source"
			: String(assetName || matrix.name || "").trim() || matrix.name;

	const fileHash =
		matrix.fileHash ||
		`cm_${matrix._id}_${Date.now()}`;

	const upload = await AssetUpload.create({
		accountId: matrix.accountId,
		assetName: resolvedAssetName,
		fileName: matrix.fileName || `${matrix.name}.csv`,
		inputType: matrix.inputType || "file",
		fileType: matrix.fileType || "csv",
		uniqueColumn: keyColumn,
		fileRef: matrix.fileRef || `copy-matrix://${matrix._id}`,
		fileHash,
		status: "draft",
		copyMatrixId: matrix._id,
		columns: ensureRowIdColumn(matrix.columns || []),
		uploadedBy: userId,
	});

	try {
		const inserted = await insertRowsFromCopyMatrix(
			upload,
			matrix,
			keyColumn,
			"DRAFT"
		);

		upload.processedRows = inserted;
		upload.message = `Draft asset source — ${inserted} rows from copy matrix`;
		await upload.save();

		await CopyMatrix.findByIdAndUpdate(matrix._id, {
			$set: {
				assetUploadId: upload._id,
				uniqueColumn: keyColumn,
			},
		});

		return { upload, uniqueColumnNotice: notice };
	} catch (err) {
		await AssetSource.deleteMany({ uploadId: upload._id });
		await AssetUpload.findByIdAndDelete(upload._id);
		throw err;
	}
}

async function resolveLinkedAssetUpload(matrix) {
	if (!matrix?._id) return null;

	const matrixId = matrix._id;

	if (matrix.assetUploadId) {
		const linked = await AssetUpload.findById(matrix.assetUploadId).select(
			"_id copyMatrixId columns"
		);
		if (linked && String(linked.copyMatrixId) === String(matrixId)) {
			return linked;
		}

		await clearCopyMatrixAssetUploadLink(matrixId, matrix.assetUploadId);
		matrix.assetUploadId = null;
	}

	const upload = await AssetUpload.findOne({
		$or: [
			{ copyMatrixId: matrixId },
			{ fileRef: `copy-matrix://${matrixId}` },
		],
	})
		.sort({ createdAt: -1 })
		.select("_id copyMatrixId columns");

	if (!upload) return null;

	if (String(matrix.assetUploadId || "") !== String(upload._id)) {
		await CopyMatrix.updateOne(
			{ _id: matrixId },
			{ $set: { assetUploadId: upload._id } }
		);
		matrix.assetUploadId = upload._id;
	}

	return upload;
}

function snapshotCmSourceData(cmRowData, columns = []) {
	const snap = {};
	for (const column of columns) {
		snap[column] = cmRowData?.[column] ?? "";
	}
	return snap;
}

function copyMatrixCellChanged(snapshot, cmRowData, column) {
	if (!snapshot || typeof snapshot !== "object") return false;
	return (
		normalizeCellText(snapshot?.[column]) !==
		normalizeCellText(cmRowData?.[column])
	);
}

function parseCopyMatrixIdFromUpload(upload) {
	if (upload?.copyMatrixId) return String(upload.copyMatrixId);
	const match = String(upload?.fileRef || "").match(/^copy-matrix:\/\/(.+)$/);
	return match?.[1] || null;
}

function rowIndexFromAsset(row) {
	const raw =
		row?.cmRowIndex ??
		row?.rowData?.[AUTO_ROW_ID_COLUMN] ??
		row?.primaryKey;
	const index = Number(raw);
	return Number.isFinite(index) && index > 0 ? index : null;
}

function mergeExistingAssetRow(
	existingRow,
	cmRowData,
	cmColumns,
	newColumns,
	asOnlyColumns,
	rowIndex
) {
	const merged = { ...(existingRow?.rowData || {}) };
	const snapshot = existingRow?.cmSourceData || null;
	let hasRowDataChange = false;

	for (const column of cmColumns) {
		const isNewColumn = newColumns.includes(column);
		const cmChanged = copyMatrixCellChanged(snapshot, cmRowData, column);
		if (!isNewColumn && !cmChanged) continue;
		const nextValue = cmRowData?.[column] ?? "";
		if (normalizeCellText(merged[column]) === normalizeCellText(nextValue)) {
			if (isNewColumn && merged[column] == null) {
				merged[column] = nextValue;
				hasRowDataChange = true;
			}
			continue;
		}
		merged[column] = nextValue;
		hasRowDataChange = true;
	}

	for (const column of asOnlyColumns) {
		if (merged[column] == null) merged[column] = "";
	}
	if (!merged[AUTO_ROW_ID_COLUMN]) {
		merged[AUTO_ROW_ID_COLUMN] = String(rowIndex);
	}

	return {
		rowData: merged,
		cmSourceData: snapshotCmSourceData(cmRowData, cmColumns),
		hasRowDataChange,
	};
}

function buildFreshAssetRow(cmRowData, asOnlyColumns, rowIndex) {
	const rowData = { ...(cmRowData || {}) };
	for (const column of asOnlyColumns) {
		if (rowData[column] == null) rowData[column] = "";
	}
	rowData[AUTO_ROW_ID_COLUMN] = String(rowIndex);
	return rowData;
}

function addedRowPatchMap(addedRowPatches) {
	const patches = new Map();
	for (const patch of addedRowPatches || []) {
		const rowIndex = Number(patch?.rowIndex);
		if (!Number.isFinite(rowIndex) || !patch?.rowData) continue;
		patches.set(rowIndex, patch.rowData);
	}
	return patches;
}

function applyAddedRowPatch(rowData, patch) {
	if (!patch || typeof patch !== "object") return rowData;
	const next = { ...rowData };
	for (const [key, value] of Object.entries(patch)) {
		if (
			!key ||
			key === AUTO_ROW_ID_COLUMN ||
			key === "_id" ||
			key === "rowIndex" ||
			key === "primaryKey"
		) {
			continue;
		}
		next[key] = value ?? "";
	}
	return next;
}

async function mergeCopyMatrixIntoAssetUpload(
	fullUpload,
	matrix,
	userId = null,
	options = {}
) {
	const { keyColumn, notice } = await resolveUniqueColumnWithFallback();
	const importStatus = fullUpload.status === "draft" ? "DRAFT" : "ACTIVE";
	const fileHash =
		fullUpload.fileHash ||
		matrix.fileHash ||
		`cm_${matrix._id}_${Date.now()}`;

	fullUpload.uniqueColumn = keyColumn;
	matrix.uniqueColumn = keyColumn;
	await matrix.save();

	const cmRows = await CopyMatrixRow.find({ copyMatrixId: matrix._id })
		.sort({ rowIndex: 1 })
		.lean();
	const existingRows = await AssetSource.find({
		uploadId: fullUpload._id,
	}).lean();

	const cmColumns = omitRowIdColumn(matrix.columns || []);
	const existingColumns = omitRowIdColumn(fullUpload.columns || []);
	const asOnlyColumns = existingColumns.filter(
		(column) => !cmColumns.includes(column)
	);
	const newColumns = cmColumns.filter(
		(column) => !existingColumns.includes(column)
	);
	const nextColumns = ensureRowIdColumn([...existingColumns, ...newColumns]);

	const addedPatches = addedRowPatchMap(options.addedRowPatches);
	const liveRows = existingRows.filter((row) => row.isDeleted !== true);
	const existingByIndex = new Map();
	for (const row of liveRows) {
		const index = rowIndexFromAsset(row);
		if (index != null && !existingByIndex.has(index)) {
			existingByIndex.set(index, row);
		}
	}

	const ops = [];
	let inserted = 0;

	for (const cmRow of cmRows) {
		const rowIndex = cmRow.rowIndex || existingByIndex.size + inserted + 1;
		const existing = existingByIndex.get(rowIndex);

		if (existing) {
			const merged = mergeExistingAssetRow(
				existing,
				cmRow.rowData,
				cmColumns,
				newColumns,
				asOnlyColumns,
				rowIndex
			);
			const snapshotUnchanged =
				JSON.stringify(existing.cmSourceData || {}) ===
				JSON.stringify(merged.cmSourceData || {});
			if (
				!merged.hasRowDataChange &&
				existing.cmSourceData &&
				snapshotUnchanged
			) {
				continue;
			}
			const primaryKey = buildPrimaryKey(
				merged.rowData,
				keyColumn,
				rowIndex
			);
			ops.push({
				updateOne: {
					filter: { _id: existing._id },
					update: {
						$set: {
							primaryKey,
							rowData: merged.rowData,
							fileHash,
							isDeleted: false,
							importStatus,
							cmRowIndex: rowIndex,
							cmSourceData: merged.cmSourceData,
						},
					},
				},
			});
			continue;
		}

		const rowData = applyAddedRowPatch(
			buildFreshAssetRow(cmRow.rowData, asOnlyColumns, rowIndex),
			addedPatches.get(Number(rowIndex))
		);
		const primaryKey = buildPrimaryKey(rowData, keyColumn, rowIndex);
		ops.push({
			insertOne: {
				document: {
					uploadId: fullUpload._id,
					primaryKey,
					rowData,
					fileHash,
					isDeleted: false,
					importStatus,
					cmRowIndex: rowIndex,
					cmSourceData: snapshotCmSourceData(cmRow.rowData, cmColumns),
				},
			},
		});
		inserted += 1;
	}

	if (ops.length > 0) {
		await AssetSource.bulkWrite(ops, { ordered: true });
	}

	fullUpload.columns = nextColumns;
	fullUpload.processedRows = liveRows.length + inserted;
	fullUpload.message = `Updated existing asset source — kept existing rows and added ${inserted} new row${
		inserted === 1 ? "" : "s"
	} from copy matrix`;
	if (userId) {
		fullUpload.uploadedBy = userId;
	}
	await fullUpload.save();

	return { upload: fullUpload, uniqueColumnNotice: notice };
}

async function applyAssetSourceRefreshDecision(
	fullUpload,
	userId,
	{ action, rowIndexes } = {}
) {
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

	const matrix = await CopyMatrix.findById(fullUpload.copyMatrixId);
	if (!matrix) {
		const err = new Error("Linked copy matrix was not found");
		err.statusCode = 404;
		throw err;
	}

	const { keyColumn } = await resolveUniqueColumnWithFallback();
	const cmRows = await CopyMatrixRow.find({ copyMatrixId: matrix._id })
		.sort({ rowIndex: 1 })
		.lean();
	const existingRows = await AssetSource.find({
		uploadId: fullUpload._id,
		isDeleted: { $ne: true },
	}).lean();
	const cmColumns = omitRowIdColumn(matrix.columns || []);
	const existingColumns = omitRowIdColumn(fullUpload.columns || []);
	const asOnlyColumns = existingColumns.filter(
		(column) => !cmColumns.includes(column)
	);
	const newColumns = cmColumns.filter(
		(column) => !existingColumns.includes(column)
	);
	const existingByIndex = new Map();
	for (const row of existingRows) {
		const index = rowIndexFromAsset(row);
		if (index != null && !existingByIndex.has(index)) {
			existingByIndex.set(index, row);
		}
	}

	const cmIndexSet = new Set(
		cmRows
			.map((row) => Number(row.rowIndex))
			.filter((index) => Number.isFinite(index) && index > 0)
	);
	const fileHash =
		fullUpload.fileHash || matrix.fileHash || `cm_${matrix._id}_${Date.now()}`;
	const importStatus = fullUpload.status === "draft" ? "DRAFT" : "ACTIVE";
	const ops = [];
	let inserted = 0;
	let removed = 0;
	let approvedNewColumn = false;

	for (const cmRow of cmRows) {
		const rowIndex = Number(cmRow.rowIndex);
		if (!indexes.has(rowIndex)) continue;
		const existing = existingByIndex.get(rowIndex);

		if (decision === "reject") {
			if (!existing) continue;
			ops.push({
				updateOne: {
					filter: { _id: existing._id },
					update: {
						$set: {
							cmRowIndex: rowIndex,
							cmSourceData: snapshotCmSourceData(
								cmRow.rowData,
								cmColumns
							),
						},
					},
				},
			});
			continue;
		}

		if (existing) {
			const merged = mergeExistingAssetRow(
				existing,
				cmRow.rowData,
				cmColumns,
				newColumns,
				asOnlyColumns,
				rowIndex
			);
			if (newColumns.some((column) => column in (cmRow.rowData || {}))) {
				approvedNewColumn = true;
			}
			ops.push({
				updateOne: {
					filter: { _id: existing._id },
					update: {
						$set: {
							primaryKey: buildPrimaryKey(
								merged.rowData,
								keyColumn,
								rowIndex
							),
							rowData: merged.rowData,
							fileHash,
							isDeleted: false,
							importStatus,
							cmRowIndex: rowIndex,
							cmSourceData: merged.cmSourceData,
						},
					},
				},
			});
			continue;
		}

		const rowData = buildFreshAssetRow(
			cmRow.rowData,
			asOnlyColumns,
			rowIndex
		);
		approvedNewColumn = approvedNewColumn || newColumns.length > 0;
		ops.push({
			insertOne: {
				document: {
					uploadId: fullUpload._id,
					primaryKey: buildPrimaryKey(rowData, keyColumn, rowIndex),
					rowData,
					fileHash,
					isDeleted: false,
					importStatus,
					cmRowIndex: rowIndex,
					cmSourceData: snapshotCmSourceData(cmRow.rowData, cmColumns),
				},
			},
		});
		inserted += 1;
	}

	for (const existing of existingRows) {
		const rowIndex = rowIndexFromAsset(existing);
		if (rowIndex == null || !indexes.has(rowIndex)) continue;
		if (cmIndexSet.has(rowIndex) || !existing.cmSourceData) continue;
		if (decision === "approve") {
			ops.push({
				updateOne: {
					filter: { _id: existing._id },
					update: { $set: { isDeleted: true } },
				},
			});
			removed += 1;
			continue;
		}
		ops.push({
			updateOne: {
				filter: { _id: existing._id },
				update: { $unset: { cmSourceData: "" } },
			},
		});
	}

	if (ops.length > 0) {
		await AssetSource.bulkWrite(ops, { ordered: true });
	}

	if (decision === "approve" && approvedNewColumn) {
		fullUpload.columns = ensureRowIdColumn([
			...existingColumns,
			...newColumns,
		]);
	}
	fullUpload.processedRows = Math.max(
		0,
		existingRows.length + inserted - removed
	);
	if (userId) fullUpload.uploadedBy = userId;
	await fullUpload.save();
	return fullUpload;
}

async function syncAssetSourceFromCopyMatrix(
	matrixId,
	userId = null,
	uniqueColumn = null,
	options = {}
) {
	const matrix = await CopyMatrix.findById(matrixId);
	if (!matrix) return null;

	let fullUpload = null;
	if (options.uploadId) {
		fullUpload = await AssetUpload.findById(options.uploadId);
		if (!fullUpload) return null;
		const linkedId = parseCopyMatrixIdFromUpload(fullUpload);
		const reverseLinked =
			String(matrix.assetUploadId || "") === String(fullUpload._id);
		if (
			String(linkedId || "") !== String(matrixId) &&
			!reverseLinked
		) {
			const err = new Error(
				"This asset source is not linked to that copy matrix"
			);
			err.statusCode = 400;
			throw err;
		}
		if (!fullUpload.copyMatrixId) {
			fullUpload.copyMatrixId = matrix._id;
		}
	} else {
		const upload = await resolveLinkedAssetUpload(matrix);
		if (!upload) return null;
		fullUpload = await AssetUpload.findById(upload._id);
	}

	if (!fullUpload) return null;

	return mergeCopyMatrixIntoAssetUpload(fullUpload, matrix, userId, options);
}

module.exports = {
	createAssetSourceFromCopyMatrix,
	syncAssetSourceFromCopyMatrix,
	applyAssetSourceRefreshDecision,
	mergeCopyMatrixIntoAssetUpload,
	resolveLinkedAssetUpload,
	clearCopyMatrixAssetUploadLink,
	resolveUniqueColumnWithFallback,
	isColumnUnique,
	analyzeColumnUniqueness,
	parseCopyMatrixIdFromUpload,
	rowIndexFromAsset,
	snapshotCmSourceData,
	copyMatrixCellChanged,
	AUTO_ROW_ID_COLUMN,
	resolveUniqueColumn,
};
