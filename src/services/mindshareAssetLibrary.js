const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = process.env.MINDSHARE_API_BASE_URL;

function getBaseUrl() {
	return String(process.env.MINDSHARE_API_BASE_URL || DEFAULT_BASE_URL)
		.trim()
		.replace(/\/+$/, "");
}

function buildAuthHeaders() {
	const headers = {};
	const apiKey = String(
		process.env.MINDSHARE_API_KEY || process.env.MINDSHARE_API_TOKEN || ""
	).trim();
	const cookie = String(process.env.MINDSHARE_API_COOKIE || "").trim();
	const authHeader = String(process.env.MINDSHARE_AUTH_HEADER || "").trim();

	// Mindshare asset-library expects x-api-key (cookie/Bearer alone return 401).
	if (apiKey) {
		headers["x-api-key"] = apiKey.replace(/^session=/i, "");
	} else if (cookie) {
		const match = cookie.match(/(?:^|;\s*)session=([^;]+)/i);
		headers["x-api-key"] = (match ? match[1] : cookie).trim();
	}

	if (authHeader) {
		headers.Authorization = authHeader;
	} else if (apiKey && !headers["x-api-key"]) {
		headers.Authorization = apiKey.toLowerCase().startsWith("bearer ")
			? apiKey
			: `Bearer ${apiKey}`;
	}
	if (cookie) {
		headers.Cookie = cookie;
	}
	return headers;
}

async function resolveAccountAdvId(_accountId) {
	// Temporary hardcode while Mindshare account mapping is finalized.
	const advId = String(process.env.MINDSHARE_ACCOUNT_ID || "29509").trim();
	if (!advId) {
		const err = new Error("MINDSHARE_ACCOUNT_ID is not configured");
		err.statusCode = 500;
		throw err;
	}
	return advId;
}

function pickAssetUrl(asset) {
	if (!asset || typeof asset !== "object") return "";
	const candidates = [
		asset.url,
		asset.cdnUrl,
		asset.cdnURL,
		asset.cdn,
		asset.assetUrl,
		asset.assetURL,
		asset.fileUrl,
		asset.fileURL,
		asset.downloadUrl,
		asset.href,
		asset.link,
		asset.path,
		asset.src,
		asset.location,
		asset.publicUrl,
		asset.s3Url,
		asset.signedUrl,
	];
	for (const value of candidates) {
		if (value != null && String(value).trim()) {
			return String(value).trim();
		}
	}
	return "";
}

function pickAssetName(asset) {
	if (!asset || typeof asset !== "object") return "";
	const candidates = [
		asset.name,
		asset.assetName,
		asset.fileName,
		asset.filename,
		asset.title,
		asset.key,
		asset.prefix,
	];
	for (const value of candidates) {
		if (value != null && String(value).trim()) {
			return String(value).trim();
		}
	}
	const url = pickAssetUrl(asset);
	if (!url) return "";
	try {
		const pathname = new URL(url).pathname;
		return path.basename(pathname);
	} catch {
		return path.basename(url);
	}
}

function normalizeAssetList(payload) {
	if (!payload) return [];
	if (Array.isArray(payload)) return payload;
	// Mindshare asset-library returns { files, folders }
	if (Array.isArray(payload.files)) return payload.files;
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.assets)) return payload.assets;
	if (Array.isArray(payload.items)) return payload.items;
	if (Array.isArray(payload.results)) return payload.results;
	if (Array.isArray(payload.data?.assets)) return payload.data.assets;
	if (Array.isArray(payload.data?.files)) return payload.data.files;
	if (Array.isArray(payload.data?.items)) return payload.data.items;
	return [];
}

function stripExtension(name) {
	const value = String(name || "").trim();
	const idx = value.lastIndexOf(".");
	if (idx <= 0) return value;
	return value.slice(0, idx);
}

function namesMatch(candidate, needle) {
	const left = String(candidate || "").trim().toLowerCase();
	const right = String(needle || "").trim().toLowerCase();
	if (!left || !right) return false;
	if (left === right) return true;
	// "Reset" matches "Reset.png"
	if (stripExtension(left) === right || left === stripExtension(right)) {
		return true;
	}
	return false;
}

function matchAssetUrl(assets, prefix) {
	const needle = String(prefix || "").trim();
	if (!needle) return "";

	const normalized = normalizeAssetList(assets)
		.map((asset) => {
			const url = pickAssetUrl(asset);
			const name = pickAssetName(asset);
			let urlName = "";
			if (url) {
				try {
					urlName = path.basename(new URL(url).pathname);
				} catch {
					urlName = path.basename(url);
				}
			}
			return { name, urlName, url, raw: asset };
		})
		.filter((item) => item.url);

	// Prefer exact same asset name (API name or URL basename).
	const exact = normalized.find(
		(item) =>
			namesMatch(item.name, needle) || namesMatch(item.urlName, needle)
	);
	if (exact) return exact.url;

	// Prefix lookup often returns a single file with empty name — use it.
	if (normalized.length === 1) return normalized[0].url;

	return "";
}

async function parseJsonSafe(response) {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}

async function uploadAssetsToAccount(accountId, files = []) {
	const advId = await resolveAccountAdvId(accountId);
	if (!Array.isArray(files) || files.length === 0) {
		const err = new Error("At least one image or zip file is required");
		err.statusCode = 400;
		throw err;
	}

	const form = new FormData();
	for (const file of files) {
		const filePath = file.path;
		const fileName = file.originalname || path.basename(filePath);
		const buffer = fs.readFileSync(filePath);
		const blob = new Blob([buffer], {
			type: file.mimetype || "application/octet-stream",
		});
		form.append("file", blob, fileName);
		form.append("files", blob, fileName);
	}

	const response = await fetch(
		`${getBaseUrl()}/v2/accounts/${advId}/asset-library`,
		{
			method: "POST",
			headers: buildAuthHeaders(),
			body: form,
		}
	);
	const payload = await parseJsonSafe(response);
	if (!response.ok) {
		const err = new Error(
			payload?.message ||
				payload?.error ||
				`Mindshare upload failed (${response.status})`
		);
		err.statusCode = response.status >= 400 && response.status < 600
			? response.status
			: 502;
		err.data = payload;
		throw err;
	}

	return {
		accountAdvId: advId,
		uploaded: files.length,
		assets: normalizeAssetList(payload),
		raw: payload,
	};
}

function pickFirstUploadedCdnUrl(uploadResult) {
	const assets = normalizeAssetList(
		uploadResult?.assets?.length
			? uploadResult.assets
			: uploadResult?.raw || uploadResult
	);
	for (const asset of assets) {
		const url = pickAssetUrl(asset);
		if (url) return url;
	}

	const deepUrls = [];
	const walk = (value) => {
		if (value == null) return;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (/^https?:\/\//i.test(trimmed)) deepUrls.push(trimmed);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value === "object") {
			const preferred = pickAssetUrl(value);
			if (preferred) deepUrls.push(preferred);
			for (const nested of Object.values(value)) walk(nested);
		}
	};
	walk(uploadResult?.raw || uploadResult);
	return deepUrls[0] || "";
}

async function lookupCdnUrlByFilenames(accountId, names) {
	const uniqueNames = [
		...new Set(
			(names || [])
				.map((name) => String(name || "").trim())
				.filter(Boolean)
		),
	];
	if (!uniqueNames.length) return "";

	// Prefix lookup only — full library scans take many seconds.
	for (const name of uniqueNames) {
		try {
			const listed = await listAssetsByPrefix(accountId, name);
			if (listed?.matchedUrl) return listed.matchedUrl;
			const assets = listed?.assets || [];
			const matched = matchAssetUrl(assets, name);
			if (matched) return matched;
			const matchedBase = matchAssetUrl(assets, stripExtension(name));
			if (matchedBase) return matchedBase;
			if (assets.length === 1) {
				const only = pickAssetUrl(assets[0]);
				if (only) return only;
			}
		} catch {
			// try next name
		}
	}

	return "";
}

/**
 * Resolve a CDN URL for just-uploaded files.
 * Prefer upload response; otherwise one fast prefix lookup (optional short retry).
 */
async function resolveUploadedCdnUrl(
	accountId,
	uploadResult,
	uploadedFiles = [],
	_folder = ""
) {
	const fromResponse = pickFirstUploadedCdnUrl(uploadResult);
	if (fromResponse) return fromResponse;

	const names = (uploadedFiles || [])
		.map((file) =>
			String(file?.originalname || file?.name || "").trim()
		)
		.filter(Boolean);
	if (!names.length) return "";

	let url = await lookupCdnUrlByFilenames(accountId, names);
	if (url) return url;

	// Brief retry — Mindshare can lag slightly after upload.
	await new Promise((resolve) => setTimeout(resolve, 300));
	return (await lookupCdnUrlByFilenames(accountId, names)) || "";
}

async function listAssetsByPrefix(accountId, prefix) {
	const advId = await resolveAccountAdvId(accountId);
	const query = new URLSearchParams();
	if (prefix != null && String(prefix).trim()) {
		query.set("prefix", String(prefix).trim());
	}
	const url = `${getBaseUrl()}/v2/accounts/${advId}/asset-library${
		query.toString() ? `?${query.toString()}` : ""
	}`;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			...buildAuthHeaders(),
			Accept: "application/json",
		},
	});
	const payload = await parseJsonSafe(response);
	if (!response.ok) {
		const err = new Error(
			payload?.message ||
				payload?.error ||
				`Mindshare asset lookup failed (${response.status})`
		);
		err.statusCode = response.status >= 400 && response.status < 600
			? response.status
			: 502;
		err.data = payload;
		throw err;
	}

	const assets = normalizeAssetList(payload);
	const prefixValue = String(prefix || "").trim();
	let matchedUrl = matchAssetUrl(assets, prefixValue);

	// When prefix query returns one file (often with blank name), use its CDN URL.
	if (!matchedUrl && assets.length === 1) {
		matchedUrl = pickAssetUrl(assets[0]);
	}

	return {
		accountAdvId: advId,
		prefix: prefixValue,
		assets,
		matchedUrl,
		raw: payload,
	};
}

async function fetchAssetLibraryPage(advId, { prefix = "", nextKey = null } = {}) {
	const query = new URLSearchParams();
	if (prefix) query.set("prefix", prefix);
	if (nextKey) query.set("nextKey", String(nextKey));
	const url = `${getBaseUrl()}/v2/accounts/${advId}/asset-library${
		query.toString() ? `?${query.toString()}` : ""
	}`;
	const response = await fetch(url, {
		method: "GET",
		headers: {
			...buildAuthHeaders(),
			Accept: "application/json",
		},
	});
	const payload = await parseJsonSafe(response);
	if (!response.ok) {
		const err = new Error(
			payload?.message ||
				payload?.error ||
				`Mindshare asset lookup failed (${response.status})`
		);
		err.statusCode =
			response.status >= 400 && response.status < 600
				? response.status
				: 502;
		err.data = payload;
		throw err;
	}
	return payload;
}

function isRealAssetFile(asset) {
	const name = pickAssetName(asset);
	if (!name || name === ".dir") return false;
	const url = pickAssetUrl(asset);
	if (!url) return false;
	// Placeholder folder markers sometimes appear as files.
	if (String(url).endsWith("/.dir") || String(url).endsWith("/.dir/")) {
		return false;
	}
	return true;
}

function normalizeFolderName(folder) {
	if (folder == null) return "";
	if (typeof folder === "string") return folder.trim();
	if (typeof folder === "object") {
		return String(folder.name || folder.path || folder.prefix || "").trim();
	}
	return String(folder).trim();
}

function joinFolderPrefix(parentPrefix, folderName) {
	const parent = String(parentPrefix || "").replace(/\/+$/, "");
	const name = String(folderName || "").replace(/^\/+|\/+$/g, "");
	if (!name) return parent ? `${parent}/` : "";
	return parent ? `${parent}/${name}/` : `${name}/`;
}

function isAemFolderName(name) {
	return /^AEM[-_]/i.test(String(name || "").trim());
}

async function listAccountAssets(
	accountId,
	{ folder = "", recursive = true, excludeAem = false } = {}
) {
	const advId = await resolveAccountAdvId(accountId);
	const assets = [];
	const folders = [];
	const visited = new Set();
	const folderPrefix = String(folder || "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	const queue = [folderPrefix ? `${folderPrefix}/` : ""];
	let pages = 0;

	while (queue.length && pages < 200) {
		const prefix = queue.shift();
		const visitKey = prefix || "__root__";
		if (visited.has(visitKey)) continue;
		visited.add(visitKey);

		let nextKey = null;
		do {
			const payload = await fetchAssetLibraryPage(advId, {
				prefix,
				nextKey,
			});
			pages += 1;

			for (const file of normalizeAssetList(payload)) {
				if (isRealAssetFile(file)) assets.push(file);
			}

			if (recursive) {
				for (const folderEntry of payload?.folders || []) {
					const folderName = normalizeFolderName(folderEntry);
					if (!folderName) continue;
					if (excludeAem && isAemFolderName(folderName)) continue;
					const childPrefix = joinFolderPrefix(prefix, folderName);
					const childPath = childPrefix.replace(/\/+$/, "");
					if (childPath && !folders.includes(childPath)) {
						folders.push(childPath);
					}
					if (excludeAem && isAemFolderName(childPrefix.split("/")[0])) {
						continue;
					}
					if (childPrefix && !visited.has(childPrefix)) {
						queue.push(childPrefix);
					}
				}
			}

			nextKey = payload?.nextKey || null;
		} while (nextKey && pages < 200);
	}

	return {
		accountAdvId: advId,
		folder: folderPrefix,
		assets,
		folders: folders.sort((left, right) =>
			left.localeCompare(right, undefined, { sensitivity: "base" })
		),
	};
}

/**
 * Build a CDN index for Update URLs.
 * - Specific folder: that folder (+ nested).
 * - All (empty): walk library root-first then folders (root wins on name clash).
 */
async function buildUpdateImagesAssetIndex(accountId, folder = "") {
	const folderPath = String(folder || "").trim();

	if (folderPath) {
		const { assets } = await listAccountAssets(accountId, {
			folder: folderPath,
			recursive: true,
			excludeAem: false,
		});
		return {
			index: buildAssetUrlIndex(assets),
			librarySize: assets.length,
			folder: folderPath,
			scope: "folder",
		};
	}

	// All folders: BFS visits root files first, then each folder — first-wins
	// in buildAssetUrlIndex keeps outside-folder URLs as priority.
	const { assets } = await listAccountAssets(accountId, {
		folder: "",
		recursive: true,
		excludeAem: true,
	});

	return {
		index: buildAssetUrlIndex(assets),
		librarySize: assets.length,
		folder: null,
		scope: "all",
	};
}

/**
 * If index miss, try a direct prefix lookup so we don't leave the cell blank.
 */
async function resolveAssetUrlWithFallback(accountId, index, assetName) {
	const fromIndex = resolveAssetUrlByName(index, assetName);
	if (fromIndex) return fromIndex;

	const name = String(assetName || "").trim();
	if (!name) return "";

	try {
		const listed = await listAssetsByPrefix(accountId, name);
		if (listed?.matchedUrl) return listed.matchedUrl;
		const matched = matchAssetUrl(listed?.assets || [], name);
		if (matched) return matched;
		const matchedBase = matchAssetUrl(
			listed?.assets || [],
			stripExtension(name)
		);
		if (matchedBase) return matchedBase;
	} catch {
		return "";
	}
	return "";
}

async function listAccountFolders(accountId) {
	const advId = await resolveAccountAdvId(accountId);
	const folders = [];
	const visited = new Set();
	const queue = [""];
	let pages = 0;

	while (queue.length && pages < 200) {
		const prefix = queue.shift();
		const visitKey = prefix || "__root__";
		if (visited.has(visitKey)) continue;
		visited.add(visitKey);

		let nextKey = null;
		do {
			const payload = await fetchAssetLibraryPage(advId, {
				prefix,
				nextKey,
			});
			pages += 1;

			for (const folderEntry of payload?.folders || []) {
				const folderName = normalizeFolderName(folderEntry);
				if (!folderName) continue;
				const childPrefix = joinFolderPrefix(prefix, folderName);
				const folderPath = childPrefix.replace(/\/+$/, "");
				if (folderPath && !folders.includes(folderPath)) {
					folders.push(folderPath);
				}
				if (childPrefix && !visited.has(childPrefix)) {
					queue.push(childPrefix);
				}
			}

			nextKey = payload?.nextKey || null;
		} while (nextKey && pages < 200);
	}

	folders.sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: "base" })
	);

	return {
		accountAdvId: advId,
		folders,
	};
}

function buildAssetUrlIndex(assets = []) {
	const byName = new Map();
	const byBaseName = new Map();

	for (const asset of normalizeAssetList(assets)) {
		if (!isRealAssetFile(asset)) continue;
		const url = pickAssetUrl(asset);
		const name = pickAssetName(asset);
		let urlName = "";
		try {
			urlName = path.basename(new URL(url).pathname);
		} catch {
			urlName = path.basename(url);
		}

		for (const candidate of [name, urlName]) {
			const key = String(candidate || "")
				.trim()
				.toLowerCase();
			if (!key || key === ".dir") continue;
			if (!byName.has(key)) byName.set(key, url);
			const base = stripExtension(key).toLowerCase();
			if (base && !byBaseName.has(base)) byBaseName.set(base, url);
		}
	}

	return { byName, byBaseName };
}

function resolveAssetUrlByName(index, assetName) {
	const needle = String(assetName || "").trim();
	if (!needle || !index) return "";
	const key = needle.toLowerCase();
	if (index.byName.has(key)) return index.byName.get(key);
	const base = stripExtension(key).toLowerCase();
	if (base && index.byBaseName.has(base)) return index.byBaseName.get(base);
	// Cell has "Reset.png" but index only keyed "reset"
	if (base && index.byName.has(base)) return index.byName.get(base);
	// Cell may include a folder path: "Images/foo.png"
	const bare = path.basename(needle);
	if (bare && bare.toLowerCase() !== key) {
		return resolveAssetUrlByName(index, bare);
	}
	return "";
}

module.exports = {
	uploadAssetsToAccount,
	listAssetsByPrefix,
	listAccountAssets,
	listAccountFolders,
	buildAssetUrlIndex,
	buildUpdateImagesAssetIndex,
	resolveAssetUrlByName,
	resolveAssetUrlWithFallback,
	matchAssetUrl,
	resolveAccountAdvId,
	pickAssetUrl,
	pickAssetName,
	pickFirstUploadedCdnUrl,
	resolveUploadedCdnUrl,
};
