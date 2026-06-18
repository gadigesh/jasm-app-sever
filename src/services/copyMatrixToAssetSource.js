const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");

const BATCH_SIZE = 500;

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
			const primaryKey = String(
				rowData[keyColumn] || row.rowIndex || i + offset + 1
			).trim();

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
			await AssetSource.insertMany(chunk, { ordered: false });
			inserted += chunk.length;
		}
	}

	return inserted;
}

async function createAssetSourceFromCopyMatrix(matrix, userId, uniqueColumn) {
	const keyColumn =
		uniqueColumn?.trim() ||
		(matrix.columns && matrix.columns[0]) ||
		"id";

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
		columns: matrix.columns || [],
		uploadedBy: userId,
	});

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

	return upload;
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

async function syncAssetSourceFromCopyMatrix(matrixId, userId = null) {
	const matrix = await CopyMatrix.findById(matrixId);
	if (!matrix) return null;

	const upload = await resolveLinkedAssetUpload(matrix);
	if (!upload) return null;

	const fullUpload = await AssetUpload.findById(upload._id);
	if (!fullUpload) return null;

	const keyColumn = fullUpload.uniqueColumn || matrix.columns?.[0] || "id";
	const importStatus = fullUpload.status === "draft" ? "DRAFT" : "ACTIVE";

	await AssetSource.deleteMany({ uploadId: fullUpload._id });

	const inserted = await insertRowsFromCopyMatrix(
		fullUpload,
		matrix,
		keyColumn,
		importStatus
	);

	fullUpload.columns = matrix.columns || [];
	fullUpload.processedRows = inserted;
	fullUpload.message = `Synced ${inserted} rows from copy matrix`;
	if (userId) {
		fullUpload.uploadedBy = userId;
	}
	await fullUpload.save();

	return fullUpload;
}

module.exports = {
	createAssetSourceFromCopyMatrix,
	syncAssetSourceFromCopyMatrix,
	resolveLinkedAssetUpload,
};
