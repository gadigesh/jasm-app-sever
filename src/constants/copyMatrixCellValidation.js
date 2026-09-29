/**
 * Copy Matrix cell rules run on upload / source replace / refresh parse.
 * Add new entries here to enforce more checks without changing call sites.
 */
const COPY_MATRIX_CELL_VALIDATION_MAX_ISSUES = 30;
const INVALID_HTTP_PROTOCOL_PATTERN =
	/\b(?:http|htt|htp|hp|htps|htts):\/\//i;

const COPY_MATRIX_CELL_CHECKS = [
	{
		id: "http-url",
		issue(value) {
			const match = String(value ?? "").match(
				INVALID_HTTP_PROTOCOL_PATTERN
			);
			return match ? `contains ${match[0]}` : "contains invalid URL";
		},
		test(value) {
			const text = String(value ?? "").trim();
			if (!text) return false;
			return INVALID_HTTP_PROTOCOL_PATTERN.test(text);
		},
	},
];

module.exports = {
	COPY_MATRIX_CELL_CHECKS,
	COPY_MATRIX_CELL_VALIDATION_MAX_ISSUES,
};
