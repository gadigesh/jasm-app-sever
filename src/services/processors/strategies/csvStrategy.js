const csv = require("csv-parser");
const storageService = require("../../storage");
const { processBatch } = require("../batchLogic");

const BATCH_SIZE = 1000;
const MAX_VALIDATION_ERRORS = 100; // Limit error logging to prevent DB bloat

async function processStreamCSV(uploadDoc, uniqueKey, seenKeys, fileHash, userId) {
	const stream = storageService
		.getReadStream(uploadDoc.fileRef)
		.pipe(csv({ mapHeaders: ({ header }) => header.trim() }));
	
	let batch = [];
	let stats = { created: 0, updated: 0, skipped: 0 };
	let validationErrors = [];
	let rowIndex = 0;

	for await (const row of stream) {
		rowIndex++;

		// Clean row data
		const cleanRow = {};
		for (const key in row)
			cleanRow[key] = row[key] ? row[key].trim() : "";

		const keyVal = cleanRow[uniqueKey];

		// 🛑 VALIDATION: Missing Key
		if (!keyVal) {
			if (validationErrors.length < MAX_VALIDATION_ERRORS) {
				validationErrors.push({
					row: rowIndex,
					message: `Missing value for "${uniqueKey}"`,
					data: cleanRow,
				});
			}
			continue; // Skip Row
		}

		// 🛑 VALIDATION: Duplicate in File
		if (seenKeys.has(keyVal)) {
			if (validationErrors.length < MAX_VALIDATION_ERRORS) {
				validationErrors.push({
					row: rowIndex,
					message: `Duplicate "${keyVal}" found in file`,
					data: cleanRow,
				});
			}
			continue; // Skip Row
		}

		seenKeys.add(keyVal);
		batch.push(cleanRow);

		// Process Batch
		if (batch.length >= BATCH_SIZE) {
			const res = await processBatch(
				batch,
				uploadDoc._id,
				userId,
				uniqueKey,
				fileHash
			);
			stats.created += res.created;
			stats.updated += res.updated;
			stats.skipped += res.skipped;
			batch = [];
		}
	}

	if (batch.length > 0) {
		const res = await processBatch(
			batch,
			uploadDoc._id,
			userId,
			uniqueKey,
			fileHash
		);
		stats.created += res.created;
		stats.updated += res.updated;
		stats.skipped += res.skipped;
	}

	return { stats, validationErrors };
}

module.exports = processStreamCSV;
