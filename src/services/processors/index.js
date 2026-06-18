const AssetUpload = require("../../models/assetUpload");
const AssetSource = require("../../models/assetSource");
const processStreamCSV = require("./strategies/csvStrategy");
const processMemoryXLSX = require("./strategies/xlsxStrategy");
const processGoogleSheet = require("./strategies/gsheetStrategy");

async function processUpload(uploadId) {
	let uploadDoc = await AssetUpload.findById(uploadId).populate("uploadedBy");
	if (!uploadDoc) return;

	// Update status to processing
	uploadDoc.status = "processing";
	uploadDoc.message = "Parsing and comparing data...";
	await uploadDoc.save();

	console.log(`[Processor] Starting: ${uploadDoc.fileName}`);

	const UNIQUE_KEY = uploadDoc.uniqueColumn;
	const CURRENT_HASH = uploadDoc.fileHash;
	const USER_ID = uploadDoc.uploadedBy ? uploadDoc.uploadedBy._id : null; // 👈 Get User
	
	const seenKeys = new Set(); // To track duplicates within the file itself

	try {
		let result = {
			stats: { created: 0, updated: 0, skipped: 0 },
			validationErrors: [],
		};

		// 1. Process File
		// Note: Ensure your strategies (csvStrategy, etc.) call 'processBatch' internally!
		// They should pass USER_ID to processBatch.
		if (uploadDoc.inputType === "gsheet") {
			result = await processGoogleSheet(
				uploadDoc,
				UNIQUE_KEY,
				seenKeys,
				CURRENT_HASH,
				USER_ID
			);
		} else if (uploadDoc.fileType === "csv") {
			result = await processStreamCSV(
				uploadDoc,
				UNIQUE_KEY,
				seenKeys,
				CURRENT_HASH,
				USER_ID
			);
		} else if (uploadDoc.fileType === "xlsx") {
			result = await processMemoryXLSX(
				uploadDoc,
				UNIQUE_KEY,
				seenKeys,
				CURRENT_HASH,
				USER_ID
			);
		}

		// 2. 🧹 SOFT DELETE CLEANUP
		// "If row belongs to this UploadID, but hash != CURRENT_HASH, it was removed."
		const cleanupResult = await AssetSource.updateMany(
			{
				uploadId: uploadId,
				fileHash: { $ne: CURRENT_HASH },
			},
			{
				$set: { isDeleted: true },
			}
		);

		console.log(
			`[Processor] Cleanup: Soft deleted ${cleanupResult.modifiedCount} rows.`
		);

		// 3. Save Final Stats
		const { stats, validationErrors } = result;

		uploadDoc.processedRows =
			(stats.created || 0) + (stats.updated || 0) + (stats.skipped || 0);
		uploadDoc.validationErrors = validationErrors;

		if (validationErrors && validationErrors.length > 0) {
			uploadDoc.status = "partial_success";
			uploadDoc.message = `Completed with ${validationErrors.length} errors. Created: ${stats.created}, Updated: ${stats.updated}, Deleted: ${cleanupResult.modifiedCount}`;
		} else {
			uploadDoc.status = "completed";
			uploadDoc.message = `Success! Created: ${stats.created}, Updated: ${stats.updated}, Skipped: ${stats.skipped}, Deleted: ${cleanupResult.modifiedCount}`;
		}

		await uploadDoc.save();
	} catch (err) {
		console.error(`[Processor] Failed:`, err);

		// Reload doc in case it changed
		const freshDoc = await AssetUpload.findById(uploadId);
		if (freshDoc) {
			freshDoc.status = "failed";
			freshDoc.message = err.message;
			freshDoc.errorLog = err.stack;
			await freshDoc.save();
		}
	}
}

module.exports = { processUpload };
