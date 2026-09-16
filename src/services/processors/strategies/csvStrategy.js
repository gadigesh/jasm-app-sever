const csv = require("csv-parser");
const storageService = require("../../storage");
const { processBatch } = require("../batchLogic");
const { assignRowKey } = require("../helper");
const { isAutoRowIdColumn } = require("../../../constants/copyMatrix");
const {
	rowArrayFromRecord,
	buildHeadersFromHeaderRow,
	rowDataFromArray,
	makeUniqueHeader,
} = require("../../../utils/sheetColumnHelpers");

const BATCH_SIZE = 1000;
const MAX_VALIDATION_ERRORS = 100; // Limit error logging to prevent DB bloat

async function processStreamCSV(uploadDoc, uniqueKey, seenKeys, fileHash, userId) {
	const stream = storageService
		.getReadStream(uploadDoc.fileRef)
		.pipe(csv({ headers: false }));

	let batch = [];
	let stats = { created: 0, updated: 0, skipped: 0 };
	let validationErrors = [];
	let rowIndex = 0;
	let headers = null;

	for await (const row of stream) {
		const rowArr = rowArrayFromRecord(row);

		if (rowIndex === 0) {
			headers = buildHeadersFromHeaderRow(rowArr, rowArr.length);
			rowIndex++;
			continue;
		}

		if (rowArr.length > headers.length) {
			const usedNames = new Set(headers);
			for (let i = headers.length; i < rowArr.length; i++) {
				headers.push(makeUniqueHeader(`Column ${i + 1}`, usedNames));
			}
		}

		rowIndex++;
		const { rowData: cleanRow } = rowDataFromArray(rowArr, headers);

		const keyVal = assignRowKey(cleanRow, uniqueKey, rowIndex - 1);

		// 🛑 VALIDATION: Missing Key
		if (!keyVal && !isAutoRowIdColumn(uniqueKey)) {
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
		if (!isAutoRowIdColumn(uniqueKey) && seenKeys.has(keyVal)) {
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
