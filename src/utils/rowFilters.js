function normalizeFilterValue(value) {
	if (value == null) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function parseColumnFilters(rawFilters) {
	if (!rawFilters) return {};

	let parsed = rawFilters;
	if (typeof rawFilters === "string") {
		try {
			parsed = JSON.parse(rawFilters);
		} catch {
			return {};
		}
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(parsed)
			.filter(([, values]) => Array.isArray(values))
			.map(([column, values]) => [
				column,
				[...new Set(values.map(normalizeFilterValue))],
			])
	);
}

function buildRowFilter(
	baseFilter,
	rawFilters,
	allowedColumns = [],
	rowIdColumn = ""
) {
	const allowed = new Set(allowedColumns);
	const filters = parseColumnFilters(rawFilters);
	const clauses = [baseFilter];

	for (const [column, values] of Object.entries(filters)) {
		if (!allowed.has(column)) continue;

		const path =
			column === rowIdColumn ? "rowIndex" : `rowData.${column}`;
		const nonBlankValues = values.filter((value) => value !== "");
		const includesBlank = values.some((value) => value === "");
		const alternatives = [];

		if (nonBlankValues.length > 0) {
			const queryValues = nonBlankValues.flatMap((value) => {
				const numericValue = Number(value);
				return Number.isFinite(numericValue) &&
					String(numericValue) === value
					? [value, numericValue]
					: [value];
			});
			alternatives.push({
				[path]: { $in: [...new Set(queryValues)] },
			});
		}
		if (includesBlank) {
			alternatives.push(
				{ [path]: { $exists: false } },
				{ [path]: null },
				{ [path]: "" }
			);
		}

		// An explicitly empty selection means that no rows match.
		clauses.push(
			alternatives.length > 0
				? alternatives.length === 1
					? alternatives[0]
					: { $or: alternatives }
				: { _id: null }
		);
	}

	return clauses.length === 1 ? baseFilter : { $and: clauses };
}

function buildRowSort(
	column,
	direction,
	allowedColumns = [],
	rowIdColumn = "Row ID",
	defaultSort = {}
) {
	if (!column || !new Set(allowedColumns).has(column)) {
		return defaultSort;
	}

	const sortDirection = String(direction).toLowerCase() === "desc" ? -1 : 1;
	const sortPath = column === rowIdColumn ? "rowIndex" : `rowData.${column}`;
	return {
		[sortPath]: sortDirection,
		rowIndex: 1,
	};
}

function sortFilterValues(values = []) {
	return [...new Set(values.map(normalizeFilterValue))].sort((a, b) =>
		a.localeCompare(b, undefined, {
			numeric: true,
			sensitivity: "base",
		})
	);
}

module.exports = {
	buildRowFilter,
	buildRowSort,
	normalizeFilterValue,
	parseColumnFilters,
	sortFilterValues,
};
