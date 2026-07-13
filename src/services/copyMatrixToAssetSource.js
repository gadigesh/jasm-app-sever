const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	injectRowIdIntoRowData,
	resolveUniqueColumn,
	isAutoRowIdColumn,
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
async function analyzeColumnUniqueness(copyMatrixId, keyColumn) {
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

	const byValue = new Map();
	const emptyRows = [];

	for (const row of cmRows) {
		const key = normalizeKeyValue(row.rowData?.[keyColumn]);
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

	// Only duplicate non-empty values block uniqueness.
	// Empty cells are allowed — primary keys fall back to row_${rowIndex}.
	const unique = duplicates.length === 0;

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
		} in "${keyColumn}" — those rows will use a row-index key`;
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

async function resolveUniqueColumnWithFallback(
	copyMatrixId,
	requestedColumn,
	columns = []
) {
	const requested =
		requestedColumn?.trim() ||
		resolveUniqueColumn(null, columns) ||
		AUTO_ROW_ID_COLUMN;

	if (isAutoRowIdColumn(requested)) {
		return {
			keyColumn: AUTO_ROW_ID_COLUMN,
			requestedColumn: requested,
			notice: null,
		};
	}

	const analysis = await analyzeColumnUniqueness(copyMatrixId, requested);
	if (analysis.unique) {
		return {
			keyColumn: requested,
			requestedColumn: requested,
			notice: analysis.emptyWarning || null,
		};
	}

	// Do not silently switch to Row ID — keep the CM selection and surface the error.
	const err = new Error(
		analysis.message ||
			`"${requested}" has duplicate values. Fix them or pick another unique column.`
	);
	err.statusCode = 400;
	err.code = "UNIQUE_COLUMN_DUPLICATES";
	err.duplicates = analysis.duplicates;
	err.emptyRowIndexes = analysis.emptyRowIndexes;
	throw err;
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
	const requested =
		uniqueColumn?.trim() ||
		matrix.uniqueColumn?.trim() ||
		null;

	const { keyColumn, notice } = await resolveUniqueColumnWithFallback(
		matrix._id,
		requested,
		matrix.columns || []
	);

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
			"_id copyMatrixId"
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
		.select("_id copyMatrixId");

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

async function syncAssetSourceFromCopyMatrix(
	matrixId,
	userId = null,
	uniqueColumn = null
) {
	const matrix = await CopyMatrix.findById(matrixId);
	if (!matrix) return null;

	const upload = await resolveLinkedAssetUpload(matrix);
	if (!upload) return null;

	const fullUpload = await AssetUpload.findById(upload._id);
	if (!fullUpload) return null;

	const { keyColumn, notice } = await resolveUniqueColumnWithFallback(
		matrixId,
		uniqueColumn || matrix.uniqueColumn || fullUpload.uniqueColumn,
		matrix.columns || []
	);
	const importStatus = fullUpload.status === "draft" ? "DRAFT" : "ACTIVE";

	fullUpload.uniqueColumn = keyColumn;
	matrix.uniqueColumn = keyColumn;
	await matrix.save();

	await AssetSource.deleteMany({ uploadId: fullUpload._id });

	const inserted = await insertRowsFromCopyMatrix(
		fullUpload,
		matrix,
		keyColumn,
		importStatus
	);

	fullUpload.columns = ensureRowIdColumn(matrix.columns || []);
	fullUpload.processedRows = inserted;
	fullUpload.message = `Synced ${inserted} rows from copy matrix`;
	if (userId) {
		fullUpload.uploadedBy = userId;
	}
	await fullUpload.save();

	return { upload: fullUpload, uniqueColumnNotice: notice };
}

module.exports = {
	createAssetSourceFromCopyMatrix,
	syncAssetSourceFromCopyMatrix,
	resolveLinkedAssetUpload,
	clearCopyMatrixAssetUploadLink,
	resolveUniqueColumnWithFallback,
	isColumnUnique,
	analyzeColumnUniqueness,
	AUTO_ROW_ID_COLUMN,
	resolveUniqueColumn,
};
