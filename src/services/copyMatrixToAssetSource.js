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
	if (isAutoRowIdColumn(keyColumn)) {
		return true;
	}

	const cmRows = await CopyMatrixRow.find({ copyMatrixId })
		.select("rowData rowIndex")
		.sort({ rowIndex: 1 })
		.lean();

	const seen = new Set();

	for (const row of cmRows) {
		const key = normalizeKeyValue(row.rowData?.[keyColumn]);
		if (!key) return false;
		if (seen.has(key)) return false;
		seen.add(key);
	}

	return true;
}

async function resolveUniqueColumnWithFallback(
	copyMatrixId,
	requestedColumn,
	columns = []
) {
	const requested = requestedColumn?.trim() || AUTO_ROW_ID_COLUMN;

	if (isAutoRowIdColumn(requested)) {
		return {
			keyColumn: AUTO_ROW_ID_COLUMN,
			requestedColumn: requested,
			notice: null,
		};
	}

	if (await isColumnUnique(copyMatrixId, requested)) {
		return {
			keyColumn: requested,
			requestedColumn: requested,
			notice: null,
		};
	}

	return {
		keyColumn: AUTO_ROW_ID_COLUMN,
		requestedColumn: requested,
		notice: `Selected column "${requested}" is not unique. Using "${AUTO_ROW_ID_COLUMN}" as the unique column.`,
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

async function createAssetSourceFromCopyMatrix(matrix, userId, uniqueColumn) {
	const { keyColumn, notice } = await resolveUniqueColumnWithFallback(
		matrix._id,
		uniqueColumn,
		matrix.columns || []
	);

	const fileHash =
		matrix.fileHash ||
		`cm_${matrix._id}_${Date.now()}`;

	const upload = await AssetUpload.create({
		accountId: matrix.accountId,
		assetName: matrix.name,
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
			$set: { assetUploadId: upload._id },
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
		uniqueColumn || fullUpload.uniqueColumn,
		matrix.columns || []
	);
	const importStatus = fullUpload.status === "draft" ? "DRAFT" : "ACTIVE";

	fullUpload.uniqueColumn = keyColumn;

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
	resolveUniqueColumnWithFallback,
	isColumnUnique,
	AUTO_ROW_ID_COLUMN,
	resolveUniqueColumn,
};
