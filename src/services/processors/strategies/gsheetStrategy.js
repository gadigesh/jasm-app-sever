const { google } = require("googleapis");
const { processBatch } = require("../batchLogic");
const BATCH_SIZE = 1000;
const ROW_LIMIT = 40000; // 🛑 STRICT LIMIT FOR GSHEETS
const MAX_VALIDATION_ERRORS = 100;

// Ensure google-credentials.json is in Root
const auth = new google.auth.GoogleAuth({
	keyFile: "google-credentials.json",
	scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

async function processGoogleSheet(uploadDoc, uniqueKey, seenKeys, fileHash, userId) {
	const sheets = google.sheets({ version: "v4", auth });
	const sheetId = uploadDoc.fileRef;

	// 1. Get Metadata to check limits
	const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
	const sheetInfo = meta.data.sheets[0];
	const title = sheetInfo.properties.title;
	const totalRows = sheetInfo.properties.gridProperties.rowCount; // Total physical rows

	// Escaping sheet name for A1 notation (necessary if sheet name contains spaces/special characters)
	const escapedTitle = `'${title.replace(/'/g, "''")}'`;

	// 🛑 LIMIT CHECK
	console.log(`[GSheet Check] Total Rows: ${totalRows}`);
	if (totalRows > ROW_LIMIT) {
		throw new Error(
			`Google Sheet has ${totalRows} rows. Limit is ${ROW_LIMIT}. Please export as CSV.`
		);
	}

	// 2. Get Headers
	const hRes = await sheets.spreadsheets.values.get({
		spreadsheetId: sheetId,
		range: `${escapedTitle}!1:1`,
	});
	const headers = hRes.data.values
		? hRes.data.values[0].map((h) => h.trim())
		: [];

	if (!headers.includes(uniqueKey))
		throw new Error(`Header "${uniqueKey}" not found in Google Sheet.`);

	let stats = { created: 0, updated: 0, skipped: 0 };
	let validationErrors = [];
	let currentRow = 2; // Data starts at row 2

	// 3. Paginate Safely
	// 🛑 LOGIC FIX: Stop if currentRow exceeds total rows
	while (currentRow <= totalRows) {
		// Calculate End Row: Don't go beyond the physical sheet limit
		const endRow = Math.min(currentRow + BATCH_SIZE - 1, totalRows);

		// Fetch Data
		// Range example: "'Sheet1'!A2:ZZ1001" or "'Sheet 1'!A1002:ZZ1050"
		const range = `${escapedTitle}!A${currentRow}:ZZ${endRow}`;

		console.log(`[GSheet] Fetching range: ${range}`); // Debug log

		try {
			const res = await sheets.spreadsheets.values.get({
				spreadsheetId: sheetId,
				range,
			});

			// If API returns empty (no data in range), break
			if (!res.data.values || res.data.values.length === 0) break;

			const batch = [];

			res.data.values.forEach((rowArr, idx) => {
				const realRowNumber = currentRow + idx;
				const obj = {};
				headers.forEach(
					(h, i) => (obj[h] = rowArr[i] ? rowArr[i].trim() : "")
				);

				const keyVal = obj[uniqueKey];

				// Validation
				if (!keyVal) {
					if (validationErrors.length < MAX_VALIDATION_ERRORS) {
						validationErrors.push({
							row: realRowNumber,
							message: `Missing "${uniqueKey}"`,
						});
					}
					return;
				}
				if (seenKeys.has(keyVal)) {
					if (validationErrors.length < MAX_VALIDATION_ERRORS) {
						validationErrors.push({
							row: realRowNumber,
							message: `Duplicate "${keyVal}"`,
						});
					}
					return;
				}

				seenKeys.add(keyVal);
				batch.push(obj);
			});

			if (batch.length > 0) {
				const resStats = await processBatch(
					batch,
					uploadDoc._id,
					userId,
					uniqueKey,
					fileHash
				);
				stats.created += resStats.created;
				stats.updated += resStats.updated;
				stats.skipped += resStats.skipped;
			}

			currentRow += BATCH_SIZE;
		} catch (error) {
			console.error(
				`[GSheet Error] Batch failed at ${range}:`,
				error.message
			);
			throw new Error(`Google API Error: ${error.message}`);
		}
	}

	return { stats, validationErrors };
}

module.exports = processGoogleSheet;
