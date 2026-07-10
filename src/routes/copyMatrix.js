const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");
const AssetUpload = require("../models/assetUpload");
const storageService = require("../services/storage");
const { processCopyMatrix } = require("../services/copyMatrixProcessors");
const {
	createAssetSourceFromCopyMatrix,
	syncAssetSourceFromCopyMatrix,
	resolveLinkedAssetUpload,
} = require("../services/copyMatrixToAssetSource");
const {
	extractSheetId,
	extractGid,
	listSheetsFromMeta,
} = require("../utils/gsheetHelpers");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	injectRowIdIntoRowData,
} = require("../constants/copyMatrix");
const { google } = require("googleapis");
const {
	logCopyMatrixRowChanges,
	logCopyMatrixAction,
} = require("../services/copyMatrixHistory");
const { userAuth } = require("../middlewares/auth");
const { buildCsv, sendCsv } = require("../utils/csvExport");
const {
	assertUniqueCopyMatrixName,
	assertUniqueAssetSourceName,
	checkCopyMatrixNameAvailability,
	isDuplicateNameError,
	getDeletedAssetSourceNames,
} = require("../utils/nameValidation");
const { formatApiError } = require("../utils/apiErrors");

const copyMatrixRouter = express.Router();

const upload = multer({
	dest: "temp_uploads/",
	limits: { fileSize: 500 * 1024 * 1024 },
});

const gsheetAuth = new google.auth.GoogleAuth({
	keyFile: "google-credentials.json",
	scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

async function fetchSpreadsheetSheets(fileRef) {
	const sheetsApi = google.sheets({ version: "v4", auth: gsheetAuth });
	const spreadsheetId = extractSheetId(fileRef);
	const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
	return {
		spreadsheetId,
		sheets: listSheetsFromMeta(meta.data.sheets),
	};
}

const mapListStatus = (status) => {
	if (status === "completed" || status === "partial_success") return "Active";
	if (status === "failed") return "Inactive";
	if (status === "processing" || status === "pending" || status === "draft")
		return "Processing";
	return status;
};

const isFinalizedCopyMatrixStatus = (status) =>
	status === "completed" ||
	status === "partial_success" ||
	status === "Active";

async function resolveCopyMatrixAssetLink(matrix) {
	const linkedUpload = await resolveLinkedAssetUpload(matrix);
	if (!linkedUpload) {
		return {
			upload: null,
			hasActiveLinkedUpload: false,
			canRecreateAssetSource: isFinalizedCopyMatrixStatus(matrix.status),
			assetUploadId: null,
		};
	}

	const upload = await AssetUpload.findById(linkedUpload._id).select(
		"_id status assetName copyMatrixId"
	);
	if (!upload) {
		return {
			upload: null,
			hasActiveLinkedUpload: false,
			canRecreateAssetSource: isFinalizedCopyMatrixStatus(matrix.status),
			assetUploadId: null,
		};
	}

	const hasActiveLinkedUpload = upload.status !== "draft";

	return {
		upload,
		hasActiveLinkedUpload,
		canRecreateAssetSource:
			isFinalizedCopyMatrixStatus(matrix.status) &&
			!hasActiveLinkedUpload,
		assetUploadId: hasActiveLinkedUpload ? toIdString(upload._id) : null,
	};
}

const toIdString = (value) => (value ? String(value) : null);

async function applyCopyMatrixRowUpdates(matrix, rows, userId) {
	if (!Array.isArray(rows) || rows.length === 0) return;

	await logCopyMatrixRowChanges(matrix._id, rows, userId);

	for (const item of rows) {
		if (!item._id || !item.rowData) continue;
		const row = await CopyMatrixRow.findById(item._id);
		if (!row || String(row.copyMatrixId) !== String(matrix._id)) continue;
		row.rowData = item.rowData;
		await row.save();
	}

	matrix.updatedBy = userId;
	await matrix.save();
}

const handlePreviewUpload = async (req, res) => {
	const cleanup = () => {
		try {
			if (req.file && fs.existsSync(req.file.path)) {
				fs.unlinkSync(req.file.path);
			}
		} catch (err) {
			console.error("Cleanup error:", err);
		}
	};

	try {
		const { accountId, name, inputType, fileRef, sheetGid } = req.body;
		const isGSheet = inputType === "gsheet";

		if (!isGSheet && !req.file) {
			return res.status(400).json({ message: "No file uploaded" });
		}
		if (isGSheet && !fileRef?.trim()) {
			return res
				.status(400)
				.json({ message: "Google Sheet URL or ID is required" });
		}
		if (!accountId) {
			cleanup();
			return res.status(400).json({ message: "Account ID is required" });
		}

		let finalFileRef = isGSheet ? fileRef.trim() : "";
		let resolvedSheetGid = null;
		let sheetTitle = null;
		let fileHash = "";
		let fileName = "";
		let fileType = "";
		let matrixName = name?.trim() || "";

		if (!isGSheet) {
			const fileBuffer = fs.readFileSync(req.file.path);
			fileHash = crypto
				.createHash("md5")
				.update(fileBuffer)
				.digest("hex");
			finalFileRef = await storageService.saveFile(req.file);
			fileName = req.file.originalname;
			fileType = path
				.extname(req.file.originalname)
				.replace(".", "")
				.toLowerCase();
			if (!matrixName) {
				matrixName = fileName.replace(/\.[^.]+$/, "");
			}
		} else {
			const gidFromBody =
				sheetGid != null && sheetGid !== ""
					? Number(sheetGid)
					: null;
			const gidFromUrl = extractGid(fileRef);
			resolvedSheetGid =
				gidFromBody != null && !Number.isNaN(gidFromBody)
					? gidFromBody
					: gidFromUrl;

			try {
				const { sheets } = await fetchSpreadsheetSheets(fileRef);
				const selected = sheets.find(
					(s) => Number(s.sheetId) === Number(resolvedSheetGid)
				);
				if (selected) {
					sheetTitle = selected.title;
				} else if (sheets.length > 0) {
					resolvedSheetGid = sheets[0].sheetId;
					sheetTitle = sheets[0].title;
				}
			} catch (err) {
				console.warn("[CopyMatrix] Could not resolve sheet tab:", err.message);
			}

			fileHash = crypto
				.createHash("md5")
				.update(fileRef.trim() + "_" + Date.now())
				.digest("hex");
			fileName = sheetTitle || "Google Sheet";
			fileType = "GSheet";
			if (!matrixName) matrixName = sheetTitle || "Copy Matrix";
		}

		const matrix = await CopyMatrix.create({
			accountId,
			name: matrixName,
			fileName,
			inputType: inputType || "file",
			fileType,
			fileRef: finalFileRef,
			sheetGid: resolvedSheetGid,
			fileHash,
			status: "pending",
			updatedBy: req.user._id,
		});

		await processCopyMatrix(matrix._id, { draft: true });
		const finalMatrix = await CopyMatrix.findById(matrix._id);

		if (!finalMatrix || finalMatrix.status === "failed") {
			await CopyMatrix.findByIdAndDelete(matrix._id);
			await CopyMatrixRow.deleteMany({ copyMatrixId: matrix._id });
			return res.status(500).json({
				message:
					finalMatrix?.message ||
					"Could not process the file. Check the format and try again.",
			});
		}

		res.status(201).json({
			message: finalMatrix.message || "Preview ready",
			data: {
				copyMatrixId: matrix._id,
				name: finalMatrix.name,
				status: finalMatrix.status,
				processedRows: finalMatrix.processedRows,
				columns: finalMatrix.columns,
				fileName: finalMatrix.fileName,
				sheetGid: finalMatrix.sheetGid,
				sheetTitle: sheetTitle || finalMatrix.fileName,
			},
		});
	} catch (err) {
		cleanup();
		console.error("Copy matrix preview error:", err);
		res.status(500).json({
			message:
				err.message ||
				"Could not preview the copy matrix. Please check your file and try again.",
		});
	}
};

copyMatrixRouter.get(
	"/copy-matrix/list/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;

			const matrices = await CopyMatrix.find({
				accountId,
				status: { $nin: ["draft", "pending", "processing"] },
			})
				.populate("updatedBy", "firstName lastName email")
				.sort({ updatedAt: -1 });

			const missingIds = matrices
				.filter((m) => !m.assetUploadId)
				.map((m) => m._id);
			if (missingIds.length > 0) {
				const uploads = await AssetUpload.find({
					copyMatrixId: { $in: missingIds },
				})
					.select("_id copyMatrixId")
					.lean();
				const uploadByMatrix = new Map(
					uploads.map((u) => [String(u.copyMatrixId), u._id])
				);
				const bulkOps = [];
				for (const matrix of matrices) {
					if (matrix.assetUploadId) continue;
					const uploadId = uploadByMatrix.get(String(matrix._id));
					if (!uploadId) continue;
					matrix.assetUploadId = uploadId;
					bulkOps.push({
						updateOne: {
							filter: { _id: matrix._id },
							update: { $set: { assetUploadId: uploadId } },
						},
					});
				}
			if (bulkOps.length > 0) {
				await CopyMatrix.bulkWrite(bulkOps);
			}
		}

		const linkedIds = matrices
			.map((m) => m.assetUploadId)
			.filter(Boolean);
		const uploadStatusById = new Map();
		const uploadDetailsById = new Map();
		if (linkedIds.length > 0) {
			const validUploads = await AssetUpload.find({
				_id: { $in: linkedIds },
			})
				.select("_id status assetName")
				.lean();
			for (const upload of validUploads) {
				uploadStatusById.set(String(upload._id), upload.status);
				uploadDetailsById.set(String(upload._id), upload);
			}
			const validIds = new Set(validUploads.map((u) => String(u._id)));
			const staleOps = [];

			for (const matrix of matrices) {
				if (!matrix.assetUploadId) continue;
				if (validIds.has(String(matrix.assetUploadId))) continue;

				matrix.assetUploadId = null;
				staleOps.push({
					updateOne: {
						filter: { _id: matrix._id },
						update: { $unset: { assetUploadId: "" } },
					},
				});
			}

			if (staleOps.length > 0) {
				await CopyMatrix.bulkWrite(staleOps);
			}
		}

		const matrixIds = matrices.map((m) => m._id);
		const uploadsByCopyMatrixId = new Map();
		if (matrixIds.length > 0) {
			const cmUploads = await AssetUpload.find({
				copyMatrixId: { $in: matrixIds },
			})
				.select("_id copyMatrixId assetName status updatedAt")
				.sort({ updatedAt: -1 })
				.lean();

			for (const upload of cmUploads) {
				const key = String(upload.copyMatrixId);
				if (!uploadsByCopyMatrixId.has(key)) {
					uploadsByCopyMatrixId.set(key, []);
				}
				uploadsByCopyMatrixId.get(key).push({
					id: String(upload._id),
					name: upload.assetName,
					status: upload.status,
				});
			}
		}

		const formattedData = matrices.map((matrix) => {
			const linkedId = toIdString(matrix.assetUploadId);
			const linkedStatus = linkedId
				? uploadStatusById.get(linkedId)
				: null;
			const hasActiveLinkedUpload =
				Boolean(linkedId) &&
				linkedStatus &&
				linkedStatus !== "draft";

			const mappedAssetSources =
				uploadsByCopyMatrixId.get(String(matrix._id)) || [];

			const mappedAssetSource =
				mappedAssetSources.find((item) => item.status === "completed") ||
				mappedAssetSources.find((item) => item.status === "draft") ||
				null;

			const historicalMappedAssetSourceNames =
				getDeletedAssetSourceNames(matrix);

			return {
				_id: matrix._id,
				name: matrix.name,
				fileName: matrix.fileName,
				status: mapListStatus(matrix.status),
				rawStatus: matrix.status,
				rows: matrix.processedRows,
				createdBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedAt: matrix.updatedAt,
				assetUploadId: hasActiveLinkedUpload ? linkedId : null,
				mappedAssetSource,
				mappedAssetSources,
				historicalMappedAssetSourceNames,
				canRecreateAssetSource:
					isFinalizedCopyMatrixStatus(matrix.status) &&
					!hasActiveLinkedUpload,
			};
		});

			res.status(200).json({
				message: "Copy matrices fetched successfully",
				data: formattedData,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to fetch copy matrices" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/:id/rows",
	userAuth,
	async (req, res) => {
		try {
			const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
			const limit = Math.min(
				Math.max(parseInt(req.query.limit, 10) || 50, 1),
				200
			);
			const skip = (page - 1) * limit;

			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const [rows, total] = await Promise.all([
				CopyMatrixRow.find({ copyMatrixId: matrix._id })
					.sort({ rowIndex: 1 })
					.skip(skip)
					.limit(limit)
					.lean(),
				CopyMatrixRow.countDocuments({ copyMatrixId: matrix._id }),
			]);

			res.status(200).json({
				message: "Rows fetched successfully",
				data: {
					columns: ensureRowIdColumn(matrix.columns || []),
					rows: rows.map((row) => ({
						_id: row._id,
						rowIndex: row.rowIndex,
						...injectRowIdIntoRowData(row.rowData || {}, row.rowIndex),
					})),
					pagination: {
						page,
						limit,
						total,
						totalPages: Math.ceil(total / limit) || 1,
					},
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to fetch rows" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/:id/export",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const cmRows = await CopyMatrixRow.find({
				copyMatrixId: matrix._id,
			})
				.sort({ rowIndex: 1 })
				.lean();

			const columns = ensureRowIdColumn(matrix.columns || []);
			const rows = cmRows.map((row) =>
				injectRowIdIntoRowData(row.rowData || {}, row.rowIndex)
			);
			const csv = buildCsv(columns, rows);
			sendCsv(res, matrix.name || "copy-matrix", csv);
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to export copy matrix" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/check-name/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;
			const { name, excludeId, excludeUploadId } = req.query;

			const result = await checkCopyMatrixNameAvailability(
				accountId,
				name,
				excludeId || null,
				excludeUploadId || null
			);

			res.status(200).json({
				message: result.available
					? "Name is available"
					: result.message,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to check copy matrix name" });
		}
	}
);

copyMatrixRouter.get("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id).populate(
			"updatedBy",
			"firstName lastName email"
		);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const linkState = await resolveCopyMatrixAssetLink(matrix);

		const deletedAssetSourceNames = getDeletedAssetSourceNames(matrix);

		const cmUploads = await AssetUpload.find({
			copyMatrixId: matrix._id,
		})
			.select("_id assetName status")
			.sort({ updatedAt: -1 })
			.lean();

		const mappedAssetSources = cmUploads.map((upload) => ({
			id: String(upload._id),
			name: upload.assetName,
			status: upload.status,
		}));

		res.status(200).json({
			message: "Copy matrix fetched successfully",
			data: {
				_id: matrix._id,
				accountId: matrix.accountId,
				name: matrix.name,
				fileName: matrix.fileName,
				status: matrix.status,
				columns: ensureRowIdColumn(matrix.columns || []),
				defaultUniqueColumn: AUTO_ROW_ID_COLUMN,
				processedRows: matrix.processedRows,
				message: matrix.message,
				validationErrors: matrix.validationErrors,
				createdBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedAt: matrix.updatedAt,
				assetUploadId: linkState.assetUploadId,
				canRecreateAssetSource: linkState.canRecreateAssetSource,
				mappedAssetSources,
				deletedAssetSourceNames,
				lastDeletedAssetSourceName:
					deletedAssetSourceNames[deletedAssetSourceNames.length - 1] ||
					null,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch copy matrix" });
	}
});

copyMatrixRouter.post(
	"/copy-matrix/gsheet/sheets",
	userAuth,
	async (req, res) => {
		try {
			const { fileRef } = req.body;
			if (!fileRef?.trim()) {
				return res
					.status(400)
					.json({ message: "Google Sheet URL is required" });
			}

			const { spreadsheetId, sheets } = await fetchSpreadsheetSheets(
				fileRef
			);
			const defaultGid = extractGid(fileRef);

			res.status(200).json({
				message: "Sheets fetched successfully",
				data: {
					spreadsheetId,
					defaultGid,
					sheets,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message:
					err.message ||
					"Could not load Google Sheet tabs. Check the URL and sharing settings.",
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/preview",
	userAuth,
	upload.single("file"),
	handlePreviewUpload
);

copyMatrixRouter.post(
	"/copy-matrix/upload",
	userAuth,
	upload.single("file"),
	handlePreviewUpload
);

copyMatrixRouter.put("/copy-matrix/:id/rows", userAuth, async (req, res) => {
	try {
		const { rows } = req.body;
		if (!Array.isArray(rows) || rows.length === 0) {
			return res.status(400).json({ message: "Rows array is required" });
		}

		const matrix = await CopyMatrix.findById(req.params.id);
		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		await applyCopyMatrixRowUpdates(matrix, rows, req.user._id);

		const linkedUpload = await resolveLinkedAssetUpload(matrix);
		let assetUploadId = toIdString(linkedUpload?._id);
		if (assetUploadId) {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id
			);
			assetUploadId =
				toIdString(synced?.upload?._id) || assetUploadId;
			await logCopyMatrixAction(matrix._id, req.user._id, "sync", [
				{
					field: "syncedRows",
					oldValue: null,
					newValue: synced?.upload?.processedRows ?? 0,
				},
			]);
		}

		res.status(200).json({
			message: "Rows updated successfully",
			data: { assetUploadId },
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update rows"),
		});
	}
});

copyMatrixRouter.post(
	"/copy-matrix/:id/save-and-continue",
	userAuth,
	async (req, res) => {
		try {
			const { rows } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);

			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			if (Array.isArray(rows) && rows.length > 0) {
				await applyCopyMatrixRowUpdates(matrix, rows, req.user._id);
			}

			const freshMatrix = await CopyMatrix.findById(matrix._id);
			if (!freshMatrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const linkedUpload = await resolveLinkedAssetUpload(freshMatrix);
			if (!linkedUpload) {
				return res.status(404).json({
					message:
						"No linked asset source found. Finish the copy matrix first.",
				});
			}

			const synced = await syncAssetSourceFromCopyMatrix(
				freshMatrix._id,
				req.user._id
			);
			const assetUploadId =
				toIdString(synced?.upload?._id) ||
				toIdString(linkedUpload._id);

			if (Array.isArray(rows) && rows.length > 0) {
				await logCopyMatrixAction(freshMatrix._id, req.user._id, "sync", [
					{
						field: "syncedRows",
						oldValue: null,
						newValue: synced?.upload?.processedRows ?? 0,
					},
				]);
			}

			res.status(200).json({
				message: "Copy matrix saved — opening asset source",
				data: {
					assetUploadId,
					copyMatrixId: toIdString(freshMatrix._id),
					syncedAt: new Date().toISOString(),
				},
			});
		} catch (err) {
			console.error(err);
			if (isDuplicateNameError(err)) {
				return res.status(409).json({ message: err.message });
			}
			res.status(500).json({
				message: formatApiError(err, "Failed to save copy matrix"),
			});
		}
	}
);

copyMatrixRouter.post("/copy-matrix/:id/finish", userAuth, async (req, res) => {
	try {
		const {
			name,
			uniqueColumn,
			assetSourceName,
			forceNewAssetSource,
			finalizeOnly,
		} = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		if (matrix.status === "draft" && finalizeOnly) {
			if (name?.trim()) {
				matrix.name = name.trim();
			}

			await assertUniqueCopyMatrixName(
				matrix.accountId,
				matrix.name,
				matrix._id
			);

			const prevStatus = matrix.status;
			matrix.status = "completed";
			matrix.message = `Saved ${matrix.processedRows} rows successfully`;
			matrix.updatedBy = req.user._id;
			await matrix.save();

			try {
				await logCopyMatrixAction(matrix._id, req.user._id, "finish", [
					{
						field: "status",
						oldValue: prevStatus,
						newValue: "completed",
					},
				]);
			} catch (historyErr) {
				console.error("Copy matrix history log failed:", historyErr);
			}

			return res.status(200).json({
				message: "Copy matrix saved successfully",
				data: {
					copyMatrixId: matrix._id,
					assetUploadId: null,
					name: matrix.name,
					status: mapListStatus(matrix.status),
					processedRows: matrix.processedRows,
				},
			});
		}

		const linkState = await resolveCopyMatrixAssetLink(matrix);
		let linkedUpload = linkState.upload;

		let isRecreate =
			matrix.status !== "draft" &&
			isFinalizedCopyMatrixStatus(matrix.status) &&
			(!linkedUpload || linkedUpload.status === "draft");

		if (
			forceNewAssetSource &&
			matrix.status !== "draft" &&
			isFinalizedCopyMatrixStatus(matrix.status)
		) {
			await CopyMatrix.updateOne(
				{ _id: matrix._id },
				{ $unset: { assetUploadId: "" } }
			);
			matrix.assetUploadId = null;
			linkedUpload = null;
			isRecreate = true;
		}

		if (matrix.status !== "draft") {
			if (linkedUpload && !isRecreate) {
				return res.status(200).json({
					message:
						"Copy matrix already saved — continue editing asset source",
					data: {
						copyMatrixId: matrix._id,
						assetUploadId: toIdString(linkedUpload._id),
						name: matrix.name,
						status: mapListStatus(matrix.status),
						processedRows: matrix.processedRows,
					},
				});
			}
			if (!isFinalizedCopyMatrixStatus(matrix.status)) {
				return res.status(400).json({
					message: "Only draft copy matrices can be finalized",
				});
			}
		}

		if (!isRecreate) {
			if (name?.trim()) matrix.name = name.trim();

			await assertUniqueCopyMatrixName(
				matrix.accountId,
				matrix.name,
				matrix._id
			);

			const linkedUploadId = linkedUpload?._id || matrix.assetUploadId;
			await assertUniqueAssetSourceName(
				matrix.accountId,
				matrix.name,
				linkedUploadId
			);
		}

		const prevStatus = matrix.status;
		let assetUpload = forceNewAssetSource ? null : linkedUpload;
		let uniqueColumnNotice = null;

		if (!assetUpload) {
			const created = await createAssetSourceFromCopyMatrix(
				matrix,
				req.user._id,
				uniqueColumn,
				forceNewAssetSource ? "" : null
			);
			assetUpload = created.upload;
			uniqueColumnNotice = created.uniqueColumnNotice;
		} else if (prevStatus === "draft") {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id,
				uniqueColumn
			);
			assetUpload = synced.upload;
			uniqueColumnNotice = synced.uniqueColumnNotice;
		} else if (isRecreate && !forceNewAssetSource) {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id,
				uniqueColumn
			);
			assetUpload = synced.upload;
			uniqueColumnNotice = synced.uniqueColumnNotice;
		}

		if (!assetUpload) {
			return res.status(500).json({
				message: "Failed to create asset source from copy matrix",
			});
		}

		matrix.status = "completed";
		matrix.message = `Saved ${matrix.processedRows} rows successfully`;
		matrix.updatedBy = req.user._id;
		matrix.assetUploadId = assetUpload._id;
		await matrix.save();

		if (prevStatus === "draft" || isRecreate) {
			try {
				await logCopyMatrixAction(matrix._id, req.user._id, "finish", [
					{
						field: "status",
						oldValue: prevStatus,
						newValue: "completed",
					},
					{
						field: "assetUploadId",
						oldValue: null,
						newValue: String(assetUpload._id),
					},
					...(isRecreate
						? [
								{
									field: "assetSourceName",
									oldValue: null,
									newValue: assetUpload.assetName,
								},
							]
						: []),
				]);
			} catch (historyErr) {
				console.error("Copy matrix history log failed:", historyErr);
			}
		}

		res.status(200).json({
			message: uniqueColumnNotice
				? uniqueColumnNotice
				: forceNewAssetSource
				? "New asset source created from copy matrix"
				: isRecreate
				? "Asset source created from copy matrix"
				: "Copy matrix saved — continue editing asset source",
			data: {
				copyMatrixId: matrix._id,
				assetUploadId: toIdString(assetUpload._id),
				name: matrix.name,
				assetSourceName: assetUpload.assetName,
				status: mapListStatus(matrix.status),
				processedRows: matrix.processedRows,
				uniqueColumn: assetUpload.uniqueColumn,
				uniqueColumnNotice,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to save copy matrix"),
		});
	}
});

copyMatrixRouter.post("/copy-matrix/:id/clone", userAuth, async (req, res) => {
	try {
		const { name } = req.body;
		const trimmedName = String(name || "").trim();

		if (!trimmedName) {
			return res.status(400).json({ message: "Copy matrix name is required" });
		}

		const source = await CopyMatrix.findById(req.params.id);
		if (!source) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		await assertUniqueCopyMatrixName(
			source.accountId,
			trimmedName
		);

		const cloned = await CopyMatrix.create({
			accountId: source.accountId,
			name: trimmedName,
			fileName: source.fileName,
			inputType: source.inputType,
			fileType: source.fileType,
			fileRef: source.fileRef,
			sheetGid: source.sheetGid,
			fileHash: source.fileHash,
			columns: source.columns,
			status: source.status,
			processedRows: source.processedRows,
			message: source.message,
			errorLog: source.errorLog,
			validationErrors: source.validationErrors,
			updatedBy: req.user._id,
			assetUploadId: null,
			deletedAssetSourceNames: [],
			lastDeletedAssetSourceName: null,
		});

		const sourceRows = await CopyMatrixRow.find({
			copyMatrixId: source._id,
		})
			.sort({ rowIndex: 1 })
			.lean();

		if (sourceRows.length > 0) {
			await CopyMatrixRow.insertMany(
				sourceRows.map((row) => ({
					copyMatrixId: cloned._id,
					rowIndex: row.rowIndex,
					rowData: row.rowData,
				}))
			);
		}

		res.status(201).json({
			message: "Copy matrix cloned successfully",
			data: {
				_id: cloned._id,
				name: cloned.name,
				status: mapListStatus(cloned.status),
				processedRows: cloned.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: err.message || "Failed to clone copy matrix",
		});
	}
});

copyMatrixRouter.delete("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id);
		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		await CopyMatrixRow.deleteMany({ copyMatrixId: matrix._id });
		await matrix.deleteOne();

		res.status(200).json({ message: "Copy matrix deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to delete copy matrix" });
	}
});

copyMatrixRouter.put("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const { status, name } = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const hasLinkedAssetSources = await AssetUpload.exists({
			copyMatrixId: matrix._id,
			status: { $ne: "draft" },
		});

		const updates = { updatedBy: req.user._id };

		if (name?.trim()) {
			const trimmedName = name.trim();
			if (trimmedName !== matrix.name) {
				if (hasLinkedAssetSources) {
					return res.status(400).json({
						message:
							"Cannot rename a copy matrix that is synced with an asset source.",
					});
				}
				await assertUniqueCopyMatrixName(
					matrix.accountId,
					trimmedName,
					matrix._id
				);
				updates.name = trimmedName;
			}
		}

		if (status) {
			updates.status = status;
		}

		const updated = await CopyMatrix.findByIdAndUpdate(
			matrix._id,
			{ $set: updates },
			{ new: true }
		);

		res.status(200).json({
			message: "Copy matrix updated successfully",
			data: {
				_id: updated._id,
				accountId: updated.accountId,
				name: updated.name,
				status: updated.status,
				updatedAt: updated.updatedAt,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update copy matrix"),
		});
	}
});

module.exports = copyMatrixRouter;
