const mongoose = require("mongoose");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");
const {
	normalizeCellText,
	omitRowIdColumn,
	AUTO_ROW_ID_COLUMN,
} = require("../constants/copyMatrix");
const {
	parseCopyMatrixIdFromUpload,
	rowIndexFromAsset,
	syncAssetSourceFromCopyMatrix,
	copyMatrixCellChanged,
} = require("./copyMatrixToAssetSource");

function cellText(rowData, column) {
	return normalizeCellText(rowData?.[column]);
}

function toObjectIds(ids = []) {
	return [...new Set(ids.filter(Boolean).map(String))]
		.filter((id) => mongoose.Types.ObjectId.isValid(id))
		.map((id) => new mongoose.Types.ObjectId(id));
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
	const addedRowIndexes = new Set();
	const removedRowIndexes = new Set();

	for (const change of changes) {
		if (change.rowIndex != null) {
			rowIndexes.add(change.rowIndex);
		}
		if (change.status === "Added") {
			addedRowIndexes.add(change.rowIndex);
		}
		if (change.status === "Removed") {
			removedRowIndexes.add(change.rowIndex);
		}
		if (
			change.status !== "Removed" &&
			change.column &&
			change.column !== "Entire row"
		) {
			cells.push({
				rowIndex: change.rowIndex,
				column: change.column,
				rowId: change.rowId || null,
			});
		}
	}

	return {
		cells,
		rowIndexes: [...rowIndexes],
		addedRowIndexes: [...addedRowIndexes],
		removedRowIndexes: [...removedRowIndexes],
	};
}

function linkedCopyMatrixId(upload) {
	return parseCopyMatrixIdFromUpload(upload);
}

function compareColumns(matrixColumns, cmRows) {
	const cols = new Set(omitRowIdColumn(matrixColumns || []));
	for (const row of cmRows || []) {
		for (const key of Object.keys(row?.rowData || {})) {
			if (key && key !== AUTO_ROW_ID_COLUMN) cols.add(key);
		}
	}
	return [...cols];
}

async function resolveLinkedMatrixIdsByUpload(assets = []) {
	const linkedIds = new Map();
	const missingUploadIds = [];

	for (const asset of assets) {
		const matrixId = parseCopyMatrixIdFromUpload(asset);
		if (matrixId) {
			linkedIds.set(String(asset._id), String(matrixId));
		} else if (asset?._id) {
			missingUploadIds.push(asset._id);
		}
	}

	if (missingUploadIds.length > 0) {
		const reverseLinks = await CopyMatrix.find({
			assetUploadId: { $in: missingUploadIds },
		})
			.select("_id assetUploadId")
			.lean();
		for (const matrix of reverseLinks) {
			const uploadId = String(matrix.assetUploadId);
			if (!linkedIds.has(uploadId)) {
				linkedIds.set(uploadId, String(matrix._id));
			}
		}
	}

	return linkedIds;
}

async function resolveCopyMatrixForUpload(upload) {
	const matrixId = parseCopyMatrixIdFromUpload(upload);
	if (matrixId) {
		const matrix = await CopyMatrix.findById(matrixId);
		if (matrix) return matrix;
	}
	if (upload?._id) {
		return CopyMatrix.findOne({ assetUploadId: upload._id });
	}
	return null;
}

function emptyChangeCounts() {
	return { added: 0, modified: 0, removed: 0, newColumns: 0, total: 0 };
}

function countChangedRows(cmRows, asRows, cmColumns, asColumns = []) {
	const asByIndex = new Map();
	for (const row of asRows || []) {
		const index = rowIndexFromAsset(row);
		if (index != null && !asByIndex.has(index)) {
			asByIndex.set(index, row);
		}
	}

	const existingColSet = new Set(asColumns || []);
	const newColumns = (cmColumns || []).filter(
		(column) => !existingColSet.has(column)
	);
	const usePositionalFallback =
		asByIndex.size === 0 && (asRows || []).length > 0;
	let added = 0;
	let modified = 0;
	const cmIndexSet = new Set();

	for (let i = 0; i < (cmRows || []).length; i++) {
		const cmRow = cmRows[i];
		const index = Number(cmRow.rowIndex);
		if (Number.isFinite(index) && index > 0) cmIndexSet.add(index);
		const existing = Number.isFinite(index)
			? asByIndex.get(index)
			: null;
		const current = existing || (usePositionalFallback ? asRows[i] : null);
		if (!current) {
			added += 1;
			continue;
		}
		const snapshot = current.cmSourceData || null;
		const hasCmCellChange = (cmColumns || []).some((column) => {
			if (newColumns.includes(column)) return false;
			return copyMatrixCellChanged(snapshot, cmRow.rowData, column);
		});
		const cmEditedAfterAs =
			!snapshot &&
			cmRow.updatedAt &&
			current.updatedAt &&
			new Date(cmRow.updatedAt).getTime() >
				new Date(current.updatedAt).getTime();
		if (hasCmCellChange || cmEditedAfterAs) modified += 1;
	}

	let removed = 0;
	for (const asRow of asRows || []) {
		const index = rowIndexFromAsset(asRow);
		if (index == null || !asRow.cmSourceData) continue;
		if (!cmIndexSet.has(index)) removed += 1;
	}

	return {
		added,
		modified,
		removed,
		newColumns: newColumns.length,
		total: added + modified + removed + newColumns.length,
	};
}

async function getAddedRowCountsByUpload(assets = [], linkedMatrixIds = null) {
	const counts = new Map();
	if (!assets.length) return counts;

	const linkedIds =
		linkedMatrixIds || (await resolveLinkedMatrixIdsByUpload(assets));
	const matrixIds = toObjectIds([...linkedIds.values()]);
	const uploadIds = assets.map((asset) => asset._id).filter(Boolean);

	const columnsByMatrix = new Map();
	const cmRowsByMatrix = new Map();
	if (matrixIds.length > 0) {
		const matrices = await CopyMatrix.find({ _id: { $in: matrixIds } })
			.select("_id columns")
			.lean();
		for (const matrix of matrices) {
			columnsByMatrix.set(String(matrix._id), matrix.columns || []);
		}

		const cmRows = await CopyMatrixRow.find({
			copyMatrixId: { $in: matrixIds },
		})
			.select("copyMatrixId rowIndex rowData updatedAt")
			.lean();
		for (const row of cmRows) {
			const key = String(row.copyMatrixId);
			if (!cmRowsByMatrix.has(key)) cmRowsByMatrix.set(key, []);
			cmRowsByMatrix.get(key).push(row);
		}
	}

	const asRowsByUpload = new Map();
	if (uploadIds.length > 0) {
		const asRows = await AssetSource.find({
			uploadId: { $in: uploadIds },
			isDeleted: { $ne: true },
		})
			.select("uploadId rowData cmRowIndex primaryKey cmSourceData updatedAt")
			.lean();
		for (const row of asRows) {
			const key = String(row.uploadId);
			if (!asRowsByUpload.has(key)) asRowsByUpload.set(key, []);
			asRowsByUpload.get(key).push(row);
		}
	}

	for (const asset of assets) {
		const matrixId = linkedIds.get(String(asset._id));
		if (!matrixId) {
			counts.set(String(asset._id), emptyChangeCounts());
			continue;
		}
		const cmRows = (cmRowsByMatrix.get(String(matrixId)) || [])
			.slice()
			.sort((a, b) => Number(a.rowIndex) - Number(b.rowIndex));
		const asRows = (asRowsByUpload.get(String(asset._id)) || [])
			.slice()
			.sort(
				(a, b) =>
					Number(a.cmRowIndex || 0) - Number(b.cmRowIndex || 0)
			);
		counts.set(
			String(asset._id),
			countChangedRows(
				cmRows,
				asRows,
				compareColumns(columnsByMatrix.get(String(matrixId)), cmRows),
				omitRowIdColumn(asset.columns || [])
			)
		);
	}

	return counts;
}

async function previewAssetSourceRefresh(upload) {
	const matrix = await resolveCopyMatrixForUpload(upload);
	if (!matrix) {
		const err = new Error(
			"This asset source is not linked to a copy matrix"
		);
		err.statusCode = 400;
		throw err;
	}

	const cmRows = await CopyMatrixRow.find({ copyMatrixId: matrix._id })
		.sort({ rowIndex: 1 })
		.select("_id rowIndex rowData updatedAt")
		.lean();
	const asRows = await AssetSource.find({
		uploadId: upload._id,
		isDeleted: { $ne: true },
	})
		.sort({ cmRowIndex: 1 })
		.select("_id rowData cmRowIndex primaryKey cmSourceData updatedAt")
		.lean();

	const asByIndex = new Map();
	for (const row of asRows) {
		const index = rowIndexFromAsset(row);
		if (index != null && !asByIndex.has(index)) {
			asByIndex.set(index, row);
		}
	}
	const usePositionalFallback =
		asByIndex.size === 0 && asRows.length > 0;

	const cmColumns = compareColumns(matrix.columns || [], cmRows);
	const existingColumns = omitRowIdColumn(upload.columns || []);
	const newColumns = cmColumns.filter(
		(column) => !existingColumns.includes(column)
	);
	const rowCounts = countChangedRows(
		cmRows,
		asRows,
		cmColumns,
		existingColumns
	);
	const changes = [];
	const pendingEdits = {};
	const addedRows = [];
	const removedRows = [];

	for (let i = 0; i < cmRows.length; i++) {
		const cmRow = cmRows[i];
		const rowIndex = Number(cmRow.rowIndex);
		const existing =
			asByIndex.get(rowIndex) ||
			(usePositionalFallback ? asRows[i] : null);
		if (!existing) {
			addedRows.push({
				rowIndex,
				rowData: cmRow.rowData || {},
			});
			const filled = cmColumns.filter((column) =>
				cellText(cmRow.rowData, column)
			);
			if (filled.length === 0) {
				changes.push({
					rowIndex,
					rowId: null,
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
					rowId: null,
					column,
					previousValue: "",
					updatedValue: cmRow.rowData?.[column] ?? "",
					status: "Added",
				});
			}
			continue;
		}

		for (const column of cmColumns) {
			const isNewColumn = newColumns.includes(column);
			const cmChanged = copyMatrixCellChanged(
				existing.cmSourceData,
				cmRow.rowData,
				column
			);
			if (!isNewColumn && !cmChanged) continue;
			const updatedValue = cmRow.rowData?.[column] ?? "";
			const rowId = existing._id ? String(existing._id) : null;
			if (rowId) {
				if (!pendingEdits[rowId]) pendingEdits[rowId] = {};
				pendingEdits[rowId][column] = updatedValue;
			}
			changes.push({
				rowIndex,
				rowId,
				column,
				previousValue: isNewColumn
					? ""
					: existing.rowData?.[column] ?? "",
				updatedValue,
				status: isNewColumn ? "Added" : "Modified",
			});
		}
	}

	const cmIndexSet = new Set(
		(cmRows || [])
			.map((row) => Number(row.rowIndex))
			.filter((index) => Number.isFinite(index) && index > 0)
	);
	for (const asRow of asRows) {
		const rowIndex = rowIndexFromAsset(asRow);
		if (rowIndex == null) continue;
		if (cmIndexSet.has(rowIndex)) continue;
		if (!asRow.cmSourceData) continue;
		removedRows.push({
			_id: String(asRow._id),
			rowIndex,
			rowData: asRow.rowData || {},
		});
		const summaryCols = cmColumns.filter((column) =>
			cellText(asRow.rowData, column)
		);
		if (summaryCols.length === 0) {
			changes.push({
				rowIndex,
				rowId: String(asRow._id),
				column: "Entire row",
				previousValue: "Row data",
				updatedValue: "",
				status: "Removed",
			});
			continue;
		}
		for (const column of summaryCols) {
			changes.push({
				rowIndex,
				rowId: String(asRow._id),
				column,
				previousValue: asRow.rowData?.[column] ?? "",
				updatedValue: "",
				status: "Removed",
			});
		}
	}

	const summary = summarizeChanges(changes);

	return {
		hasChanges:
			changes.length > 0 ||
			rowCounts.added > 0 ||
			rowCounts.modified > 0 ||
			rowCounts.removed > 0 ||
			rowCounts.newColumns > 0,
		name: upload.assetName,
		fileName: matrix.name || upload.fileName || "",
		copyMatrixId: String(matrix._id),
		copyMatrixName: matrix.name || "",
		currentRowCount: asRows.length,
		sourceRowCount: cmRows.length,
		addedRowCount: rowCounts.added,
		modifiedRowCount: rowCounts.modified,
		removedRowCount: rowCounts.removed,
		newColumnCount: rowCounts.newColumns,
		changedRowCount: rowCounts.total,
		summary,
		changes,
		highlights: highlightsFromChanges(changes),
		pendingEdits,
		addedRows,
		removedRows,
		newColumns,
	};
}

async function applyAssetSourceRefresh(upload, userId) {
	const preview = await previewAssetSourceRefresh(upload);
	const synced = await syncAssetSourceFromCopyMatrix(
		preview.copyMatrixId,
		userId,
		null,
		{ uploadId: upload._id }
	);

	return {
		...preview,
		processedRows: synced?.upload?.processedRows ?? preview.sourceRowCount,
	};
}

module.exports = {
	getAddedRowCountsByUpload,
	previewAssetSourceRefresh,
	applyAssetSourceRefresh,
	linkedCopyMatrixId,
	resolveLinkedMatrixIdsByUpload,
};
