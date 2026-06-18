const AssetSource = require("../models/assetSource");
const AssetHistory = require("../models/assetHistory");

/**
 * Updates an asset AND saves the history log automatically.
 * @param {String} assetId - The ID of the asset
 * @param {Object} updates - The new values, e.g., { "Price": 400 }
 * @param {String} userId - The ID of the user making the change
 */
async function updateAssetWithHistory(assetId, updates, userId) {
	// 1. Fetch the CURRENT (Old) Data
	const oldAsset = await AssetSource.findById(assetId);
	if (!oldAsset) throw new Error("Asset not found");

	const historyChanges = [];
	const mongoUpdate = {}; // This will hold { "$set": { "rowData.Price": 400 } }

	// 2. Loop through the updates to find differences
	for (const key in updates) {
		const newValue = updates[key];

		// Access nested rowData safely
		const oldValue = oldAsset.rowData ? oldAsset.rowData[key] : undefined;

		// If the value is different, record it in history
		if (oldValue != newValue) {
			historyChanges.push({
				field: key, // e.g., "Price"
				oldValue: oldValue, // e.g., 600
				newValue: newValue, // e.g., 400
			});
		}

		// Prepare the MongoDB Update Query (Dot Notation)
		mongoUpdate[`rowData.${key}`] = newValue;
	}

	// 3. If there are real changes, Save to History Collection
	if (historyChanges.length > 0) {
		await AssetHistory.create({
			assetId: assetId,
			updatedBy: userId,
			changes: historyChanges,
			updatedAt: new Date(),
		});
	}

	// 4. Perform the Actual Update (Partial Update using $set)
	const updatedAsset = await AssetSource.findByIdAndUpdate(
		assetId,
		{ $set: mongoUpdate },
		{ new: true } // Returns the NEW combined object
	);

	// 5. Return the result to be sent to UI
	return updatedAsset;
}

module.exports = { updateAssetWithHistory };
