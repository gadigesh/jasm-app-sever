const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Models & Services
const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const storageService = require("../services/storage");
const { processUpload } = require("../services/processors");
const { updateAssetWithHistory } = require("../services/assetServices");
const { userAuth } = require("../middlewares/auth");
const { buildCsv, sendCsv } = require("../utils/csvExport");

const assetRouter = express.Router();

// Multer Config (Temp Storage)
const upload = multer({
	dest: "temp_uploads/",
	limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

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
			.populate("uploadedBy", "firstName lastName email") // Adjust fields based on your User model
			.sort({ updatedAt: -1 }); // Newest first

		// Format data for the Frontend Table
		const formattedData = assets.map((asset) => {
			const userName = asset.uploadedBy
				? asset.uploadedBy.firstName
				: "Unknown";
			return {
				_id: asset._id,
				name: asset.assetName, // "Summer Campaign"
				fileName: asset.fileName, // "data.csv"
				status: asset.status, // "completed", "processing"
				rows: asset.processedRows, // 1500
				uploadedBy: userName,
				updatedBy: userName,
				updatedAt: asset.updatedAt,
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

			// 3. Create the Database Record (Pending Status)
			const newUpload = await AssetUpload.create({
				accountId: accountId, // 🔗 LINK TO ACCOUNT
				assetName: assetName || fileName,
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
		res.status(500).json({ message: "Failed to update asset source" });
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

		res.status(200).json({
			message: "Asset source fetched successfully",
			data: {
				_id: upload._id,
				name: upload.assetName,
				fileName: upload.fileName,
				status: upload.status,
				uniqueColumn: upload.uniqueColumn,
				columns,
				processedRows: upload.processedRows,
				copyMatrixId: upload.copyMatrixId,
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
		res.status(500).json({ message: "Failed to update rows" });
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
			upload.assetName = assetName.trim();
		} else if (!upload.assetName?.trim()) {
			return res
				.status(400)
				.json({ message: "Asset source name is required" });
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
		res.status(500).json({ message: "Failed to save asset source" });
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
		await upload.deleteOne();

		res.status(200).json({ message: "Asset source deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to delete asset source" });
	}
});

module.exports = assetRouter;
