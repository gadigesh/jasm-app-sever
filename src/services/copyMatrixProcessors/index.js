const csv = require("csv-parser");
const ExcelJS = require("exceljs");
const fs = require("fs");
const { google } = require("googleapis");
const CopyMatrix = require("../../models/copyMatrix");
const CopyMatrixRow = require("../../models/copyMatrixRow");
const storageService = require("../storage");
const { getExcelCellValue } = require("../processors/helper");

const BATCH_SIZE = 500;
const ROW_LIMIT = 40000;
const SIZE_LIMIT_MB = 10;

const auth = new google.auth.GoogleAuth({
	keyFile: "google-credentials.json",
	scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

function extractSheetId(ref) {
	const match = ref.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
	return match ? match[1] : ref.trim();
}

async function saveRows(copyMatrixId, rows) {
	await CopyMatrixRow.deleteMany({ copyMatrixId });

	let inserted = 0;
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const chunk = rows.slice(i, i + BATCH_SIZE).map((rowData, offset) => ({
			copyMatrixId,
			rowIndex: i + offset + 1,
			rowData,
		}));
		await CopyMatrixRow.insertMany(chunk, { ordered: false });
		inserted += chunk.length;
	}
	return inserted;
}

async function processCsv(matrixDoc) {
	const rows = [];
	const columns = new Set();

	await new Promise((resolve, reject) => {
		storageService
			.getReadStream(matrixDoc.fileRef)
			.pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
			.on("data", (row) => {
				const cleanRow = {};
				for (const key in row) {
					const value = row[key] ? String(row[key]).trim() : "";
					cleanRow[key] = value;
					if (key) columns.add(key);
				}
				if (Object.values(cleanRow).some(Boolean)) {
					rows.push(cleanRow);
				}
			})
			.on("end", resolve)
			.on("error", reject);
	});

	return { rows, columns: [...columns] };
}

async function processXlsx(matrixDoc) {
	const fileStats = fs.statSync(matrixDoc.fileRef);
	if (fileStats.size / 1024 / 1024 > SIZE_LIMIT_MB) {
		throw new Error(
			`Excel file too large (> ${SIZE_LIMIT_MB}MB). Please convert to CSV.`
		);
	}

	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(matrixDoc.fileRef);
	const worksheet = workbook.worksheets[0];

	if (worksheet.rowCount > ROW_LIMIT) {
		throw new Error(
			`Excel file has ${worksheet.rowCount} rows. Limit is ${ROW_LIMIT}.`
		);
	}

	let headers = [];
	const rows = [];

	for (let i = 1; i <= worksheet.rowCount; i++) {
		const row = worksheet.getRow(i);

		if (i === 1) {
			row.eachCell(
				{ includeEmpty: true },
				(cell, col) => {
					headers[col] = getExcelCellValue(cell.value);
				}
			);
			continue;
		}

		const rowData = {};
		let hasValue = false;
		headers.forEach((header, colIndex) => {
			if (!header) return;
			const cell = row.getCell(colIndex);
			const value = getExcelCellValue(cell.value);
			rowData[header] = value ? String(value).trim() : "";
			if (rowData[header]) hasValue = true;
		});

		if (hasValue) rows.push(rowData);
	}

	return { rows, columns: headers.filter(Boolean) };
}

async function processGsheet(matrixDoc) {
	const sheets = google.sheets({ version: "v4", auth });
	const sheetId = extractSheetId(matrixDoc.fileRef);

	const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
	const sheetInfo = meta.data.sheets[0];
	const title = sheetInfo.properties.title;
	const totalRows = sheetInfo.properties.gridProperties.rowCount;

	if (totalRows > ROW_LIMIT) {
		throw new Error(
			`Google Sheet has ${totalRows} rows. Limit is ${ROW_LIMIT}.`
		);
	}

	const escapedTitle = `'${title.replace(/'/g, "''")}'`;
	const response = await sheets.spreadsheets.values.get({
		spreadsheetId: sheetId,
		range: `${escapedTitle}!A1:ZZ${totalRows}`,
	});

	const values = response.data.values || [];
	if (values.length === 0) {
		return { rows: [], columns: [] };
	}

	const headers = values[0].map((h) => String(h || "").trim());
	const rows = [];

	for (let i = 1; i < values.length; i++) {
		const rowData = {};
		let hasValue = false;
		headers.forEach((header, colIndex) => {
			if (!header) return;
			const value = values[i][colIndex]
				? String(values[i][colIndex]).trim()
				: "";
			rowData[header] = value;
			if (value) hasValue = true;
		});
		if (hasValue) rows.push(rowData);
	}

	return { rows, columns: headers.filter(Boolean) };
}

async function processCopyMatrix(matrixId, { draft = false } = {}) {
	const matrixDoc = await CopyMatrix.findById(matrixId);
	if (!matrixDoc) return;

	matrixDoc.status = "processing";
	matrixDoc.message = "Parsing sheet data...";
	await matrixDoc.save();

	try {
		let result = { rows: [], columns: [] };

		if (matrixDoc.inputType === "gsheet") {
			result = await processGsheet(matrixDoc);
		} else if (matrixDoc.fileType === "csv" || matrixDoc.fileType === "txt") {
			result = await processCsv(matrixDoc);
		} else if (matrixDoc.fileType === "xlsx" || matrixDoc.fileType === "xls") {
			result = await processXlsx(matrixDoc);
		} else {
			throw new Error("Unsupported file type");
		}

		const inserted = await saveRows(matrixId, result.rows);

		matrixDoc.columns = result.columns;
		matrixDoc.processedRows = inserted;
		matrixDoc.status = draft ? "draft" : "completed";
		matrixDoc.message = draft
			? `Preview ready — ${inserted} rows parsed`
			: `Imported ${inserted} rows successfully`;
		await matrixDoc.save();
	} catch (err) {
		console.error("[CopyMatrix Processor]", err);
		const freshDoc = await CopyMatrix.findById(matrixId);
		if (freshDoc) {
			freshDoc.status = "failed";
			freshDoc.message = err.message;
			freshDoc.errorLog = err.stack;
			await freshDoc.save();
		}
	}
}

module.exports = { processCopyMatrix, saveRows };
