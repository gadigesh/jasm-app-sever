const CopyMatrixRow = require("../models/copyMatrixRow");
const CopyMatrixHistory = require("../models/copyMatrixHistory");

function collectFieldChanges(oldData = {}, newData = {}) {
	const keys = new Set([
		...Object.keys(oldData),
		...Object.keys(newData),
	]);
	const changes = [];

	for (const key of keys) {
		if (oldData[key] != newData[key]) {
			changes.push({
				field: key,
				oldValue: oldData[key],
				newValue: newData[key],
			});
		}
	}

	return changes;
}

async function logCopyMatrixRowChanges(matrixId, rowUpdates, userId) {
	const historyDocs = [];

	for (const item of rowUpdates) {
		if (!item._id || !item.rowData) continue;

		const row = await CopyMatrixRow.findById(item._id);
		if (!row || String(row.copyMatrixId) !== String(matrixId)) continue;

		const changes = collectFieldChanges(row.rowData || {}, item.rowData || {});
		if (changes.length === 0) continue;

		historyDocs.push({
			copyMatrixId: matrixId,
			copyMatrixRowId: row._id,
			rowIndex: row.rowIndex,
			action: "row_edit",
			updatedBy: userId,
			changes,
		});
	}

	if (historyDocs.length > 0) {
		await CopyMatrixHistory.insertMany(historyDocs, { ordered: false });
	}

	return historyDocs.length;
}

async function logCopyMatrixAction(matrixId, userId, action, changes) {
	await CopyMatrixHistory.create({
		copyMatrixId: matrixId,
		action,
		updatedBy: userId,
		changes,
	});
}

module.exports = {
	logCopyMatrixRowChanges,
	logCopyMatrixAction,
};
