const { AUTO_ROW_ID_COLUMN } = require("../constants/copyMatrix");
const {
	COPY_MATRIX_CELL_CHECKS,
	COPY_MATRIX_CELL_VALIDATION_MAX_ISSUES,
} = require("../constants/copyMatrixCellValidation");

function findCopyMatrixCellViolations(
	rows,
	{ maxIssues = COPY_MATRIX_CELL_VALIDATION_MAX_ISSUES, checks = COPY_MATRIX_CELL_CHECKS } = {}
) {
	const violations = [];
	const list = Array.isArray(rows) ? rows : [];
	const rules = Array.isArray(checks) ? checks : [];

	for (let index = 0; index < list.length; index += 1) {
		const rowData = list[index] || {};
		const rowNumber = index + 1;
		for (const [column, value] of Object.entries(rowData)) {
			if (!column || column === AUTO_ROW_ID_COLUMN) continue;
			for (const rule of rules) {
				if (!rule?.test?.(value)) continue;
				const issue =
					typeof rule.issue === "function"
						? rule.issue(value)
						: rule.issue;
				violations.push({
					rowNumber,
					column,
					issue: issue || rule.id || "invalid value",
					ruleId: rule.id || "",
				});
				if (violations.length >= maxIssues) {
					return violations;
				}
				break;
			}
		}
	}

	return violations;
}

function formatCopyMatrixCellViolationSummary(violations = []) {
	if (!violations.length) return "";
	const lines = violations.map(
		(item) =>
			`${item.rowNumber} : ${item.column} : ${item.issue || "invalid value"}`
	);
	const suffix =
		violations.length >= COPY_MATRIX_CELL_VALIDATION_MAX_ISSUES
			? " (showing first 30 — fix these and re-upload)"
			: "";
	return `Please update and re-upload.${suffix}\nRow Number : Column Name : Issue\n${lines.join(
		"\n"
	)}`;
}

function assertCopyMatrixCellRules(rows, options = {}) {
	const violations = findCopyMatrixCellViolations(rows, options);
	if (!violations.length) return;
	const err = new Error(formatCopyMatrixCellViolationSummary(violations));
	err.statusCode = 400;
	err.cellViolations = violations;
	throw err;
}

module.exports = {
	findCopyMatrixCellViolations,
	formatCopyMatrixCellViolationSummary,
	assertCopyMatrixCellRules,
};
