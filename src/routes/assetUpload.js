const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

// Models & Services
const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const storageService = require("../services/storage");
const { processUpload } = require("../services/processors");
const { updateAssetWithHistory } = require("../services/assetServices");
const { userAuth } = require("../middlewares/auth");
const { buildCsv, sendCsv } = require("../utils/csvExport");
const {
	assertUniqueAssetSourceName,
	checkAssetSourceNameAvailability,
	getDeletedAssetSourceNames,
	isDuplicateNameError,
} = require("../utils/nameValidation");
const { formatApiError } = require("../utils/apiErrors");

const assetRouter = express.Router();

// Multer Config (Temp Storage)
const upload = multer({
	dest: "temp_uploads/",
	limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

function parseCopyMatrixIdFromFileRef(fileRef) {
	const match = String(fileRef || "").match(/^copy-matrix:\/\/(.+)$/);
	return match?.[1] || null;
}

function collectMatrixIdsForAsset(asset) {
	const ids = new Set();
	if (asset.copyMatrixId) {
		ids.add(String(asset.copyMatrixId));
	}
	const fromFileRef = parseCopyMatrixIdFromFileRef(asset.fileRef);
	if (fromFileRef) {
		ids.add(fromFileRef);
	}
	return [...ids];
}

// =====================================================================
// ROUTE 1: GET ASSET LIST
// Usage: When user clicks an Account Card (e.g., Nike)
// URL: GET /api/assets/list/:accountId
// =====================================================================
assetRouter.get("/list/:accountId", userAuth, async (req, res) => {
	try {
		const { accountId } = req.params;

		// Fetch uploads linked to this specific Account (exclude drafts)
		const assets = await AssetUpload.find({
			accountId,
			status: { $ne: "draft" },
		})
			.populate("uploadedBy", "firstName lastName email")
			.sort({ updatedAt: -1 })
			.lean();

		const uploadIds = assets.map((asset) => asset._id);
		const copyMatrixIds = [
			...new Set(assets.flatMap((asset) => collectMatrixIdsForAsset(asset))),
		];

		const matricesById = new Map();
		const matricesByUploadId = new Map();

		if (copyMatrixIds.length > 0) {
			const objectIds = copyMatrixIds
				.filter((id) => mongoose.Types.ObjectId.isValid(id))
				.map((id) => new mongoose.Types.ObjectId(id));

			const byId = await CopyMatrix.find({
				_id: { $in: objectIds },
				accountId,
			})
				.select("_id name status")
				.lean();

			for (const matrix of byId) {
				matricesById.set(String(matrix._id), {
					id: String(matrix._id),
					name: matrix.name,
					status: matrix.status,
				});
			}
		}

		if (uploadIds.length > 0) {
			const byUpload = await CopyMatrix.find({
				assetUploadId: { $in: uploadIds },
				accountId,
			})
				.select("_id name status assetUploadId")
				.lean();

			for (const matrix of byUpload) {
				matricesByUploadId.set(String(matrix.assetUploadId), {
					id: String(matrix._id),
					name: matrix.name,
					status: matrix.status,
				});
			}
		}

		const formattedData = assets.map((asset) => {
			const userName = asset.uploadedBy
				? asset.uploadedBy.firstName
				: "Unknown";

			const mappedCopyMatrices = [];
			const seenMatrixIds = new Set();

			const addMatrix = (matrix) => {
				if (!matrix?.id || seenMatrixIds.has(matrix.id)) return;
				seenMatrixIds.add(matrix.id);
				mappedCopyMatrices.push(matrix);
			};

			if (asset.copyMatrixId) {
				addMatrix(matricesById.get(String(asset.copyMatrixId)));
			}

			const fileRefMatrixId = parseCopyMatrixIdFromFileRef(asset.fileRef);
			if (fileRefMatrixId) {
				addMatrix(matricesById.get(fileRefMatrixId));
			}

			addMatrix(matricesByUploadId.get(String(asset._id)));

			const mappedCopyMatrix = mappedCopyMatrices[0] || null;

			return {
				_id: asset._id,
				name: asset.assetName,
				fileName: asset.fileName,
				status: asset.status,
				rows: asset.processedRows,
				uploadedBy: userName,
				updatedBy: userName,
				updatedAt: asset.updatedAt,
				copyMatrixId: asset.copyMatrixId
					? String(asset.copyMatrixId)
					: null,
				mappedCopyMatrix,
				mappedCopyMatrices,
			};
		});

		res.status(200).json({
			message: "Assets fetched successfully",
			data: formattedData,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch asset list" });
	}
});

// =====================================================================
// ROUTE 2: UPLOAD NEW ASSET
// Usage: When user clicks "Add New" inside the Account View
// URL: POST /api/assets/upload
// =====================================================================
assetRouter.post(
	"/upload",
	userAuth,
	upload.single("file"),
	async (req, res) => {
		// Cleanup helper in case of error (safely unlinking only if temp file still exists)
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
			// 1. Extract Data from Frontend Form
			const { accountId, assetName, uniqueColumn, inputType, fileRef } =
				req.body;
			const isGSheet = inputType === "gsheet";

			// 2. Validation
			if (!isGSheet && !req.file) {
				return res.status(400).json({ message: "No file uploaded" });
			}
			if (isGSheet && !fileRef) {
				return res
					.status(400)
					.json({ message: "Google Sheet ID (fileRef) is required" });
			}
			if (!accountId) {
				cleanup();
				return res
					.status(400)
					.json({ message: "Account ID is required" });
			}
			if (!uniqueColumn) {
				cleanup();
				return res.status(400).json({
					message: "Unique Column (Primary Key) is required",
				});
			}

			let finalFileRef = isGSheet ? fileRef.trim() : "";
			let fileHash = "";
			let fileName = "";
			let fileType = "";

			if (!isGSheet) {
				// Compute MD5 hash of the uploaded file
				const fileBuffer = fs.readFileSync(req.file.path);
				fileHash = crypto
					.createHash("md5")
					.update(fileBuffer)
					.digest("hex");

				// Move file to permanent storage and get the final reference path
				finalFileRef = await storageService.saveFile(req.file);

				fileName = req.file.originalname;
				fileType = path
					.extname(req.file.originalname)
					.replace(".", "")
					.toLowerCase();
			} else {
				// For Google Sheets, generate a unique hash based on spreadsheetId and current timestamp
				fileHash = crypto
					.createHash("md5")
					.update(fileRef.trim() + "_" + Date.now())
					.digest("hex");
				fileName = assetName || "Google Sheet";
				fileType = "GSheet";
			}

			const resolvedAssetName = (
				assetName?.trim() ||
				fileName.replace(/\.[^.]+$/, "") ||
				fileName
			).trim();

			if (!resolvedAssetName) {
				cleanup();
				return res.status(400).json({
					message: "Asset source name is required",
				});
			}

			await assertUniqueAssetSourceName(accountId, resolvedAssetName);

			// 3. Create the Database Record (Pending Status)
			const newUpload = await AssetUpload.create({
				accountId: accountId, // 🔗 LINK TO ACCOUNT
				assetName: resolvedAssetName,
				uniqueColumn: uniqueColumn.trim(), // 🔑 The column selected by user
				fileName,
				inputType: inputType || "file",
				fileType,
				fileRef: finalFileRef,
				status: "pending",
				fileHash,
				uploadedBy: req.user._id, // From userAuth middleware
			});

			// 4. Trigger Processing (Awaited to capture actual processing result)
			await processUpload(newUpload._id);

			// Fetch the updated document to check the status
			const finalUpload = await AssetUpload.findById(newUpload._id);

			if (!finalUpload || finalUpload.status === "failed") {
				return res.status(500).json({
					message:
						finalUpload?.message ||
						"Could not process the file. Check the format and try again.",
				});
			}

			// 5. Respond to UI with final state
			res.status(201).json({
				message: finalUpload.message || "Upload completed successfully",
				data: {
					uploadId: newUpload._id,
					status: finalUpload.status,
					processedRows: finalUpload.processedRows,
					validationErrors: finalUpload.validationErrors,
				},
			});
		} catch (err) {
			cleanup();
			console.error("Upload Error:", err);
			if (isDuplicateNameError(err)) {
				return res.status(409).json({ message: err.message });
			}
			res.status(500).json({
				message:
					err.message ||
					"File upload failed. Please check your file and try again.",
			});
		}
	},
);

// =====================================================================
// ROUTE 3: RETRY / REPLACE UPLOAD FILE
// Usage: When user replaces the spreadsheet for an existing upload record
// URL: PUT /retry/:id
// =====================================================================
assetRouter.put(
	"/retry/:id",
	userAuth,
	upload.single("file"),
	async (req, res) => {
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
			const { id } = req.params;
			if (!req.file) {
				return res.status(400).json({ message: "No file uploaded" });
			}

			const assetUpload = await AssetUpload.findById(id);
			if (!assetUpload) {
				cleanup();
				return res
					.status(404)
					.json({ message: "Asset upload record not found" });
			}

			// Compute MD5 hash of the uploaded file
			const fileBuffer = fs.readFileSync(req.file.path);
			const fileHash = crypto
				.createHash("md5")
				.update(fileBuffer)
				.digest("hex");

			// Move file to permanent storage and get the final reference path
			const finalFileRef = await storageService.saveFile(req.file);

			const fileName = req.file.originalname;
			const fileType = path
				.extname(req.file.originalname)
				.replace(".", "")
				.toLowerCase();

			// Update the Database Record (Pending Status)
			assetUpload.fileName = fileName;
			assetUpload.fileType = fileType;
			assetUpload.fileRef = finalFileRef;
			assetUpload.status = "pending";
			assetUpload.fileHash = fileHash;
			assetUpload.uploadedBy = req.user._id;

			await assetUpload.save();

			// Trigger Processing (Awaited to capture actual processing result)
			await processUpload(assetUpload._id);

			// Fetch the updated document to check the status
			const finalUpload = await AssetUpload.findById(assetUpload._id);

			if (!finalUpload || finalUpload.status === "failed") {
				return res.status(500).json({
					message:
						finalUpload?.message ||
						"Could not process the file. Check the format and try again.",
				});
			}

			// Respond to UI with final state
			res.status(200).json({
				message:
					finalUpload.message ||
					"Upload updated and processed successfully",
				data: {
					uploadId: assetUpload._id,
					status: finalUpload.status,
					processedRows: finalUpload.processedRows,
					validationErrors: finalUpload.validationErrors,
				},
			});
		} catch (err) {
			cleanup();
			console.error("Retry Upload Error:", err);
			res.status(500).json({
				message:
					err.message ||
					"File update failed. Please check your file and try again.",
			});
		}
	},
);

assetRouter.get(
	"/source/check-name/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;
			const { name, excludeId } = req.query;

			const result = await checkAssetSourceNameAvailability(
				accountId,
				name,
				excludeId || null
			);

			res.status(200).json({
				message: result.available
					? "Name is available"
					: result.message,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to check asset source name" });
		}
	}
);

// =====================================================================
// ROUTE 4b: UPDATE ASSET SOURCE METADATA (draft name)
// URL: PUT /source/:id
// =====================================================================
assetRouter.put("/source/:id", userAuth, async (req, res) => {
	try {
		const { assetName } = req.body;
		const upload = await AssetUpload.findById(req.params.id);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}
		if (upload.status !== "draft") {
			return res.status(400).json({
				message: "Asset source name can only be set while in draft",
			});
		}
		if (!assetName?.trim()) {
			return res
				.status(400)
				.json({ message: "Asset source name is required" });
		}

		await assertUniqueAssetSourceName(
			upload.accountId,
			assetName.trim(),
			upload._id
		);

		upload.assetName = assetName.trim();
		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({
			message: "Asset source name saved",
			data: {
				_id: upload._id,
				name: upload.assetName,
				status: upload.status,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update asset source"),
		});
	}
});

assetRouter.get("/source/:id/export", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const sortOrder = upload.copyMatrixId
			? { cmRowIndex: 1, primaryKey: 1 }
			: { primaryKey: 1 };

		const rows = await AssetSource.find({
			uploadId: upload._id,
			isDeleted: false,
		})
			.sort(sortOrder)
			.lean();

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: rows[0]?.rowData
				? Object.keys(rows[0].rowData)
				: [];

		const dataRows = rows.map((row) => row.rowData || {});
		const csv = buildCsv(columns, dataRows);
		sendCsv(
			res,
			upload.assetName || upload.fileName || "asset-source",
			csv
		);
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to export asset source" });
	}
});

// =====================================================================
// ROUTE 4: GET ASSET SOURCE DETAIL (draft or completed)
// URL: GET /source/:id
// =====================================================================
assetRouter.get("/source/:id", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id).populate(
			"uploadedBy",
			"firstName lastName email"
		);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: await AssetSource.findOne({ uploadId: upload._id }).then(
						(row) =>
							row?.rowData
								? Object.keys(row.rowData)
								: []
				  );

		let deletedAssetSourceNames = [];
		if (upload.copyMatrixId) {
			const linkedMatrix = await CopyMatrix.findById(
				upload.copyMatrixId
			).select("deletedAssetSourceNames lastDeletedAssetSourceName");
			deletedAssetSourceNames = getDeletedAssetSourceNames(linkedMatrix);
		}

		res.status(200).json({
			message: "Asset source fetched successfully",
			data: {
				_id: upload._id,
				accountId: upload.accountId,
				name: upload.assetName,
				fileName: upload.fileName,
				status: upload.status,
				uniqueColumn: upload.uniqueColumn,
				columns,
				processedRows: upload.processedRows,
				copyMatrixId: upload.copyMatrixId,
				deletedAssetSourceNames,
				lastDeletedAssetSourceName:
					deletedAssetSourceNames[deletedAssetSourceNames.length - 1] ||
					null,
				updatedBy: upload.uploadedBy
					? upload.uploadedBy.firstName
					: "Unknown",
				updatedAt: upload.updatedAt,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch asset source" });
	}
});

// =====================================================================
// ROUTE 5: GET ASSET SOURCE ROWS (paginated)
// URL: GET /source/:id/rows
// =====================================================================
assetRouter.get("/source/:id/rows", userAuth, async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
		const limit = Math.min(
			Math.max(parseInt(req.query.limit, 10) || 50, 1),
			200
		);
		const skip = (page - 1) * limit;

		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const filter = { uploadId: upload._id, isDeleted: false };

		const sortOrder = upload.copyMatrixId
			? { cmRowIndex: 1, primaryKey: 1 }
			: { primaryKey: 1 };

		const [rows, total] = await Promise.all([
			AssetSource.find(filter).sort(sortOrder).skip(skip).limit(limit).lean(),
			AssetSource.countDocuments(filter),
		]);

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: rows[0]?.rowData
				? Object.keys(rows[0].rowData)
				: [];

		res.status(200).json({
			message: "Rows fetched successfully",
			data: {
				columns,
				rows: rows.map((row, idx) => ({
					_id: row._id,
					rowIndex: row.cmRowIndex ?? skip + idx + 1,
					primaryKey: row.primaryKey,
					...row.rowData,
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
});

// =====================================================================
// ROUTE 6: UPDATE ASSET SOURCE ROWS (bulk edit in preview)
// URL: PUT /source/:id/rows
// =====================================================================
assetRouter.put("/source/:id/rows", userAuth, async (req, res) => {
	try {
		const { rows } = req.body;
		if (!Array.isArray(rows) || rows.length === 0) {
			return res.status(400).json({ message: "Rows array is required" });
		}

		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const keyColumn = upload.uniqueColumn;

		for (const item of rows) {
			if (!item._id || !item.rowData) continue;

			const asset = await AssetSource.findById(item._id);
			if (!asset || String(asset.uploadId) !== String(upload._id)) continue;

			asset.rowData = item.rowData;
			if (item.rowData[keyColumn] != null) {
				asset.primaryKey = String(item.rowData[keyColumn]).trim();
			}
			await asset.save();
		}

		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({ message: "Rows updated successfully" });
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

// =====================================================================
// ROUTE 7: FINISH ASSET SOURCE DRAFT
// URL: POST /source/:id/finish
// =====================================================================
assetRouter.post("/source/:id/finish", userAuth, async (req, res) => {
	try {
		const { assetName } = req.body;
		const upload = await AssetUpload.findById(req.params.id);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}
		if (upload.status !== "draft") {
			return res
				.status(400)
				.json({ message: "Only draft asset sources can be finalized" });
		}

		if (assetName?.trim()) {
			const trimmedName = assetName.trim();
			await assertUniqueAssetSourceName(
				upload.accountId,
				trimmedName,
				upload._id,
				upload.copyMatrixId
			);
			upload.assetName = trimmedName;
		} else if (!upload.assetName?.trim()) {
			return res
				.status(400)
				.json({ message: "Asset source name is required" });
		} else {
			await assertUniqueAssetSourceName(
				upload.accountId,
				upload.assetName,
				upload._id,
				upload.copyMatrixId
			);
		}
		upload.status = "completed";
		upload.message = `Asset source saved — ${upload.processedRows} rows`;
		upload.uploadedBy = req.user._id;
		await upload.save();

		await AssetSource.updateMany(
			{ uploadId: upload._id },
			{ $set: { importStatus: "ACTIVE" } }
		);

		res.status(200).json({
			message: "Asset source saved successfully",
			data: {
				uploadId: upload._id,
				name: upload.assetName,
				status: upload.status,
				processedRows: upload.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to save asset source"),
		});
	}
});

assetRouter.post("/source/:id/clone", userAuth, async (req, res) => {
	try {
		const { name, assetName } = req.body;
		const trimmedName = String(name || assetName || "").trim();

		if (!trimmedName) {
			return res.status(400).json({ message: "Asset source name is required" });
		}

		const source = await AssetUpload.findById(req.params.id);
		if (!source) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		await assertUniqueAssetSourceName(
			source.accountId,
			trimmedName
		);

		const sourceRows = await AssetSource.find({
			uploadId: source._id,
			isDeleted: false,
		}).lean();

		const fileRef =
			source.fileRef ||
			(source.copyMatrixId
				? `copy-matrix://${source.copyMatrixId}`
				: `asset-source://${source._id}`);

		let cloned = null;

		try {
			cloned = await AssetUpload.create({
				accountId: source.accountId,
				assetName: trimmedName,
				fileName: source.fileName || `${trimmedName}.csv`,
				originalName: source.originalName,
				inputType: source.inputType || "file",
				fileType: source.fileType || "csv",
				uniqueColumn: source.uniqueColumn,
				fileRef,
				storageType: source.storageType || "local",
				fileHash:
					source.fileHash ||
					`clone_${source._id}_${Date.now()}`,
				copyMatrixId: source.copyMatrixId,
				columns: source.columns || [],
				status: source.status === "draft" ? "completed" : source.status,
				processedRows: source.processedRows,
				message: source.message,
				errorLog: source.errorLog,
				validationErrors: source.validationErrors,
				uploadedBy: req.user._id,
			});

			if (sourceRows.length > 0) {
				await AssetSource.insertMany(
					sourceRows.map((row) => ({
						uploadId: cloned._id,
						primaryKey: row.primaryKey,
						rowData: row.rowData,
						fileHash: row.fileHash,
						isDeleted: false,
						importStatus:
							cloned.status === "completed"
								? "ACTIVE"
								: row.importStatus,
						cmRowIndex: row.cmRowIndex,
					}))
				);
			}
		} catch (cloneErr) {
			if (cloned?._id) {
				await AssetSource.deleteMany({ uploadId: cloned._id });
				await AssetUpload.findByIdAndDelete(cloned._id);
			}
			throw cloneErr;
		}

		if (!cloned) {
			return res.status(500).json({
				message: "Failed to clone asset source",
			});
		}

		res.status(201).json({
			message: "Asset source cloned successfully",
			data: {
				_id: cloned._id,
				name: cloned.assetName,
				status: cloned.status,
				processedRows: cloned.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: err.message || "Failed to clone asset source",
		});
	}
});

// =====================================================================
// ROUTE 8: DELETE ASSET SOURCE
// URL: DELETE /source/:id
// =====================================================================
assetRouter.delete("/source/:id", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		await AssetSource.deleteMany({ uploadId: upload._id });
		const deletedName = String(upload.assetName || "").trim();
		const deleteUpdate = {
			$unset: { assetUploadId: "" },
		};
		if (deletedName) {
			deleteUpdate.$addToSet = { deletedAssetSourceNames: deletedName };
		}
		await CopyMatrix.updateMany({ assetUploadId: upload._id }, deleteUpdate);
		await upload.deleteOne();

		res.status(200).json({ message: "Asset source deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to delete asset source" });
	}
});

module.exports = assetRouter;
