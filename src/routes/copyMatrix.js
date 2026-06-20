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

			const formattedData = matrices.map((matrix) => ({
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
				assetUploadId: toIdString(matrix.assetUploadId),
			}));

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

copyMatrixRouter.get("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id).populate(
			"updatedBy",
			"firstName lastName email"
		);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const linkedUpload = await resolveLinkedAssetUpload(matrix);

		res.status(200).json({
			message: "Copy matrix fetched successfully",
			data: {
				_id: matrix._id,
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
				assetUploadId: toIdString(
					linkedUpload?._id || matrix.assetUploadId
				),
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
		res.status(500).json({ message: "Failed to update rows" });
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
			res.status(500).json({
				message: err.message || "Failed to save copy matrix",
			});
		}
	}
);

copyMatrixRouter.post("/copy-matrix/:id/finish", userAuth, async (req, res) => {
	try {
		const { name, uniqueColumn } = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const linkedUpload = await resolveLinkedAssetUpload(matrix);

		if (matrix.status !== "draft") {
			if (linkedUpload) {
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
			if (matrix.status !== "completed") {
				return res.status(400).json({
					message: "Only draft copy matrices can be finalized",
				});
			}
		}

		if (name?.trim()) matrix.name = name.trim();

		const prevStatus = matrix.status;
		let assetUpload = linkedUpload;
		let uniqueColumnNotice = null;

		if (!assetUpload) {
			const created = await createAssetSourceFromCopyMatrix(
				matrix,
				req.user._id,
				uniqueColumn
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
		}

		matrix.status = "completed";
		matrix.message = `Saved ${matrix.processedRows} rows successfully`;
		matrix.updatedBy = req.user._id;
		matrix.assetUploadId = assetUpload._id;
		await matrix.save();

		if (prevStatus === "draft") {
			await logCopyMatrixAction(matrix._id, req.user._id, "finish", [
				{ field: "status", oldValue: "draft", newValue: "completed" },
				{
					field: "assetUploadId",
					oldValue: null,
					newValue: String(assetUpload._id),
				},
			]);
		}

		res.status(200).json({
			message: uniqueColumnNotice
				? uniqueColumnNotice
				: "Copy matrix saved — continue editing asset source",
			data: {
				copyMatrixId: matrix._id,
				assetUploadId: toIdString(assetUpload._id),
				name: matrix.name,
				status: mapListStatus(matrix.status),
				processedRows: matrix.processedRows,
				uniqueColumn: assetUpload.uniqueColumn,
				uniqueColumnNotice,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: err.message || "Failed to save copy matrix",
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
		const { status } = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		if (status) {
			matrix.status = status;
		}
		matrix.updatedBy = req.user._id;
		await matrix.save();

		res.status(200).json({
			message: "Copy matrix updated successfully",
			data: matrix,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to update copy matrix" });
	}
});

module.exports = copyMatrixRouter;
