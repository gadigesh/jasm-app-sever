const express = require("express");
const accountRouter = express.Router();
const Account = require("../models/account");
const { userAuth } = require("../middlewares/auth");
const {
	listAccountAssets,
	pickAssetName,
	pickAssetUrl,
} = require("../services/mindshareAssetLibrary");
const { formatApiError } = require("../utils/apiErrors");

const normalize = (value) => value.trim().toLowerCase();
const ACCOUNT_ASSET_CACHE_TTL_MS = 60 * 1000;
const accountAssetCache = new Map();

async function getAccountAssets(accountId, folder) {
	const key = `${String(accountId)}:${String(folder || "").trim()}`;
	const now = Date.now();
	const cached = accountAssetCache.get(key);
	if (cached && cached.expiresAt > now) {
		return cached.promise;
	}

	const promise = listAccountAssets(accountId, {
		folder,
		recursive: true,
		excludeAem: false,
	});
	accountAssetCache.set(key, {
		expiresAt: now + ACCOUNT_ASSET_CACHE_TTL_MS,
		promise,
	});

	try {
		return await promise;
	} catch (error) {
		accountAssetCache.delete(key);
		throw error;
	}
}

accountRouter.post("/accounts/create", userAuth, async (req, res) => {
	try {
		const { accountName, clientName, accountStatus, accountAdvId } =
			req.body;

		if (!accountName || !clientName) {
			return res.status(400).json({
				message: "Account name and client are required",
			});
		}

		const normalAccountName = normalize(accountName);
		const normalClientName = normalize(clientName);

		// 🔍 Check existing account
		const existingAccount = await Account.findOne({
			accountName: normalAccountName,
			clientName: normalClientName,
		});

		if (existingAccount) {
			return res.status(409).json({
				message: "Account already exists",
			});
		}

		// Create & save
		const account = await Account.create({
			accountName: normalAccountName,
			clientName: normalClientName,
			accountStatus,
			accountAdvId,
		});

		res.status(201).json({
			message: "Account created successfully",
			data: account,
		});
	} catch (err) {
		// Mongo duplicate key
		if (err.code === 11000) {
			return res.status(409).json({ message: "Account already exists" });
		}

		// Mongoose validation error
		if (err.name === "ValidationError") {
			// pick the first field with error safely
			const field = Object.keys(err.errors || {})[0];
			const message = field
				? `${field} should be either Active or Inactive`
				: err.message;
			return res.status(400).json({ message });
		}

		// fallback
		console.error(err); // log the real error for debugging
		return res.status(500).json({ message: "Failed to create account" });
	}
});

accountRouter.post("/switch-account", userAuth, async (req, res) => {
	const { accountId } = req.body;

	req.user.activeAccountId = accountId;
	await req.user.save();

	res.json({ message: "Active account updated" });
});

accountRouter.get("/accounts", userAuth, async (req, res) => {
	try {
		const { status } = req.query;
		const filter = {};

		if (status) {
			const VALID_STATUSES = ["Active", "Inactive"];
			const normalizedStatus =
				status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

			if (!VALID_STATUSES.includes(normalizedStatus)) {
				return res.status(400).json({
					message: `Invalid status filter. Allowed: ${VALID_STATUSES.join(
						", "
					)}`,
				});
			}

			filter.accountStatus = normalizedStatus;
		}

		const accounts = await Account.find(filter).sort({ updatedAt: -1 });

		res.status(200).json({
			message: "Accounts fetched successfully",
			data: accounts,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: "Failed to fetch accounts",
		});
	}
});

// Mindshare folders are account-scoped (same list for all CM/AS under an account).
accountRouter.get(
	"/accounts/:accountId/mindshare/folders",
	userAuth,
	async (req, res) => {
		try {
			const account = await Account.findById(req.params.accountId)
				.select("_id")
				.lean();
			if (!account) {
				return res.status(404).json({ message: "Account not found" });
			}
			// Share the same cached recursive library walk used by file preview.
			// This avoids loading every Mindshare folder twice.
			const result = await getAccountAssets(account._id, "");
			res.status(200).json({
				message: "Folders fetched",
				data: {
					accountAdvId: result.accountAdvId,
					folders: result.folders || [],
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to list folders"),
			});
		}
	}
);

accountRouter.get(
	"/accounts/:accountId/mindshare/assets",
	userAuth,
	async (req, res) => {
		try {
			const account = await Account.findById(req.params.accountId)
				.select("_id")
				.lean();
			if (!account) {
				return res.status(404).json({ message: "Account not found" });
			}

			const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
			const limit = Math.min(
				50,
				Math.max(1, Number.parseInt(req.query.limit, 10) || 10)
			);
			const folder = String(req.query.folder || "").trim();
			const search = String(req.query.search || "").trim().toLowerCase();
			const result = await getAccountAssets(account._id, folder);

			const seen = new Set();
			const files = result.assets
				.map((asset) => ({
					name: pickAssetName(asset),
					url: pickAssetUrl(asset),
					mimeType:
						asset?.mimeType ||
						asset?.contentType ||
						asset?.type ||
						"",
				}))
				.filter((asset) => {
					if (!asset.url || seen.has(asset.url)) return false;
					seen.add(asset.url);
					return true;
				})
				.map(({ name, url, mimeType }) => ({
					name,
					url,
					mimeType: String(mimeType || ""),
					isImage:
						String(mimeType).toLowerCase().startsWith("image/") ||
						/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(
							url
						) ||
						/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name),
				}))
				.filter((asset) => {
					if (!search) return true;
					return [asset.name, asset.mimeType, asset.url].some((value) =>
						String(value || "").toLowerCase().includes(search)
					);
				})
				.sort((left, right) =>
					String(left.name || "").localeCompare(String(right.name || ""))
				);

			const total = files.length;
			const totalPages = Math.max(1, Math.ceil(total / limit));
			const safePage = Math.min(page, totalPages);
			const start = (safePage - 1) * limit;

			res.status(200).json({
				message: "Account files fetched",
				data: {
					assets: files.slice(start, start + limit),
					pagination: {
						page: safePage,
						limit,
						total,
						totalPages,
					},
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to list account images"),
			});
		}
	}
);

module.exports = accountRouter;
