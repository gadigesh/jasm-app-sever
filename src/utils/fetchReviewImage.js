const dns = require("dns").promises;
const net = require("net");

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_TYPES = new Set([
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/avif",
]);

const blockedHost = (hostname) => {
	const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
	return (
		!host ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host === "metadata.google.internal"
	);
};

const blockedAddress = (address) => {
	const family = net.isIP(address);
	if (family === 4) {
		const [a, b] = address.split(".").map(Number);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		return false;
	}
	if (family === 6) {
		const lower = address.toLowerCase();
		if (lower === "::1" || lower === "::") return true;
		if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
			return true;
		}
		if (lower.startsWith("::ffff:")) return blockedAddress(lower.slice(7));
	}
	return false;
};

const assertPublicUrl = async (rawUrl) => {
	let url;
	try {
		url = new URL(String(rawUrl || "").trim());
	} catch {
		const error = new Error("Image URL is not allowed");
		error.statusCode = 400;
		throw error;
	}
	if (url.protocol !== "https:" || url.username || url.password || blockedHost(url.hostname)) {
		const error = new Error("Image URL is not allowed");
		error.statusCode = 400;
		throw error;
	}
	if (net.isIP(url.hostname)) {
		if (blockedAddress(url.hostname)) {
			const error = new Error("Image URL is not allowed");
			error.statusCode = 400;
			throw error;
		}
		return url;
	}
	const records = await dns.lookup(url.hostname, { all: true });
	if (!records.length || records.some((record) => blockedAddress(record.address))) {
		const error = new Error("Image URL is not allowed");
		error.statusCode = 400;
		throw error;
	}
	return url;
};

const fetchReviewImage = async (rawUrl) => {
	let current = String(rawUrl || "").trim();
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const url = await assertPublicUrl(current);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 12000);
		let response;
		try {
			response = await fetch(url.href, {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: { Accept: "image/*,*/*;q=0.8" },
			});
		} catch {
			const error = new Error("Unable to load image");
			error.statusCode = 502;
			throw error;
		} finally {
			clearTimeout(timer);
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || hop === MAX_REDIRECTS) {
				const error = new Error("Unable to load image");
				error.statusCode = 502;
				throw error;
			}
			current = new URL(location, url).href;
			continue;
		}

		if (!response.ok) {
			const error = new Error("Unable to load image");
			error.statusCode = 502;
			throw error;
		}

		const contentType = String(response.headers.get("content-type") || "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (!ALLOWED_TYPES.has(contentType)) {
			const error = new Error("Unable to load image");
			error.statusCode = 415;
			throw error;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		if (!buffer.length || buffer.length > MAX_BYTES) {
			const error = new Error("Unable to load image");
			error.statusCode = 413;
			throw error;
		}
		return { buffer, contentType };
	}

	const error = new Error("Unable to load image");
	error.statusCode = 502;
	throw error;
};

module.exports = { fetchReviewImage };
