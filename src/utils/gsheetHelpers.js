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

module.exports = {
	extractSheetId,
	extractGid,
	resolveSheetFromMeta,
	listSheetsFromMeta,
};
