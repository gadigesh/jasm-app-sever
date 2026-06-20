const ExcelJS = require("exceljs");
const fs = require("fs");
const { processBatch } = require("../batchLogic");
const { getExcelCellValue } = require("../helper");
const {
	buildHeadersFromHeaderRow,
	rowDataFromArray,
	getWorksheetMaxColumn,
} = require("../../../utils/sheetColumnHelpers");

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
	const maxCol = getWorksheetMaxColumn(worksheet);
	const headerCells = [];

	for (let col = 1; col <= maxCol; col++) {
		headerCells[col - 1] = getExcelCellValue(
			worksheet.getRow(1).getCell(col).value
		);
	}

	const headers = buildHeadersFromHeaderRow(headerCells, maxCol);

	if (!headers.includes(uniqueKey)) {
		throw new Error(`Header "${uniqueKey}" not found in Excel.`);
	}

	for (let i = 2; i <= worksheet.rowCount; i++) {
		const row = worksheet.getRow(i);
		const rowArr = [];

		for (let col = 1; col <= maxCol; col++) {
			const val = getExcelCellValue(row.getCell(col).value);
			rowArr[col - 1] = val ? String(val).trim() : "";
		}

		const { rowData, hasValue: hasRealData } = rowDataFromArray(
			rowArr,
			headers
		);

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
