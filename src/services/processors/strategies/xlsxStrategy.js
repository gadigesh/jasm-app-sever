const ExcelJS = require("exceljs");
const fs = require("fs");
const { processBatch } = require("../batchLogic");
const { getExcelCellValue } = require("../helper");

const BATCH_SIZE = 1000;
const ROW_LIMIT = 40000; // 🛑 STRICT LIMIT
const SIZE_LIMIT_MB = 10;
const MAX_VALIDATION_ERRORS = 100;

async function processMemoryXLSX(uploadDoc, uniqueKey, seenKeys, fileHash, userId) {
	// 1. File Size Check
	const fileStats = fs.statSync(uploadDoc.fileRef);
	if (fileStats.size / 1024 / 1024 > SIZE_LIMIT_MB) {
		throw new Error(
			`Excel file too large (> ${SIZE_LIMIT_MB}MB). Please convert to CSV.`
		);
	}

	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(uploadDoc.fileRef);
	const worksheet = workbook.worksheets[0];

	// 2. Row Limit Check
	if (worksheet.rowCount > ROW_LIMIT) {
		throw new Error(
			`Excel file has ${worksheet.rowCount} rows. Limit is ${ROW_LIMIT}. Please convert to CSV.`
		);
	}

	let batch = [];
	let stats = { created: 0, updated: 0, skipped: 0 };
	let validationErrors = [];
	let headers = [];

	for (let i = 1; i <= worksheet.rowCount; i++) {
		const row = worksheet.getRow(i);

		// Headers (Row 1)
		if (i === 1) {
			row.eachCell(
				{ includeEmpty: true },
				(c, col) => (headers[col] = getExcelCellValue(c.value))
			);
			if (!headers.includes(uniqueKey))
				throw new Error(`Header "${uniqueKey}" not found in Excel.`);
			continue;
		}

		// Data Rows
		const rowData = {};
		let hasRealData = false;
		row.eachCell({ includeEmpty: true }, (c, col) => {
			if (headers[col]) {
				const val = getExcelCellValue(c.value);
				rowData[headers[col]] = val;
				if (val !== "") {
					hasRealData = true;
				}
			}
		});

		if (!hasRealData) continue; // Skip truly empty rows

		const keyVal = rowData[uniqueKey];

		// Validation
		if (!keyVal) {
			if (validationErrors.length < MAX_VALIDATION_ERRORS) {
				validationErrors.push({
					row: i,
					message: `Missing "${uniqueKey}"`,
					data: rowData,
				});
			}
			continue;
		}

		if (seenKeys.has(keyVal)) {
			if (validationErrors.length < MAX_VALIDATION_ERRORS) {
				validationErrors.push({
					row: i,
					message: `Duplicate "${keyVal}"`,
					data: rowData,
				});
			}
			continue;
		}

		seenKeys.add(keyVal);
		batch.push(rowData);

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
			if (global.gc) global.gc();
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

module.exports = processMemoryXLSX;
