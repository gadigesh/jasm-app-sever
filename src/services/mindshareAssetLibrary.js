const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const unzipper = require("unzipper");

const DEFAULT_BASE_URL = process.env.MINDSHARE_API_BASE_URL;
const MAX_UPLOAD_BATCH_BYTES = 9 * 1024 * 1024;
const MAX_EXTRACTED_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const UPDATE_IMAGES_INDEX_CACHE_TTL_MS = 30 * 1000;
const updateImagesIndexCache = new Map();
const IMAGE_EXTENSIONS =
	/\.(?:avif|bmp|gif|jpe?g|png|svg|webp|tiff?)$/i;
const MIME_TYPES_BY_EXTENSION = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
	tif: "image/tiff",
	tiff: "image/tiff",
};

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

function isZipFile(file) {
	return (
		/application\/(?:x-)?zip/i.test(String(file?.mimetype || "")) ||
		/\.zip$/i.test(String(file?.originalname || file?.name || ""))
	);
}

function isImageFileName(fileName) {
	return IMAGE_EXTENSIONS.test(String(fileName || "").trim());
}

function mimeTypeForFileName(fileName) {
	const extension = path
		.extname(String(fileName || ""))
		.slice(1)
		.toLowerCase();
	return MIME_TYPES_BY_EXTENSION[extension] || "application/octet-stream";
}

function safeZipEntryName(entryName) {
	const normalized = path.posix.normalize(
		String(entryName || "").replace(/\\/g, "/")
	);
	if (
		!normalized ||
		normalized === "." ||
		normalized.startsWith("/") ||
		normalized.split("/").includes("..")
	) {
		return "";
	}
	return normalized;
}

async function extractZipImages(file, extractionDirectory) {
	const directory = await unzipper.Open.file(file.path);
	const extractedFiles = [];
	let extractedBytes = 0;

	for (const entry of directory.files) {
		if (entry.type !== "File") continue;

		const entryName = safeZipEntryName(entry.path);
		const fileName = path.posix.basename(entryName);
		if (
			!entryName ||
			!fileName ||
			fileName.startsWith(".") ||
			!isImageFileName(fileName)
		) {
			continue;
		}
		if (extractedFiles.length >= MAX_ZIP_ENTRIES) {
			const err = new Error(
				`ZIP contains more than ${MAX_ZIP_ENTRIES} image files`
			);
			err.statusCode = 413;
			throw err;
		}
		const targetPath = path.join(
			extractionDirectory,
			`${String(extractedFiles.length).padStart(4, "0")}-${fileName}`
		);
		let entryBytes = 0;
		const counter = new Transform({
			transform(chunk, _encoding, callback) {
				entryBytes += chunk.length;
				extractedBytes += chunk.length;
				if (extractedBytes > MAX_EXTRACTED_ZIP_BYTES) {
					const error = new Error(
						"Extracted ZIP contents exceed the 500 MB limit"
					);
					error.statusCode = 413;
					callback(error);
					return;
				}
				this.push(chunk);
				callback();
			},
		});

		try {
			await pipeline(
				entry.stream(),
				counter,
				fs.createWriteStream(targetPath)
			);
		} catch (error) {
			await fs.promises.unlink(targetPath).catch(() => {});
			throw error;
		}

		extractedFiles.push({
			path: targetPath,
			originalname: fileName,
			mimetype: mimeTypeForFileName(fileName),
			size: entryBytes,
			// Keep the ZIP's internal directories so frame paths such as
			// bg1/BG1/Frame1/image1 remain addressable after upload.
			relativeFolder:
				path.posix.dirname(entryName) === "."
					? ""
					: path.posix.dirname(entryName),
		});
	}

	if (extractedFiles.length === 0) {
		const err = new Error("ZIP does not contain any supported image files");
		err.statusCode = 400;
		throw err;
	}

	return extractedFiles;
}

async function getFileSize(file) {
	if (Number.isFinite(Number(file?.size))) return Number(file.size);
	try {
		const stats = await fs.promises.stat(file.path);
		return stats.size;
	} catch {
		return 0;
	}
}

function zipFolderName(file) {
	const originalName = path.basename(
		String(file?.originalname || file?.name || "")
	);
	const folderName = originalName.replace(/\.zip$/i, "").trim();
	if (!folderName || folderName === "." || folderName === "..") {
		const err = new Error("ZIP filename must provide a folder name");
		err.statusCode = 400;
		throw err;
	}
	return folderName;
}

function joinUploadFolder(parentFolder, childFolder) {
	const parent = String(parentFolder || "").trim().replace(/^\/+|\/+$/g, "");
	const child = String(childFolder || "").trim().replace(/^\/+|\/+$/g, "");
	if (!parent) return child;
	if (
		parent
			.split("/")
			.pop()
			.toLowerCase() === child.toLowerCase()
	) {
		return parent;
	}
	return child ? `${parent}/${child}` : parent;
}

function appendUploadFolder(parentFolder, childFolder) {
	const parent = String(parentFolder || "").trim().replace(/^\/+|\/+$/g, "");
	const child = String(childFolder || "").trim().replace(/^\/+|\/+$/g, "");
	if (!parent) return child;
	return child ? `${parent}/${child}` : parent;
}

async function expandUploadFiles(
	files,
	extractionDirectory,
	parentFolder = ""
) {
	const groups = [];
	for (const file of files) {
		if (isZipFile(file)) {
			const zipRootFolder = joinUploadFolder(
				parentFolder,
				zipFolderName(file)
			);
			const extractedFiles = await extractZipImages(
				file,
				extractionDirectory
			);
			const groupsByFolder = new Map();
			for (const extractedFile of extractedFiles) {
				const uploadFolder = appendUploadFolder(
					zipRootFolder,
					extractedFile.relativeFolder
				);
				const group = groupsByFolder.get(uploadFolder) || {
					files: [],
					folder: uploadFolder,
					rootFolder: zipRootFolder,
				};
				group.files.push(extractedFile);
				groupsByFolder.set(uploadFolder, group);
			}
			groups.push(...groupsByFolder.values());
		} else {
			groups.push({
				files: [
					{
						...file,
						size: await getFileSize(file),
					},
				],
				folder: parentFolder,
				rootFolder: parentFolder,
			});
		}
	}
	return groups;
}

function splitUploadBatches(files) {
	return files.map((file) => {
		const fileSize = Number(file.size) || 0;
		if (fileSize > MAX_UPLOAD_BATCH_BYTES) {
			const err = new Error(
				`"${file.originalname || "File"}" is too large for the asset library upload limit`
			);
			err.statusCode = 413;
			throw err;
		}
		// Mindshare accepts the multipart request but processes only the first
		// `files` part. Keep one extracted image per request so ZIP uploads do
		// not silently lose every image after the first one.
		return [file];
	});
}

async function uploadFileBatch(advId, files, folderPath) {
	const form = new FormData();
	if (folderPath) {
		// Support both folder naming conventions used by the asset-library API.
		form.append("folder", folderPath);
		form.append("path", folderPath);
	}

	for (const file of files) {
		const buffer = await fs.promises.readFile(file.path);
		const blob = new Blob([buffer], {
			type: file.mimetype || "application/octet-stream",
		});
		// Send each upload once. Adding both `file` and `files` duplicated the
		// payload and could push a valid request over Mindshare's 10 MB limit.
		form.append("files", blob, file.originalname || path.basename(file.path));
	}

	const query = folderPath
		? `?folder=${encodeURIComponent(folderPath)}&path=${encodeURIComponent(
				folderPath
		  )}`
		: "";
	const response = await fetch(
		`${getBaseUrl()}/v2/accounts/${advId}/asset-library${query}`,
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
		err.statusCode =
			response.status >= 400 && response.status < 600
				? response.status
				: 502;
		err.data = payload;
		throw err;
	}
	return {
		payload,
		assets: normalizeAssetList(payload),
	};
}

async function uploadAssetsToAccount(accountId, files = [], folder = "") {
	const advId = await resolveAccountAdvId(accountId);
	if (!Array.isArray(files) || files.length === 0) {
		const err = new Error("At least one image or zip file is required");
		err.statusCode = 400;
		throw err;
	}

	const extractionDirectory = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "jasm-asset-upload-")
	);
	try {
		const requestedFolder = String(folder || "").trim();
		const uploadGroups = await expandUploadFiles(
			files,
			extractionDirectory,
			requestedFolder
		);
		const uploadFiles = uploadGroups.flatMap((group) => group.files);
		const batchResults = [];

		for (const group of uploadGroups) {
			const batches = splitUploadBatches(group.files);
			for (const batch of batches) {
				batchResults.push(
					await uploadFileBatch(advId, batch, group.folder)
				);
			}
		}
		clearUpdateImagesAssetIndexCache(accountId);
		const rootFolderPaths = [
			...new Set(
				uploadGroups
					.map((group) => group.rootFolder || group.folder)
					.filter(Boolean)
			),
		];

		return {
			accountAdvId: advId,
			folder:
				rootFolderPaths.length === 1
					? rootFolderPaths[0]
					: requestedFolder,
			uploaded: uploadFiles.length,
			uploadedFiles: uploadGroups.flatMap((group) =>
				group.files.map((file) => ({
					originalname: file.originalname,
					mimetype: file.mimetype,
					size: file.size,
					folder: group.folder,
				}))
			),
			assets: batchResults.flatMap((result) => result.assets),
			raw:
				batchResults.length === 1
					? batchResults[0].payload
					: batchResults.map((result) => result.payload),
		};
	} finally {
		await fs.promises.rm(extractionDirectory, {
			recursive: true,
			force: true,
		});
	}
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
	const folderSet = new Set();
	const visited = new Set();
	const queued = new Set();
	const folderPrefix = String(folder || "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	const queue = [folderPrefix ? `${folderPrefix}/` : ""];
	queued.add(queue[0]);
	let pages = 0;
	const maxPages = 200;
	const concurrency = 8;

	const readPrefix = async (prefix) => {
		const prefixAssets = [];
		const childPrefixes = [];
		let nextKey = null;

		do {
			if (pages >= maxPages) break;
			pages += 1;
			const payload = await fetchAssetLibraryPage(advId, {
				prefix,
				nextKey,
			});

			for (const file of normalizeAssetList(payload)) {
				if (isRealAssetFile(file)) prefixAssets.push(file);
			}

			if (recursive) {
				for (const folderEntry of payload?.folders || []) {
					const folderName = normalizeFolderName(folderEntry);
					if (!folderName) continue;
					if (excludeAem && isAemFolderName(folderName)) continue;
					const childPrefix = joinFolderPrefix(prefix, folderName);
					const childPath = childPrefix.replace(/\/+$/, "");
					if (childPath && !folderSet.has(childPath)) {
						folderSet.add(childPath);
						folders.push(childPath);
					}
					if (excludeAem && isAemFolderName(childPrefix.split("/")[0])) {
						continue;
					}
					if (childPrefix) childPrefixes.push(childPrefix);
				}
			}

			nextKey = payload?.nextKey || null;
		} while (nextKey && pages < maxPages);

		return { prefixAssets, childPrefixes };
	};

	while (queue.length && pages < maxPages) {
		const batch = [];
		while (queue.length && batch.length < concurrency) {
			const prefix = queue.shift();
			const visitKey = prefix || "__root__";
			if (visited.has(visitKey)) continue;
			visited.add(visitKey);
			batch.push(prefix);
		}

		const results = await Promise.all(batch.map(readPrefix));
		for (const result of results) {
			assets.push(...result.prefixAssets);
			if (!recursive) continue;
			for (const childPrefix of result.childPrefixes) {
				if (!visited.has(childPrefix) && !queued.has(childPrefix)) {
					queued.add(childPrefix);
					queue.push(childPrefix);
				}
			}
		}
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
	const cacheKey = `${String(accountId)}:${folderPath}`;
	const now = Date.now();
	const cached = updateImagesIndexCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.promise;
	}

	const promise = (async () => {
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

		// All folders: BFS visits root files first, then each folder —
		// first-wins in buildAssetUrlIndex keeps outside-folder URLs as
		// priority.
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
	})();
	updateImagesIndexCache.set(cacheKey, {
		expiresAt: now + UPDATE_IMAGES_INDEX_CACHE_TTL_MS,
		promise,
	});
	try {
		return await promise;
	} catch (error) {
		updateImagesIndexCache.delete(cacheKey);
		throw error;
	}
}

function clearUpdateImagesAssetIndexCache(accountId) {
	const prefix = `${String(accountId)}:`;
	for (const key of updateImagesIndexCache.keys()) {
		if (key.startsWith(prefix)) updateImagesIndexCache.delete(key);
	}
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
	const byPathParts = new Map();
	const paths = [];
	const normalizeAssetPath = (value) => {
		let normalized = String(value || "").trim().replace(/\\/g, "/");
		try {
			normalized = decodeURIComponent(normalized);
		} catch {
			// Keep the original path when it contains malformed encoding.
		}
		return normalized
			.replace(/\s*\/\s*/g, "/")
			.replace(/^\/+|\/+$/g, "")
			.toLowerCase();
	};
	const pathCandidates = (value) => {
		const normalized = normalizeAssetPath(value);
		if (!normalized) return [];
		const parts = normalized.split("/").filter(Boolean);
		return parts.map((_part, index) => parts.slice(index).join("/"));
	};

	for (const asset of normalizeAssetList(assets)) {
		if (!isRealAssetFile(asset)) continue;
		const url = pickAssetUrl(asset);
		const name = pickAssetName(asset);
		const candidates = [
			...pathCandidates(name),
			...(() => {
				try {
					return pathCandidates(new URL(url).pathname);
				} catch {
					return pathCandidates(url);
				}
			})(),
		];

		for (const candidate of new Set(candidates)) {
			const key = normalizeAssetPath(candidate);
			if (!key || key === ".dir") continue;
			if (!byName.has(key)) byName.set(key, url);
			if (key.includes("/")) {
				paths.push({ key, url });
				const parts = key.split("/").filter(Boolean);
				const fileName = parts[parts.length - 1];
				const fileBaseName = stripExtension(fileName);
				for (const folderPart of parts.slice(0, -1)) {
					const partKey = `${folderPart}/${fileName}`;
					const basePartKey = `${folderPart}/${fileBaseName}`;
					if (!byPathParts.has(partKey)) {
						byPathParts.set(partKey, url);
					}
					if (!byPathParts.has(basePartKey)) {
						byPathParts.set(basePartKey, url);
					}
				}
			}
			const base = stripExtension(key).toLowerCase();
			if (base && !byBaseName.has(base)) byBaseName.set(base, url);
		}
	}

	return { byName, byBaseName, byPathParts, paths };
}

function resolveAssetUrlByName(index, assetName) {
	const needle = String(assetName || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/\s*\/\s*/g, "/");
	if (!needle || !index) return "";
	const key = needle.replace(/^\/+|\/+$/g, "").toLowerCase();
	if (index.byName.has(key)) return index.byName.get(key);
	const base = stripExtension(key).toLowerCase();
	if (base && index.byBaseName.has(base)) return index.byBaseName.get(base);
	// Cell has "Reset.png" but index only keyed "reset"
	if (base && index.byName.has(base)) return index.byName.get(base);
	if (index.byPathParts?.has(key)) return index.byPathParts.get(key);
	if (base && index.byPathParts?.has(base)) {
		return index.byPathParts.get(base);
	}
	// A target column can identify a folder/frame while the reference cell
	// contains only the filename (for example, `BG1` + `image1`). Allow the
	// requested path parts to appear in order with frame folders between them.
	if (key.includes("/") && Array.isArray(index.paths)) {
		const needleParts = key.split("/").filter(Boolean);
		let bestMatch = null;
		let bestScore = -Infinity;
		for (const entry of index.paths) {
			const assetParts = entry.key.split("/").filter(Boolean);
			let needleIndex = 0;
			for (let assetIndex = 0; assetIndex < assetParts.length; assetIndex += 1) {
				const assetPart = assetParts[assetIndex];
				const comparableAssetPart =
					assetIndex === assetParts.length - 1
						? stripExtension(assetPart)
						: assetPart;
				if (comparableAssetPart === needleParts[needleIndex]) {
					needleIndex += 1;
					if (needleIndex === needleParts.length) break;
				}
			}
			if (needleIndex !== needleParts.length) continue;
			const score =
				needleParts.length * 100 -
				(assetParts.length - needleParts.length);
			if (score > bestScore) {
				bestScore = score;
				bestMatch = entry.url;
			}
		}
		if (bestMatch) return bestMatch;
	}
	// A frame path may be present in the cell. Only fall back to its
	// basename after trying the complete path and every normalized suffix.
	const pathParts = key.split("/").filter(Boolean);
	for (let indexInPath = 1; indexInPath < pathParts.length; indexInPath += 1) {
		const suffix = pathParts.slice(indexInPath).join("/");
		const suffixUrl = resolveAssetUrlByName(index, suffix);
		if (suffixUrl) return suffixUrl;
	}
	const bare = path.posix.basename(needle);
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
