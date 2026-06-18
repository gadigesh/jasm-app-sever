function getExcelCellValue(cellValue) {
	if (cellValue === null || cellValue === undefined) return "";
	if (typeof cellValue !== "object") return String(cellValue).trim();

	if (cellValue.richText && Array.isArray(cellValue.richText)) {
		return cellValue.richText
			.map((part) => part.text)
			.join("")
			.trim();
	}
	if (Array.isArray(cellValue)) {
		return cellValue
			.map((part) => (part.text ? part.text : ""))
			.join("")
			.trim();
	}
	if (cellValue.result !== undefined) return String(cellValue.result).trim();
	if (cellValue.text !== undefined) return String(cellValue.text).trim();
	if (cellValue instanceof Date) return cellValue.toISOString();

	return JSON.stringify(cellValue);
}

function getDiff(oldObj, newObj, uniqueKey) {
	const changes = [];
	for (const key in newObj) {
		if (key === uniqueKey) continue;
		const newVal = String(newObj[key]).trim();
		const oldVal = oldObj[key] ? String(oldObj[key]).trim() : "";

		if (newVal !== oldVal) {
			changes.push({ field: key, oldValue: oldVal, newValue: newVal });
		}
	}
	return changes;
}

module.exports = { getExcelCellValue, getDiff };
