const AssetSource = require("../../models/assetSource");
const AssetHistory = require("../../models/assetHistory");
const { getDiff } = require("./helper");

/**
 * Processes a chunk of rows (e.g., 500 rows).
 * Upserts valid ones, logs history, and updates fileHash.
 */
async function processBatch(rows, uploadId, userId, uniqueKey, fileHash) {
	const assetOps = [];
	const historyDocs = [];
	let created = 0,
		updated = 0,
		skipped = 0;

	// 1. Extract Keys (Normalize to String)
	// We use these to query the 'primaryKey' index efficiently
	const keys = rows
		.map((r) => String(r[uniqueKey] || "").trim())
		.filter((k) => k);

	if (keys.length === 0) return { created, updated, skipped };

	// 2. Fetch Existing Docs using FAST Index
	// ❌ OLD (Slow): { [`rowData.${uniqueKey}`]: { $in: keys } }
	// ✅ NEW (Fast): { uploadId, primaryKey: { $in: keys } }
	const existingAssets = await AssetSource.find({
		uploadId: uploadId,
		primaryKey: { $in: keys },
	});

	const assetMap = new Map();
	existingAssets.forEach((doc) => assetMap.set(doc.primaryKey, doc));

	for (const row of rows) {
		const rawVal = row[uniqueKey];
		if (!rawVal) continue; // Skip rows missing the ID

		const key = String(rawVal).trim(); // The Primary Key
		const existingDoc = assetMap.get(key);

		if (!existingDoc) {
			// ============================
			// CASE A: INSERT (New Row)
			// ============================
			assetOps.push({
				insertOne: {
					document: {
						uploadId,
						primaryKey: key, // 👈 Save the generic ID
						rowData: row,
						fileHash: fileHash, // 👈 Mark version
						isDeleted: false,
						importStatus: "ACTIVE", // Start as Active
					},
				},
			});
			created++;
		} else {
			// ============================
			// CASE B: UPSERT (Existing)
			// ============================
			const changes = getDiff(existingDoc.rowData, row);

			// Base update: Always update Metadata
			const updateFields = {
				fileHash: fileHash, // 👈 Proof this row exists in new file
				isDeleted: false, // 👈 Resurrect if it was deleted
				primaryKey: key, // Ensure consistency
				importStatus: "ACTIVE",
			};

			// If actual data changed, update rowData & Log History
			if (changes.length > 0) {
				updateFields.rowData = row; // Overwrite data

				historyDocs.push({
					assetId: existingDoc._id,
					updatedBy: userId || null, // Handle system updates
					changes,
					updatedAt: new Date(),
				});
				updated++;
			} else {
				skipped++;
			}

			assetOps.push({
				updateOne: {
					filter: { _id: existingDoc._id },
					update: { $set: updateFields },
				},
			});
		}
	}

	// 3. Execute Bulk Operations
	if (assetOps.length > 0) {
		await AssetSource.bulkWrite(assetOps, { ordered: false });
	}

	if (historyDocs.length > 0) {
		await AssetHistory.insertMany(historyDocs, { ordered: false });
	}

	return { created, updated, skipped };
}

module.exports = { processBatch };
