function extractSheetId(ref) {
	const match = ref.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
	return match ? match[1] : ref.trim();
}

function extractGid(ref) {
	if (!ref) return null;
	const match = String(ref).match(/[?#&]gid=(\d+)/);
	return match ? Number(match[1]) : null;
}

function resolveSheetFromMeta(sheets, gid) {
	if (!sheets?.length) return null;
	if (gid != null && gid !== "") {
		const target = Number(gid);
		const match = sheets.find(
			(s) => Number(s.properties?.sheetId) === target
		);
		if (match) return match;
	}
	return sheets[0];
}

function listSheetsFromMeta(sheets) {
	return (sheets || []).map((s) => ({
		sheetId: s.properties?.sheetId,
		title: s.properties?.title,
		rowCount: s.properties?.gridProperties?.rowCount ?? 0,
	}));
}

function isRowMetadataHidden(meta) {
	return Boolean(meta?.hiddenByUser || meta?.hiddenByFilter);
}

async function fetchHiddenRowFlags(
	sheetsApi,
	spreadsheetId,
	escapedTitle,
	rowCount
) {
	const flags = [];
	const chunkSize = 10000;

	for (let start = 1; start <= rowCount; start += chunkSize) {
		const end = Math.min(start + chunkSize - 1, rowCount);
		const meta = await sheetsApi.spreadsheets.get({
			spreadsheetId,
			ranges: [`${escapedTitle}!A${start}:A${end}`],
			includeGridData: true,
			fields: "sheets.data.rowMetadata(hiddenByUser,hiddenByFilter)",
		});
		const rowMetadata = meta.data.sheets?.[0]?.data?.[0]?.rowMetadata || [];
		for (let i = 0; i < end - start + 1; i++) {
			flags[start - 1 + i] = isRowMetadataHidden(rowMetadata[i]);
		}
	}

	return flags;
}

module.exports = {
	extractSheetId,
	extractGid,
	resolveSheetFromMeta,
	listSheetsFromMeta,
	fetchHiddenRowFlags,
};