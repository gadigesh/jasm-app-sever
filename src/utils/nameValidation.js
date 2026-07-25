const CopyMatrix = require("../models/copyMatrix");
const AssetUpload = require("../models/assetUpload");

const DUPLICATE_NAME_MESSAGE =
	"Same name already exists. Please change the name.";

const DELETED_ASSET_SOURCE_NAME_MESSAGE =
	"This name was used by a deleted asset source. Please choose a different name.";

function namesMatch(a, b) {
	if (!a || !b) return false;
	return (
		String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
	);
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameRegex(name) {
	const trimmed = String(name || "").trim();
	if (!trimmed) return null;
	return new RegExp(`^${escapeRegex(trimmed)}$`, "i");
}

async function findDuplicateCopyMatrixName(accountId, name, excludeId = null) {
	const pattern = nameRegex(name);
	if (!pattern || !accountId) return null;

	const query = {
		accountId,
		name: { $regex: pattern },
		// Create drafts are intentionally hidden from the list and may be
		// abandoned. They must not reserve a name for active records.
		status: { $ne: "draft" },
	};
	if (excludeId) {
		query._id = { $ne: excludeId };
	}

	return CopyMatrix.findOne(query).select("_id name").lean();
}

async function findDuplicateAssetSourceName(accountId, name, excludeId = null) {
	const pattern = nameRegex(name);
	if (!pattern || !accountId) return null;

	const query = {
		accountId,
		assetName: { $regex: pattern },
		// Hidden create drafts should not block a visible CM/AS name.
		status: { $ne: "draft" },
	};
	if (excludeId) {
		query._id = { $ne: excludeId };
	}

	return AssetUpload.findOne(query).select("_id assetName").lean();
}

function duplicateNameError() {
	const err = new Error(DUPLICATE_NAME_MESSAGE);
	err.statusCode = 409;
	return err;
}

async function assertUniqueCopyMatrixName(accountId, name, excludeId = null) {
	const duplicate = await findDuplicateCopyMatrixName(
		accountId,
		name,
		excludeId
	);
	if (duplicate) throw duplicateNameError();
}

async function assertUniqueAssetSourceName(
	accountId,
	name,
	excludeUploadId = null,
	excludeCopyMatrixId = null
) {
	const duplicateAs = await findDuplicateAssetSourceName(
		accountId,
		name,
		excludeUploadId
	);
	if (duplicateAs) throw duplicateNameError();

	const duplicateCm = await findDuplicateCopyMatrixName(
		accountId,
		name,
		excludeCopyMatrixId
	);
	if (duplicateCm) throw duplicateNameError();
}

function assertNotDeletedAssetSourceName(name, deletedNames) {
	const blocked = normalizeDeletedAssetSourceNames(deletedNames);
	if (blocked.some((blockedName) => namesMatch(name, blockedName))) {
		const err = new Error(DELETED_ASSET_SOURCE_NAME_MESSAGE);
		err.statusCode = 409;
		throw err;
	}
}

function normalizeDeletedAssetSourceNames(deletedNames) {
	const values = Array.isArray(deletedNames)
		? deletedNames
		: deletedNames
		? [deletedNames]
		: [];

	const seen = new Set();
	const normalized = [];

	for (const value of values) {
		const trimmed = String(value || "").trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(trimmed);
	}

	return normalized;
}

function getDeletedAssetSourceNames(matrix) {
	if (!matrix) return [];

	const names = normalizeDeletedAssetSourceNames(
		matrix.deletedAssetSourceNames
	);

	const legacy = String(matrix.lastDeletedAssetSourceName || "").trim();
	if (legacy && !names.some((name) => namesMatch(name, legacy))) {
		names.push(legacy);
	}

	return names;
}

async function checkCopyMatrixNameAvailability(
	accountId,
	name,
	excludeMatrixId = null,
	excludeUploadId = null
) {
	const trimmed = String(name || "").trim();
	if (!trimmed || !accountId) {
		return { available: true };
	}

	const cmDuplicate = await findDuplicateCopyMatrixName(
		accountId,
		trimmed,
		excludeMatrixId
	);
	if (cmDuplicate) {
		return { available: false, message: DUPLICATE_NAME_MESSAGE };
	}

	const asDuplicate = await findDuplicateAssetSourceName(
		accountId,
		trimmed,
		excludeUploadId
	);
	if (asDuplicate) {
		return { available: false, message: DUPLICATE_NAME_MESSAGE };
	}

	return { available: true };
}

async function checkAssetSourceNameAvailability(
	accountId,
	name,
	excludeUploadId = null
) {
	const trimmed = String(name || "").trim();
	if (!trimmed || !accountId) {
		return { available: true };
	}

	const duplicate = await findDuplicateAssetSourceName(
		accountId,
		trimmed,
		excludeUploadId
	);
	if (duplicate) {
		return { available: false, message: DUPLICATE_NAME_MESSAGE };
	}

	return { available: true };
}

function isDuplicateNameError(err) {
	return err?.statusCode === 409;
}

module.exports = {
	DUPLICATE_NAME_MESSAGE,
	DELETED_ASSET_SOURCE_NAME_MESSAGE,
	assertUniqueCopyMatrixName,
	assertUniqueAssetSourceName,
	assertNotDeletedAssetSourceName,
	namesMatch,
	normalizeDeletedAssetSourceNames,
	getDeletedAssetSourceNames,
	findDuplicateCopyMatrixName,
	findDuplicateAssetSourceName,
	checkCopyMatrixNameAvailability,
	checkAssetSourceNameAvailability,
	isDuplicateNameError,
};
