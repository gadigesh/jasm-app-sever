const csv = require("csv-parser");
const ExcelJS = require("exceljs");
const fs = require("fs");
const { google } = require("googleapis");
const CopyMatrix = require("../../models/copyMatrix");
const CopyMatrixRow = require("../../models/copyMatrixRow");
const storageService = require("../storage");
const { getExcelCellValue } = require("../processors/helper");
const {
	extractSheetId,
	extractGid,
	resolveSheetFromMeta,
} = require("../../utils/gsheetHelpers");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	injectRowIdIntoRowData,
} = require("../../constants/copyMatrix");
const {
	rowArrayFromRecord,
	resolveHeadersFromGrid,
	buildHeadersFromHeaderRow,
	rowDataFromArray,
	getWorksheetMaxColumn,
} = require("../../utils/sheetColumnHelpers");

const BATCH_SIZE = 500;
const ROW_LIMIT = 40000;
const SIZE_LIMIT_MB = 10;

const auth = new google.auth.GoogleAuth({
	keyFile: "google-credentials.json",
	scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

async function saveRows(copyMatrixId, rows) {
	await CopyMatrixRow.deleteMany({ copyMatrixId });

	let inserted = 0;
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const chunk = rows.slice(i, i + BATCH_SIZE).map((rowData, offset) => {
			const rowIndex = i + offset + 1;
			return {
				copyMatrixId,
				rowIndex,
				rowData: injectRowIdIntoRowData(rowData, rowIndex),
			};
		});
		await CopyMatrixRow.insertMany(chunk, { ordered: false });
		inserted += chunk.length;
	}
	return inserted;
}

async function processCsv(matrixDoc) {
	const rawRows = [];

	await new Promise((resolve, reject) => {
		storageService
			.getReadStream(matrixDoc.fileRef)
			.pipe(csv({ headers: false }))
			.on("data", (row) => {
				rawRows.push(rowArrayFromRecord(row));
			})
			.on("end", resolve)
			.on("error", reject);
	});

	const { headers, rows } = resolveHeadersFromGrid(rawRows);
	return { rows, columns: headers };
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
	const maxCol = getWorksheetMaxColumn(worksheet);

	if (maxCol > 0) {
		const headerCells = [];
		for (let col = 1; col <= maxCol; col++) {
			headerCells[col - 1] = getExcelCellValue(
				worksheet.getRow(1).getCell(col).value
			);
		}
		headers = buildHeadersFromHeaderRow(headerCells, maxCol);
	}

	for (let i = 2; i <= worksheet.rowCount; i++) {
		const row = worksheet.getRow(i);
		const rowArr = [];
		for (let col = 1; col <= maxCol; col++) {
			const value = getExcelCellValue(row.getCell(col).value);
			rowArr[col - 1] = value ? String(value).trim() : "";
		}

		const { rowData, hasValue } = rowDataFromArray(rowArr, headers);
		if (hasValue) rows.push(rowData);
	}

	return { rows, columns: headers };
}

async function processGsheet(matrixDoc) {
	const sheets = google.sheets({ version: "v4", auth });
	const sheetId = extractSheetId(matrixDoc.fileRef);
	const gid =
		matrixDoc.sheetGid != null
			? Number(matrixDoc.sheetGid)
			: extractGid(matrixDoc.fileRef);

	const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
	const sheetInfo = resolveSheetFromMeta(meta.data.sheets, gid);
	if (!sheetInfo) {
		throw new Error("No sheets found in spreadsheet");
	}

	const title = sheetInfo.properties.title;
	const totalRows = sheetInfo.properties.gridProperties.rowCount;

	console.log(
		`[CopyMatrix GSheet] tab="${title}" gid=${sheetInfo.properties.sheetId} rows=${totalRows}`
	);

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
		return {
			rows: [],
			columns: [],
			sheetTitle: title,
			sheetGid: sheetInfo.properties.sheetId,
		};
	}

	const { headers, rows } = resolveHeadersFromGrid(values);

	return {
		rows,
		columns: headers,
		sheetTitle: title,
		sheetGid: sheetInfo.properties.sheetId,
	};
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

		matrixDoc.columns = ensureRowIdColumn(result.columns);
		matrixDoc.processedRows = inserted;
		matrixDoc.status = draft ? "draft" : "completed";
		if (matrixDoc.inputType === "gsheet" && result.sheetTitle) {
			matrixDoc.sheetGid = result.sheetGid;
			matrixDoc.fileName = result.sheetTitle;
		}
		matrixDoc.message = draft
			? result.sheetTitle
				? `Preview ready — ${inserted} rows from "${result.sheetTitle}"`
				: `Preview ready — ${inserted} rows parsed`
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
