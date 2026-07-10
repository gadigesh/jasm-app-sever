const { isDuplicateNameError } = require("./nameValidation");

function formatMongoDuplicateKeyError(err) {
	const keyValue = err?.keyValue;
	if (!keyValue || typeof keyValue !== "object") {
		return "A duplicate value was found. Please fix duplicate row keys and try again.";
	}

	const entries = Object.entries(keyValue)
		.map(([field, value]) => `${field}: "${value}"`)
		.join(", ");

	return `Duplicate value found (${entries}). Please update the duplicate and try again.`;
}

function formatValidationError(err) {
	const messages = Object.values(err?.errors || {})
		.map((item) => item?.message)
		.filter(Boolean);

	if (messages.length) {
		return messages.join("; ");
	}

	return err?.message || null;
}

function formatApiError(err, fallback = "Something went wrong") {
	if (!err) return fallback;

	if (isDuplicateNameError(err)) {
		return err.message;
	}

	if (err.code === 11000 || err.code === 11001) {
		return formatMongoDuplicateKeyError(err);
	}

	if (err.name === "ValidationError") {
		return formatValidationError(err) || fallback;
	}

	if (typeof err.message === "string" && err.message.trim()) {
		return err.message.trim();
	}

	return fallback;
}

module.exports = {
	formatApiError,
	formatMongoDuplicateKeyError,
};
